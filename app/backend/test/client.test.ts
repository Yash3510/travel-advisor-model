import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTakeoffApi, parseDone, parseInsights, parseItinerary, TakeoffApiError } from '../../client/takeoff-api.js';
import { buildItinerary } from '../src/services/itineraryService.js';
import { NOW, profileWith, TOWN, tripWith } from './fixtures.js';

const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const draft = json(buildItinerary({
  trip: tripWith({ destination: 'Goa', startDate: '2026-12-15', endDate: '2026-12-16', durationDays: 2, travelers: 2 }),
  profile: profileWith({ add: { interests: ['beach', 'history'] } }), insights: [], pointsOfInterest: TOWN, version: 1,
}));
const insight = { type: 'weather', title: 'Heavy rain likely', detail: '90% chance of rain', source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com', licence: 'CC BY 4.0', checkedAt: NOW, severity: 'warning', confidence: 0.7, status: 'checked', date: '2026-12-15', effect: 'rain' };
const notChecked = { type: 'event', title: 'Events not checked', detail: 'There is no approved events source yet', source: 'No approved source yet', checkedAt: NOW, severity: 'info', confidence: 0, status: 'not_checked' };
const planning = { state: 'draft_ready', action: 'draft', assumptions: ['a balanced pace'], missing: [] };

describe('parseDone', () => {
  it('keeps a complete itinerary, its insights and planning metadata exactly as sent', () => {
    const reply = parseDone(json({ message: 'Here is your plan', threadId: 3, planning, itinerary: draft, insights: [insight, notChecked] }));
    expect(reply.itinerary).toEqual(draft);
    expect(reply.itinerary!.days[0].items.some((i) => i.travelToNext?.isEstimate)).toBe(true);
    expect(reply.itinerary!.sources[0]).toMatchObject({ name: 'OpenStreetMap', attribution: '© OpenStreetMap contributors' });
    expect(reply.insights).toEqual([insight, notChecked]);
    expect(reply.planning).toEqual(planning);
  });

  it('reads the original done event exactly as before', () => {
    expect(parseDone({ message: 'Hi', threadId: 1 })).toEqual({ message: 'Hi', threadId: 1, offers: [] });
    const pendingBooking = { offer_id: 'OF-1', travelers: 2, total_price_inr: 5000 };
    expect(parseDone({ message: 'Confirm?', threadId: 1, offers: [{ offer_id: 'OF-1' }], pendingBooking })).toMatchObject({ offers: [{ offer_id: 'OF-1' }], pendingBooking });
  });

  it('fills missing optional lists so a UI can map over them, and drops shapes it cannot read', () => {
    const bare = parseItinerary({ version: 2, destination: 'Goa', confidence: 0.4, days: [{ day: 1, items: [{ kind: 'activity', block: 'morning', start: '09:00', end: '10:00', title: 'Old Fort', durationMinutes: 60, confidence: 0.4 }] }] });
    expect(bare).toMatchObject({ assumptions: [], warnings: [], alternatives: [], sources: [], rejected: [], days: [{ warnings: [], items: [{ notes: [] }] }] });
    expect(bare!.startDate).toBeUndefined();
    expect(bare!.days[0].items[0].travelToNext).toBeUndefined();
    expect(parseItinerary({ version: 1, days: 'nope' })).toBeUndefined();
    expect(parseItinerary(null)).toBeUndefined();
    expect(parseInsights([insight, { nope: 1 }, null])).toEqual([insight]);
    expect(parseInsights(undefined)).toEqual([]);
    expect(parseDone({ message: 'x', threadId: 1, itinerary: { days: 3 }, planning: 'draft' })).toEqual({ message: 'x', threadId: 1, offers: [] });
  });

  it('keeps unknown additive fields, at the top level and inside the plan', () => {
    const reply = parseDone({ message: 'x', threadId: 1, mapCards: [{ id: 1 }], itinerary: { ...draft, mapUrl: 'm' }, insights: [{ ...insight, extra: true }] });
    expect(reply.mapCards).toEqual([{ id: 1 }]);
    expect((reply.itinerary as unknown as Record<string, unknown>).mapUrl).toBe('m');
    expect(reply.insights![0]).toMatchObject({ extra: true });
  });

  it('rejects a done event without its message or thread', () => {
    expect(() => parseDone({ threadId: 1 })).toThrow(TakeoffApiError);
    expect(() => parseDone('nope')).toThrow(expect.objectContaining({ code: 'bad_response' }));
  });
});

describe('chat over a raw event stream', () => {
  // writes the reply in fragments with keep-alive comments in between, as a slow proxy might deliver it
  let server: http.Server;
  let url = '';
  const done = JSON.stringify({ message: 'Here is your plan', threadId: 7, planning, itinerary: draft, insights: [insight], mapCards: [1] });
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/api/session') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"sessionId":"s-1"}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const pieces = [': keep-alive\n\n', 'event: destination_selected\ndata: {"regionName":"Goa","regionCode":"goa"}\n\n', ': keep-alive\n\n', 'event: done\r\ndata: ', done.slice(0, 40), done.slice(40, 900), done.slice(900), '\r\n\r\n'];
      let i = 0;
      const next = () => { if (i < pieces.length) { res.write(pieces[i++]); setTimeout(next, 5); } else res.end(); };
      next();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('assembles a done event split across chunks, and keeps the additive fields', async () => {
    const m = new Map<string, string>();
    const api = createTakeoffApi({ baseUrl: url, storage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } } });
    const destinations: unknown[] = [];
    const reply = await api.chat('Plan Goa', { onDestination: (d) => destinations.push(d) });
    expect(destinations).toEqual([{ regionName: 'Goa', regionCode: 'goa' }]);
    expect(reply).toMatchObject({ message: 'Here is your plan', threadId: 7, planning, insights: [insight], mapCards: [1] });
    expect(reply.itinerary).toEqual(draft);
  });
});
