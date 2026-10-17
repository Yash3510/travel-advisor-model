import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createHandler } from '../src/routes.js';
import { MockBackend } from '../src/tools.js';
import { createTakeoffApi, readSse, toDealCard, TakeoffApiError, type Deal } from '../../client/takeoff-api.js';
import type { TripInsight } from '../src/domain/insights.js';
import { TRAVEL_ESTIMATE_WARNING, TRAVEL_UNAVAILABLE_WARNING } from '../src/services/itineraryValidator.js';
import { travelTimeProvider, UNAVAILABLE_SOURCE, type TravelTimeProvider } from '../src/services/travelTime.js';
import { NOW, TOWN } from './fixtures.js';

// Stand-in for llama-server: replies come from a queue; every request body is recorded.
type Reply = { content?: string; tool_calls?: { name: string; args: object }[]; delayMs?: number } | 'fail' | ((req: any) => Reply);
const stub = { queue: [] as Reply[], requests: [] as any[] };
let testInsights: TripInsight[] = [];
let testTravel: (() => TravelTimeProvider) | undefined;
let modelServer: http.Server;
let apiServer: http.Server;
let base = '';

function listen(s: http.Server): Promise<string> {
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

beforeAll(async () => {
  modelServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      stub.requests.push(parsed);
      let next = stub.queue.shift();
      if (typeof next === 'function') next = next(parsed);
      if (!next || next === 'fail') { res.writeHead(500).end('boom'); return; }
      const tool_calls = next.tool_calls?.map((t) => ({ type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }));
      const payload = JSON.stringify({ choices: [{ message: { role: 'assistant', content: next.content ?? '', tool_calls } }] });
      setTimeout(() => { if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload); }, next.delayMs ?? 0);
    });
  });
  const modelUrl = await listen(modelServer);
  apiServer = http.createServer(createHandler({
    catalogPath: config.catalogPath, backend: new MockBackend(config.catalogPath), modelUrl,
    // place data and insights are injected: tests never touch the generated files or live services
    places: (d) => (d === 'Goa' ? { slug: 'goa', center: { lat: 15.5, lon: 73.8 }, pois: TOWN } : undefined),
    insights: async () => testInsights,
    travelTime: () => (testTravel ?? (() => travelTimeProvider({})))(),
  }));
  base = await listen(apiServer);
});
afterAll(() => { modelServer.close(); apiServer.close(); });
beforeEach(() => { stub.queue = []; stub.requests = []; testInsights = []; testTravel = undefined; });

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function session(): Promise<string> {
  return (await (await post('/api/session', {})).json()).sessionId;
}

async function chatRaw(sessionId: string, content: string, threadId?: number) {
  return (await post('/api/chat', { sessionId, threadId, messages: [{ role: 'user', content, timestamp: null }] })).text();
}

async function chat(sessionId: string, content: string, threadId?: number) {
  const text = await chatRaw(sessionId, content, threadId);
  // SSE comment lines (": keep-alive") carry no event
  return text.trim().split('\n\n').filter((b) => !b.startsWith(':')).map((b) => ({
    event: /^event: (.*)$/m.exec(b)![1],
    data: JSON.parse(/^data: (.*)$/m.exec(b)![1]),
  }));
}

describe('POST /api/chat', () => {
  it('streams destination, deals, then done, and keeps history on the server', async () => {
    const sid = await session();
    stub.queue = [{ content: 'Bali in December is lovely. Who is travelling?' }];
    const first = await chat(sid, '5 day Bali trip in December for 2');
    expect(first.map((e) => e.event)).toEqual(['destination_selected', 'campaign_deals', 'done']);
    expect(first[0].data).toEqual({ regionName: 'Bali', regionCode: 'idn' });
    expect(first[1].data.deals.length).toBeGreaterThan(0);

    const threadId = first[2].data.threadId;
    stub.queue = [{ content: 'A relaxed pace it is.' }];
    const second = await chat(sid, 'relaxed pace please', threadId);
    expect(second.map((e) => e.event)).toEqual(['done']);
    expect(second[0].data.threadId).toBe(threadId);
    expect(stub.requests[1].messages.map((m: any) => m.role)).toEqual(['system', 'assistant', 'user', 'assistant', 'user']);
  });

  it('runs tools, keeps tool prices, replaces invented ones, and lets the offer be confirmed', async () => {
    const sid = await session();
    stub.queue = [
      { tool_calls: [{ name: 'search_hotels', args: { city: 'bali', check_in: '2026-12-10', check_out: '2026-12-15', guests: 2 } }] },
      (req) => {
        const top = JSON.parse(req.messages.at(-1).content).results[0];
        return { content: `${top.hotel} is ₹${top.price_per_night_inr.toLocaleString('en-IN')} a night. Flights are about ₹87,654.` };
      },
    ];
    const done = (await chat(sid, 'find me a hotel in Bali from 10 to 15 December for 2')).at(-1)!;
    expect(done.event).toBe('done');
    const offer = done.data.offers[0];
    expect(offer.nights).toBe(5);
    expect(done.data.message).toContain(`₹${offer.price_per_night_inr.toLocaleString('en-IN')}`);
    expect(done.data.message).not.toContain('87,654');

    const sent = stub.requests[1].messages;
    expect(sent.at(-1).tool_call_id).toBe(sent.at(-2).tool_calls[0].id);

    // next turn: the model books an offer from the stored tool history; the harness holds it for Confirm
    stub.queue = [(req) => {
      const tool = req.messages.find((m: any) => m.role === 'tool');
      const id = JSON.parse(tool.content).results[0].offer_id;
      return { tool_calls: [{ name: 'create_booking', args: { offer_id: id, travelers: 2, total_price_inr: 1, customer_confirmed_terms: true } }] };
    }];
    const hold = (await chat(sid, 'yes, book the first one', done.data.threadId)).at(-1)!;
    expect(hold.data.pendingBooking).toMatchObject({ offer_id: offer.offer_id, travelers: 2 });
    expect(hold.data.message).toMatch(/^Please confirm this booking:/);
    expect(stub.requests).toHaveLength(3);

    expect((await post('/api/confirm', { threadId: done.data.threadId, offerId: offer.offer_id })).status).toBe(404);
    const other = await session();
    expect((await post('/api/confirm', { sessionId: other, threadId: done.data.threadId, offerId: offer.offer_id })).status).toBe(404);
    const ok = await post('/api/confirm', { sessionId: sid, threadId: done.data.threadId, offerId: offer.offer_id, travelers: 2 });
    expect(ok.status).toBe(200);
    const booked = await ok.json();
    expect(booked).toMatchObject({ status: 'PENDING_SUPPLIER_CONFIRMATION', bookingRef: expect.stringMatching(/^BK-/) });
    expect(booked.message).toContain('not confirmed yet');
    const again = await (await post('/api/confirm', { sessionId: sid, threadId: done.data.threadId, offerId: offer.offer_id })).json();
    expect(again.bookingRef).toBe(booked.bookingRef);

    // the model can look the request up, and sees it as pending
    stub.queue = [
      { tool_calls: [{ name: 'get_booking', args: { booking_ref: booked.bookingRef } }] },
      { content: 'Still pending with the supplier.' },
    ];
    await chat(sid, 'is it confirmed now?', done.data.threadId);
    const lookup = JSON.parse(stub.requests.at(-1).messages.at(-1).content);
    expect(lookup).toMatchObject({ booking_ref: booked.bookingRef, status: 'PENDING_SUPPLIER_CONFIRMATION', travelers: 2 });

    const shown = await (await fetch(`${base}/api/threads/${done.data.threadId}/messages?sessionId=${sid}`)).json();
    expect(shown.messages.every((m: any) => m.role !== 'tool' && m.content)).toBe(true);
  });

  it("never lets one session read or write another session's thread", async () => {
    const a = await session();
    const b = await session();
    stub.queue = [{ content: 'Hello A' }, { content: 'Hello B' }];
    const ta = (await chat(a, 'hi')).at(-1)!.data.threadId;
    const tb = (await chat(b, 'hi', ta)).at(-1)!.data.threadId;
    expect(tb).not.toBe(ta);
    expect((await fetch(`${base}/api/threads/${ta}/messages?sessionId=${b}`)).status).toBe(404);
    const mine = await (await fetch(`${base}/api/threads/${ta}/messages?sessionId=${a}`)).json();
    expect(mine.messages.map((m: any) => m.role)).toEqual(['assistant', 'user', 'assistant']);
  });

  it('answers emergencies without calling the model and raises a handoff', async () => {
    const sid = await session();
    const e = (await chat(sid, 'my friend collapsed and is unresponsive')).at(-1)!;
    expect(e.data.message).toContain('112');
    expect(e.data.message).toContain('alerted our support team');
    expect(stub.requests).toHaveLength(0);
  });

  it('tells the customer when card details were removed', async () => {
    const sid = await session();
    stub.queue = [{ content: 'Noted.' }];
    const d = (await chat(sid, 'my card is 4111 1111 1111 1111, can you hold a hotel?')).at(-1)!;
    expect(stub.requests).toHaveLength(1);
    expect(d.data.message).toMatch(/^For your safety I removed/);
    expect(JSON.stringify(stub.requests)).not.toContain('4111');
  });

  it('reports a model outage without saving half a turn', async () => {
    const sid = await session();
    stub.queue = ['fail'];
    const ev = await chat(sid, 'what is the weather like in Japan?');
    expect(ev).toEqual([{ event: 'error', data: expect.objectContaining({ code: 'model_unavailable' }) }]);
    expect((await (await fetch(`${base}/api/threads?sessionId=${sid}`)).json()).threads).toEqual([]);
  });

  it('keeps slow replies alive with SSE comments', async () => {
    const sid = await session();
    stub.queue = [{ content: 'Here you go.', delayMs: 150 }];
    const raw = await chatRaw(sid, 'what can you do?');
    expect(raw).toMatch(/^: keep-alive\n\n/m);
    expect(raw).toContain('event: done');
  });

  it('drops the turn when the client disconnects mid-reply', async () => {
    const sid = await session();
    stub.queue = [{ content: 'Too late.', delayMs: 300 }];
    const ac = new AbortController();
    const pending = fetch(`${base}/api/chat`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, messages: [{ role: 'user', content: 'what can you do?' }] }) }).then((r) => r.text()).catch(() => 'aborted');
    setTimeout(() => ac.abort(), 50);
    expect(await pending).toBe('aborted');
    await new Promise((r) => setTimeout(r, 400));
    expect((await (await fetch(`${base}/api/threads?sessionId=${sid}`)).json()).threads).toEqual([]);
  });

  it('rejects unknown sessions and oversized bodies', async () => {
    expect((await chat('nope', 'hi'))[0]).toMatchObject({ event: 'error', data: { code: 'session_not_found' } });
    const big = await post('/api/chat', { sessionId: 'x', messages: [{ role: 'user', content: 'a'.repeat(70_000) }] });
    expect(big.status).toBe(413);
  });
});

describe('planning flow', () => {
  it('asks its own questions, then has the model write the plan by the fourth message', async () => {
    const sid = await session();
    const asks: string[] = [];
    let threadId: number | undefined;
    for (const text of ['I want to plan a trip', 'Manali', 'December, 5 days, me and my wife']) {
      const done = (await chat(sid, text, threadId)).at(-1)!;
      threadId = done.data.threadId;
      expect(done.data.planning.action).toBe('ask');
      asks.push(done.data.planning.field);
    }
    expect(asks).toEqual(['destination', 'when', 'budget']);
    expect(stub.requests).toHaveLength(0);

    stub.queue = [{ content: 'Day 1: settle in near the beach.' }];
    const plan = (await chat(sid, 'around 80k', threadId)).at(-1)!;
    expect(plan.data).toMatchObject({ message: 'Day 1: settle in near the beach.', planning: { action: 'draft', state: 'draft_ready' } });
    const sent = stub.requests[0].messages;
    expect(sent[0].content).toMatch(/^You are a travel advisor and booking assistant for trips in India\./);
    expect(sent.at(-1).content).toMatch(/^around 80k\n\nTrip details so far: destination Manali; .*budget ₹80,000 in total/);

    // the summary went to the model only; the thread keeps what the customer typed
    const stored = await (await fetch(`${base}/api/threads/${threadId}/messages?sessionId=${sid}`)).json();
    expect(stored.messages.at(-2)).toMatchObject({ role: 'user', content: 'around 80k' });
    const trip = await (await fetch(`${base}/api/threads/${threadId}/trip?sessionId=${sid}`)).json();
    expect(trip.trip).toMatchObject({ destination: 'Manali', month: 12, durationDays: 5, travelers: 2, budgetInr: 80000, status: 'drafted', asked: ['destination', 'when', 'budget'] });
    expect((await fetch(`${base}/api/threads/${threadId}/trip?sessionId=${await session()}`)).status).toBe(404);
  });

  it('keeps a profile per session, learns from chat and reuses it in a new thread', async () => {
    const sid = await session();
    const patched = await fetch(`${base}/api/profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, travelStyle: 'relaxed' }) });
    expect((await patched.json()).profile.travelStyle).toBe('relaxed');

    await chat(sid, 'I love beaches but hate crowds');
    const learned = (await (await fetch(`${base}/api/profile?sessionId=${sid}`)).json()).profile;
    expect(learned).toMatchObject({ travelStyle: 'relaxed', interests: ['beach'], dislikes: ['crowds'] });

    const next = (await chat(sid, 'Plan a trip to Goa')).at(-1)!;
    expect(next.data.message).toContain("I'll use your saved preferences: relaxed pace; likes beach; avoids crowds.");

    const other = await session();
    expect((await (await fetch(`${base}/api/profile?sessionId=${other}`)).json()).profile.interests).toEqual([]);
    const bad = await fetch(`${base}/api/profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, travelStyle: 'speedy' }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/profile?sessionId=nope`)).status).toBe(404);
    const reset = await (await post('/api/profile/reset', { sessionId: sid })).json();
    expect(reset.profile.interests).toEqual([]);
    expect((await (await fetch(`${base}/api/profile?sessionId=${sid}`)).json()).profile.travelStyle).toBeUndefined();
  });
});

async function toDraft(note: Reply | undefined) {
  const sid = await session();
  let threadId: number | undefined;
  for (const text of ['Plan a trip to Goa', '15 to 16 December, 2 of us']) threadId = (await chat(sid, text, threadId)).at(-1)!.data.threadId;
  stub.queue = note ? [note] : [];
  const done = (await chat(sid, 'about 50k', threadId)).at(-1)!;
  return { sid, threadId: threadId!, done };
}
const legs = (plan: any) => plan.days.flatMap((d: any) => d.items).filter((i: any) => i.travelToNext).map((i: any) => i.travelToNext);
const titles = (plan: any) => plan.days.flatMap((d: any) => d.items.filter((i: any) => i.kind === 'activity').map((i: any) => i.title));

describe('itinerary flow', () => {
  it('plans in code, and the model only adds a checked note', async () => {
    const note = 'A gentle start each morning and plenty of time to enjoy it together.';
    const { sid, threadId, done } = await toDraft({ content: note });
    expect(done.data.planning).toMatchObject({ action: 'draft' });
    const plan = done.data.itinerary;
    expect(plan.days.map((d: any) => d.date)).toEqual(['2026-12-15', '2026-12-16']);
    expect(done.data.message.startsWith(`${note}\n\nDay 1, Tuesday 15 December`)).toBe(true);
    for (const t of titles(plan)) expect(done.data.message).toContain(t);
    const sent = stub.requests.at(-1);
    expect(sent.tools).toBeUndefined();
    expect(sent.messages[0].content).toMatch(/^You are a travel advisor and booking assistant for trips in India\./);
    const stored = await (await fetch(`${base}/api/threads/${threadId}/itinerary?sessionId=${sid}`)).json();
    expect(stored.itinerary).toEqual(plan);
    expect((await fetch(`${base}/api/threads/${threadId}/itinerary?sessionId=${await session()}`)).status).toBe(404);
  });

  it('cannot be overridden by the model: dates, prices, places, bookings, tool calls', async () => {
    const attacks: Reply[] = [
      { content: 'Your trip starts on 25 December, dinner is ₹9,999 at Golden Sands Beach and everything is booked.' },
      { tool_calls: [{ name: 'search_hotels', args: { city: 'Goa', check_in: '2026-12-15', check_out: '2026-12-16', guests: 2 } }] },
      'fail',
    ];
    for (const attack of attacks) {
      const { done } = await toDraft(attack);
      const plan = done.data.itinerary;
      expect(done.data.message.startsWith('Here is your 2-day balanced plan for Goa.\n\nDay 1, Tuesday 15 December')).toBe(true);
      expect(plan.days.map((d: any) => d.date)).toEqual(['2026-12-15', '2026-12-16']);
      expect(done.data.message).not.toMatch(/9,999|Golden Sands|booked/);
      for (const t of titles(plan)) expect(done.data.message).toContain(t);
      for (const w of plan.warnings) expect(done.data.message).toContain(w);
      expect(done.data.offers).toBeUndefined();
    }
  });

  it('rebuilds the plan on revisions and keeps the saved profile', async () => {
    const { sid, threadId, done } = await toDraft(undefined);
    const first = titles(done.data.itinerary);
    const cheaper = (await chat(sid, 'make it cheaper', threadId)).at(-1)!;
    expect(cheaper.data).toMatchObject({ planning: { action: 'revise' }, itinerary: { version: 2 } });
    expect((await (await fetch(`${base}/api/profile?sessionId=${sid}`)).json()).profile.budgetStyle).toBeUndefined();

    const skip = (await chat(sid, `skip ${first[0]}`, threadId)).at(-1)!;
    expect(skip.data.itinerary.version).toBe(3);
    expect(titles(skip.data.itinerary)).not.toContain(first[0]);

    await chat(sid, 'we are 4 people now', threadId);
    const moved = (await chat(sid, 'move it to 21 to 22 December', threadId)).at(-1)!;
    expect(moved.data.itinerary.days.map((d: any) => d.date)).toEqual(['2026-12-21', '2026-12-22']);
    const trip = (await (await fetch(`${base}/api/threads/${threadId}/trip?sessionId=${sid}`)).json()).trip;
    expect(trip).toMatchObject({ travelers: 4, excludedPoiIds: [TOWN.find((p) => p.name === first[0])!.id], budgetStyleOverride: 'budget', itineraryVersion: 5 });
  });

  it('lets a rain forecast change the plan, and says so', async () => {
    testInsights = [{ type: 'weather', title: 'Heavy rain likely', detail: '90% chance of rain', source: 'Open-Meteo', licence: 'CC BY 4.0', checkedAt: NOW, severity: 'warning', confidence: 0.7, status: 'checked', date: '2026-12-15', effect: 'rain' }];
    const { done } = await toDraft(undefined);
    const day1 = done.data.itinerary.days[0].items.filter((i: any) => i.kind === 'activity');
    expect(day1.every((a: any) => TOWN.find((p) => p.id === a.poiId)!.indoor)).toBe(true);
    expect(done.data.message).toContain('Heavy rain likely on 15 December');
    expect(done.data.insights).toEqual(testInsights);
  });

  it('uses road times from a routing server, and labelled estimates when it fails', async () => {
    let down = false;
    const osrm = http.createServer((req, res) => {
      if (down) { res.writeHead(503).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'Ok', routes: [{ duration: 840, distance: 4100 }] }));
    });
    const url = await listen(osrm);
    try {
      testTravel = () => travelTimeProvider({ url });
      const road = (await toDraft(undefined)).done.data;
      expect(legs(road.itinerary).length).toBeGreaterThan(0);
      expect(legs(road.itinerary).every((l: any) => l.basis === 'road' && l.source === 'OSRM' && l.minutes === 24 && !l.isEstimate)).toBe(true);
      expect(road.itinerary.sources.map((s: any) => s.name)).toContain('OSRM');
      expect(road.itinerary.warnings).not.toContain(TRAVEL_ESTIMATE_WARNING);
      expect(road.message).toContain('Then about 24 min by road to the next stop.');

      down = true;
      const fallback = (await toDraft(undefined)).done.data;
      expect(legs(fallback.itinerary).every((l: any) => l.isEstimate && l.source === UNAVAILABLE_SOURCE)).toBe(true);
      expect(fallback.itinerary.warnings).toContain(TRAVEL_UNAVAILABLE_WARNING);
      expect(fallback.message).toContain(TRAVEL_UNAVAILABLE_WARNING);
      expect(fallback.message).toMatch(/min to the next stop \(estimated\)/);
    } finally {
      osrm.close();
    }
  });
});

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
};

describe('drop-in client (client/takeoff-api.ts)', () => {
  it('chats, receives destination and deals, and confirms a deal', async () => {
    const api = createTakeoffApi({ baseUrl: base, storage: memory() });
    stub.queue = [{ content: 'Bali in February is lovely.' }];
    let destination: unknown;
    let deals: Deal[] = [];
    const reply = await api.chat('Bali honeymoon in February for 2', { onDestination: (d) => { destination = d; }, onDeals: (d) => { deals = d; } });
    expect(destination).toEqual({ regionName: 'Bali', regionCode: 'idn' });
    expect(reply.message).toBe('Bali in February is lovely.');
    expect(toDealCard(deals[0])).toMatchObject({ id: deals[0].campaignItineraryId, priceINR: deals[0].itineraryCost, pax: 1 });

    const booked = await api.confirm({ threadId: reply.threadId, offerId: deals[0].campaignItineraryId, travelers: 2 });
    expect(booked.status).toBe('PENDING_SUPPLIER_CONFIRMATION');
    expect((await api.threads()).map((t) => t.id)).toEqual([reply.threadId]);
    expect((await api.messages(reply.threadId)).at(-1)!.content).toBe(booked.message);
  });

  it('survives keep-alive lines and replaces a session the server no longer knows', async () => {
    const storage = memory();
    storage.setItem('takeoff.sessionId', 'stale-session');
    const api = createTakeoffApi({ baseUrl: base, storage });
    stub.queue = [{ content: 'Hello again.', delayMs: 120 }];
    expect((await api.chat('what can you do?', { threadId: 1 })).message).toBe('Hello again.');
    expect(storage.getItem('takeoff.sessionId')).not.toBe('stale-session');
  });

  it('reads and edits the profile, and reads the trip and plan of a thread', async () => {
    const api = createTakeoffApi({ baseUrl: base, storage: memory() });
    expect(await api.profile()).toMatchObject({ interests: [], dislikes: [], sourceByField: {} });
    const edited = await api.updateProfile({ travelStyle: 'relaxed', interests: ['beach', 'food'] });
    expect(edited).toMatchObject({ travelStyle: 'relaxed', interests: ['beach', 'food'], sourceByField: { travelStyle: 'explicit' } });
    expect(await api.profile()).toEqual(edited);
    await expect(api.updateProfile({ travelStyle: 'fast' as never })).rejects.toMatchObject({ code: 'invalid_profile', status: 400 });

    let reply = await api.chat('Plan a trip to Goa');
    reply = await api.chat('15 to 16 December, 2 of us', { threadId: reply.threadId });
    expect(reply.planning).toMatchObject({ action: 'ask', state: 'high_value_refinement' });
    reply = await api.chat('about 50k', { threadId: reply.threadId });
    expect(reply.planning).toMatchObject({ action: 'draft', state: 'draft_ready' });
    expect(reply.itinerary!.days.map((d) => d.date)).toEqual(['2026-12-15', '2026-12-16']);
    expect(reply.insights).toEqual([]);
    expect(await api.trip(reply.threadId)).toMatchObject({ destination: 'Goa', startDate: '2026-12-15', travelers: 2, status: 'drafted', itineraryVersion: 1 });
    expect(await api.itinerary(reply.threadId)).toEqual(reply.itinerary);
    await expect(api.trip(reply.threadId + 999)).rejects.toMatchObject({ code: 'thread_not_found', status: 404 });

    const reset = await api.resetProfile();
    expect(reset).toMatchObject({ interests: [], sourceByField: {} });
    expect(reset.travelStyle).toBeUndefined();
  });

  it('reports backend errors with their codes', async () => {
    const api = createTakeoffApi({ baseUrl: base, storage: memory() });
    stub.queue = ['fail'];
    await expect(api.chat('is Goa safe?')).rejects.toMatchObject({ code: 'model_unavailable' });
    await expect(api.chat('x'.repeat(4001))).rejects.toBeInstanceOf(TakeoffApiError);
  });

  it('parses SSE split across chunks, with CRLF, comments and multi-line data', async () => {
    const text = ': keep-alive\r\n\r\nevent: done\r\ndata: {"a":\r\ndata: 1}\r\n\r\nevent: error\ndata: {"code":"x"}\n\n';
    const chunks = [text.slice(0, 7), text.slice(7, 30), text.slice(30)];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
    const events = [];
    for await (const e of readSse(body)) events.push(e);
    expect(events).toEqual([{ event: 'done', data: '{"a":\n1}' }, { event: 'error', data: '{"code":"x"}' }]);
  });
});
