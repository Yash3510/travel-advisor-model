import { describe, expect, it, vi } from 'vitest';
import { emptyTrip, mergeTrip } from '../src/domain/trip.js';
import { gatherInsights, guideInsights, NOT_CHECKED_TYPES, openMeteo } from '../src/services/insightsService.js';

const NOW = new Date('2026-12-10T06:00:00.000Z');
const GOA = { lat: 15.35, lon: 74.0 };
const trip = (start?: string, days = 3) => mergeTrip(emptyTrip(), { destination: 'Goa', ...(start ? { startDate: start, durationDays: days } : { month: 12 }), travelerTypes: [] }, NOW.toISOString());

const forecast = (rows: [string, number, number, number][]) => ({
  ok: true,
  json: async () => ({ daily: { time: rows.map((r) => r[0]), precipitation_probability_max: rows.map((r) => r[1]), precipitation_sum: rows.map((r) => r[2]), temperature_2m_max: rows.map((r) => r[3]), weather_code: rows.map(() => 61) } }),
});

describe('Open-Meteo weather', () => {
  it('turns a daily forecast into dated insights, with rain as a warning the planner acts on', async () => {
    const fetchFn = vi.fn(async () => forecast([['2026-12-12', 90, 25, 29], ['2026-12-13', 10, 0, 31], ['2026-12-14', 20, 1, 31]]));
    const out = await openMeteo({ trip: trip('2026-12-12'), at: GOA, now: NOW, fetchFn, env: {} });
    expect(String(fetchFn.mock.calls[0][0])).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?.*latitude=15\.35.*start_date=2026-12-12.*end_date=2026-12-14/);
    expect(out[0]).toMatchObject({ type: 'weather', date: '2026-12-12', severity: 'warning', effect: 'rain', status: 'checked', source: 'Open-Meteo', licence: 'CC BY 4.0', checkedAt: NOW.toISOString() });
    expect(out[1]).toMatchObject({ date: '2026-12-13', severity: 'info', status: 'checked' });
    expect(out[1].effect).toBeUndefined();
  });

  it('does not call the service for trips beyond the 16-day forecast, or without dates', async () => {
    const fetchFn = vi.fn();
    expect(await openMeteo({ trip: trip('2027-02-01'), at: GOA, now: NOW, fetchFn, env: {} })).toEqual([expect.objectContaining({ status: 'not_checked', title: 'Weather forecast not available yet' })]);
    expect(await openMeteo({ trip: trip(), at: GOA, now: NOW, fetchFn, env: {} })).toEqual([expect.objectContaining({ status: 'not_checked' })]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('needs a paid key in production, and uses the commercial endpoint with one', async () => {
    const fetchFn = vi.fn(async () => forecast([['2026-12-12', 10, 0, 30]]));
    const prod = await openMeteo({ trip: trip('2026-12-12', 1), at: GOA, now: NOW, fetchFn, env: { NODE_ENV: 'production' } });
    expect(prod[0]).toMatchObject({ status: 'not_checked' });
    expect(prod[0].detail).toMatch(/non-commercial/);
    expect(fetchFn).not.toHaveBeenCalled();
    await openMeteo({ trip: trip('2026-12-12', 1), at: GOA, now: NOW, fetchFn, env: { NODE_ENV: 'production', OPEN_METEO_API_KEY: 'k' } });
    expect(String(fetchFn.mock.calls[0][0])).toMatch(/^https:\/\/customer-api\.open-meteo\.com\/v1\/forecast\?.*apikey=k/);
  });

  it('reports a timeout or error as not checked, and an old cached forecast as stale', async () => {
    const slow = vi.fn(() => new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5)));
    expect((await openMeteo({ trip: trip('2026-12-20', 1), at: GOA, now: NOW, fetchFn: slow, env: {} }))[0]).toMatchObject({ status: 'not_checked', detail: expect.stringMatching(/did not respond/) });

    const cache = new Map();
    const ok = vi.fn(async () => forecast([['2026-12-21', 10, 0, 30]]));
    await openMeteo({ trip: trip('2026-12-21', 1), at: GOA, now: NOW, fetchFn: ok, env: {}, cache });
    const later = new Date(NOW.getTime() + 7 * 3600_000);
    const stale = await openMeteo({ trip: trip('2026-12-21', 1), at: GOA, now: later, fetchFn: slow, env: {}, cache });
    expect(stale[0]).toMatchObject({ status: 'stale', checkedAt: NOW.toISOString() });
  });
});

describe('Wikivoyage guide', () => {
  it('gives seasonal notes for the destination with attribution, and never quotes prices', () => {
    const out = guideInsights({ trip: trip(), now: NOW });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ type: 'season', source: 'Wikivoyage', licence: 'CC BY-SA 4.0', sourceUrl: 'https://en.wikivoyage.org/wiki/Goa', checkedAt: '2026-10-11', status: 'checked' });
    expect(out[0].detail).toMatch(/best time/i);
    expect(out.every((i) => !/₹|\bRs\.?\s?\d/.test(i.detail))).toBe(true);
  });
  it('says not checked for places without a guide page, and stale once the snapshot is a year old', () => {
    expect(guideInsights({ trip: mergeTrip(emptyTrip(), { destination: 'Xyzabad', travelerTypes: [] }, NOW.toISOString()), now: NOW })[0]).toMatchObject({ status: 'not_checked' });
    expect(guideInsights({ trip: trip(), now: new Date('2027-11-01T00:00:00Z') })[0].status).toBe('stale');
  });
});

describe('gatherInsights', () => {
  it('reports every unsupported kind as not checked, and every insight names a source and a time', async () => {
    const out = await gatherInsights({ trip: trip('2026-12-12'), at: GOA, now: NOW, fetchFn: vi.fn(async () => forecast([['2026-12-12', 10, 0, 30], ['2026-12-13', 10, 0, 30], ['2026-12-14', 10, 0, 30]])), env: {} });
    for (const type of NOT_CHECKED_TYPES) expect(out).toContainEqual(expect.objectContaining({ type, status: 'not_checked' }));
    expect(out.every((i) => i.source && i.checkedAt)).toBe(true);
    expect(out.filter((i) => i.status === 'not_checked').every((i) => i.confidence === 0 && !i.effect)).toBe(true);
  });
});
