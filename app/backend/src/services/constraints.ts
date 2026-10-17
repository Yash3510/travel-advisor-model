// The rules a schedule must respect: travel time, opening hours, the day's time budget, breaks, access needs,
// dislikes, and weather or closure blocks. Pure functions, so the planner and the validator share them.

import type { LatLon } from '../domain/geo.js';
import { haversineKm } from '../domain/geo.js';
import type { TripInsight } from '../domain/insights.js';
import type { TravelLeg } from '../domain/itinerary.js';
import { isOpen } from '../domain/openingHours.js';
import type { PoiCategory, PointOfInterest } from '../domain/poi.js';
import type { TravelerProfile, TravelStyle } from '../domain/profile.js';

// ── Travel time. The planner searches with this straight-line estimate; the legs that end up in a plan are then
// asked of the routing provider (travelTime.ts), and anything it can't answer stays a labelled estimate.
const ROAD_FACTOR = 1.35;
const LOCAL_KMH = 25;
const LONG_KMH = 40;
const LOCAL_KM = 15;
export const BUFFER_MIN = 10;
/** A single transfer longer than this does not fit inside a day of sightseeing. */
export const MAX_LEG_MINUTES = 120;
export const ESTIMATE_SOURCE = 'Straight-line estimate';
export const UNAVAILABLE_SOURCE = 'Straight-line estimate (road routing unavailable)';
export const ESTIMATE_CONFIDENCE = 0.5;

export type TravelEstimate = TravelLeg;
/** Travel time between two stops, answered synchronously from what is already known. */
export type TravelLookup = (a: LatLon, b: LatLon) => TravelLeg;

export function estimateTravel(a: LatLon, b: LatLon): TravelLeg {
  const road = haversineKm(a, b) * ROAD_FACTOR;
  const hours = road <= LOCAL_KM ? road / LOCAL_KMH : LOCAL_KM / LOCAL_KMH + (road - LOCAL_KM) / LONG_KMH;
  return { km: Math.round(road * 10) / 10, minutes: Math.round(hours * 60) + BUFFER_MIN, basis: 'straight_line_estimate', source: ESTIMATE_SOURCE, isEstimate: true, confidence: ESTIMATE_CONFIDENCE };
}

// ── How sure we are of a stop: its hours, its visit length, and how reliably we know the way there
export const UNKNOWN_HOURS_CONFIDENCE = 0.3;
/** the first stop of a day starts from the traveller's stay, which we don't know */
const START_CONFIDENCE = 0.5;

export function activityConfidence(p: PointOfInterest, hours: 'open' | 'unknown' | undefined, arriving: TravelLeg | undefined): number {
  const h = hours === 'open' ? p.openingHours.confidence : UNKNOWN_HOURS_CONFIDENCE;
  return Math.round(((h + p.visitDuration.confidence + (arriving?.confidence ?? START_CONFIDENCE)) / 3) * 100) / 100;
}

// ── The shape of a day, by pace and party
export interface Break { kind: 'lunch' | 'rest' | 'dinner'; start: number; end: number }
export interface DayRules { start: number; end: number; activityMinutes: number; maxActivities: number; maxTravelMinutes: number; breaks: Break[] }

const PACE: Record<TravelStyle, Omit<DayRules, 'breaks'>> = {
  relaxed: { start: 10 * 60, end: 21 * 60, activityMinutes: 240, maxActivities: 3, maxTravelMinutes: 90 },
  balanced: { start: 9 * 60, end: 21 * 60 + 30, activityMinutes: 360, maxActivities: 4, maxTravelMinutes: 150 },
  packed: { start: 8 * 60 + 30, end: 22 * 60, activityMinutes: 480, maxActivities: 6, maxTravelMinutes: 210 },
};

export function dayPlanRules(i: { pace?: TravelStyle; travelerTypes: string[] }): DayRules {
  const pace = i.pace ?? 'balanced';
  const base = { ...PACE[pace] };
  const slower = i.travelerTypes.includes('kids') || i.travelerTypes.includes('seniors');
  if (slower) { base.maxActivities -= 1; base.activityMinutes -= 60; }
  const breaks: Break[] = [{ kind: 'lunch', start: 13 * 60, end: 14 * 60 }];
  if (pace === 'relaxed' || slower) breaks.push({ kind: 'rest', start: 15 * 60 + 30, end: 16 * 60 + 30 });
  breaks.push({ kind: 'dinner', start: 19 * 60 + 30, end: 20 * 60 + 30 });
  return { ...base, breaks };
}

// ── Hard filters
const HARD_FOR_WHEELCHAIRS: PoiCategory[] = ['waterfall', 'nature_reserve'];
const HARD_FOR_LIMITED_WALKING: PoiCategory[] = ['waterfall', 'nature_reserve'];

const no = (why: string) => ({ eligible: false, notes: [why] });

export function eligibility(p: PointOfInterest, i: { profile: TravelerProfile; travelerTypes: string[]; excluded: string[] }): { eligible: boolean; notes: string[] } {
  const notes: string[] = [];
  if (i.excluded.includes(p.id)) return no(`${p.name} was removed from the plan`);
  const disliked = p.interests.filter((x) => i.profile.dislikes.includes(x));
  if (disliked.length) return no(`${p.name} matches a dislike (${disliked.join(', ')})`);
  if (p.category === 'nightlife' && i.travelerTypes.includes('kids')) return no(`${p.name} is nightlife, and the trip includes children`);
  const access = p.accessibility.wheelchair;
  if (i.profile.mobilityNeeds.includes('wheelchair')) {
    if (access === 'no') return no(`${p.name} is not wheelchair accessible`);
    if (HARD_FOR_WHEELCHAIRS.includes(p.category) && access !== 'yes') return no(`${p.name} is hard to reach in a wheelchair`);
    if (access === 'unknown') notes.push(`Wheelchair access is not confirmed for ${p.name}`);
    if (access === 'limited') notes.push(`${p.name} has limited wheelchair access`);
  }
  if (i.profile.mobilityNeeds.includes('limited walking') && HARD_FOR_LIMITED_WALKING.includes(p.category) && access !== 'yes') {
    return no(`${p.name} involves walking on uneven paths`);
  }
  return { eligible: true, notes };
}

export function fitsOpeningHours(p: PointOfInterest, date: string, start: number, end: number): 'yes' | 'no' | 'unknown' {
  return isOpen(p.openingHours, date, start, end);
}

/** Why a place can't be visited on that date, if it can't. */
export function blockedOn(p: PointOfInterest, date: string, insights: TripInsight[]): 'rain' | 'closed' | undefined {
  for (const x of insights) {
    if (x.date !== date || x.status !== 'checked') continue;
    if (x.effect === 'closed' && x.poiId === p.id) return 'closed';
    if (x.effect === 'rain' && !p.indoor) return 'rain';
  }
  return undefined;
}
