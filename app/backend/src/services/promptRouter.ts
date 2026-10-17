// The planning flow: a first plan within three to four customer messages.
//
// Each message is parsed (no model), merged into the trip and the profile, then routed:
// - ask: one deterministic question for the most useful missing field (no model call)
// - draft: the model writes the plan; a plain-language summary of everything known, plus the assumptions
//   for what isn't, is added to the customer's message. The trained system prompt is never changed.
// - converse: side questions, searches, bookings and edits after the plan go to the model as they are.
// At most three questions per trip, so the fourth planning message always gets a plan.

import { inrAmount } from '../harness.js';
import { extractFacts, type Extraction } from '../domain/extract.js';
import { hasPreferences, mergeProfile, profileSummary, type TravelerProfile } from '../domain/profile.js';
import { mergeTrip, type TripContext } from '../domain/trip.js';

export type RouteState = 'profile_context' | 'trip_basics' | 'high_value_refinement' | 'draft_ready' | 'revision';
export type PlanField = 'destination' | 'when' | 'travelers' | 'budget' | 'pace' | 'interests';
export type AskField = PlanField | 'tradeoff:luxury_budget' | 'tradeoff:pace';

export interface Route {
  action: 'ask' | 'draft' | 'converse';
  state: RouteState;
  field?: AskField;
  /** the reply, for ask */
  text?: string;
  /** added to the customer's message for the model, for draft */
  brief?: string;
  assumptions: string[];
  missing: PlanField[];
}

export const MAX_QUESTIONS = 3;
// Below this per person per day, luxury stays and the stated budget conflict. Internal only, never shown.
const LUXURY_MIN_PER_PERSON_DAY_INR = 4000;
const DEFAULT_DAYS = 4;

// highest impact first; essentials are needed for a useful plan, refinements improve it
const ESSENTIALS: PlanField[] = ['destination', 'when', 'travelers'];
const REFINEMENTS: PlanField[] = ['budget', 'pace', 'interests'];

const QUESTIONS: Record<AskField, string> = {
  destination: 'Where would you like to go? A place you have in mind, or a kind of trip, such as beaches, mountains or heritage.',
  when: 'When are you planning to travel, and for how many days?',
  travelers: "Who's travelling: just you, a couple, family or friends? And how many people?",
  budget: 'Do you have a rough total budget in mind? A range is fine.',
  pace: 'What pace suits you: relaxed, balanced, or packed?',
  interests: 'What do you enjoy most on a trip? For example beaches, nature, food, history, adventure or nightlife.',
  'tradeoff:luxury_budget': 'Luxury stays for this many nights would stretch that budget. Should I keep the budget with comfortable stays, or keep luxury and plan for a higher budget?',
  'tradeoff:pace': 'Should the days be relaxed with free time, or packed so you see as much as possible?',
};

const STATE_FOR: Record<AskField, RouteState> = {
  destination: 'trip_basics', when: 'trip_basics', travelers: 'trip_basics',
  pace: 'profile_context', interests: 'profile_context',
  budget: 'high_value_refinement', 'tradeoff:luxury_budget': 'high_value_refinement', 'tradeoff:pace': 'high_value_refinement',
};

const ASSUMPTIONS: Record<PlanField, string> = {
  destination: 'suggest two or three destinations that fit',
  when: `flexible dates, ${DEFAULT_DAYS} days`,
  travelers: '2 travellers',
  budget: 'a mid-range budget',
  pace: 'a balanced pace',
  interests: 'a mix of the main sights',
};

const REQUEST = /\b(?:book|search|find|show me|check|compare|look up|cancel|status|confirm|refund|availability|available)\b/i;
const PLANNING = /\b(?:plan|planning|itinerary|trip|holiday|vacation|getaway|tour|jana hai|ghumna)\b/i;
const QUESTION = /\?\s*$|^\s*(?:what|how|is|are|can|could|should|do|does|why|which|when|where|will|would|tell me)\b/i;

function known(trip: TripContext, profile: TravelerProfile): Record<PlanField, boolean> {
  return {
    destination: !!trip.destination,
    when: !!(trip.startDate || trip.month || trip.durationDays),
    travelers: !!trip.travelers,
    budget: !!(trip.budgetInr || profile.budgetStyle),
    pace: !!profile.travelStyle,
    interests: profile.interests.length > 0,
  };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function longDate(d: string, withYear: boolean): string {
  return `${Number(d.slice(8, 10))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]}${withYear ? ` ${d.slice(0, 4)}` : ''}`;
}

/** "12 to 15 December 2026", "December", "starting 5 March 2027" */
function whenText(t: TripContext): string | undefined {
  if (t.startDate && t.endDate) {
    const sameMonth = t.startDate.slice(0, 7) === t.endDate.slice(0, 7);
    return sameMonth
      ? `${Number(t.startDate.slice(8, 10))} to ${longDate(t.endDate, true)}`
      : `${longDate(t.startDate, t.startDate.slice(0, 4) !== t.endDate.slice(0, 4))} to ${longDate(t.endDate, true)}`;
  }
  if (t.startDate) return `starting ${longDate(t.startDate, true)}`;
  if (t.month) return MONTH_NAMES[t.month - 1];
  return undefined;
}

function acknowledgement(t: TripContext): string {
  const parts = [t.destination, whenText(t), t.durationDays && `${t.durationDays} days`, t.travelers && `${t.travelers} traveller${t.travelers > 1 ? 's' : ''}`].filter(Boolean);
  return parts.length ? `Noted: ${parts.join(', ')}.` : '';
}

/** Everything known, in the customer's voice, so it reads like a message the model was trained on. */
function brief(t: TripContext, p: TravelerProfile, assumptions: string[]): string {
  const parts = [
    t.destination && `destination ${t.destination}`,
    t.origin && `starting from ${t.origin}`,
    whenText(t) && `dates ${whenText(t)}${t.durationDays ? ` (${t.durationDays} days)` : ''}`,
    !whenText(t) && t.durationDays && `${t.durationDays} days`,
    t.travelers && `${t.travelers} traveller${t.travelers > 1 ? 's' : ''}${t.travelerTypes.length ? ` (${t.travelerTypes.join(', ')})` : ''}`,
    t.purpose && `occasion: ${t.purpose}`,
    t.budgetInr && `budget ${inr(t.budgetInr)} ${t.budgetPerPerson ? 'per person' : 'in total'}`,
    p.budgetStyle && `stays: ${p.budgetStyle}`,
    p.travelStyle && `pace: ${p.travelStyle}`,
    p.interests.length > 0 && `likes: ${p.interests.join(', ')}`,
    p.dislikes.length > 0 && `avoid: ${p.dislikes.join(', ')}`,
    p.dietaryNeeds.length > 0 && `diet: ${p.dietaryNeeds.join(', ')}`,
    p.mobilityNeeds.length > 0 && `access needs: ${p.mobilityNeeds.join(', ')}`,
    p.accommodationPreferences.length > 0 && `stay type: ${p.accommodationPreferences.join(', ')}`,
  ].filter(Boolean);
  const assume = assumptions.length ? ` Where I haven't said, assume ${assumptions.join('; ')}.` : '';
  return `Trip details so far: ${parts.join('; ') || 'none yet'}.${assume} Please suggest a day-by-day plan.`;
}

function conflict(t: TripContext, p: TravelerProfile, ex: Extraction): AskField | undefined {
  if (ex.paceConflict && !t.asked.includes('tradeoff:pace')) return 'tradeoff:pace';
  if (p.budgetStyle === 'premium' && t.budgetInr && !t.asked.includes('tradeoff:luxury_budget')) {
    const people = t.travelers ?? 2;
    const days = t.durationDays ?? DEFAULT_DAYS;
    const perPersonDay = (t.budgetPerPerson ? t.budgetInr : t.budgetInr / people) / days;
    if (perPersonDay < LUXURY_MIN_PER_PERSON_DAY_INR) return 'tradeoff:luxury_budget';
  }
  return undefined;
}

export function routeTurn(i: { trip: TripContext; profile: TravelerProfile; message: string; extraction: Extraction; firstTurnOfThread: boolean; savedProfile: TravelerProfile }): Route {
  const { trip, profile, message } = i;
  const have = known(trip, profile);
  const missing = [...ESSENTIALS, ...REFINEMENTS].filter((f) => !have[f]);
  const essentialsMissing = ESSENTIALS.filter((f) => !have[f]);
  const assumptions = missing.map((f) => (f === 'when' && trip.month ? `${DEFAULT_DAYS} days` : ASSUMPTIONS[f]));

  if (trip.status === 'drafted') return { action: 'converse', state: 'revision', assumptions: [], missing };
  if (REQUEST.test(message) || (QUESTION.test(message) && !PLANNING.test(message))) {
    return { action: 'converse', state: essentialsMissing.length ? 'trip_basics' : 'high_value_refinement', assumptions, missing };
  }

  const questionsLeft = MAX_QUESTIONS - trip.asked.length;
  const ask = (field: AskField): Route => {
    const summary = i.firstTurnOfThread && hasPreferences(i.savedProfile)
      ? `I'll use your saved preferences: ${profileSummary(i.savedProfile)}. Tell me if anything has changed.`
      : '';
    const text = [i.extraction.hasTripFacts ? acknowledgement(trip) : '', summary, QUESTIONS[field]].filter(Boolean).join('\n\n');
    return { action: 'ask', state: STATE_FOR[field], field, text, assumptions, missing };
  };

  if (questionsLeft > 0) {
    const tradeoff = conflict(trip, profile, i.extraction);
    if (tradeoff) return ask(tradeoff);
    const essential = essentialsMissing.find((f) => !trip.asked.includes(f));
    if (essential) return ask(essential);
    // one refinement question, unless the customer gave everything essential in their first message
    const refinementAsked = trip.asked.some((f) => !(ESSENTIALS as string[]).includes(f));
    const refinement = REFINEMENTS.find((f) => !have[f] && !trip.asked.includes(f));
    if (trip.planningTurns > 0 && !refinementAsked && refinement) return ask(refinement);
  }
  return { action: 'draft', state: 'draft_ready', brief: brief(trip, profile, assumptions), assumptions, missing };
}

/**
 * One customer message through the planner. Pure: the caller stores the returned trip and profile.
 * `message` must already be redacted.
 */
export function planTurn(i: { trip: TripContext; profile: TravelerProfile; message: string; today: string; catalogPath: string; firstTurnOfThread: boolean; now: string }) {
  const extraction = extractFacts(i.message, i.today, i.catalogPath);
  // a bare answer to the question just asked: "80k", "3"
  const justAsked = i.trip.status === 'collecting' ? i.trip.asked.at(-1) : undefined;
  if (justAsked === 'budget' && extraction.trip.budgetInr === undefined) {
    const m = /(\d+(?:,\d+)*(?:\.\d+)?)\s?(k|l|lakhs?|lacs?|crores?|cr)?\b/i.exec(i.message);
    const value = m ? inrAmount(m[1], m[2]) : 0;
    if (value >= 1000) extraction.trip = { ...extraction.trip, budgetInr: value, budgetPerPerson: /\b(?:per person|each)\b/i.test(i.message) };
  }
  if (justAsked === 'travelers' && extraction.trip.travelers === undefined) {
    const m = /^\D*(\d{1,2})\D*$/.exec(i.message);
    if (m && Number(m[1]) > 0) extraction.trip = { ...extraction.trip, travelers: Number(m[1]) };
  }
  if (justAsked && !extraction.hasTripFacts) extraction.hasTripFacts = Object.keys(extraction.trip).length > 1;

  const profile = mergeProfile(mergeProfile(i.profile, extraction.profile.explicit, 'explicit', i.now), extraction.profile.inferred, 'inferred', i.now);
  let trip = mergeTrip(i.trip, extraction.trip, i.now);
  const route = routeTurn({ trip, profile, message: i.message, extraction, firstTurnOfThread: i.firstTurnOfThread, savedProfile: i.profile });
  if (route.action === 'ask') trip = { ...trip, asked: [...trip.asked, route.field!], planningTurns: trip.planningTurns + 1 };
  if (route.action === 'draft') trip = { ...trip, status: 'drafted', planningTurns: trip.planningTurns + 1 };
  return { trip, profile, route };
}
