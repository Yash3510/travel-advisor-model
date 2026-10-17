// Plan helpers for the Takeoff frontend, used next to takeoff-api.ts: quick replies for the planner's questions, the
// message that applies each alternative, labels for travel times, insights and sources, and the plan in the shapes of
// the frontend's DayPlan and Activity. No dependencies, no React. Copy it into the frontend as-is
// (src/services/takeoff-plan.ts); it is tested against the backend's planner in backend/test/client-plan.test.ts.

import type { ItineraryAlternative, ItineraryDraft, TravelLeg, TripContext, TripInsight } from './takeoff-api';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Replies to the question the planner just asked (`reply.planning.field`); each one is text the planner understands. */
export function quickReplies(field: string | undefined, today = new Date()): string[] {
  const month = (ahead: number) => MONTHS[(today.getMonth() + ahead) % 12];
  switch (field) {
    case 'destination': return ['Goa']; // the destinations with day-by-day plans so far
    case 'when': return [`${month(1)}, 4 days`, `${month(2)}, 5 days`];
    case 'travelers': return ['just me', 'me and my wife', '2 of us', 'we are 4 people'];
    case 'budget': return ['about 30k', 'about 60k', 'budget 1 lakh'];
    case 'pace': return ['relaxed', 'balanced', 'packed'];
    case 'interests': return ['beaches and food', 'history and culture', 'nature and adventure'];
    case 'tradeoff:pace': return ['relaxed', 'packed'];
    case 'tradeoff:luxury_budget': return ['keep the budget, comfortable stays are fine', 'keep luxury, I can spend more'];
    default: return [];
  }
}

/** The message that applies an alternative: the backend then rebuilds exactly the plan its `changes` described. */
export const ALTERNATIVE_MESSAGE: Record<ItineraryAlternative['kind'], string> = {
  cheaper: 'Make it cheaper',
  more_relaxed: 'Make it more relaxed',
  more_adventurous: 'Make it more adventurous',
};

/** "about 37 min (estimated)" or "about 24 min by road": an estimate is never shown as an exact time. */
export const travelLabel = (leg: TravelLeg) => (leg.isEstimate ? `about ${leg.minutes} min (estimated)` : `about ${leg.minutes} min by road`);

export const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

/** "Tue, 15 Dec" from "2026-12-15"; '' when there is no date. */
export const niceDate = (iso?: string) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';

/** One line per insight, saying plainly what was checked and what was not. */
export function insightLine(i: TripInsight): string {
  if (i.status === 'not_checked') return `${i.title}: ${i.detail}`;
  const when = i.date ? `, ${niceDate(i.date)}` : '';
  const stale = i.status === 'stale' ? ` (${i.type === 'weather' ? 'earlier forecast' : 'checked earlier'})` : '';
  return `${i.title}${when}${stale}: ${i.detail}`;
}

/** The credit line the plan's licences require, e.g. "© OpenStreetMap contributors (ODbL-1.0)". */
export const sourcesLine = (it: ItineraryDraft) => it.sources.map((s) => (s.licence ? `${s.attribution} (${s.licence})` : s.attribution)).join(' · ');

/** Plan-wide warnings, then each day's, labelled with the day. */
export const planWarnings = (it: ItineraryDraft) => [...it.warnings, ...it.days.flatMap((d) => d.warnings.map((w) => `Day ${d.day}: ${w}`))];

/** The frontend's Activity, plus what the plan adds; `priceINR` is absent when no fee is published (never 0). */
export interface PlanActivity {
  id: string; time: string; title: string; location: string; description: string; duration: string;
  category: 'Sightseeing' | 'Culinary' | 'Relaxation';
  priceINR?: number;
  /** no photos come from the backend: show a neutral placeholder */
  image: string;
  /** the place's OpenStreetMap page */
  mapUrl?: string;
  /** to the next stop, e.g. "about 37 min (estimated)" */
  travelToNext?: string;
}

/** The frontend's DayPlan. Hotels are not part of a plan, so `stayHotelId` is ''. */
export interface PlanDay { dayNumber: number; date: string; title: string; tagline: string; activities: PlanActivity[]; stayHotelId: string }

export function toDayPlans(it: ItineraryDraft): PlanDay[] {
  return it.days.map((d) => ({
    dayNumber: d.day,
    date: niceDate(d.date) || `Day ${d.day}`,
    title: `Day ${d.day}`,
    tagline: d.items.filter((i) => i.kind === 'activity').map((i) => i.title).join(' · '),
    activities: d.items.map((i, n): PlanActivity => ({
      id: i.poiId ?? `day${d.day}-${i.kind}-${n}`,
      time: `${i.start}–${i.end}`,
      title: i.title,
      location: it.destination,
      description: [
        ...(i.why?.matched.length ? [`Why: ${i.why.matched.join(', ')}`] : []),
        ...(i.suggestions?.length ? [`Nearby: ${i.suggestions.map((s) => s.name).join(', ')}`] : []),
        ...i.notes,
        ...(i.kind === 'activity' && i.hours === 'unknown' ? ['Opening hours not published'] : []),
      ].join('. '),
      duration: duration(i.durationMinutes),
      category: i.kind === 'meal' ? 'Culinary' : i.kind === 'rest' ? 'Relaxation' : 'Sightseeing',
      ...(i.costInr !== undefined ? { priceINR: i.costInr } : {}),
      image: '',
      ...(i.source?.url ? { mapUrl: i.source.url } : {}),
      ...(i.travelToNext ? { travelToNext: travelLabel(i.travelToNext) } : {}),
    })),
    stayHotelId: '',
  }));
}

/** A TripState with nothing in it, for a new conversation: the dossier shows only what the backend has sent. */
export const noTrip = () => ({
  destination: '', country: '', dates: '', durationDays: 0, travelers: 0, tripType: '',
  flightIncluded: false, flightPriceINR: 0, hotels: [] as never[], days: [] as PlanDay[],
});

/** The frontend's TripState fields that a plan fills: spread it over the current state (`{ ...trip, ...planTrip(...) }`). */
export function planTrip(it: ItineraryDraft, trip: Partial<Pick<TripContext, 'travelers' | 'purpose'>> = {}) {
  const first = it.days[0]?.date;
  const last = it.days.at(-1)?.date;
  return {
    destination: it.destination,
    country: 'India',
    dates: first && last ? `${niceDate(first)} – ${niceDate(last)}` : 'Flexible dates',
    durationDays: it.days.length,
    travelers: trip.travelers ?? 2,
    tripType: trip.purpose ?? '',
    flightIncluded: false,
    flightPriceINR: 0, // not shown: there are no flights in a plan
    hotels: [] as never[],
    days: toDayPlans(it),
  };
}

/** What the chat's itinerary card needs: no hotel and no price, since a plan has neither. */
export function planSummary(it: ItineraryDraft) {
  const days = toDayPlans(it);
  const first = it.days[0]?.date;
  const last = it.days.at(-1)?.date;
  return {
    destination: it.destination,
    duration: `${it.days.length} ${it.days.length === 1 ? 'Day' : 'Days'}`,
    dates: first && last ? `${niceDate(first)} – ${niceDate(last)}` : 'Flexible dates',
    daysCount: it.days.length,
    activitiesCount: it.days.flatMap((d) => d.items).filter((i) => i.kind === 'activity').length,
    day1Activities: (days[0]?.activities ?? []).filter((a) => a.category === 'Sightseeing'),
  };
}
