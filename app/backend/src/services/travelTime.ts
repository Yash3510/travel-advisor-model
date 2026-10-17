// Travel time between two stops, behind one interface. With ROUTING_URL set, a self-hosted OSRM server gives road
// times; without it, or when the server fails, the straight-line estimate is used and labelled as an estimate
// (docs/data-sources.md). The public OSRM demo server is never used in production: its terms forbid it.

import type { LatLon } from '../domain/geo.js';
import type { TravelLeg } from '../domain/itinerary.js';
import { BUFFER_MIN, ESTIMATE_SOURCE, estimateTravel, UNAVAILABLE_SOURCE } from './constraints.js';

export type Coordinates = LatLon;

export interface TravelTimeResult {
  minutes: number;
  distanceKm: number;
  mode: 'road' | 'estimate';
  source: string;
  checkedAt: string;
  confidence: number;
  isEstimate: boolean;
}

export interface TravelTimeProvider {
  estimate(from: Coordinates, to: Coordinates): Promise<TravelTimeResult>;
}

type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export { ESTIMATE_SOURCE, UNAVAILABLE_SOURCE };
export const ROAD_SOURCE = 'OSRM';
export const ROAD_CONFIDENCE = 0.8;
const TIMEOUT_MS = 2000;
// OSRM answers these for one pair of points (an island, a point far from any road); the server itself is fine
const PAIR_ERRORS = ['NoRoute', 'NoSegment'];
const DEMO_HOST = /(^|\.)project-osrm\.org$/i;

const isMinutes = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function estimateProvider(o: { now?: () => Date; source?: string } = {}): TravelTimeProvider {
  return {
    async estimate(a, b) {
      const e = estimateTravel(a, b);
      return { minutes: e.minutes, distanceKm: e.km, mode: 'estimate', source: o.source ?? ESTIMATE_SOURCE, checkedAt: (o.now ?? (() => new Date()))().toISOString(), confidence: e.confidence, isEstimate: true };
    },
  };
}

export function osrmProvider(o: { url: string; fetchFn?: FetchFn; timeoutMs?: number; now?: () => Date; onError?: (err: Error) => void }): TravelTimeProvider {
  const base = o.url.replace(/\/+$/, '');
  const now = o.now ?? (() => new Date());
  const fallback = estimateProvider({ now, source: UNAVAILABLE_SOURCE });
  const fetchFn = o.fetchFn ?? (fetch as unknown as FetchFn);
  // after one failure the rest of this plan uses the estimate, so a dead server costs one timeout, not one per leg
  let down = false;

  async function route(a: Coordinates, b: Coordinates): Promise<TravelTimeResult | undefined> {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, o.timeoutMs ?? TIMEOUT_MS);
    });
    try {
      const res = await Promise.race([fetchFn(`${base}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`, { signal: ctrl.signal }), timeout]);
      const body = (await Promise.race([res.json(), timeout]).catch(() => undefined)) as { code?: unknown; routes?: { duration?: unknown; distance?: unknown }[] } | null | undefined;
      const code = body && typeof body === 'object' ? body.code : undefined;
      if (!res.ok && typeof code === 'string' && PAIR_ERRORS.includes(code)) return undefined;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = code === 'Ok' && Array.isArray(body?.routes) ? body.routes[0] : undefined;
      if (!r || !isMinutes(r.duration) || !isMinutes(r.distance)) throw new Error(`unexpected response (code ${String(code)})`);
      return {
        minutes: Math.round(r.duration / 60) + BUFFER_MIN, distanceKm: Math.round(r.distance / 100) / 10, mode: 'road',
        source: ROAD_SOURCE, checkedAt: now().toISOString(), confidence: ROAD_CONFIDENCE, isEstimate: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async estimate(a, b) {
      if (down) return fallback.estimate(a, b);
      try {
        return (await route(a, b)) ?? (await fallback.estimate(a, b));
      } catch (err) {
        // legs are asked in parallel, so report the outage once
        if (!down) o.onError?.(err instanceof Error ? err : new Error(String(err)));
        down = true;
        return fallback.estimate(a, b);
      }
    },
  };
}

/** One answer per directed pair for the life of the provider (one planning request); road times can differ by direction. */
export function withCache(p: TravelTimeProvider): TravelTimeProvider {
  const cache = new Map<string, Promise<TravelTimeResult>>();
  return {
    estimate(a, b) {
      const key = `${a.lat},${a.lon};${b.lat},${b.lon}`;
      let hit = cache.get(key);
      if (!hit) { hit = p.estimate(a, b); cache.set(key, hit); }
      return hit;
    },
  };
}

/** The provider for one planning request: OSRM when ROUTING_URL is set, else the estimate. */
export function travelTimeProvider(o: { url?: string; production?: boolean; timeoutMs?: number; fetchFn?: FetchFn; now?: () => Date; onError?: (err: Error) => void }): TravelTimeProvider {
  if (!o.url) return withCache(estimateProvider({ now: o.now }));
  let host = '';
  try { host = new URL(o.url).hostname; } catch { /* checked below */ }
  if (!host || (o.production && DEMO_HOST.test(host))) {
    o.onError?.(new Error(host ? 'the public OSRM demo server is not for production use; set ROUTING_URL to a self-hosted server' : `ROUTING_URL is not a valid URL`));
    return withCache(estimateProvider({ now: o.now, source: UNAVAILABLE_SOURCE }));
  }
  return withCache(osrmProvider({ url: o.url, fetchFn: o.fetchFn, timeoutMs: o.timeoutMs, now: o.now, onError: o.onError }));
}

/** A provider's answer as the leg stored on an itinerary item. */
export const toLeg = (r: TravelTimeResult): TravelLeg => ({
  minutes: r.minutes, km: r.distanceKm, basis: r.mode === 'road' ? 'road' : 'straight_line_estimate', source: r.source, isEstimate: r.isEstimate, confidence: r.confidence,
});
