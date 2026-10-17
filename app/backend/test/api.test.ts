import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createHandler } from '../src/routes.js';
import { MockBackend } from '../src/tools.js';
import { createTakeoffApi, readSse, toDealCard, TakeoffApiError, type Deal } from '../../client/takeoff-api.js';

// Stand-in for llama-server: replies come from a queue; every request body is recorded.
type Reply = { content?: string; tool_calls?: { name: string; args: object }[]; delayMs?: number } | 'fail' | ((req: any) => Reply);
const stub = { queue: [] as Reply[], requests: [] as any[] };
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
  apiServer = http.createServer(createHandler({ catalogPath: config.catalogPath, backend: new MockBackend(config.catalogPath), modelUrl }));
  base = await listen(apiServer);
});
afterAll(() => { modelServer.close(); apiServer.close(); });
beforeEach(() => { stub.queue = []; stub.requests = []; });

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
    const d = (await chat(sid, 'my card is 4111 1111 1111 1111')).at(-1)!;
    expect(d.data.message).toMatch(/^For your safety I removed/);
    expect(JSON.stringify(stub.requests)).not.toContain('4111');
  });

  it('reports a model outage without saving half a turn', async () => {
    const sid = await session();
    stub.queue = ['fail'];
    const ev = await chat(sid, 'plan a trip to Japan');
    expect(ev).toEqual([{ event: 'error', data: expect.objectContaining({ code: 'model_unavailable' }) }]);
    expect((await (await fetch(`${base}/api/threads?sessionId=${sid}`)).json()).threads).toEqual([]);
  });

  it('keeps slow replies alive with SSE comments', async () => {
    const sid = await session();
    stub.queue = [{ content: 'Here you go.', delayMs: 150 }];
    const raw = await chatRaw(sid, 'hello');
    expect(raw).toMatch(/^: keep-alive\n\n/m);
    expect(raw).toContain('event: done');
  });

  it('drops the turn when the client disconnects mid-reply', async () => {
    const sid = await session();
    stub.queue = [{ content: 'Too late.', delayMs: 300 }];
    const ac = new AbortController();
    const pending = fetch(`${base}/api/chat`, { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, messages: [{ role: 'user', content: 'hello' }] }) }).then((r) => r.text()).catch(() => 'aborted');
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
    expect((await api.chat('hello', { threadId: 1 })).message).toBe('Hello again.');
    expect(storage.getItem('takeoff.sessionId')).not.toBe('stale-session');
  });

  it('reports backend errors with their codes', async () => {
    const api = createTakeoffApi({ baseUrl: base, storage: memory() });
    stub.queue = ['fail'];
    await expect(api.chat('plan Goa')).rejects.toMatchObject({ code: 'model_unavailable' });
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
