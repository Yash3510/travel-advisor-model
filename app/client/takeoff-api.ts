// Typed client for the Takeoff backend. No dependencies: works in the browser (React + Vite) and in Node 22.
// Copy this file into the frontend as-is (src/services/takeoff-api.ts). The contract it speaks is in
// app/AGENTS.md in the model repo; app/integration.md shows how to wire it into the UI.

export interface Deal {
  campaignItineraryId: string; sourceItineraryId: string; title: string; image: string; images: string[];
  destinationString: string; nights: number; tripType: string;
  itineraryCost: number; itineraryCostWithoutFlights: number; strikedCost: number; dealDiscountPercentage: number;
  hotelStarRating: number; numBookings: number; slug: string; pills: string[];
  cityHotelStay: { cityName: string; hotelName: string; nights: number; hotelImages: string[] }[];
  activities: string[]; highlights: string[]; regionName: string; regionCode: string; type: string;
}

export interface HotelOffer {
  offer_id: string; hotel: string; city: string; room: string; price_per_night_inr: number; nights: number; guests: number;
  check_in: string; check_out: string; amenities: string[]; rate_rule: string; total_inr: number;
  taxes_included: boolean; taxes_estimate_inr?: number;
}

export interface FlightOffer {
  offer_id: string; airline: string; from: string; to: string; date: string; departs: string; duration_min: number; stops: number;
  fare_per_person_inr: number; passengers: number; total_inr: number; baggage: string; fare_rule: string;
}

export type Offer = HotelOffer | FlightOffer;

/** Present when the reply is a booking summary: show Confirm (call `confirm`) and Change (just send the next message). */
export interface PendingBooking { offer_id: string; travelers: number; total_price_inr: number }

// ── Planning (additive to the original contract): profile, trip, itinerary, insights ──────────────────────

export type TravelStyle = 'relaxed' | 'balanced' | 'packed';
export type BudgetStyle = 'budget' | 'value' | 'comfort' | 'premium';

/** The traveller's reusable preferences (the session is the user until accounts exist). Only code writes it. */
export interface TravelerProfile {
  homeCity?: string; travelStyle?: TravelStyle; budgetStyle?: BudgetStyle;
  interests: string[]; dislikes: string[];
  /** hard constraints: the planner never breaks them */
  dietaryNeeds: string[]; mobilityNeeds: string[];
  accommodationPreferences: string[];
  /** 'travelStyle' or 'interests:beach' → said by the traveller ('explicit') or picked up from chat ('inferred') */
  sourceByField: Record<string, 'explicit' | 'inferred'>;
  updatedAt: string;
}

/** An edit from a preferences screen: a list replaces the saved list, null clears a field. */
export interface ProfilePatch {
  homeCity?: string | null; travelStyle?: TravelStyle | null; budgetStyle?: BudgetStyle | null;
  interests?: string[]; dislikes?: string[]; dietaryNeeds?: string[]; mobilityNeeds?: string[]; accommodationPreferences?: string[];
}

/** What the customer has said about one trip. Dates are YYYY-MM-DD; `month` (1-12) when only the month is known. */
export interface TripFacts {
  destination?: string; origin?: string; startDate?: string; endDate?: string; month?: number; durationDays?: number;
  travelers?: number;
  /** solo, couple, family, friends, kids, seniors */
  travelerTypes: string[];
  purpose?: string; budgetInr?: number; budgetPerPerson?: boolean;
}

export interface TripContext extends TripFacts {
  /** questions the planner has asked, in order */
  asked: string[]; planningTurns: number; status: 'collecting' | 'drafted';
  /** revisions for this trip only ("skip X", "make day 2 more relaxed", "cheaper"); the profile is untouched */
  excludedPoiIds: string[]; dayPace: Record<string, TravelStyle>; paceOverride?: TravelStyle; budgetStyleOverride?: BudgetStyle;
  addedInterests?: string[];
  itineraryVersion: number; updatedAt: string;
}

export type PlanningAction = 'ask' | 'draft' | 'revise' | 'converse';
export type PlanningState = 'trip_basics' | 'profile_context' | 'high_value_refinement' | 'draft_ready' | 'revision';
/** `done.planning`: what the planner did this turn; `field` is the question it asked. */
export interface PlanningInfo { state: PlanningState; action: PlanningAction; field?: string; assumptions: string[]; missing: string[] }

/** A road time from the routing server, or a straight-line estimate (`isEstimate`): show estimates as estimated. */
export interface TravelLeg { minutes: number; km: number; basis: 'road' | 'straight_line_estimate'; source: string; isEstimate: boolean; confidence: number }

export interface ItinerarySource { name: string; licence?: string; attribution: string; url?: string }

/** One block of a day: a visit (activity), a meal break or a rest. Times are HH:MM. */
export interface ItineraryItem {
  kind: 'activity' | 'meal' | 'rest'; block: 'morning' | 'afternoon' | 'evening';
  start: string; end: string; title: string; poiId?: string; durationMinutes: number;
  /** the place's position, for the map (activities only) */
  coordinates?: { lat: number; lng: number };
  durationBasis?: 'category_default' | 'fixed';
  /** to the next activity of the day */
  travelToNext?: TravelLeg;
  /** 'open': checked against published hours; 'unknown': none published */
  hours?: 'open' | 'unknown';
  costInr?: number; costBasis?: 'osm_charge';
  why?: { matched: string[]; tradeoffs: string[] };
  notes: string[];
  /** meal blocks: nearby places that match the traveller's diet */
  suggestions?: { poiId: string; name: string; diet: string[] }[];
  source?: { name: string; url: string; licence: string; attribution: string };
  confidence: number;
}

export interface ItineraryDay { day: number; date?: string; items: ItineraryItem[]; warnings: string[] }
export interface ItineraryAlternative { kind: 'cheaper' | 'more_relaxed' | 'more_adventurous'; summary: string; changes: string[] }

/** `done.itinerary`: the plan itself and the source of truth (`message` is its rendering). Show `sources`: the OpenStreetMap credit is required by its licence. */
export interface ItineraryDraft {
  version: number; destination: string; startDate?: string; days: ItineraryDay[];
  totalEstimatedCostInr?: number; assumptions: string[]; warnings: string[]; alternatives: ItineraryAlternative[];
  confidence: number; sources: ItinerarySource[];
  /** places considered and left out, with the reason */
  rejected: { poiId: string; name: string; reason: string }[];
}

/** `done.insights`: facts from outside sources. 'not_checked' means there is no approved source: say so, never guess. */
export interface TripInsight {
  type: 'weather' | 'season' | 'guide' | 'event' | 'closure' | 'travel_time' | 'price' | 'advisory' | 'visa';
  title: string; detail: string; source: string; sourceUrl?: string; licence?: string; checkedAt: string;
  severity: 'info' | 'warning' | 'blocking'; confidence: number; status: 'checked' | 'not_checked' | 'stale';
  date?: string; poiId?: string; effect?: 'rain' | 'closed';
}

/** The `done` event. Fields a newer backend adds are kept as they arrive. */
export interface ChatReply {
  message: string; threadId: number; offers: Offer[]; pendingBooking?: PendingBooking;
  planning?: PlanningInfo; itinerary?: ItineraryDraft; insights?: TripInsight[];
  [key: string]: unknown;
}
export interface Destination { regionName: string; regionCode: string }
/** Topics the contact form accepts. */
export const CONTACT_TOPICS = ['trip', 'feedback', 'partnership', 'other'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** Additive `status` event: what the server is doing right now ("Searching hotels"). */
export interface ChatStatus { step: string; label: string }
export interface Thread { id: number; title: string; destination: string | null; isActive: boolean; createdAt: string; updatedAt: string }
export interface ThreadMessage { role: 'user' | 'assistant'; content: string; createdAt: string }
export interface BookingResult { status: string; bookingRef: string; message: string; offer: Record<string, unknown> }

/**
 * `code` is the backend's: bad_request, session_not_found, message_too_long, thread_busy, model_unavailable,
 * rate_limited, body_too_large, offer_not_found, thread_not_found, invalid_profile; plus network, aborted, stream_ended and
 * bad_response from here.
 */
export class TakeoffApiError extends Error {
  // plain fields, not constructor parameter properties: the frontend compiles with erasableSyntaxOnly
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'TakeoffApiError';
    this.code = code;
    this.status = status;
  }
}

export const MAX_MESSAGE_CHARS = 4000;

/** Customer-facing text for an error. */
export function errorText(err: unknown): string {
  const code = err instanceof TakeoffApiError ? err.code : 'network';
  switch (code) {
    case 'rate_limited': return (err as TakeoffApiError).message || 'Please wait a minute and try again.';
    case 'thread_busy': return "I'm still answering your last message.";
    case 'message_too_long': return `Please keep messages under ${MAX_MESSAGE_CHARS} characters.`;
    case 'model_unavailable': return 'The travel assistant is unavailable right now. Please try again in a minute.';
    case 'cannot_rewind': return 'That message can no longer be changed.';
    case 'account_locked': case 'bot_check': case 'email_failed': case 'account_disabled': case 'mfa_required': case 'invalid_code': case 'admin_off': case 'cannot_disable_admin':
    case 'invalid_login': case 'weak_password': case 'invalid_email': case 'invalid_name': case 'email_taken': case 'invalid_token': case 'wrong_password': case 'not_confirmed':
      return (err as TakeoffApiError).message;
    case 'not_signed_in': return 'Please sign in again.';
    case 'invalid_google': return 'Google sign-in did not work. Please try again.';
    case 'aborted': return 'Stopped.';
    default: return 'Something went wrong. Please try again.';
  }
}

/** Server-sent events from a fetch body. Skips comment lines (": keep-alive"); handles CRLF and multi-line data. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += value ? decoder.decode(value, { stream: true }) : '';
    for (;;) {
      const end = /\r?\n\r?\n/.exec(buf);
      if (!end) break;
      const block = buf.slice(0, end.index);
      buf = buf.slice(end.index + end[0].length);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const v = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = v;
        else if (field === 'data') data.push(v);
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
    if (done) return;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const listOf = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** A plan from `done.itinerary` or the itinerary endpoint. Lists an older backend left out become []; extra fields stay. */
export function parseItinerary(x: unknown): ItineraryDraft | undefined {
  if (!isObject(x) || typeof x.version !== 'number' || !Array.isArray(x.days)) return undefined;
  const days = x.days.filter(isObject).map((d) => ({ ...d, items: listOf<unknown>(d.items).filter(isObject).map((i) => ({ ...i, notes: listOf(i.notes) })), warnings: listOf(d.warnings) }));
  return { ...x, days, assumptions: listOf(x.assumptions), warnings: listOf(x.warnings), alternatives: listOf(x.alternatives), sources: listOf(x.sources), rejected: listOf(x.rejected) } as unknown as ItineraryDraft;
}

/** `done.insights`, keeping only entries that are insights. */
export function parseInsights(x: unknown): TripInsight[] {
  return listOf<unknown>(x).filter((i): i is TripInsight => isObject(i) && typeof i.type === 'string' && typeof i.title === 'string' && typeof i.status === 'string');
}

function parsePlanning(x: unknown): PlanningInfo | undefined {
  if (!isObject(x) || typeof x.action !== 'string' || typeof x.state !== 'string') return undefined;
  return { ...x, assumptions: listOf(x.assumptions), missing: listOf(x.missing) } as unknown as PlanningInfo;
}

/** The `done` event's data. The original keys read as before; additive ones are kept, known ones checked. */
export function parseDone(x: unknown): ChatReply {
  if (!isObject(x) || typeof x.message !== 'string' || typeof x.threadId !== 'number') throw new TakeoffApiError('bad_response', 'The reply was not in the expected format.');
  const { planning, itinerary, insights, ...rest } = x;
  const reply: ChatReply = { ...rest, message: x.message, threadId: x.threadId, offers: listOf<Offer>(x.offers) };
  const p = parsePlanning(planning);
  if (p) reply.planning = p;
  const plan = parseItinerary(itinerary);
  if (plan) reply.itinerary = plan;
  if (insights !== undefined) reply.insights = parseInsights(insights);
  return reply;
}

/** The deal-card shape the Takeoff frontend renders today. `itineraryCost` is per person, hence pax 1. */
export function toDealCard(d: Deal) {
  return {
    id: d.campaignItineraryId,
    title: d.title,
    route: d.destinationString.split(',').map((s) => s.trim()).join(' · '),
    nights: d.nights,
    pax: 1,
    priceINR: d.itineraryCost,
    originalINR: d.strikedCost,
    tag: d.tripType.toUpperCase(),
    stat: `${d.numBookings.toLocaleString('en-IN')} booked`,
    image: d.image,
    prompt: `I'd like the "${d.title}" trip. Help me plan it.`,
  };
}

interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

async function failure(res: Response): Promise<TakeoffApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return new TakeoffApiError(body.error?.code ?? `http_${res.status}`, body.error?.message ?? res.statusText, res.status);
}

/**
 * `baseUrl`: '' when the dev server proxies /api to the backend, else e.g. 'https://api.example.com'.
 * `storage`: where the session id lives (default localStorage, so threads survive a reload).
 */
/** What a share link shows (D-024): the plan and the trip's basics, never the conversation. */
export interface SharedTrip {
  title: string; destination: string | null; updatedAt: string; itinerary: ItineraryDraft | null;
  trip: Pick<TripFacts, 'destination' | 'startDate' | 'endDate' | 'month' | 'durationDays' | 'travelers' | 'travelerTypes' | 'purpose'>;
}

/** A destination page: verbatim Wikivoyage sentences (CC BY-SA 4.0), the guide the model also reads. */
export interface GuidePage {
  slug: string; name: string; summary: string | null; whenToGo: string[]; permits: string[];
  gettingThere: { air: string[]; rail: string[]; road: string[]; sea: string[] };
  source: string; sourceUrl: string; retrieved: string;
}
export type GuideListItem = Pick<GuidePage, 'slug' | 'name' | 'summary'>;

/** A sample itinerary for the public /trips pages, built by the same engine as the chat. */
export interface SampleCard { slug: string; title: string; blurb: string; destination: string; days: number; who: string; pace: string; interests: string[]; /** destination guide slug, when there is one */ guide: string | null }
export interface SampleTrip extends SampleCard { itinerary: ItineraryDraft }

/** The signed-in user, as the server shows it (D-021). */
/** A browser signed in to the account (`id` signs it out). */
export interface SignedInDevice { id: string; current: boolean; userAgent: string; createdAt: string; lastSeenAt: string }

export interface Account { id: number; name: string; email: string; emailVerified: boolean; hasPassword: boolean; google: boolean; createdAt: string; /** present only for admins (D-025) */ admin?: true }

// ── admin panel (D-025) ──
export const BOOKING_STATUSES = ['PENDING_SUPPLIER_CONFIRMATION', 'IN_PROGRESS', 'CONFIRMED', 'CANCELLED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export interface AdminOverview { users: number; usersNew7d: number; threads7d: number; messages7d: number; bookingsOpen: number; messagesOpen: number; sharesActive: number }
export interface AdminBooking {
  ref: string; status: BookingStatus; travelers: number; destination: string | null; threadId: number; createdAt: string; updatedAt: string | null; note: string;
  customer: { name: string; email: string } | null; offer: Offer | null;
}
export interface AdminMessage { id: number; name: string; email: string; topic: string; message: string; createdAt: string; handledAt: string | null }
export interface AdminUser { id: number; name: string; email: string; emailVerified: boolean; google: boolean; admin: boolean; disabled: boolean; threads: number; createdAt: string }
export interface AdminAuditEntry { id: number; admin: string | null; action: string; target: string | null; detail: Record<string, unknown> | null; ip: string | null; at: string }

/**
 * `credentials`: 'same-origin' (default) when the API is served from the site's own origin, 'include' when it lives on
 * another origin listed in the backend's ALLOWED_ORIGINS (the sign-in cookie must travel with each request).
 */
export function createTakeoffApi(opts: { baseUrl?: string; storage?: KeyValueStore; credentials?: RequestCredentials } = {}) {
  const base = (opts.baseUrl ?? '').replace(/\/$/, '');
  const storage = opts.storage ?? (globalThis as { localStorage?: KeyValueStore }).localStorage;
  const KEY = 'takeoff.sessionId';
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const credentials = opts.credentials ?? 'same-origin';

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, { credentials, ...init });
    } catch (err) {
      throw new TakeoffApiError('network', (err as Error).message);
    }
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  }
  const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });

  /** The stored session id, or a new one from the server. Calls made at the same time share one new session. */
  let creating: Promise<string> | undefined;
  async function session(): Promise<string> {
    const saved = storage?.getItem(KEY);
    if (saved) return saved;
    creating ??= post<{ sessionId: string }>('/api/session', {})
      .then(({ sessionId }) => { storage?.setItem(KEY, sessionId); return sessionId; })
      .finally(() => { creating = undefined; });
    return creating;
  }

  /** Forget the session (e.g. a "start over" action). The next call creates a new one. */
  function resetSession(): void {
    storage?.removeItem(KEY);
  }

  /**
   * Send one customer message and wait for the reply (5–60 s on CPU). The destination and deals arrive first,
   * through the callbacks. Keep the returned threadId and pass it with the next message. If the server no longer
   * knows the session (e.g. after a reset), a new session is made once and the reply starts a new thread.
   */
  async function chat(text: string, o: {
    threadId?: number; signal?: AbortSignal;
    onDestination?: (d: Destination) => void; onDeals?: (deals: Deal[]) => void;
    /** progress while the reply is prepared */
    onStatus?: (s: ChatStatus) => void;
    /** the reply so far, in checked sentences; '' when the server takes back what it sent. `done` replaces it. */
    onText?: (soFar: string) => void;
  } = {}): Promise<ChatReply> {
    const content = text.trim();
    if (!content) throw new TakeoffApiError('bad_request', 'Message is empty.');
    if (content.length > MAX_MESSAGE_CHARS) throw new TakeoffApiError('message_too_long', `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
    let threadId = o.threadId;
    for (let attempt = 0; ; attempt++) {
      const sessionId = await session();
      let error: TakeoffApiError | undefined;
      try {
        const res = await fetch(base + '/api/chat', {
          credentials,
          method: 'POST', headers: jsonHeaders, signal: o.signal,
          body: JSON.stringify({ sessionId, threadId, messages: [{ role: 'user', content, timestamp: new Date().toISOString() }] }),
        });
        if (!res.ok || !res.body) throw await failure(res);
        let soFar = '';
        for await (const { event, data } of readSse(res.body)) {
          const d = JSON.parse(data);
          if (event === 'status') o.onStatus?.(d as ChatStatus);
          else if (event === 'delta') { soFar = d.reset ? '' : soFar + String(d.text ?? ''); o.onText?.(soFar); }
          else if (event === 'destination_selected') o.onDestination?.(d as Destination);
          else if (event === 'campaign_deals') o.onDeals?.((d as { deals: Deal[] }).deals);
          else if (event === 'done') return parseDone(d);
          else if (event === 'error') error = new TakeoffApiError(d.code ?? 'error', d.message);
        }
      } catch (err) {
        if (o.signal?.aborted) throw new TakeoffApiError('aborted', 'Request cancelled.');
        if (err instanceof TakeoffApiError) throw err;
        throw new TakeoffApiError('network', (err as Error).message);
      }
      if (error?.code === 'session_not_found' && attempt === 0) {
        resetSession();
        threadId = undefined;
        continue;
      }
      throw error ?? new TakeoffApiError('stream_ended', 'The reply ended before it finished. Please try again.');
    }
  }

  /** The Confirm button for a pendingBooking (offer_id) or a deal (campaignItineraryId). Show `message` to the customer. */
  async function confirm(a: { threadId: number; offerId: string; travelers?: number }): Promise<BookingResult> {
    return post<BookingResult>('/api/confirm', { sessionId: await session(), ...a });
  }

  async function threads(): Promise<Thread[]> {
    return (await call<{ threads: Thread[] }>(`/api/threads?sessionId=${encodeURIComponent(await session())}`)).threads;
  }

  async function messages(threadId: number): Promise<ThreadMessage[]> {
    return (await call<{ messages: ThreadMessage[] }>(`/api/threads/${threadId}/messages?sessionId=${encodeURIComponent(await session())}`)).messages;
  }

  const withSession = async (path: string) => `${path}?sessionId=${encodeURIComponent(await session())}`;

  /** The traveller's saved preferences. */
  async function profile(): Promise<TravelerProfile> {
    return (await call<{ profile: TravelerProfile }>(await withSession('/api/profile'))).profile;
  }

  /** Save edits from a preferences screen. Unknown fields or values reject with code invalid_profile. */
  async function updateProfile(patch: ProfilePatch): Promise<TravelerProfile> {
    const body = JSON.stringify({ ...patch, sessionId: await session() });
    return (await call<{ profile: TravelerProfile }>('/api/profile', { method: 'PATCH', headers: jsonHeaders, body })).profile;
  }

  /** Forget the saved preferences; returns the empty profile. */
  async function resetProfile(): Promise<TravelerProfile> {
    return (await post<{ profile: TravelerProfile }>('/api/profile/reset', { sessionId: await session() })).profile;
  }

  /** What the planner knows about the trip in a thread. */
  async function trip(threadId: number): Promise<TripContext> {
    return (await call<{ trip: TripContext }>(await withSession(`/api/threads/${threadId}/trip`))).trip;
  }

  /** The latest plan of a thread (revisions included), or null before the first one. */
  async function itinerary(threadId: number): Promise<ItineraryDraft | null> {
    return parseItinerary((await call<{ itinerary: unknown }>(await withSession(`/api/threads/${threadId}/itinerary`))).itinerary) ?? null;
  }

  /** Take back the newest message and its reply (also its plan and trip changes); returns the message text. Edit and regenerate resend after this. */
  async function rewind(threadId: number): Promise<string> {
    return (await post<{ removed: string }>(`/api/threads/${threadId}/rewind`, { sessionId: await session() })).removed;
  }

  /** Rename a thread; returns the title as stored (one line, at most 80 characters). */
  async function renameThread(threadId: number, title: string): Promise<string> {
    const body = JSON.stringify({ sessionId: await session(), title });
    return (await call<{ title: string }>(`/api/threads/${threadId}`, { method: 'PATCH', headers: jsonHeaders, body })).title;
  }

  /** Delete a thread and everything in it. */
  async function deleteThread(threadId: number): Promise<void> {
    await call(await withSession(`/api/threads/${threadId}`), { method: 'DELETE' });
  }

  /** Product analytics (e.g. a thumbs up or down on a reply); never throws. */
  async function track(name: string, props: Record<string, unknown> = {}): Promise<void> {
    await post('/api/events/track', { name, ...props, sessionId: await session().catch(() => null) }).catch(() => undefined);
  }

  /** The contact form: stored for the team to answer by email. Rejects with bad_request or rate_limited. */
  async function contact(m: { name: string; email: string; topic: ContactTopic; message: string; turnstileToken?: string }): Promise<void> {
    await post('/api/contact', m);
  }

  // ── share links (D-024) ──
  /** The thread's live share token, or null. */
  async function shareStatus(threadId: number): Promise<string | null> {
    return (await call<{ token: string | null }>(await withSession(`/api/threads/${threadId}/share`))).token;
  }
  /** Turn on sharing (or get the existing link's token). */
  async function share(threadId: number): Promise<string> {
    return (await post<{ token: string }>(`/api/threads/${threadId}/share`, { sessionId: await session() })).token;
  }
  async function stopSharing(threadId: number): Promise<void> {
    await call(await withSession(`/api/threads/${threadId}/share`), { method: 'DELETE' });
  }
  /** What anyone with the link sees. */
  async function sharedTrip(token: string): Promise<SharedTrip> {
    const t = await call<SharedTrip>(`/api/share/${encodeURIComponent(token)}`);
    return { ...t, itinerary: parseItinerary(t.itinerary) ?? null };
  }

  const guideList = async () => (await call<{ destinations: GuideListItem[] }>('/api/guide')).destinations;
  const guidePage = (slug: string) => call<GuidePage>(`/api/guide/${encodeURIComponent(slug)}`);
  const sampleList = async () => (await call<{ samples: SampleCard[] }>('/api/samples')).samples;
  async function sampleTrip(slug: string): Promise<SampleTrip> {
    const t = await call<SampleTrip>(`/api/samples/${encodeURIComponent(slug)}`);
    const itinerary = parseItinerary(t.itinerary);
    if (!itinerary) throw new TakeoffApiError('bad_response', 'The sample trip could not be read.', 502);
    return { ...t, itinerary };
  }

  const patch = <T>(path: string, body: unknown) => call<T>(path, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body) });
  const admin = {
    mfaStatus: () => call<{ enrolled: boolean; verified: boolean }>('/api/admin/mfa'),
    mfaSetup: () => post<{ secret: string; uri: string }>('/api/admin/mfa/setup', {}),
    mfaVerify: (code: string) => post<{ ok: true }>('/api/admin/mfa/verify', { code }),
    overview: () => call<AdminOverview>('/api/admin/overview'),
    bookings: async () => (await call<{ bookings: AdminBooking[] }>('/api/admin/bookings')).bookings,
    updateBooking: (ref: string, change: { status?: BookingStatus; note?: string }) => patch<{ ok: true }>(`/api/admin/bookings/${encodeURIComponent(ref)}`, change),
    messages: async () => (await call<{ messages: AdminMessage[] }>('/api/admin/messages')).messages,
    setHandled: (id: number, handled: boolean) => patch<{ ok: true }>(`/api/admin/messages/${id}`, { handled }),
    users: async (q = '') => (await call<{ users: AdminUser[] }>(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`)).users,
    setDisabled: (id: number, disabled: boolean) => post<{ ok: true }>(`/api/admin/users/${id}/${disabled ? 'disable' : 'enable'}`, {}),
    audit: async () => (await call<{ entries: AdminAuditEntry[] }>('/api/admin/audit')).entries,
  };

  // ── accounts (D-021): the server keeps the sign-in in an HttpOnly cookie; the client keeps the account's chat session id ──
  const browserSession = () => storage?.getItem(KEY) ?? undefined;
  const signedIn = (r: { user: Account; sessionId: string }) => { storage?.setItem(KEY, r.sessionId); return r.user; };

  /** Whether "Continue with Google" is available, and its client id. */
  async function authConfig(): Promise<{ googleClientId: string | null }> {
    return call('/api/auth/config');
  }
  /** The signed-in user, or null. Signed in, the account's chat session becomes this browser's. */
  async function me(): Promise<Account | null> {
    const r = await call<{ user: Account | null; sessionId?: string }>('/api/auth/me');
    if (r.user && r.sessionId) storage?.setItem(KEY, r.sessionId);
    return r.user;
  }
  /** Create an account and sign in; trips planned in this browser move into it. Rejects with weak_password, invalid_email, email_taken… */
  async function signup(a: { name: string; email: string; password: string; turnstileToken?: string }): Promise<Account> {
    return signedIn(await post('/api/auth/signup', { ...a, sessionId: browserSession() }));
  }
  async function login(a: { email: string; password: string }): Promise<Account> {
    return signedIn(await post('/api/auth/login', { ...a, sessionId: browserSession() }));
  }
  /** `credential` is the ID token from Google Identity Services. */
  async function google(credential: string): Promise<Account> {
    return signedIn(await post('/api/auth/google', { credential, sessionId: browserSession() }));
  }
  /** Sign out; this browser forgets the account's chat session. */
  async function logout(): Promise<void> {
    await post('/api/auth/logout', {}).catch(() => undefined);
    resetSession();
  }
  async function verifyEmail(token: string): Promise<void> { await post('/api/auth/verify', { token }); }
  async function resendVerification(): Promise<void> { await post('/api/auth/resend-verification', {}); }
  /** Always resolves the same way, whether or not the email has an account. */
  async function forgotPassword(email: string, turnstileToken?: string): Promise<void> { await post('/api/auth/forgot', { email, turnstileToken }); }
  /** Choose a new password from an emailed link; signs in. */
  async function resetPassword(token: string, password: string): Promise<Account> {
    return signedIn(await post('/api/auth/reset', { token, password, sessionId: browserSession() }));
  }
  async function updateAccount(a: { name: string }): Promise<Account> {
    return (await call<{ user: Account }>('/api/account', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(a) })).user;
  }
  /** Other browsers are signed out. Accounts without a password (Google only) can set one without `currentPassword`. */
  async function changePassword(a: { currentPassword?: string; newPassword: string }): Promise<Account> {
    return (await post<{ user: Account }>('/api/account/password', a)).user;
  }
  /** Start changing the email: a link goes to the new address (and a notice to the old one). */
  async function changeEmail(a: { newEmail: string; password?: string }): Promise<string> {
    return (await post<{ pendingEmail: string }>('/api/account/email', a)).pendingEmail;
  }
  async function confirmEmailChange(token: string): Promise<void> { await post('/api/auth/confirm-email', { token }); }
  async function devices(): Promise<SignedInDevice[]> { return (await call<{ sessions: SignedInDevice[] }>('/api/account/sessions')).sessions; }
  async function signOutDevice(id: string): Promise<SignedInDevice[]> {
    return (await call<{ sessions: SignedInDevice[] }>(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })).sessions;
  }
  async function signOutOtherDevices(): Promise<SignedInDevice[]> { return (await post<{ sessions: SignedInDevice[] }>('/api/account/sessions/sign-out-others', {})).sessions; }
  /** Everything stored about the account, as JSON. */
  async function exportData(): Promise<unknown> { return call('/api/account/export'); }
  /** Confirm with the password, or `confirm: 'DELETE'` for Google-only accounts. */
  async function deleteAccount(a: { password?: string; confirm?: string }): Promise<void> {
    await call('/api/account', { method: 'DELETE', headers: jsonHeaders, body: JSON.stringify(a) });
    resetSession();
  }

  return {
    session, resetSession, chat, confirm, threads, messages, profile, updateProfile, resetProfile, trip, itinerary, rewind, renameThread, deleteThread, track, contact,
    authConfig, me, signup, login, google, logout, verifyEmail, resendVerification, forgotPassword, resetPassword, updateAccount, changePassword, exportData, deleteAccount,
    changeEmail, confirmEmailChange, devices, signOutDevice, signOutOtherDevices,
    shareStatus, share, stopSharing, sharedTrip, guideList, guidePage, sampleList, sampleTrip, admin,
  };
}

export type TakeoffApi = ReturnType<typeof createTakeoffApi>;
