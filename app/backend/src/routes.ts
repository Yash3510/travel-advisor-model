// HTTP route handlers on plain node:http (see decision.md D-006). Wire contract: app/AGENTS.md.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError, json, readBody, rateLimited, str, type Body } from './http.js';
import { accounts } from './auth/accounts.js';
import { currentUser, handleAuth } from './auth/routes.js';
import { CONFIRM_TURN, store, type MessageRow, type Offer, type StoredMessage } from './db.js';
import { detectRegion, dealsForRegion } from './catalog.js';
import { ingestPolicy, gateAssistantOutput, gatePrices, emergencyText, statusText, newBookingRef, toPlainText, redact, PII_NOTICE } from './harness.js';
import { log } from './log.js';
import { applyProfileEdit, emptyProfile } from './domain/profile.js';
import { emptyTrip } from './domain/trip.js';
import { planTurn, type Route } from './services/promptRouter.js';
import { loadPlaces, POI_DIR, type PlaceSet } from './data/poiStore.js';
import type { LatLon } from './domain/geo.js';
import type { TripInsight } from './domain/insights.js';
import type { ItineraryDraft } from './domain/itinerary.js';
import type { TravelerProfile } from './domain/profile.js';
import type { TripContext } from './domain/trip.js';
import { gatherInsights } from './services/insightsService.js';
import { buildCheckedPlan } from './services/planBuilder.js';
import { travelTimeProvider, type TravelTimeProvider } from './services/travelTime.js';
import { checkData } from './readiness.js';
import { REGIONS_FILE } from './data/importOsm.js';
import { GUIDE_DIR } from './services/insightsService.js';
import { checkIntro, fallbackIntro, introRequest, renderItinerary } from './services/presentation.js';
import { buildSystemPrompt } from './prompts.js';
import { chatCompletion, runTurn, trimHistory, type PendingBooking, type ToolBackend, type Turn } from './modelClient.js';
import { toolSchemas, type Backend } from './tools.js';

// Stored as the first assistant turn of every thread. The client shows its own welcome and never sends it.
const GREETING =
  "Hi, I'm Kodi, your travel assistant. Tell me where you'd like to go, when, and who's coming along, and I'll plan it with you.";

export interface RequestContext {
  catalogPath: string;
  backend: Backend;
  modelUrl: string;
  /** place data for a destination (default: the importer's files in data/poi/) */
  places?: (destination: string | undefined) => PlaceSet | undefined;
  /** trip insights (default: Open-Meteo, the Wikivoyage guide, and not-checked kinds) */
  insights?: (trip: TripContext, at: LatLon) => Promise<TripInsight[]>;
  /** a travel-time provider for one planning request (tests inject one) */
  travelTime?: () => TravelTimeProvider;
}

// India market: "today" is the date in IST, recomputed per request
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export function sse(res: ServerResponse, event: string, data: unknown): void {
  if (res.writable) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function setCommonHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (config.allowedOrigins.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true'); // the sign-in cookie, for a frontend on another origin
  }
}

const CONTACT_TOPICS = new Set(['trip', 'feedback', 'partnership', 'other']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const oneLine = (v: unknown, max: number) => str(v).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const toIso = (sqliteUtc: string) => new Date(sqliteUtc.replace(' ', 'T') + 'Z').toISOString();

export function createHandler(ctx: RequestContext) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const started = Date.now();
    const reqId = str(req.headers['x-request-id']).slice(0, 64) || randomUUID();
    res.setHeader('X-Request-Id', reqId);
    const path = (req.url ?? '/').split('?')[0]; // never log query strings: they carry session ids
    if (config.logRequests && path !== '/health' && path !== '/ready') {
      res.on('close', () => log('info', 'request', { reqId, method: req.method, path, status: res.statusCode, ms: Date.now() - started, completed: res.writableEnded }));
    }
    route(req, res, ctx).catch((err) => {
      log('error', 'unhandled route error', { reqId, path, error: (err as Error).stack });
      if (!res.headersSent) json(res, 500, { error: { code: 'internal', message: 'Internal error' } });
      else if (!res.writableEnded) { sse(res, 'error', { message: 'Internal error', code: 'internal' }); res.end(); }
    });
  };
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  setCommonHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Request-Id',
      'Access-Control-Max-Age': '86400',
    }).end();
    return;
  }

  const allow = (method: string) => {
    if (req.method !== method) { res.setHeader('Allow', method); throw new HttpError(405, 'method_not_allowed', `Use ${method}.`); }
  };

  try {
    if (await handleAuth(req, res, pathname)) return;

    // A chat session is usable by its id while anonymous; once it belongs to an account, only when signed in to it.
    const viewer = currentUser(req)?.id ?? null;
    const canUse = (sid: string) => { const owner = accounts.sessionOwner(sid); return owner === null || owner === viewer; };
    const ownThread = (id: number, sid: string) => (canUse(sid) ? store.getThread(id, sid) : undefined);

    const requireSession = (sessionId: string) => {
      if (!store.sessionExists(sessionId) || !canUse(sessionId)) throw new HttpError(404, 'session_not_found', 'Session not found. Start a new session.');
      return sessionId;
    };

    const tripPath = /^\/api\/threads\/(\d+)\/trip$/.exec(pathname);
    if (tripPath) {
      allow('GET');
      const thread = ownThread(Number(tripPath[1]), url.searchParams.get('sessionId') ?? '');
      if (!thread) throw new HttpError(404, 'thread_not_found', 'Thread not found.');
      json(res, 200, { trip: store.getTrip(thread.id) });
      return;
    }

    const itineraryPath = /^\/api\/threads\/(\d+)\/itinerary$/.exec(pathname);
    if (itineraryPath) {
      allow('GET');
      const thread = ownThread(Number(itineraryPath[1]), url.searchParams.get('sessionId') ?? '');
      if (!thread) throw new HttpError(404, 'thread_not_found', 'Thread not found.');
      json(res, 200, { itinerary: store.latestItinerary(thread.id) ?? null });
      return;
    }

    const messagesPath = /^\/api\/threads\/(\d+)\/messages$/.exec(pathname);
    if (messagesPath) {
      allow('GET');
      const thread = ownThread(Number(messagesPath[1]), url.searchParams.get('sessionId') ?? '');
      if (!thread) throw new HttpError(404, 'thread_not_found', 'Thread not found.');
      json(res, 200, {
        // what the customer saw: tool calls and tool results stay server-side
        messages: store.getMessages(thread.id)
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
          .map((m) => ({ role: m.role, content: m.content, createdAt: toIso(m.created_at) })),
      });
      return;
    }

    // additive: take back the newest customer message (edit and regenerate resend it afterwards)
    const rewindPath = /^\/api\/threads\/(\d+)\/rewind$/.exec(pathname);
    if (rewindPath) {
      allow('POST');
      const thread = ownThread(Number(rewindPath[1]), str((await readBody(req)).sessionId));
      if (!thread) throw new HttpError(404, 'thread_not_found', 'Thread not found.');
      if (busyThreads.has(thread.id)) throw new HttpError(409, 'thread_busy', 'Still answering your previous message.');
      const out = store.rewind(thread.id);
      if ('error' in out) {
        throw out.error === 'booking'
          ? new HttpError(409, 'cannot_rewind', 'A booking request was made after that message, so it stays.')
          : new HttpError(409, 'cannot_rewind', 'There is no message to take back.');
      }
      json(res, 200, { ok: true, removed: out.text });
      return;
    }

    // additive: rename (PATCH {sessionId, title}) or delete (DELETE ?sessionId=) one of the session's threads
    const singleThreadPath = /^\/api\/threads\/(\d+)$/.exec(pathname);
    if (singleThreadPath) {
      const threadId = Number(singleThreadPath[1]);
      if (req.method === 'DELETE') {
        if (busyThreads.has(threadId)) throw new HttpError(409, 'thread_busy', 'Still answering a message in that thread.');
        const sid = url.searchParams.get('sessionId') ?? '';
        if (!canUse(sid) || !store.deleteThread(threadId, sid)) throw new HttpError(404, 'thread_not_found', 'Thread not found.');
        json(res, 200, { ok: true });
        return;
      }
      allow('PATCH');
      const body = await readBody(req);
      // one line of plain text: control characters out, spaces collapsed
      const title = str(body.title).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!title) throw new HttpError(400, 'bad_request', 'A title is required.');
      if (!canUse(str(body.sessionId)) || !store.renameThread(threadId, str(body.sessionId), title)) throw new HttpError(404, 'thread_not_found', 'Thread not found.');
      json(res, 200, { ok: true, title });
      return;
    }

    switch (pathname) {
      case '/health':
      case '/api/health': {
        allow('GET');
        json(res, 200, { ok: true });
        return;
      }
      case '/ready':
      case '/api/ready': {
        allow('GET');
        const modelOk = await fetch(`${ctx.modelUrl.replace(/\/$/, '')}/v1/models`, {
          headers: config.modelApiKey ? { Authorization: `Bearer ${config.modelApiKey}` } : {},
          signal: AbortSignal.timeout(3000),
        }).then((r) => r.ok, () => false);
        // additive: the files the planner needs, and where travel times come from
        const data = checkData({ catalogPath: ctx.catalogPath, regionsFile: fileURLToPath(REGIONS_FILE), poiDir: fileURLToPath(POI_DIR), guideDir: fileURLToPath(GUIDE_DIR), dbPath: config.dbPath });
        const ok = modelOk && data.ok;
        json(res, ok ? 200 : 503, { ok, model: modelOk ? 'ok' : 'unreachable', data, routing: config.routingUrl ? 'osrm' : 'estimate' });
        return;
      }
      case '/api/session': {
        allow('POST');
        json(res, 200, { sessionId: store.createSession(), message: 'Session created. Ready to start planning your trip!' });
        return;
      }
      case '/api/threads': {
        allow('GET');
        const sessionId = url.searchParams.get('sessionId') ?? '';
        json(res, 200, {
          threads: (sessionId && canUse(sessionId) ? store.listThreads(sessionId) : []).map((r) => ({
            id: r.id,
            title: r.title.length > 64 ? r.title.slice(0, 61) + '...' : r.title,
            destination: r.destination,
            itineraryId: null,
            itineraryMeta: null,
            isActive: !!r.is_active,
            createdAt: toIso(r.created_at),
            updatedAt: toIso(r.updated_at),
          })),
        });
        return;
      }
      case '/api/profile': {
        // the traveler profile belongs to the session; another session only ever sees its own
        if (req.method === 'GET') {
          json(res, 200, { profile: store.getProfile(requireSession(url.searchParams.get('sessionId') ?? '')) });
          return;
        }
        if (req.method !== 'PATCH') { res.setHeader('Allow', 'GET, PATCH'); throw new HttpError(405, 'method_not_allowed', 'Use GET or PATCH.'); }
        const body = await readBody(req);
        const sessionId = requireSession(str(body.sessionId));
        let profile;
        try {
          profile = applyProfileEdit(store.getProfile(sessionId), body, new Date().toISOString());
        } catch (err) {
          throw new HttpError(400, 'invalid_profile', (err as Error).message);
        }
        store.saveProfile(sessionId, profile);
        json(res, 200, { profile });
        return;
      }
      case '/api/profile/reset': {
        allow('POST');
        const sessionId = requireSession(str((await readBody(req)).sessionId));
        store.resetProfile(sessionId);
        json(res, 200, { profile: emptyProfile() });
        return;
      }
      case '/api/events/track': {
        allow('POST');
        const body = await readBody(req);
        // still answers ok for anything (the original contract); stores events with a plain name and small props
        const name = str(body.name);
        const { name: _n, sessionId: _s, ...props } = body;
        const propsJson = JSON.stringify(props);
        if (/^[a-z][a-z0-9_]{0,39}$/.test(name) && propsJson.length <= 4000 && !rateLimited(req, 'events', 120)) {
          const sid = str(body.sessionId);
          store.saveEvent(sid && store.sessionExists(sid) && canUse(sid) ? sid : null, name, propsJson);
        }
        json(res, 200, { ok: true });
        return;
      }
      case '/api/contact': {
        allow('POST');
        if (rateLimited(req, 'contact', 5)) throw new HttpError(429, 'rate_limited', 'Too many messages. Please wait a minute and try again.');
        const body = await readBody(req);
        const name = oneLine(body.name, 100);
        const email = oneLine(body.email, 200);
        const topic = str(body.topic);
        // card and ID numbers are taken out, as in the chat; the reply address is its own field
        const message = redact(str(body.message).trim().slice(0, config.maxMessageChars)).text;
        if (!name || !EMAIL_RE.test(email) || !CONTACT_TOPICS.has(topic) || message.length < 5) {
          throw new HttpError(400, 'bad_request', 'Please give a name, an email address, a topic and a message.');
        }
        store.saveContact({ name, email, topic, message });
        log('info', 'contact message', { topic });
        json(res, 200, { ok: true });
        return;
      }
      case '/api/confirm': {
        allow('POST');
        const body = await readBody(req);
        // thread ids are sequential and deal ids are public, so the session must own the thread
        const thread = ownThread(Number(body.threadId), str(body.sessionId));
        const offer = thread ? store.getOffer(str(body.offerId), thread.id) : undefined;
        if (!thread || !offer) throw new HttpError(404, 'offer_not_found', 'offer not found');
        json(res, 200, await confirmBooking(ctx, thread.id, offer, body.travelers));
        return;
      }
      case '/api/chat': {
        allow('POST');
        if (rateLimited(req)) throw new HttpError(429, 'rate_limited', 'Too many messages. Please wait a minute and try again.');
        await handleChat(await readBody(req), res, ctx, canUse);
        return;
      }
      default:
        throw new HttpError(404, 'not_found', 'Not found.');
    }
  } catch (err) {
    if (!(err instanceof HttpError) || res.headersSent) throw err;
    json(res, err.status, { error: { code: err.code, message: err.message } });
  }
}

/**
 * The Confirm button: the only path to the supplier's create_booking. Repeating it returns the first request.
 * The outcome text comes from a template, never from the model.
 */
async function confirmBooking(ctx: RequestContext, threadId: number, offer: Offer, travelersIn: unknown) {
  const existing = store.findBooking(offer.offer_id, threadId);
  if (existing) {
    const result = { status: existing.status, request_id: existing.booking_ref };
    return { status: existing.status, bookingRef: existing.booking_ref, offer, message: statusText(result, offer) };
  }
  const bookingRef = newBookingRef();
  const travelers = Number(travelersIn) || Number(offer.guests ?? offer.passengers) || 1;
  const args = { offer_id: offer.offer_id, travelers, total_price_inr: Number(offer.total_inr ?? offer.itineraryCost ?? 0), customer_confirmed_terms: true, request_id: bookingRef };
  const result = (await ctx.backend.call('create_booking', args)) as Record<string, unknown>;
  const message = statusText(result, offer);
  const status = String(result.status ?? 'FAILED');
  store.tx(() => {
    if (status !== 'FAILED') store.saveBooking(bookingRef, offer.offer_id, threadId, status, travelers);
    // the model sees the outcome on its next turn, exactly as its harness records it
    for (const m of [
      { role: 'user', content: CONFIRM_TURN },
      { role: 'assistant', content: '', tool_calls: [{ id: 'confirm', type: 'function', function: { name: 'create_booking', arguments: JSON.stringify(args) } }] },
      { role: 'tool', name: 'create_booking', tool_call_id: 'confirm', content: JSON.stringify(result) },
      { role: 'assistant', content: message },
    ] as StoredMessage[]) store.appendMessage(threadId, m);
  });
  return { status, bookingRef, offer, message };
}

/** Tools as the model sees them in one session: get_booking reads that session's booking requests. */
function sessionTools(ctx: RequestContext, sessionId: string): ToolBackend {
  return {
    call: async (name, args) => {
      if (name !== 'get_booking') return ctx.backend.call(name, args);
      const ref = String(args.booking_ref ?? '');
      const b = store.findBookingByRef(ref, sessionId);
      if (!b) return { status: 'NOT_FOUND', booking_ref: ref };
      const o = b.offer;
      const product = o.hotel ? `${o.hotel}, ${o.room ?? 'room'}, ${o.check_in} to ${o.check_out}`
        : o.airline ? `${o.airline} ${o.from} to ${o.to} on ${o.date}` : String(o.title ?? o.offer_id);
      return { booking_ref: b.booking_ref, status: b.status, product, travelers: b.travelers, requested_at: toIso(b.created_at) };
    },
  };
}

async function planItinerary(p: { ctx: RequestContext; trip: TripContext; profile: TravelerProfile; history: Turn[]; userText: string; places: PlaceSet; signal: AbortSignal; threadId?: number; onStep?: (step: string) => void }) {
  p.onStep?.('weather');
  const insights = await (p.ctx.insights ?? ((trip, at) => gatherInsights({ trip, at, now: new Date() })))(p.trip, p.places.center);
  const pois = p.places.pois;
  const travel = (p.ctx.travelTime ?? defaultTravelTime)();
  p.onStep?.('plan');
  const { draft, profile } = await buildCheckedPlan({ trip: p.trip, profile: p.profile, insights, pois, travel });

  let intro = fallbackIntro(draft, profile, p.trip);
  p.onStep?.('note');
  try {
    // no tools: the model can't search or book here, only write a note about the plan it is shown
    const out = await chatCompletion({
      base: p.ctx.modelUrl, apiKey: config.modelApiKey, model: config.model, timeoutMs: config.modelTimeoutMs, signal: p.signal,
      messages: [{ role: 'system', content: buildSystemPrompt(today(), profile.name) }, ...trimHistory([...p.history, { role: 'user', content: `${p.userText}\n\n${introRequest(draft, profile, p.trip)}` }], config.maxHistoryChars)],
    });
    const note = toPlainText(out.content);
    const check = out.toolCalls.length ? { ok: false as const, reason: 'tried to use a tool' } : checkIntro(note, { draft, knownPlaceNames: pois.map((x) => x.name) });
    if (check.ok) intro = note;
    else log('info', 'model note rejected', { threadId: p.threadId ?? null, reason: check.reason });
  } catch (err) {
    if (p.signal.aborted) return undefined;
    log('warn', 'model note unavailable, using the template', { threadId: p.threadId ?? null, error: (err as Error).message });
  }
  return { draft, insights, reply: `${intro}\n\n${renderItinerary(draft, insights)}` };
}

/** Additive `planning` key on `done`: where the planner is, so the UI can show progress and assumptions. */
const defaultTravelTime = () => travelTimeProvider({
  url: config.routingUrl, production: process.env.NODE_ENV === 'production', timeoutMs: config.routingTimeoutMs,
  onError: (err) => log('warn', 'routing unavailable; using straight-line estimates', { error: err.message }),
});

const planningInfo = (r: Route) => ({ state: r.state, action: r.action, ...(r.field ? { field: r.field } : {}), assumptions: r.assumptions, missing: r.missing });

const busyThreads = new Set<number>();

const toTurn = (m: MessageRow): Turn => ({
  role: m.role, content: m.content,
  ...(m.tool_calls ? { tool_calls: JSON.parse(m.tool_calls) as unknown[] } : {}),
  ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  ...(m.name ? { name: m.name } : {}),
});

function latestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content.trim() : '';
  }
  return '';
}

/** Additive `status` event: what the server is doing, so the client can show progress instead of a spinner. */
const STEP_LABEL: Record<string, string> = {
  thinking: 'Thinking', writing: 'Writing the reply',
  search_flights: 'Searching flights', search_hotels: 'Searching hotels', get_entry_requirements: 'Checking entry rules',
  get_travel_advisory: 'Checking travel advisories', get_destination_info: 'Reading the destination guide',
  get_booking: 'Looking up your booking', create_booking: 'Preparing a booking summary', handoff_to_human: 'Contacting our team',
  weather: 'Checking weather and season', plan: 'Building your day-by-day plan', note: 'Writing a note on your plan',
};

/**
 * Additive `delta` events: the reply in whole sentences as the model writes it. Each sentence goes through the same
 * checks as the final reply (booking claims, unbacked prices, formatting) before it is sent. A blocked sentence
 * stops the stream; `{reset: true}` tells the client to drop what it has. `done` stays the authoritative reply.
 */
function sentenceStream(res: ServerResponse, check: (piece: string) => string | null) {
  let sent = 0;
  let stopped = false;
  return (soFar: string) => {
    if (stopped) return;
    if (!soFar || soFar.length < sent) {
      if (sent) sse(res, 'delta', { reset: true });
      sent = 0;
      if (!soFar) return;
    }
    const boundary = /[.!?](?=\s)|\n/g;
    boundary.lastIndex = sent;
    let end = sent;
    for (let m; (m = boundary.exec(soFar)); ) end = m.index + 1;
    if (end <= sent) return;
    const piece = soFar.slice(sent, end);
    sent = end;
    const out = check(piece);
    if (out === null) { stopped = true; sse(res, 'delta', { reset: true }); return; }
    if (out) sse(res, 'delta', { text: out });
  };
}

async function handleChat(body: Body, res: ServerResponse, ctx: RequestContext, canUse: (sessionId: string) => boolean): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
  });
  const fail = (code: string, message: string) => { sse(res, 'error', { message, code }); res.end(); };

  const sessionId = str(body.sessionId);
  if (!sessionId || !Array.isArray(body.messages)) return fail('bad_request', 'sessionId and messages are required');
  if (!store.sessionExists(sessionId) || !canUse(sessionId)) return fail('session_not_found', 'Session not found. Start a new session.');
  const content = latestUserText(body.messages);
  if (!content) return fail('bad_request', 'user message missing');
  if (content.length > config.maxMessageChars) return fail('message_too_long', `Messages are limited to ${config.maxMessageChars} characters.`);

  // A threadId from another session is treated as unknown, so a fresh thread is started.
  const thread = body.threadId != null ? store.getThread(Number(body.threadId), sessionId) : undefined;
  if (thread && busyThreads.has(thread.id)) return fail('thread_busy', 'Still answering your previous message.');
  if (thread) busyThreads.add(thread.id);

  // Comment lines keep proxies from closing a quiet stream; clients ignore them. A client that leaves
  // cancels the model call, and nothing from the abandoned turn is stored.
  const heartbeat = setInterval(() => { if (res.writable) res.write(': keep-alive\n\n'); }, config.sseHeartbeatMs);
  const clientGone = new AbortController();
  res.on('close', () => { if (!res.writableEnded) clientGone.abort(); });
  const status = (step: string) => sse(res, 'status', { step, label: STEP_LABEL[step] ?? 'Working on it' });
  try {
    const policy = ingestPolicy(content);
    // Server-owned history; the client's messages[] only supplies the newest user turn.
    const history: Turn[] = thread ? store.getMessages(thread.id).map(toTurn) : [{ role: 'assistant', content: GREETING }];
    const toStore: StoredMessage[] = [{ role: 'user', content: policy.redacted }];

    let reply: string;
    let offers: Offer[] = [];
    let pendingBooking: PendingBooking | undefined;
    let region: { name: string; code: string } | null = null;
    let planned: ReturnType<typeof planTurn> | undefined;
    let itinerary: ItineraryDraft | undefined;
    let tripInsights: TripInsight[] | undefined;
    const conversationText = () => [...history, toStore[0]].map((m) => m.content).join(' ');
    // what this turn may change, so it can be taken back (POST /api/threads/:id/rewind)
    const tripBefore = thread ? store.getTrip(thread.id) : null;
    const versionBefore = thread ? (store.latestItinerary(thread.id)?.version ?? null) : null;

    if (policy.emergency) {
      // the model is not consulted; support gets an urgent handoff
      const handoff = (await ctx.backend.call('handoff_to_human', { summary: `EMERGENCY reported by customer: ${policy.redacted.slice(0, 300)}`, urgency: 'urgent' })) as { status?: string };
      reply = emergencyText(String(handoff?.status).toUpperCase() === 'TRANSFERRED');
      toStore.push({ role: 'assistant', content: reply });
      log('warn', 'emergency message', { threadId: thread?.id ?? null, handedOff: String(handoff?.status).toUpperCase() === 'TRANSFERRED' });
    } else {
      // the planner reads the message (no model) and either asks one question itself or lets the model answer
      const current = thread ? store.latestItinerary(thread.id) : undefined;
      planned = planTurn({
        trip: thread ? store.getTrip(thread.id) : emptyTrip(), profile: store.getProfile(sessionId), message: policy.redacted,
        today: today(), catalogPath: ctx.catalogPath, firstTurnOfThread: !thread, now: new Date().toISOString(),
        scheduled: current?.days.flatMap((d) => d.items.filter((x) => x.kind === 'activity' && x.poiId).map((x) => ({ poiId: x.poiId!, name: x.title }))),
      });
      const planning = planned.route.action === 'draft' || planned.route.action === 'revise';
      const places = planning ? (ctx.places ?? loadPlaces)(planned.trip.destination) : undefined;
      if (planned.route.action === 'ask') {
        reply = planned.route.text!;
        toStore.push({ role: 'assistant', content: reply });
        if (!thread?.region_code) region = detectRegion(conversationText(), ctx.catalogPath);
      } else if (places) {
        // the plan comes from code; the model only adds a short, checked note
        const built = await planItinerary({ ctx, trip: planned.trip, profile: planned.profile, history, userText: policy.redacted, places, signal: clientGone.signal, threadId: thread?.id, onStep: status });
        if (!built) { log('info', 'client left before the reply', { threadId: thread?.id ?? null }); return; }
        ({ draft: itinerary, insights: tripInsights, reply } = built);
        planned.trip = { ...planned.trip, status: 'drafted', itineraryVersion: built.draft.version };
        toStore.push({ role: 'assistant', content: reply });
        if (!thread?.region_code) region = detectRegion(conversationText(), ctx.catalogPath);
      } else {
      // no place data for this destination: the model drafts from the trip summary, added for the model only
      const modelTurn: Turn = planned.route.action === 'draft' ? { role: 'user', content: `${policy.redacted}\n\n${planned.route.brief}` } : toStore[0];
      let turn: Awaited<ReturnType<typeof runTurn>>;
      const knownRegion = thread?.region_code ?? detectRegion(conversationText(), ctx.catalogPath)?.code;
      const userWords = [...history, toStore[0]].filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      const priorFacts = [...history.filter((m) => m.role === 'tool').map((m) => m.content), knownRegion ? JSON.stringify(dealsForRegion(knownRegion, ctx.catalogPath)) : ''];
      let streamFacts: string[] = [];
      const stream = sentenceStream(res, (piece) => {
        if (gateAssistantOutput(piece).blocked) return null;
        const lead = /^\s*/.exec(piece)![0];
        const trail = /\s*$/.exec(piece.slice(lead.length))![0];
        const core = piece.slice(lead.length, piece.length - trail.length);
        return lead + toPlainText(gatePrices(core, { facts: [...priorFacts, ...streamFacts].join('\n'), user: userWords })) + trail;
      });
      try {
        turn = await runTurn({
          onStep: status,
          onDraft: (soFar, toolResults) => { streamFacts = toolResults; stream(soFar); },
          base: ctx.modelUrl, apiKey: config.modelApiKey, model: config.model, timeoutMs: config.modelTimeoutMs, signal: clientGone.signal,
          messages: [{ role: 'system', content: buildSystemPrompt(today(), planned.profile.name) }, ...trimHistory([...history, modelTurn], config.maxHistoryChars)],
          backend: sessionTools(ctx, sessionId), tools: toolSchemas,
          findOffer: (id) => (thread && id.startsWith('OF-') ? store.getOffer(id, thread.id) : undefined),
        });
      } catch (err) {
        if (clientGone.signal.aborted) { log('info', 'client left before the reply', { threadId: thread?.id ?? null }); return; }
        log('error', 'model call failed', { threadId: thread?.id ?? null, error: (err as Error).message });
        return fail('model_unavailable', 'Our travel assistant is unavailable right now. Please try again in a minute.');
      }
      if (clientGone.signal.aborted) return;
      if (config.logTools && turn.toolTrace.length) log('info', 'tool calls', { threadId: thread?.id ?? null, toolTrace: turn.toolTrace });
      offers = turn.offers;
      pendingBooking = turn.pendingBooking;
      if (!thread?.region_code) region = detectRegion(conversationText() + ' ' + turn.reply, ctx.catalogPath);
      const regionCode = thread?.region_code ?? region?.code;

      // The confirmation summary is built from supplier data; model text is checked against
      // the numbers it was given: every tool result in the thread, the deals on screen, the user's words.
      reply = toPlainText(pendingBooking ? turn.reply : gatePrices(gateAssistantOutput(turn.reply).text, {
        facts: [
          ...history.filter((m) => m.role === 'tool').map((m) => m.content),
          ...turn.added.filter((m) => m.role === 'tool').map((m) => m.content),
          regionCode ? JSON.stringify(dealsForRegion(regionCode, ctx.catalogPath)) : '',
        ].join('\n'),
        user: [...history, toStore[0]].filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
      }));
      toStore.push(...turn.added.slice(0, -1), { role: 'assistant', content: reply });
      }
    }

    const deals = region ? dealsForRegion(region.code, ctx.catalogPath) : [];
    const threadId = store.tx(() => {
      const id = thread?.id ?? store.createThread(sessionId, policy.redacted.slice(0, 200));
      if (!thread) store.appendMessage(id, { role: 'assistant', content: GREETING });
      const [userTurn, ...rest] = toStore;
      store.saveTurn(id, store.appendMessage(id, userTurn), tripBefore, versionBefore);
      for (const m of rest) store.appendMessage(id, m);
      if (region) store.updateThread(id, { destination: region.name, region_code: region.code, stage: 'planning' });
      if (planned) { store.saveTrip(id, planned.trip); store.saveProfile(sessionId, planned.profile); }
      if (itinerary) store.saveItinerary(id, itinerary);
      // deals become confirmable offers too, keyed by their campaignItineraryId
      store.saveOffers(id, [...offers, ...deals.map((d) => ({ ...d, offer_id: d.campaignItineraryId }))]);
      return id;
    });

    if (region) {
      sse(res, 'destination_selected', { regionName: region.name, regionCode: region.code });
      sse(res, 'campaign_deals', { deals });
    }
    // Additive keys: `offers` the client can show, `pendingBooking` to render a Confirm button for /api/confirm.
    sse(res, 'done', {
      message: (policy.hadPii && !policy.emergency ? PII_NOTICE : '') + reply,
      threadId,
      ...(offers.length ? { offers } : {}),
      ...(pendingBooking ? { pendingBooking } : {}),
      ...(planned ? { planning: planningInfo(planned.route) } : {}),
      // additive: the structured plan is the source of truth; the message is its rendering
      ...(itinerary ? { itinerary, insights: tripInsights } : {}),
    });
    res.end();
  } finally {
    clearInterval(heartbeat);
    if (thread) busyThreads.delete(thread.id);
  }
}
