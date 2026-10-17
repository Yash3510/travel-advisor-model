import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTravel } from '../src/services/constraints.js';
import { ESTIMATE_SOURCE, osrmProvider, travelTimeProvider, UNAVAILABLE_SOURCE, withCache } from '../src/services/travelTime.js';

const A = { lat: 15.5, lon: 73.8 };
const B = { lat: 15.6, lon: 73.9 };
const C = { lat: 15.4, lon: 73.85 };
const NOW = () => new Date('2026-10-18T10:00:00.000Z');
const estimate = estimateTravel(A, B);

const hang = () => new Promise<never>(() => {});
type Reply = { status: number; body: unknown };
const fetchReturning = (reply: Reply, calls: string[] = []) => async (url: string) => {
  calls.push(url);
  return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
};

describe('OSRM provider', () => {
  // a local server that speaks the OSRM route contract, so the real fetch path runs without the network
  let server: http.Server;
  let url = '';
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 'Ok', routes: [{ duration: 1260.4, distance: 15234.5, legs: [] }], waypoints: [] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('returns the road time, plus a fixed buffer, with its source and confidence', async () => {
    const r = await osrmProvider({ url, now: NOW }).estimate(A, B);
    expect(seen[0]).toBe('/route/v1/driving/73.8,15.5;73.9,15.6?overview=false');
    expect(r).toEqual({ minutes: 31, distanceKm: 15.2, mode: 'road', source: 'OSRM', checkedAt: '2026-10-18T10:00:00.000Z', confidence: 0.8, isEstimate: false });
  });

  it('falls back to a labelled estimate on a malformed response', async () => {
    for (const body of [{ code: 'Ok', routes: [] }, { code: 'Ok', routes: [{ duration: '600', distance: 100 }] }, { code: 'Ok', routes: [{ duration: -5, distance: 100 }] }, null, 'nope']) {
      const r = await osrmProvider({ url: 'http://osrm.test', fetchFn: fetchReturning({ status: 200, body }), now: NOW }).estimate(A, B);
      expect(r).toEqual({ minutes: estimate.minutes, distanceKm: estimate.km, mode: 'estimate', source: UNAVAILABLE_SOURCE, checkedAt: '2026-10-18T10:00:00.000Z', confidence: 0.5, isEstimate: true });
    }
  });

  it('gives up after the timeout and uses the estimate', async () => {
    const errors: string[] = [];
    const started = Date.now();
    const r = await osrmProvider({ url: 'http://osrm.test', fetchFn: hang, timeoutMs: 50, onError: (e) => errors.push(e.message) }).estimate(A, B);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r).toMatchObject({ mode: 'estimate', isEstimate: true, source: UNAVAILABLE_SOURCE });
    expect(errors).toEqual(['timeout']);
  });

  it('stops asking a failing server for the rest of the plan', async () => {
    const calls: string[] = [];
    const p = osrmProvider({ url: 'http://osrm.test', fetchFn: fetchReturning({ status: 503, body: {} }, calls) });
    expect(await p.estimate(A, B)).toMatchObject({ isEstimate: true, source: UNAVAILABLE_SOURCE });
    expect(await p.estimate(B, C)).toMatchObject({ isEstimate: true, source: UNAVAILABLE_SOURCE });
    expect(calls).toHaveLength(1);
  });

  it('treats "no route" as a fact about one pair, not a broken server', async () => {
    const calls: string[] = [];
    const p = osrmProvider({ url: 'http://osrm.test', fetchFn: fetchReturning({ status: 400, body: { code: 'NoRoute', message: 'Impossible route between points' } }, calls) });
    expect(await p.estimate(A, B)).toMatchObject({ isEstimate: true });
    await p.estimate(B, C);
    expect(calls).toHaveLength(2);
  });
});

describe('travelTimeProvider', () => {
  it('uses the straight-line estimate when no routing server is configured', async () => {
    const calls: string[] = [];
    const r = await travelTimeProvider({ url: '', fetchFn: fetchReturning({ status: 200, body: {} }, calls), now: NOW }).estimate(A, B);
    expect(r).toMatchObject({ minutes: estimate.minutes, mode: 'estimate', source: ESTIMATE_SOURCE, isEstimate: true });
    expect(calls).toEqual([]);
  });

  it('refuses the public OSRM demo server in production', async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const p = travelTimeProvider({ url: 'https://router.project-osrm.org', production: true, fetchFn: fetchReturning({ status: 200, body: {} }, calls), onError: (e) => errors.push(e.message) });
    expect(await p.estimate(A, B)).toMatchObject({ isEstimate: true, source: UNAVAILABLE_SOURCE });
    expect(calls).toEqual([]);
    expect(errors[0]).toMatch(/demo server/);
  });

  it('asks the server once per pair within a plan, even for simultaneous requests', async () => {
    const calls: string[] = [];
    const ok = { status: 200, body: { code: 'Ok', routes: [{ duration: 600, distance: 5000 }] } };
    const p = withCache(osrmProvider({ url: 'http://osrm.test', fetchFn: fetchReturning(ok, calls) }));
    const [x, y] = await Promise.all([p.estimate(A, B), p.estimate(A, B)]);
    await p.estimate(A, B);
    expect(x).toEqual(y);
    expect(calls).toHaveLength(1);
    await p.estimate(B, A); // road times can differ by direction
    expect(calls).toHaveLength(2);
  });
});
