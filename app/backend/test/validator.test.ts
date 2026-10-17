import { describe, expect, it } from 'vitest';
import { fromClock, type ItineraryDraft } from '../src/domain/itinerary.js';
import type { PointOfInterest } from '../src/domain/poi.js';
import { buildItinerary } from '../src/services/itineraryService.js';
import { MAX_LEG_MINUTES, type TravelLookup } from '../src/services/constraints.js';
import { repairItinerary, TRAVEL_ESTIMATE_WARNING, validateItinerary, type ValidationContext } from '../src/services/itineraryValidator.js';
import { poi, profileWith, TOWN, tripWith } from './fixtures.js';

const FAR = poi({ id: 'osm:node/50', name: 'Distant Falls', category: 'waterfall', interests: ['nature'], indoor: false, location: { lat: 14.2, lon: 74.4 } });
const PLACES: PointOfInterest[] = [...TOWN, FAR];

function setup(opts: { relaxed?: boolean; wheelchair?: boolean; startDate?: string } = {}) {
  const profile = profileWith({ set: { travelStyle: opts.relaxed ? 'relaxed' : 'packed' }, add: { interests: ['history', 'beach'], ...(opts.wheelchair ? { mobilityNeeds: ['wheelchair'] } : {}) } });
  const startDate = opts.startDate ?? '2026-12-15'; // a Tuesday
  const trip = tripWith({ destination: 'Goa', startDate, endDate: startDate.replace(/\d{2}$/, (d) => String(Number(d) + 1).padStart(2, '0')), durationDays: 2, travelers: 2 });
  const draft = buildItinerary({ trip, profile, insights: [], pointsOfInterest: PLACES, version: 1, withAlternatives: false });
  const ctx: ValidationContext = { pois: new Map(PLACES.map((p) => [p.id, p])), trip, profile, insights: [] };
  return { draft, ctx };
}

const clone = (d: ItineraryDraft): ItineraryDraft => structuredClone(d);
const acts = (d: ItineraryDraft, day = 0) => d.days[day].items.filter((i) => i.kind === 'activity');
const codes = (d: ItineraryDraft, ctx: ValidationContext) => validateItinerary(d, ctx).map((p) => p.code);

describe('validateItinerary', () => {
  it('accepts what the engine builds', () => {
    const { draft, ctx } = setup();
    expect(validateItinerary(draft, ctx)).toEqual([]);
    expect(validateItinerary(setup({ relaxed: true }).draft, setup({ relaxed: true }).ctx)).toEqual([]);
  });

  it('catches overlaps, bad dates and impossible travel', () => {
    const { draft, ctx } = setup();
    const overlap = clone(draft);
    const [a, b] = acts(overlap);
    b.start = a.start;
    expect(codes(overlap, ctx)).toContain('overlap');

    const badDate = clone(draft);
    badDate.days[1].date = '2026-02-30';
    expect(codes(badDate, ctx)).toContain('invalid_date');

    const far = clone(draft);
    Object.assign(acts(far)[1], { poiId: FAR.id, title: FAR.name });
    expect(codes(far, ctx)).toContain('impossible_travel');
  });

  it('catches closed places, missing access, duplicates and invented places', () => {
    const monday = setup({ startDate: '2026-12-14' });
    const closed = clone(monday.draft);
    Object.assign(acts(closed)[0], { poiId: 'osm:node/4', title: 'Town Museum', hours: 'open' });
    expect(codes(closed, monday.ctx)).toContain('closed');

    const wc = setup({ wheelchair: true });
    const noAccess = clone(wc.draft);
    Object.assign(acts(noAccess)[0], { poiId: 'osm:node/6', title: 'Club Neon' });
    expect(codes(noAccess, wc.ctx)).toContain('access');

    const { draft, ctx } = setup();
    const dup = clone(draft);
    Object.assign(acts(dup, 1)[0], { poiId: acts(dup, 0)[0].poiId, title: acts(dup, 0)[0].title });
    expect(codes(dup, ctx)).toContain('duplicate');

    const invented = clone(draft);
    Object.assign(acts(invented)[0], { poiId: 'osm:node/999', title: 'Imaginary Palace' });
    expect(codes(invented, ctx)).toContain('unknown_place');
  });

  it('catches unsupported hours and prices, wrong totals and too many stops for a relaxed pace', () => {
    const { draft, ctx } = setup();
    const claims = clone(draft);
    const beach = claims.days.flatMap((d) => d.items).find((i) => i.title.endsWith('Beach'))!;
    beach.hours = 'open'; // no published hours for beaches
    beach.costInr = 999;
    expect(codes(claims, ctx)).toEqual(expect.arrayContaining(['unsupported_hours', 'unsupported_price']));

    const total = clone(draft);
    total.totalEstimatedCostInr = 12345;
    expect(codes(total, ctx)).toContain('budget_total');

    const relaxed = setup({ relaxed: true });
    const dense = clone(setup().draft); // a packed day, checked against a relaxed traveller
    expect(acts(dense).length).toBeGreaterThan(3);
    expect(codes(dense, relaxed.ctx)).toContain('too_dense');
  });
});

describe('repairItinerary', () => {
  it('repairs deterministically into a valid plan and says what changed', () => {
    const { draft, ctx } = setup();
    const broken = clone(draft);
    const [a, b] = acts(broken);
    b.start = a.start;
    broken.days[1].date = '2026-02-30';
    broken.totalEstimatedCostInr = 1;
    const fixed = repairItinerary(broken, ctx);
    expect(validateItinerary(fixed.draft, ctx)).toEqual([]);
    expect(fixed.repaired.length).toBeGreaterThan(0);
    expect(fixed.draft.days[1].date).toBe('2026-12-16');
    expect(repairItinerary(broken, ctx)).toEqual(fixed);
    expect(repairItinerary(fixed.draft, ctx).draft).toEqual(fixed.draft); // idempotent
  });

  it('keeps the rest of the plan and recomputes travel when a stop is removed', () => {
    const { draft, ctx } = setup();
    const broken = clone(draft);
    Object.assign(acts(broken)[1], { poiId: 'osm:node/999', title: 'Imaginary Palace' });
    const fixed = repairItinerary(broken, ctx).draft;
    expect(acts(fixed).map((x) => x.title)).not.toContain('Imaginary Palace');
    expect(acts(fixed).length).toBe(acts(draft).length - 1);
    expect(validateItinerary(fixed, ctx)).toEqual([]);
  });

  it('returns a partial plan with warnings when a day cannot be saved', () => {
    const { draft, ctx } = setup();
    const broken = clone(draft);
    for (const item of acts(broken)) Object.assign(item, { poiId: 'osm:node/999', title: 'Imaginary Palace' });
    const fixed = repairItinerary(broken, ctx).draft;
    expect(acts(fixed)).toEqual([]);
    expect(fixed.days[0].warnings.join(' ')).toMatch(/could not be planned/);
    expect(validateItinerary(fixed, ctx)).toEqual([]);
  });
});

const road = (minutes: number): TravelLookup => () => ({ minutes, km: 3, basis: 'road', source: 'OSRM', isEstimate: false, confidence: 0.8 });

describe('travel times from the routing provider', () => {

  it('accepts realistic road times and rejects legs that do not fit the schedule', () => {
    const { draft, ctx } = setup();
    const [a, b] = acts(draft);
    expect(codes(draft, { ...ctx, travel: road(10) })).not.toContain('impossible_travel');
    expect(codes(draft, { ...ctx, travel: road(fromClock(b.start) - fromClock(a.end) + 15) })).toContain('impossible_travel');
    expect(codes(draft, { ...ctx, travel: road(MAX_LEG_MINUTES + 1) })).toContain('impossible_travel');
  });

  it('labels every leg with its source, uses its confidence, and warns when legs are only estimates', () => {
    const { draft, ctx } = setup();
    const estimated = repairItinerary(draft, ctx).draft;
    expect(estimated.warnings).toContain(TRAVEL_ESTIMATE_WARNING);
    expect(acts(estimated)[0].travelToNext).toMatchObject({ basis: 'straight_line_estimate', source: 'Straight-line estimate', isEstimate: true, confidence: 0.5 });

    const routed = repairItinerary(draft, { ...ctx, travel: road(10) }).draft;
    expect(routed.warnings).not.toContain(TRAVEL_ESTIMATE_WARNING);
    expect(acts(routed)[0].travelToNext).toEqual({ minutes: 10, km: 3, basis: 'road', source: 'OSRM', isEstimate: false, confidence: 0.8 });
    expect(routed.assumptions).toEqual(expect.arrayContaining([expect.stringMatching(/^Travel times are road times from OSRM/)]));
    expect(routed.assumptions.some((a) => /straight-line/.test(a))).toBe(false);
    expect(routed.sources.map((s) => s.name)).toContain('OSRM');
    expect(routed.confidence).toBeGreaterThan(estimated.confidence);
    expect(repairItinerary(routed, { ...ctx, travel: road(10) }).draft).toEqual(routed);
  });
});
