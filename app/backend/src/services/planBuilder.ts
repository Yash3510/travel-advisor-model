// The deterministic part of planning, shared by the chat route and the scenario runner: this trip's
// revisions over the saved profile, then build, then validate and repair.

import type { LatLon } from '../domain/geo.js';
import type { TripInsight } from '../domain/insights.js';
import type { ItineraryDraft, TravelLeg } from '../domain/itinerary.js';
import type { PointOfInterest } from '../domain/poi.js';
import { withInterests, type TravelerProfile } from '../domain/profile.js';
import type { TripContext } from '../domain/trip.js';
import { estimateTravel, type TravelLookup } from './constraints.js';
import { buildItinerary, type ItineraryRequest } from './itineraryService.js';
import { repairItinerary } from './itineraryValidator.js';
import { toLeg, travelTimeProvider, type TravelTimeProvider } from './travelTime.js';

/** "Make it cheaper", "slower" or "more adventurous" apply to this trip only; the saved profile stays as it is. */
export const forThisTrip = (p: TravelerProfile, t: TripContext): TravelerProfile => withInterests({
  ...p, ...(t.paceOverride ? { travelStyle: t.paceOverride } : {}), ...(t.budgetStyleOverride ? { budgetStyle: t.budgetStyleOverride } : {}),
}, t.addedInterests ?? []);

/** Rounds of "ask the provider about the plan's legs, then plan again with the answers". */
const ROUTING_ROUNDS = 3;
const pairKey = (a: LatLon, b: LatLon) => `${a.lat},${a.lon};${b.lat},${b.lon}`;

function legPairs(d: ItineraryDraft, pois: Map<string, PointOfInterest>): [LatLon, LatLon][] {
  return d.days.flatMap((day) => {
    const stops = day.items.flatMap((i) => (i.kind === 'activity' && i.poiId && pois.has(i.poiId) ? [pois.get(i.poiId)!.location] : []));
    return stops.slice(1).map((to, n): [LatLon, LatLon] => [stops[n], to]);
  });
}

export async function buildCheckedPlan(i: { trip: TripContext; profile: TravelerProfile; insights: TripInsight[]; pois: PointOfInterest[]; travel?: TravelTimeProvider }): Promise<{ draft: ItineraryDraft; profile: TravelerProfile }> {
  const profile = forThisTrip(i.profile, i.trip);
  const pois = new Map(i.pois.map((x) => [x.id, x]));
  const provider = i.travel ?? travelTimeProvider({});
  // the search compares many pairs of places, so it uses the estimate; only the legs a plan actually uses are asked
  // of the provider, and the plan is rebuilt with those answers until its legs are all known
  const known = new Map<string, TravelLeg>();
  const travel: TravelLookup = (a, b) => known.get(pairKey(a, b)) ?? estimateTravel(a, b);
  const req: ItineraryRequest = { trip: i.trip, profile, insights: i.insights, pointsOfInterest: i.pois, version: i.trip.itineraryVersion + 1, excluded: i.trip.excludedPoiIds, dayPace: i.trip.dayPace, travel };
  let built = buildItinerary(req);
  for (let round = 0; round < ROUTING_ROUNDS; round++) {
    const missing = legPairs(built, pois).filter(([a, b]) => !known.has(pairKey(a, b)));
    if (!missing.length) break;
    const answers = await Promise.all(missing.map(([a, b]) => provider.estimate(a, b)));
    let moved = false;
    missing.forEach(([a, b], n) => {
      const leg = toLeg(answers[n]);
      known.set(pairKey(a, b), leg);
      moved ||= leg.minutes !== estimateTravel(a, b).minutes;
    });
    // the last answers are still checked below; replanning only helps when a time actually changed
    if (!moved || round === ROUTING_ROUNDS - 1) break;
    built = buildItinerary(req);
  }
  const { draft } = repairItinerary(built, { pois, trip: i.trip, profile, insights: i.insights, dayPace: i.trip.dayPace, travel });
  return { draft, profile };
}
