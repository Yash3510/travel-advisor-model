// A day-by-day plan built by code from structured data. It is the source of truth: the model only phrases it.

export type Block = 'morning' | 'afternoon' | 'evening';

export interface ItineraryItem {
  kind: 'activity' | 'meal' | 'rest';
  block: Block;
  start: string; // "HH:MM"
  end: string;
  title: string;
  poiId?: string;
  coordinates?: { lat: number; lng: number };
  durationMinutes: number;
  /** visit lengths are typical times for the kind of place (OSM has none) */
  durationBasis?: 'category_default' | 'fixed';
  /** to the next activity of the day */
  travelToNext?: TravelLeg;
  /** "open": checked against published hours; "unknown": no hours published */
  hours?: 'open' | 'unknown';
  costInr?: number;
  costBasis?: 'osm_charge';
  why?: { matched: string[]; tradeoffs: string[] };
  notes: string[];
  /** meal blocks: places that match the traveller's diet */
  suggestions?: { poiId: string; name: string; diet: string[] }[];
  source?: { name: string; url: string; licence: string; attribution: string };
  confidence: number;
}

/** A road time from the routing provider, or a straight-line estimate that says it is one. */
export interface TravelLeg { minutes: number; km: number; basis: 'road' | 'straight_line_estimate'; source: string; isEstimate: boolean; confidence: number }

export interface ItineraryDay { day: number; date?: string; items: ItineraryItem[]; warnings: string[] }

export interface ItineraryAlternative { kind: 'cheaper' | 'more_relaxed' | 'more_adventurous'; summary: string; changes: string[] }

export interface ItinerarySource { name: string; licence?: string; attribution: string; url?: string }

export interface ItineraryDraft {
  version: number;
  destination: string;
  startDate?: string;
  days: ItineraryDay[];
  totalEstimatedCostInr?: number;
  assumptions: string[];
  warnings: string[];
  alternatives: ItineraryAlternative[];
  confidence: number;
  sources: ItinerarySource[];
  /** places the planner considered and left out, with the reason; the presentation must never offer them */
  rejected: { poiId: string; name: string; reason: string }[];
}

export const toClock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const fromClock = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const blockOf = (minutes: number): Block => (minutes < 13 * 60 ? 'morning' : minutes < 18 * 60 ? 'afternoon' : 'evening');
