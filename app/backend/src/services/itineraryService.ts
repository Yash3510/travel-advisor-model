// Deterministic itinerary engine: ranks licensed place data against the traveller's profile and trip, then
// schedules feasible days (nearby places together, breaks, opening hours, pace, weather, closures). The model
// never decides what is in the plan; it only phrases what this produces.

import type { Offer } from '../db.js';
import type { TripInsight } from '../domain/insights.js';
import { blockOf, toClock, type ItineraryAlternative, type ItineraryDay, type ItineraryDraft, type ItineraryItem, type ItinerarySource } from '../domain/itinerary.js';
import { isOpen } from '../domain/openingHours.js';
import type { PoiCategory, PointOfInterest } from '../domain/poi.js';
import { ADVENTURE_INTERESTS, fasterPace, slowerPace, withInterests, type TravelerProfile, type TravelStyle } from '../domain/profile.js';
import type { TripContext } from '../domain/trip.js';
import { activityConfidence, blockedOn, dayPlanRules, eligibility, estimateTravel, MAX_LEG_MINUTES, type DayRules, type TravelEstimate, type TravelLookup } from './constraints.js';
import { labelTravel } from './itineraryValidator.js';

export interface ItineraryRequest {
  trip: TripContext;
  profile: TravelerProfile;
  insights: TripInsight[];
  pointsOfInterest: PointOfInterest[];
  offers?: Offer[];
  version: number;
  /** places the traveller asked to remove */
  excluded?: string[];
  /** per-day pace overrides from revisions ("make day 2 more relaxed"), 1-based */
  dayPace?: Record<number, TravelStyle>;
  withAlternatives?: boolean;
  /** travel times for scheduling; the straight-line estimate unless the routing provider has answered */
  travel?: TravelLookup;
}

export const DEFAULT_DAYS = 4;
const CLUSTER_MINUTES = 45; // a day's places stay within this travel time of its first stop
const SEEDS_TRIED = 3;
const STEP = 15;
const MEAL_SEARCH_KM = 5;

interface Candidate { poi: PointOfInterest; score: number; matched: string[]; tradeoffs: string[]; notes: string[] }

const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const niceDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function score(p: PointOfInterest, trip: TripContext, profile: TravelerProfile, pace: TravelStyle): Candidate {
  const matched: string[] = [];
  const tradeoffs: string[] = [];
  let s = 0;
  for (const interest of p.interests) {
    if (!profile.interests.includes(interest)) continue;
    const explicit = profile.sourceByField[`interests:${interest}`] === 'explicit';
    s += explicit ? 3 : 1.5;
    matched.push(`your interest in ${interest}`);
  }
  const types = trip.travelerTypes;
  if (types.includes('kids')) { if (p.kidFriendly) { s += 2; matched.push('good for children'); } else s -= 0.5; }
  if (types.includes('seniors') && p.indoor) { s += 0.5; matched.push('easy going for older travellers'); }
  const purpose = trip.purpose;
  if ((purpose === 'honeymoon' || purpose === 'anniversary') && ['beach', 'viewpoint'].includes(p.category)) { s += 1; matched.push(`suits a ${purpose}`); }
  if (purpose === 'pilgrimage' && p.category === 'place_of_worship') { s += 3; matched.push('suits a pilgrimage'); }
  if (purpose === 'adventure' && ['theme_park', 'waterfall', 'nature_reserve'].includes(p.category)) { s += 1.5; matched.push('suits an adventure trip'); }
  if ((purpose === 'relaxation' || pace === 'relaxed') && ['beach', 'park'].includes(p.category)) { s += 0.5; matched.push('suits a relaxed pace'); }
  if (pace === 'packed' && p.visitDuration.minutes <= 90) s += 0.5;
  const thrifty = profile.budgetStyle === 'budget' || profile.budgetStyle === 'value';
  if (p.fee === 'free') { s += thrifty ? 1 : 0.2; matched.push('free entry'); }
  if (p.fee === 'paid' && thrifty) { s -= 1; tradeoffs.push('has an entry fee'); }
  const meatFree = profile.dietaryNeeds.some((d) => d === 'vegetarian' || d === 'vegan' || d === 'jain');
  if (meatFree && /\b(?:fish|meat|seafood|mutton|chicken|crab)\b/i.test(p.name)) { s -= 3; tradeoffs.push('may not suit a vegetarian diet'); }
  if (p.wikidata) s += 1; // notable enough to have an encyclopedia entry
  if (p.openingHours.basis === 'osm') s += 0.3; else tradeoffs.push('opening hours not published');
  return { poi: p, score: round2(s), matched, tradeoffs, notes: [] };
}

const rank = (a: Candidate, b: Candidate) => b.score - a.score || (a.poi.id < b.poi.id ? -1 : 1);
const eveningOnly = (p: PointOfInterest) => p.goodSlots.length === 1 && p.goodSlots[0] === 'evening';

/** Hours check: on a dated day it must be open; undated, open on at least 5 weekdays (closed days are noted). */
function hoursOk(p: PointOfInterest, date: string | undefined, start: number, end: number): { ok: boolean; hours: 'open' | 'unknown'; closedDays: string[] } {
  if (!p.openingHours.weekly) return { ok: true, hours: 'unknown', closedDays: [] };
  if (date) return { ok: isOpen(p.openingHours, date, start, end) === 'yes', hours: 'open', closedDays: [] };
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const monday = '2026-01-05'; // any Monday: only the weekday matters here
  const closed = names.filter((_, i) => isOpen(p.openingHours, addDays(monday, i), start, end) !== 'yes');
  return { ok: closed.length <= 2, hours: 'open', closedDays: closed };
}

interface Placed { c: Candidate; start: number; end: number; travel?: TravelEstimate; closedDays: string[]; hours: 'open' | 'unknown' }

/** Place the stops in order, earliest feasible time each; null if any stop can't fit. */
function place(order: Candidate[], rules: DayRules, date: string | undefined, travelTime: TravelLookup): Placed[] | null {
  const out: Placed[] = [];
  let cursor = rules.start;
  for (const c of order) {
    const prev = out.at(-1);
    const travel = prev ? travelTime(prev.c.poi.location, c.poi.location) : undefined;
    if (travel && travel.minutes > MAX_LEG_MINUTES) return null;
    const dur = c.poi.visitDuration.minutes;
    let found: Placed | null = null;
    const earliest = Math.max(cursor + (travel?.minutes ?? 0), eveningOnly(c.poi) ? 18 * 60 : 0);
    for (let s = Math.ceil(earliest / STEP) * STEP; s + dur <= rules.end; s += STEP) {
      if (rules.breaks.some((b) => s < b.end && s + dur > b.start)) continue;
      const h = hoursOk(c.poi, date, s, s + dur);
      if (!h.ok) continue;
      found = { c, start: s, end: s + dur, travel, closedDays: h.closedDays, hours: h.hours };
      break;
    }
    if (!found) return null;
    out.push(found);
    cursor = found.end;
  }
  return out;
}

/** Starting from a seed, add nearby stops by score while the day's budgets and the schedule allow. */
function fillDay(seed: Candidate, pool: Candidate[], rules: DayRules, date: string | undefined, travel: TravelLookup): Placed[] {
  let chosen = [seed];
  let placed = place([seed], rules, date, travel)!;
  for (const c of pool) {
    if (c === seed || estimateTravel(seed.poi.location, c.poi.location).minutes > CLUSTER_MINUTES) continue;
    if (chosen.length >= rules.maxActivities) break;
    if (chosen.some((x) => x.poi.category === c.poi.category)) continue;
    if (chosen.reduce((s, x) => s + x.poi.visitDuration.minutes, 0) + c.poi.visitDuration.minutes > rules.activityMinutes) continue;
    const trial = place(orderStops([...chosen, c]), rules, date, travel);
    if (!trial || trial.reduce((s, x) => s + (x.travel?.minutes ?? 0), 0) > rules.maxTravelMinutes) continue;
    chosen = [...chosen, c];
    placed = trial;
  }
  return placed;
}

/** Highest-scoring stop first, then the nearest remaining; evening-only places go last. */
function orderStops(stops: Candidate[]): Candidate[] {
  const day = stops.filter((c) => !eveningOnly(c.poi)).toSorted(rank);
  const out: Candidate[] = day.length ? [day.shift()!] : [];
  while (day.length) {
    const last = out.at(-1)!.poi.location;
    day.sort((a, b) => estimateTravel(last, a.poi.location).minutes - estimateTravel(last, b.poi.location).minutes || rank(a, b));
    out.push(day.shift()!);
  }
  return [...out, ...stops.filter((c) => eveningOnly(c.poi)).toSorted(rank)];
}

function mealItem(kind: 'lunch' | 'dinner', start: number, end: number, near: PointOfInterest | undefined, restaurants: PointOfInterest[], profile: TravelerProfile): ItineraryItem {
  const needs = profile.dietaryNeeds.filter((d) => ['vegetarian', 'vegan', 'jain'].includes(d));
  const item: ItineraryItem = { kind: 'meal', block: blockOf(start), start: toClock(start), end: toClock(end), title: kind === 'lunch' ? 'Lunch' : 'Dinner', durationMinutes: end - start, durationBasis: 'fixed', notes: [], confidence: 1 };
  if (!needs.length || !near) return item;
  const fits = (r: PointOfInterest) => needs.every((n) => (n === 'vegetarian' ? r.diet?.some((d) => d === 'vegetarian' || d === 'vegan') : r.diet?.includes(n)));
  const options = restaurants
    .filter((r) => fits(r) && estimateTravel(near.location, r.location).km <= MEAL_SEARCH_KM)
    .toSorted((a, b) => estimateTravel(near.location, a.location).km - estimateTravel(near.location, b.location).km || (a.id < b.id ? -1 : 1))
    .slice(0, 2);
  if (options.length) item.suggestions = options.map((r) => ({ poiId: r.id, name: r.name, diet: r.diet ?? [] }));
  else item.notes.push(`No ${needs.join(' and ')}-friendly restaurant nearby in our data; ask locally`);
  return item;
}

export function buildItinerary(req: ItineraryRequest): ItineraryDraft {
  const { trip, profile, insights } = req;
  const travel = req.travel ?? estimateTravel;
  const pace: TravelStyle = profile.travelStyle ?? 'balanced';
  const travelers = trip.travelers ?? 2;
  const dayCount = Math.max(1, Math.min(14, trip.durationDays ?? DEFAULT_DAYS));
  const dates = trip.startDate ? Array.from({ length: dayCount }, (_, i) => addDays(trip.startDate!, i)) : undefined;
  const assumptions: string[] = [];
  const warnings: string[] = [];
  if (!trip.durationDays) assumptions.push(`Planned for ${DEFAULT_DAYS} days`);
  if (!profile.travelStyle) assumptions.push('A balanced pace');
  if (!trip.travelers) assumptions.push('2 travellers');
  if (!dates) assumptions.push('Dates are flexible, so opening days are checked across the week rather than for specific dates');

  const restaurants = req.pointsOfInterest.filter((p) => p.category === 'restaurant');
  const rejected: ItineraryDraft['rejected'] = [];
  const candidates: Candidate[] = [];
  for (const p of req.pointsOfInterest) {
    if (p.category === 'restaurant') continue;
    const e = eligibility(p, { profile, travelerTypes: trip.travelerTypes, excluded: req.excluded ?? [] });
    if (!e.eligible) { rejected.push({ poiId: p.id, name: p.name, reason: e.notes[0] }); continue; }
    const c = score(p, trip, profile, pace);
    c.notes.push(...e.notes);
    candidates.push(c);
  }
  candidates.sort(rank);

  const used = new Set<string>();
  const categoryUses = new Map<PoiCategory, number>();
  const days: ItineraryDay[] = [];
  for (let d = 0; d < dayCount; d++) {
    const date = dates?.[d];
    const rules = dayPlanRules({ pace: req.dayPace?.[d + 1] ?? pace, travelerTypes: trip.travelerTypes });
    const dayWarnings: string[] = [];
    const pool: Candidate[] = [];
    let rainBlocked = 0;
    for (const c of candidates) {
      if (used.has(c.poi.id)) continue;
      const blocked = date ? blockedOn(c.poi, date, insights) : undefined;
      if (blocked === 'rain') { rainBlocked++; continue; }
      if (blocked === 'closed') { dayWarnings.push(`${c.poi.name} is closed on ${niceDate(date!)}, so it isn't planned that day`); continue; }
      pool.push(c);
    }
    if (rainBlocked && date) dayWarnings.push(`Heavy rain is likely on ${niceDate(date)}, so this day keeps to indoor places`);
    // variety: each kind of place loses appeal every time it has already been used
    const adjusted = pool.map((c) => ({ ...c, score: round2(c.score - 1.5 * (categoryUses.get(c.poi.category) ?? 0)) })).toSorted(rank);

    // try the best few starting points and keep the day that scores highest overall: a greedy first pick
    // can crowd out a better combination (two strong stops beat one strong stop and two fillers)
    let placed: Placed[] = [];
    let bestScore = -Infinity;
    for (const seed of adjusted.filter((c) => place([c], rules, date, travel)).slice(0, SEEDS_TRIED)) {
      const day = fillDay(seed, adjusted, rules, date, travel);
      const total = day.reduce((s, p) => s + p.c.score, 0);
      if (total > bestScore) { bestScore = total; placed = day; }
    }
    for (const p of placed) {
      used.add(p.c.poi.id);
      categoryUses.set(p.c.poi.category, (categoryUses.get(p.c.poi.category) ?? 0) + 1);
    }

    const items: ItineraryItem[] = placed.map((p, i) => {
      const next = placed[i + 1];
      const leg = next?.travel;
      const tradeoffs = [...p.c.tradeoffs];
      if (p.travel && p.travel.minutes > 30) tradeoffs.push(`about ${p.travel.minutes} min from the previous stop`);
      const notes = [...p.c.notes];
      if (p.closedDays.length) notes.push(`Closed on ${p.closedDays.join(', ')}`);
      const cost = p.c.poi.fee === 'paid' && p.c.poi.feeInr !== undefined ? p.c.poi.feeInr * travelers : undefined;
      return {
        kind: 'activity', block: blockOf(p.start), start: toClock(p.start), end: toClock(p.end), title: p.c.poi.name, poiId: p.c.poi.id,
        durationMinutes: p.end - p.start, durationBasis: 'category_default',
        ...(leg ? { travelToNext: { ...leg } } : {}),
        hours: p.hours, ...(cost !== undefined ? { costInr: cost, costBasis: 'osm_charge' as const } : {}),
        why: { matched: p.c.matched, tradeoffs }, notes,
        source: { name: p.c.poi.source.name, url: p.c.poi.source.url, licence: p.c.poi.source.licence, attribution: p.c.poi.source.attribution },
        confidence: activityConfidence(p.c.poi, p.hours, p.travel),
      } satisfies ItineraryItem;
    });
    const lastBefore = (t: number) => placed.filter((p) => p.end <= t).at(-1)?.c.poi ?? placed[0]?.c.poi;
    for (const b of rules.breaks) {
      if (b.kind === 'rest') items.push({ kind: 'rest', block: blockOf(b.start), start: toClock(b.start), end: toClock(b.end), title: 'Rest at your stay', durationMinutes: b.end - b.start, durationBasis: 'fixed', notes: [], confidence: 1 });
      else items.push(mealItem(b.kind, b.start, b.end, lastBefore(b.start), restaurants, profile));
    }
    items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    if (!placed.length) dayWarnings.push(`No suitable places were left for day ${d + 1}; it is kept free`);
    days.push({ day: d + 1, ...(date ? { date } : {}), items, warnings: dayWarnings });
  }

  // places matching the traveller's interests that were left out because they're too far from everything planned
  const plannedStops = candidates.filter((c) => used.has(c.poi.id));
  for (const c of candidates.slice(0, 5)) {
    if (used.has(c.poi.id) || !plannedStops.length || !c.matched.some((m) => m.startsWith('your interest in'))) continue;
    const nearest = Math.min(...plannedStops.map((s) => estimateTravel(s.poi.location, c.poi.location).minutes));
    if (nearest > MAX_LEG_MINUTES) warnings.push(`${c.poi.name} is too far from the other places to fit into a day of this plan (about ${Math.round(nearest / 60)} h away)`);
  }

  const activities = days.flatMap((x) => x.items.filter((i) => i.kind === 'activity'));
  const costs = activities.filter((a) => a.costInr !== undefined).map((a) => a.costInr!);
  const totalEstimatedCostInr = costs.length ? costs.reduce((a, b) => a + b, 0) : undefined;
  if (totalEstimatedCostInr !== undefined && trip.budgetInr) {
    const budget = trip.budgetPerPerson ? trip.budgetInr * travelers : trip.budgetInr;
    if (totalEstimatedCostInr > budget) warnings.push(`Entry fees in this plan (${inr(totalEstimatedCostInr)}) are above your budget (${inr(budget)})`);
  }
  assumptions.push('Visit lengths are typical times for each kind of place, not published figures');
  assumptions.push('Each day starts near where you are staying');
  const unknownHours = activities.filter((a) => a.hours === 'unknown').length;
  if (unknownHours) assumptions.push(`Opening hours aren't published for ${unknownHours} of the places in this plan; check before you go`);
  assumptions.push('Only published entry fees are counted; hotels, food and transport are not included');
  if (profile.dislikes.includes('crowds')) assumptions.push("Crowd levels aren't in our data, so quieter times can't be guaranteed");

  const sources: ItinerarySource[] = [];
  if (activities.length) sources.push({ name: 'OpenStreetMap', licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' });
  for (const x of insights.filter((i) => i.status === 'checked')) {
    if (!sources.some((s) => s.name === x.source)) sources.push({ name: x.source, attribution: x.source, ...(x.licence ? { licence: x.licence } : {}), ...(x.sourceUrl ? { url: x.sourceUrl } : {}) });
  }

  const draft: ItineraryDraft = {
    version: req.version, destination: trip.destination ?? '', ...(trip.startDate ? { startDate: trip.startDate } : {}),
    days, ...(totalEstimatedCostInr !== undefined ? { totalEstimatedCostInr } : {}),
    assumptions, warnings, alternatives: [],
    confidence: activities.length ? round2(activities.reduce((s, a) => s + a.confidence, 0) / activities.length) : 0,
    sources, rejected,
  };
  labelTravel(draft);
  if (req.withAlternatives !== false) draft.alternatives = alternatives(req, draft);
  return draft;
}

const stopsByDay = (d: ItineraryDraft) => d.days.map((day) => day.items.filter((i) => i.kind === 'activity').map((i) => i.title));

/** What changes between two plans, day by day; an alternative's `changes`. */
export function diff(base: ItineraryDraft, alt: ItineraryDraft): string[] {
  const a = stopsByDay(base);
  const b = stopsByDay(alt);
  const changes: string[] = [];
  a.forEach((stops, i) => {
    const removed = stops.filter((s) => !b[i]?.includes(s));
    const added = (b[i] ?? []).filter((s) => !stops.includes(s));
    if (removed.length || added.length) {
      changes.push(`Day ${i + 1}: ${[removed.length && `drop ${removed.join(', ')}`, added.length && `add ${added.join(', ')}`].filter(Boolean).join('; ')}`);
    }
  });
  return changes;
}

/** Cheaper, more relaxed and more adventurous versions, from the same places and rules. */
function alternatives(req: ItineraryRequest, base: ItineraryDraft): ItineraryAlternative[] {
  const variant = (profile: TravelerProfile) => buildItinerary({ ...req, profile, withAlternatives: false });
  const out: ItineraryAlternative[] = [];
  const add = (kind: ItineraryAlternative['kind'], summary: string, alt: ItineraryDraft) => {
    const changes = diff(base, alt);
    if (changes.length) out.push({ kind, summary, changes });
  };
  const p = req.profile;
  if (base.days.some((d) => d.items.some((i) => i.costInr !== undefined)) || p.budgetStyle === 'premium' || p.budgetStyle === 'comfort') {
    add('cheaper', 'Favour free places over paid entries', variant({ ...p, budgetStyle: 'budget' }));
  }
  // one step slower, as "make it more relaxed" does; only a relaxed day has the rest break
  const slower = slowerPace(p.travelStyle ?? 'balanced');
  if (p.travelStyle !== 'relaxed') add('more_relaxed', slower === 'relaxed' ? 'Fewer stops a day, with a rest break' : 'Fewer stops a day', variant({ ...p, travelStyle: slower }));
  // the "make it more adventurous" revision builds this same plan (promptRouter.ts, planBuilder.ts)
  add('more_adventurous', 'More nature and adventure, at a quicker pace',
    variant({ ...withInterests(p, ADVENTURE_INTERESTS), travelStyle: fasterPace(p.travelStyle ?? 'balanced') }));
  return out;
}
