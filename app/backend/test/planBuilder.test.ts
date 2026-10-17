import { describe, expect, it } from 'vitest';
import { fromClock, type ItineraryDraft } from '../src/domain/itinerary.js';
import { estimateTravel } from '../src/services/constraints.js';
import { TRAVEL_ESTIMATE_WARNING, TRAVEL_UNAVAILABLE_WARNING } from '../src/services/itineraryValidator.js';
import { buildCheckedPlan, forThisTrip } from '../src/services/planBuilder.js';
import { osrmProvider, UNAVAILABLE_SOURCE, type TravelTimeProvider } from '../src/services/travelTime.js';
import { NOW, profileWith, TOWN, tripWith } from './fixtures.js';

const trip = tripWith({ destination: 'Goa', startDate: '2026-12-15', endDate: '2026-12-17', durationDays: 3, travelers: 2 });
const profile = profileWith({ set: { travelStyle: 'packed' }, add: { interests: ['history', 'beach', 'food'] } });
const plan = (travel?: TravelTimeProvider) => buildCheckedPlan({ trip, profile, insights: [], pois: TOWN, ...(travel ? { travel } : {}) });

const legsOf = (d: ItineraryDraft) => d.days.flatMap((day) => day.items.filter((i) => i.kind === 'activity')).flatMap((a) => (a.travelToNext ? [a.travelToNext] : []));
const gapsRespected = (d: ItineraryDraft) => d.days.every((day) => {
  const acts = day.items.filter((i) => i.kind === 'activity');
  return acts.every((a, i) => i === 0 || fromClock(a.start) - fromClock(acts[i - 1].end) >= acts[i - 1].travelToNext!.minutes);
});

describe('forThisTrip', () => {
  it('adds interests from a revision for this trip only, as if the traveller had said them', () => {
    const saved = profileWith({ add: { interests: ['beach'] } });
    const p = forThisTrip(saved, { ...tripWith({}), paceOverride: 'packed', addedInterests: ['adventure', 'beach', 'nature'] });
    expect(p).toMatchObject({ travelStyle: 'packed', interests: ['beach', 'adventure', 'nature'], sourceByField: { 'interests:adventure': 'explicit', 'interests:nature': 'explicit' } });
    expect(saved.interests).toEqual(['beach']);
  });
});

describe('buildCheckedPlan with a routing provider', () => {
  it('asks the provider only for the legs in the plan, and schedules around the road times', async () => {
    const asked: string[] = [];
    // roads slower than the estimate, so stops have to move
    const road: TravelTimeProvider = {
      async estimate(a, b) {
        asked.push(`${a.lat},${a.lon};${b.lat},${b.lon}`);
        const e = estimateTravel(a, b);
        return { minutes: e.minutes + 20, distanceKm: e.km, mode: 'road', source: 'OSRM', checkedAt: NOW, confidence: 0.8, isEstimate: false };
      },
    };
    const { draft } = await plan(road);
    const legs = legsOf(draft);
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((l) => l.basis === 'road' && !l.isEstimate && l.source === 'OSRM')).toBe(true);
    expect(gapsRespected(draft)).toBe(true);
    // replanned with the road times, not patched by dropping stops that no longer fit
    expect(draft.days.flatMap((d) => d.warnings).filter((w) => /can't be reached in time/.test(w))).toEqual([]);
    expect(draft.warnings).not.toContain(TRAVEL_ESTIMATE_WARNING);
    expect(asked.length).toBeLessThan(TOWN.length * 2); // the plan's legs, not every pair of places
  });

  it('falls back to labelled estimates, with a warning, when routing fails', async () => {
    const failing = osrmProvider({ url: 'http://osrm.test', fetchFn: async () => { throw new Error('connect ECONNREFUSED'); } });
    const { draft } = await plan(failing);
    expect(legsOf(draft).every((l) => l.isEstimate && l.source === UNAVAILABLE_SOURCE)).toBe(true);
    expect(draft.warnings).toContain(TRAVEL_UNAVAILABLE_WARNING);
    expect(gapsRespected(draft)).toBe(true);
  });

  it('says the times are estimates when no routing server is configured', async () => {
    const { draft } = await plan();
    expect(legsOf(draft).every((l) => l.basis === 'straight_line_estimate' && l.isEstimate)).toBe(true);
    expect(draft.warnings).toContain(TRAVEL_ESTIMATE_WARNING);
  });
});
