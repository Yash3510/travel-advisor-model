// Trip context: the facts of one trip (one chat thread), kept apart from the reusable traveler profile.

import type { TripFacts } from './extract.js';

export type TripStatus = 'collecting' | 'drafted';

export interface TripContext extends TripFacts {
  /** questions the planner has asked, in order (field names) */
  asked: string[];
  /** customer messages handled by the planning flow; side questions and searches don't count */
  planningTurns: number;
  status: TripStatus;
  updatedAt: string;
}

export function emptyTrip(): TripContext {
  return { travelerTypes: [], asked: [], planningTurns: 0, status: 'collecting', updatedAt: '' };
}

/** The newest message wins: customers correct themselves ("actually 3 of us"). */
export function mergeTrip(trip: TripContext, facts: TripFacts, now: string): TripContext {
  const next: TripContext = { ...trip, travelerTypes: [...trip.travelerTypes] };
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
