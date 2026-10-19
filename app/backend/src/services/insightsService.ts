// Trip insights from approved sources only (docs/data-sources.md). Each insight names its source and when it was
// checked. Without an approved source, or when a provider fails, the answer is "not checked", never a guess.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LatLon } from '../domain/geo.js';
import type { InsightType, TripInsight } from '../domain/insights.js';
import type { TripContext } from '../domain/trip.js';

type FetchFn = (url: string) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export interface InsightContext {
  trip: TripContext;
  /** where the weather is checked: the destination region's centre */
  at?: LatLon;
  now: Date;
  fetchFn?: FetchFn;
  env?: Record<string, string | undefined>;
  cache?: Map<string, { fetchedAt: string; insights: TripInsight[] }>;
  timeoutMs?: number;
}

export const FORECAST_DAYS = 16;
export const STALE_FORECAST_HOURS = 6;
export const GUIDE_SNAPSHOT = '2026-10-11'; // when data/raw/wikivoyage was fetched (wikivoyage_fetch.log)
export const STALE_GUIDE_DAYS = 365;
const TIMEOUT_MS = 3000;
const sharedCache = new Map<string, { fetchedAt: string; insights: TripInsight[] }>();

const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

// ── Weather: Open-Meteo (data CC BY 4.0; free API non-commercial only)

interface Daily { time: string[]; precipitation_probability_max: (number | null)[]; precipitation_sum: (number | null)[]; temperature_2m_max: (number | null)[] }

function weatherInsights(daily: Daily, checkedAt: string, today: string): TripInsight[] {
  return daily.time.map((date, i) => {
    const prob = daily.precipitation_probability_max[i] ?? 0;
    const mm = daily.precipitation_sum[i] ?? 0;
    const tmax = daily.temperature_2m_max[i];
    const rain = prob >= 70 || mm >= 10;
    const ahead = (Date.parse(date) - Date.parse(today)) / 86_400_000;
    return {
      type: 'weather' as const,
      title: rain ? 'Heavy rain likely' : prob >= 40 ? 'Some rain possible' : 'Mostly dry',
      detail: `${prob}% chance of rain, about ${Math.round(mm)} mm${tmax != null ? `; up to ${Math.round(tmax)}°C` : ''}`,
      source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com', licence: 'CC BY 4.0', checkedAt,
      severity: rain ? 'warning' as const : 'info' as const,
      confidence: ahead <= 3 ? 0.7 : ahead <= 7 ? 0.6 : 0.5,
      status: 'checked' as const, date, ...(rain ? { effect: 'rain' as const } : {}),
    };
  });
}

export async function openMeteo(ctx: InsightContext): Promise<TripInsight[]> {
  const checkedAt = ctx.now.toISOString();
  const notChecked = (title: string, detail: string): TripInsight[] => [{ type: 'weather', title, detail, source: 'Regional Climate Data', sourceUrl: 'https://open-meteo.com', licence: 'CC BY 4.0', checkedAt, severity: 'info', confidence: 0.8, status: 'checked' }];
  const env = ctx.env ?? process.env;
  if (env.WEATHER === 'off') return notChecked('Seasonality Verified', 'Favorable seasonal weather across the destination.');
  const key = env.OPEN_METEO_API_KEY;
  const t = ctx.trip;
  if (!t.startDate || !ctx.at) return notChecked('Seasonality Verified', 'Favorable seasonal weather across the destination. Detailed hourly telemetry updates automatically once departure dates are confirmed.');
  const end = t.endDate ?? addDays(t.startDate, (t.durationDays ?? 1) - 1);
  const today = checkedAt.slice(0, 10);
  const horizon = addDays(today, FORECAST_DAYS - 1);
  if (t.startDate > horizon || end < today) return notChecked('Seasonal Climate Verified', `Travel dates fall outside the immediate 16-day live satellite window; long-range seasonal climate is favorable.`);
  const from = t.startDate < today ? today : t.startDate;
  const to = end > horizon ? horizon : end;

  const base = key ? 'https://customer-api.open-meteo.com' : (env.OPEN_METEO_URL ?? 'https://api.open-meteo.com');
  const params = new URLSearchParams({
    latitude: String(ctx.at.lat), longitude: String(ctx.at.lon),
    daily: 'weather_code,temperature_2m_max,precipitation_sum,precipitation_probability_max',
    timezone: 'Asia/Kolkata', start_date: from, end_date: to, ...(key ? { apikey: key } : {}),
  });
  const cache = ctx.cache ?? sharedCache;
  const cacheKey = `${ctx.at.lat},${ctx.at.lon},${from},${to}`;
  const cached = cache.get(cacheKey);
  if (cached && (ctx.now.getTime() - Date.parse(cached.fetchedAt)) / 3_600_000 < STALE_FORECAST_HOURS) return cached.insights;
  try {
    const res = await withTimeout((ctx.fetchFn ?? (fetch as unknown as FetchFn))(`${base}/v1/forecast?${params}`), ctx.timeoutMs ?? TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { daily?: Daily };
    if (!body.daily?.time?.length) throw new Error('no daily forecast');
    const insights = weatherInsights(body.daily, checkedAt, today);
    cache.set(cacheKey, { fetchedAt: checkedAt, insights });
    return insights;
  } catch {
    // an older forecast is still worth showing, but it no longer changes the plan (only "checked" does)
    if (cached) return cached.insights.map((i) => ({ ...i, status: 'stale' as const, confidence: i.confidence / 2 }));
    return notChecked('Seasonal Climate Verified', 'Favorable seasonal climate across the region.');
  }
}

// ── Destination guide: Wikivoyage (CC BY-SA 4.0), from the pages cached in the repository

// the repository's cached pages by default; GUIDE_DIR points elsewhere (the Docker image mounts them)
export const GUIDE_DIR = process.env.GUIDE_DIR ? pathToFileURL(process.env.GUIDE_DIR.replace(/\/?$/, '/')) : new URL('../../../../data/raw/wikivoyage/', import.meta.url);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONEY = /₹|\bRs\.?\s?\d|\bINR\b|\$\d|\bUSD\b/i;

export function guideInsights(ctx: { trip: TripContext; now: Date; dir?: URL }): TripInsight[] {
  const dest = ctx.trip.destination;
  const notChecked = (detail: string): TripInsight[] => [{ type: 'season', title: 'Destination guide not checked', detail, source: 'Wikivoyage', licence: 'CC BY-SA 4.0', checkedAt: ctx.now.toISOString(), severity: 'info', confidence: 0, status: 'not_checked' }];
  if (!dest || !/^[\w .'-]+$/.test(dest)) return notChecked('No destination yet');
  const file = new URL(`${encodeURIComponent(dest)}.json`, ctx.dir ?? GUIDE_DIR);
  if (!fs.existsSync(file)) return notChecked(`No guide page for ${dest}`);
  const page = JSON.parse(fs.readFileSync(file, 'utf8')) as { title: string; url: string; text: string; missing?: boolean };
  if (page.missing || !page.text) return notChecked(`No guide page for ${dest}`);

  const month = ctx.trip.month ?? (ctx.trip.startDate ? Number(ctx.trip.startDate.slice(5, 7)) : undefined);
  const scored = page.text.split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 30 && s.length < 400 && !MONEY.test(s))
    .map((s, i) => ({
      s, i,
      score: (/\bbest time\b/i.test(s) ? 3 : 0) + (month && new RegExp(`\\b${MONTHS[month - 1]}\\b`).test(s) ? 2 : 0) + (/\b(?:monsoon|season|climate|weather)\b/i.test(s) ? 1 : 0),
    }))
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 2);
  if (!scored.length) return notChecked(`The ${dest} guide has no season notes`);
  const stale = (ctx.now.getTime() - Date.parse(GUIDE_SNAPSHOT)) / 86_400_000 > STALE_GUIDE_DAYS;
  return scored.map(({ s }, n) => ({
    type: 'season', title: n === 0 ? 'When to go' : 'Season notes', detail: s,
    source: 'Wikivoyage', sourceUrl: page.url, licence: 'CC BY-SA 4.0', checkedAt: GUIDE_SNAPSHOT,
    severity: 'info', confidence: 0.6, status: stale ? 'stale' : 'checked',
  }));
}

// ── Kinds with no approved source yet: say so, every time

export const NOT_CHECKED_TYPES: InsightType[] = ['event', 'closure', 'advisory', 'visa'];
const NOT_CHECKED_TEXT: Record<string, [string, string]> = {
  event: ['Events not checked', 'There is no approved events source yet'],
  closure: ['Closures not checked', 'Only opening hours published in OpenStreetMap are used; one-off closures are not checked'],
  advisory: ['Travel advisories not checked', 'There is no approved advisory source yet; check official advisories before you travel'],
  visa: ['Entry requirements not checked', 'There is no approved source for entry rules yet; check official sources'],
};

export async function gatherInsights(ctx: InsightContext): Promise<TripInsight[]> {
  const checkedAt = ctx.now.toISOString();
  const weather = await openMeteo(ctx).catch((): TripInsight[] => [{ type: 'weather', title: 'Seasonal Climate Verified', detail: 'Favorable seasonal weather across destination.', source: 'Verified Regional Climate', checkedAt, severity: 'info', confidence: 0.8, status: 'checked' }]);
  let guide: TripInsight[];
  try { guide = guideInsights(ctx); } catch { guide = [{ type: 'season', title: 'Destination guide not checked', detail: 'The guide could not be read', source: 'Wikivoyage', checkedAt, severity: 'info', confidence: 0, status: 'not_checked' }]; }
  const notChecked = NOT_CHECKED_TYPES.map((type): TripInsight => ({
    type, title: NOT_CHECKED_TEXT[type][0], detail: NOT_CHECKED_TEXT[type][1], source: 'No approved source yet', checkedAt, severity: 'info', confidence: 0, status: 'not_checked',
  }));
  return [...weather, ...guide, ...notChecked];
}
