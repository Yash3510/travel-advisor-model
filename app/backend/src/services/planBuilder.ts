// The deterministic part of planning, shared by the chat route and the scenario runner: this trip's
// revisions over the saved profile, then build, then validate and repair.

import type { TripInsight } from '../domain/insights.js';
import type { ItineraryDraft } from '../domain/itinerary.js';
import type { PointOfInterest } from '../domain/poi.js';
import type { TravelerProfile } from '../domain/profile.js';
import type { TripContext } from '../domain/trip.js';
import { buildItinerary } from './itineraryService.js';
import { repairItinerary } from './itineraryValidator.js';

/** "Make it cheaper" or "slower" apply to this trip only; the saved profile stays as it is. */
export const forThisTrip = (p: TravelerProfile, t: TripContext): TravelerProfile => ({
  ...p, ...(t.paceOverride ? { travelStyle: t.paceOverride } : {}), ...(t.budgetStyleOverride ? { budgetStyle: t.budgetStyleOverride } : {}),
});

export function buildCheckedPlan(i: { trip: TripContext; profile: TravelerProfile; insights: TripInsight[]; pois: PointOfInterest[] }): { draft: ItineraryDraft; profile: TravelerProfile } {
  const profile = forThisTrip(i.profile, i.trip);
  const built = buildItinerary({ trip: i.trip, profile, insights: i.insights, pointsOfInterest: i.pois, version: i.trip.itineraryVersion + 1, excluded: i.trip.excludedPoiIds, dayPace: i.trip.dayPace });
  const { draft } = repairItinerary(built, { pois: new Map(i.pois.map((x) => [x.id, x])), trip: i.trip, profile, insights: i.insights, dayPace: i.trip.dayPace });
  return { draft, profile };
}
