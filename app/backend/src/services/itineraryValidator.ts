// Every plan is checked before anyone sees it, whoever produced it. Problems are repaired deterministically:
// unsupported claims are withdrawn, impossible or forbidden stops are removed, and travel and totals are
// recomputed. A day that can't be saved is kept free with a warning; the result is never an invalid plan.

import type { TripInsight } from '../domain/insights.js';
import { fromClock, type ItineraryDraft, type ItineraryItem } from '../domain/itinerary.js';
import { isOpen } from '../domain/openingHours.js';
import type { PointOfInterest } from '../domain/poi.js';
import type { TravelerProfile, TravelStyle } from '../domain/profile.js';
import type { TripContext } from '../domain/trip.js';
import { blockedOn, dayPlanRules, eligibility, estimateTravel, MAX_LEG_MINUTES } from './constraints.js';

export interface ValidationContext {
  pois: Map<string, PointOfInterest>;
  trip: TripContext;
  profile: TravelerProfile;
  insights: TripInsight[];
  dayPace?: Record<number, TravelStyle>;
}

export type ProblemCode =
  | 'invalid_date' | 'overlap' | 'outside_day' | 'unknown_place' | 'impossible_travel' | 'closed' | 'access'
  | 'hard_constraint' | 'duplicate' | 'unsupported_hours' | 'unsupported_price' | 'budget_total' | 'too_dense';

export interface Problem { code: ProblemCode; day: number; item?: number; message: string }

const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
const validIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
const round2 = (n: number) => Math.round(n * 100) / 100;
const activitySum = (d: ItineraryDraft) => d.days.flatMap((x) => x.items).filter((i) => i.costInr !== undefined).reduce((s, i) => s + i.costInr!, 0);
const hasCosts = (d: ItineraryDraft) => d.days.some((x) => x.items.some((i) => i.costInr !== undefined));

export function validateItinerary(d: ItineraryDraft, ctx: ValidationContext): Problem[] {
  const problems: Problem[] = [];
  const travelers = ctx.trip.travelers ?? 2;
  const seen = new Set<string>();

  d.days.forEach((day, di) => {
    const dayNo = day.day;
    if (day.date !== undefined) {
      const expected = d.startDate ? addDays(d.startDate, di) : undefined;
      if (!validIso(day.date) || day.date !== expected) problems.push({ code: 'invalid_date', day: dayNo, message: `Day ${dayNo} has an invalid date (${day.date})` });
    }
    let prevEnd = -1;
    let prevActivity: { item: ItineraryItem; poi: PointOfInterest } | undefined;
    const date = day.date && validIso(day.date) ? day.date : undefined;

    day.items.forEach((item, ii) => {
      const start = fromClock(item.start);
      const end = fromClock(item.end);
      if (start < prevEnd || end <= start) problems.push({ code: 'overlap', day: dayNo, item: ii, message: `${item.title} overlaps the previous item` });
      if (start < 6 * 60 || end > 23 * 60 + 59) problems.push({ code: 'outside_day', day: dayNo, item: ii, message: `${item.title} is outside the day` });
      prevEnd = Math.max(prevEnd, end);
      if (item.kind !== 'activity') return;

      const p = item.poiId ? ctx.pois.get(item.poiId) : undefined;
      if (!p) { problems.push({ code: 'unknown_place', day: dayNo, item: ii, message: `${item.title} is not a known place` }); return; }
      if (seen.has(p.id)) problems.push({ code: 'duplicate', day: dayNo, item: ii, message: `${p.name} is already in the plan` });
      seen.add(p.id);

      const e = eligibility(p, { profile: ctx.profile, travelerTypes: ctx.trip.travelerTypes, excluded: [] });
      if (!e.eligible) problems.push({ code: /wheelchair|walking/.test(e.notes[0]) ? 'access' : 'hard_constraint', day: dayNo, item: ii, message: e.notes[0] });

      if (date && (blockedOn(p, date, ctx.insights) || (p.openingHours.weekly && isOpen(p.openingHours, date, start, end) !== 'yes'))) {
        problems.push({ code: 'closed', day: dayNo, item: ii, message: `${p.name} is closed or unavailable at that time` });
      }
      if (item.hours === 'open' && !p.openingHours.weekly) problems.push({ code: 'unsupported_hours', day: dayNo, item: ii, message: `${p.name} has no published opening hours` });
      if (item.costInr !== undefined && !(p.fee === 'paid' && p.feeInr !== undefined && item.costInr === p.feeInr * travelers)) {
        problems.push({ code: 'unsupported_price', day: dayNo, item: ii, message: `${p.name}'s price is not backed by data` });
      }
      if (prevActivity) {
        const leg = estimateTravel(prevActivity.poi.location, p.location);
        if (leg.minutes > MAX_LEG_MINUTES || start - fromClock(prevActivity.item.end) < leg.minutes) {
          problems.push({ code: 'impossible_travel', day: dayNo, item: ii, message: `${p.name} can't be reached in time from ${prevActivity.poi.name}` });
        }
      }
      prevActivity = { item, poi: p };
    });

    const rules = dayPlanRules({ pace: ctx.dayPace?.[dayNo] ?? ctx.profile.travelStyle, travelerTypes: ctx.trip.travelerTypes });
    const acts = day.items.filter((i) => i.kind === 'activity');
    if (acts.length > rules.maxActivities || acts.reduce((s, i) => s + i.durationMinutes, 0) > rules.activityMinutes) {
      problems.push({ code: 'too_dense', day: dayNo, message: `Day ${dayNo} has more activity than the pace allows` });
    }
  });

  const sum = activitySum(d);
  if ((hasCosts(d) ? sum : undefined) !== d.totalEstimatedCostInr) problems.push({ code: 'budget_total', day: 0, message: 'The total does not match the items' });
  return problems;
}

const FIX_IN_PLACE: ProblemCode[] = ['unsupported_hours', 'unsupported_price'];

function refresh(d: ItineraryDraft, ctx: ValidationContext): void {
  for (const day of d.days) {
    const acts = day.items.filter((i) => i.kind === 'activity');
    acts.forEach((a, i) => {
      const next = acts[i + 1];
      const p = a.poiId ? ctx.pois.get(a.poiId) : undefined;
      const q = next?.poiId ? ctx.pois.get(next.poiId) : undefined;
      if (p && q) {
        const leg = estimateTravel(p.location, q.location);
        a.travelToNext = { minutes: leg.minutes, km: leg.km, basis: leg.basis };
      } else delete a.travelToNext;
    });
    const note = `Day ${day.day} could not be planned; it is kept free`;
    if (!acts.length && !day.warnings.includes(note)) day.warnings.push(note);
  }
  const all = d.days.flatMap((x) => x.items.filter((i) => i.kind === 'activity'));
  if (hasCosts(d)) d.totalEstimatedCostInr = activitySum(d); else delete d.totalEstimatedCostInr;
  d.confidence = all.length ? round2(all.reduce((s, a) => s + a.confidence, 0) / all.length) : 0;
}

export function repairItinerary(input: ItineraryDraft, ctx: ValidationContext): { draft: ItineraryDraft; repaired: string[] } {
  const d = structuredClone(input);
  const repaired: string[] = [];
  let changed = false;

  d.days.forEach((day, i) => {
    const expected = d.startDate ? addDays(d.startDate, i) : undefined;
    if (day.date !== expected) {
      repaired.push(`Day ${day.day}: date corrected`);
      if (expected) day.date = expected; else delete day.date;
      changed = true;
    }
  });

  for (let pass = 0; pass < 20; pass++) {
    const problems = validateItinerary(d, ctx);
    if (!problems.length) break;
    changed = true;
    for (const p of problems.filter((x) => FIX_IN_PLACE.includes(x.code))) {
      const item = d.days.find((x) => x.day === p.day)!.items[p.item!];
      if (p.code === 'unsupported_hours') { item.hours = 'unknown'; item.confidence = Math.min(item.confidence, 0.4); }
      if (p.code === 'unsupported_price') { delete item.costInr; delete item.costBasis; }
      repaired.push(`${p.message}: claim withdrawn`);
    }
    // remove one offending item per day per pass, latest first, so indices stay valid
    const removals = problems.filter((x) => x.item !== undefined && !FIX_IN_PLACE.includes(x.code));
    const dense = problems.filter((x) => x.code === 'too_dense');
    for (const day of d.days) {
      const own = removals.filter((x) => x.day === day.day).toSorted((a, b) => b.item! - a.item!);
      const first = own[0];
      if (first) {
        const [item] = day.items.splice(first.item!, 1);
        day.warnings.push(`Removed ${item.title}: ${first.message}`);
        repaired.push(`Day ${day.day}: removed ${item.title} (${first.code})`);
      } else if (dense.some((x) => x.day === day.day)) {
        const lastIdx = day.items.map((x) => x.kind).lastIndexOf('activity');
        const [item] = day.items.splice(lastIdx, 1);
        day.warnings.push(`Removed ${item.title} to keep the day at your pace`);
        repaired.push(`Day ${day.day}: removed ${item.title} (too_dense)`);
      }
    }
    refresh(d, ctx);
  }
  if (changed) refresh(d, ctx);
  return { draft: d, repaired };
}
