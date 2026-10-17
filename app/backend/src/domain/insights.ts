// Facts about the trip from outside providers (weather, guide, closures, advisories…). Every insight names its
// source and when it was checked; a provider with no approved source returns status "not_checked", never a guess.

export type InsightType = 'weather' | 'season' | 'guide' | 'event' | 'closure' | 'travel_time' | 'price' | 'advisory' | 'visa';

export interface TripInsight {
  type: InsightType;
  title: string;
  detail: string;
  source: string;
  sourceUrl?: string;
  licence?: string;
  checkedAt: string;
  severity: 'info' | 'warning' | 'blocking';
  confidence: number;
  status: 'checked' | 'not_checked' | 'stale';
  /** the trip date it applies to, for day-specific insights */
  date?: string;
  /** the place it applies to, for closures */
  poiId?: string;
  /** what the planner must do about it */
  effect?: 'rain' | 'closed';
}
