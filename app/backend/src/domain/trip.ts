// Trip context: the facts of one trip (one chat thread), kept apart from the reusable traveler profile.

import type { TripFacts } from './extract.js';
import type { BudgetStyle, TravelStyle } from './profile.js';

export type TripStatus = 'collecting' | 'drafted';

export interface TripContext extends TripFacts {
  /** questions the planner has asked, in order (field names) */
  asked: string[];
  /** customer messages handled by the planning flow; side questions and searches don't count */
  planningTurns: number;
  status: TripStatus;
  /** revisions for this trip only; the traveller's saved profile is never changed by them */
  excludedPoiIds: string[];
  dayPace: Record<number, TravelStyle>;
  paceOverride?: TravelStyle;
  budgetStyleOverride?: BudgetStyle;
  /** interests a revision added for this trip only ("make it more adventurous") */
  addedInterests?: string[];
  itineraryVersion: number;
  updatedAt: string;
}

export function emptyTrip(): TripContext {
  return { travelerTypes: [], asked: [], planningTurns: 0, status: 'collecting', excludedPoiIds: [], dayPace: {}, itineraryVersion: 0, updatedAt: '' };
}

/** The newest message wins: customers correct themselves ("actually 3 of us"). */
export function mergeTrip(trip: TripContext, facts: TripFacts, now: string): TripContext {
  const next: TripContext = { ...trip, travelerTypes: [...trip.travelerTypes], excludedPoiIds: [...trip.excludedPoiIds], dayPace: { ...trip.dayPace } };
  // moving the trip to another month invalidates the old exact dates
  if (facts.month && !facts.startDate && next.startDate && Number(next.startDate.slice(5, 7)) !== facts.month) {
    delete next.startDate;
    delete next.endDate;
  }
  if (facts.startDate && !facts.endDate) delete next.endDate;
  for (const [key, value] of Object.entries(facts) as [keyof TripFacts, unknown][]) {
    if (key === 'travelerTypes' || value === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  for (const t of facts.travelerTypes) if (!next.travelerTypes.includes(t)) next.travelerTypes.push(t);
  next.updatedAt = now;
  return next;
}
