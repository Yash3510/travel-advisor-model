import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { emptyProfile, mergeProfile, type TravelerProfile } from '../src/domain/profile.js';
import { emptyTrip, mergeTrip } from '../src/domain/trip.js';
import { planTurn, type Route } from '../src/services/promptRouter.js';

const TODAY = '2026-10-14';
const NOW = '2026-10-14T10:00:00.000Z';

/** Runs messages through the planner in one thread, as the chat route does. */
function conversation(messages: string[], profile: TravelerProfile = emptyProfile()) {
  let trip = emptyTrip();
  let p = profile;
  const routes: Route[] = [];
  messages.forEach((message, i) => {
    const r = planTurn({ trip, profile: p, message, today: TODAY, catalogPath: config.catalogPath, firstTurnOfThread: i === 0, now: NOW });
    trip = r.trip;
    p = r.profile;
    routes.push(r.route);
  });
  return { trip, profile: p, routes };
}

describe('mergeTrip', () => {
  it('lets later facts correct earlier ones and keeps the rest', () => {
    const a = mergeTrip(emptyTrip(), { destination: 'Goa', travelers: 2, month: 12, travelerTypes: ['couple'] }, NOW);
    const b = mergeTrip(a, { travelers: 3, travelerTypes: ['friends'] }, NOW);
    expect(b).toMatchObject({ destination: 'Goa', travelers: 3, month: 12, travelerTypes: ['couple', 'friends'] });
  });
  it('drops old dates when the customer moves the trip to another month', () => {
    const a = mergeTrip(emptyTrip(), { startDate: '2026-12-12', endDate: '2026-12-15', durationDays: 4, travelerTypes: [] }, NOW);
    const b = mergeTrip(a, { month: 11, travelerTypes: [] }, NOW);
    expect(b.startDate).toBeUndefined();
    expect(b).toMatchObject({ month: 11, durationDays: 4 });
  });
});

describe('planTurn', () => {
  it('drafts straight away when one message has the destination, timing and party', () => {
    const { routes, trip } = conversation(['Plan a 4 day Goa trip in December for 2, budget 1 lakh']);
    expect(routes[0]).toMatchObject({ action: 'draft', state: 'draft_ready' });
    expect(routes[0].brief).toContain('Goa');
    expect(routes[0].brief).toContain('4 days');
    expect(routes[0].brief).toContain('2 travellers');
    expect(routes[0].brief).toContain('₹1,00,000 in total');
    expect(routes[0].assumptions).toEqual(['a balanced pace', 'a mix of the main sights']);
    expect(trip).toMatchObject({ status: 'drafted', planningTurns: 1, asked: [] });
  });

  it('asks the highest-impact missing field first and plans by the fourth message', () => {
    const { routes, trip } = conversation(['I want to plan a trip', 'Goa', 'December, 5 days, me and my wife', 'around 80k']);
    expect(routes.map((r) => r.action)).toEqual(['ask', 'ask', 'ask', 'draft']);
    expect(trip.asked).toEqual(['destination', 'when', 'budget']);
    expect(routes[0].state).toBe('trip_basics');
    expect(routes[2].state).toBe('high_value_refinement');
    expect(routes[2].text).toContain('Goa, December, 5 days, 2 travellers');
    expect(routes[3].brief).toContain('budget ₹80,000 in total');
  });

  it('never asks more than three questions, and fills the gaps with stated assumptions', () => {
    const { routes, trip } = conversation(['plan a trip', 'not sure', 'no idea', 'whatever']);
    expect(routes.map((r) => r.action)).toEqual(['ask', 'ask', 'ask', 'draft']);
    expect(trip.asked).toHaveLength(3);
    expect(routes[3].assumptions).toEqual(expect.arrayContaining(['suggest two or three destinations that fit', 'flexible dates, 4 days', '2 travellers']));
  });

  it('reuses a saved profile instead of asking again, and says what it is using', () => {
    const saved = mergeProfile(emptyProfile(), { set: { travelStyle: 'relaxed' }, add: { interests: ['beach'] } }, 'explicit', NOW);
    const { routes, trip } = conversation(['Plan a trip to Goa', 'December for 2', '50k total'], saved);
    expect(routes[0].text).toContain("I'll use your saved preferences: relaxed pace; likes beach.");
    expect(trip.asked).toEqual(['when', 'budget']);
    expect(routes[2].action).toBe('draft');
    expect(routes[2].brief).toContain('pace: relaxed');
    expect(routes[2].brief).toContain('likes: beach');
  });

  it('applies explicit corrections to the trip and the profile', () => {
    const saved = mergeProfile(emptyProfile(), { set: { travelStyle: 'relaxed' } }, 'explicit', NOW);
    const { trip, profile } = conversation(['Goa for 2 in December', 'actually we are 3 people, and make it packed so we see everything'], saved);
    expect(trip.travelers).toBe(3);
    expect(profile.travelStyle).toBe('packed');
  });

  it('asks one trade-off question for luxury on a small budget', () => {
    const { routes, trip } = conversation(['Luxury trip to Goa for 2, 5 days in December, budget 20k', 'keep the budget, comfortable stays are fine']);
    expect(routes[0]).toMatchObject({ action: 'ask', field: 'tradeoff:luxury_budget' });
    expect(routes[0].text).not.toMatch(/₹|\d{3,}/);
    expect(routes[1].action).toBe('draft');
    expect(trip.asked).toEqual(['tradeoff:luxury_budget']);
  });

  it('asks about pace when one message wants it both ways', () => {
    const { routes } = conversation(['Goa for 2 in December, relaxed but we also want to see everything']);
    expect(routes[0]).toMatchObject({ action: 'ask', field: 'tradeoff:pace' });
  });

  it('lets the model answer side questions without spending the question budget', () => {
    const { routes, trip } = conversation(['Plan a trip to Goa', 'Is Goa safe in the monsoon?']);
    expect(routes[1]).toMatchObject({ action: 'converse' });
    expect(trip).toMatchObject({ asked: ['when'], planningTurns: 1 });
  });

  it('hands searches and bookings to the model', () => {
    expect(conversation(['find me hotels in Goa for 12 to 15 December']).routes[0].action).toBe('converse');
    expect(conversation(['book the first one']).routes[0].action).toBe('converse');
  });

  it('switches to revision once a plan exists', () => {
    const { routes } = conversation(['Plan a 4 day Goa trip in December for 2', 'make day 2 more relaxed']);
    expect(routes[1]).toMatchObject({ action: 'revise', state: 'revision', revision: { kind: 'slower', day: 2 } });
  });
});

describe('revisions after the first plan', () => {
  const scheduled = [{ poiId: 'osm:node/1', name: 'Sunny Beach' }, { poiId: 'osm:node/3', name: 'Old Fort' }];
  function after(message: string, profile: TravelerProfile = emptyProfile()) {
    const first = planTurn({ trip: emptyTrip(), profile, message: 'Plan a 4 day Goa trip in December for 2', today: TODAY, catalogPath: config.catalogPath, firstTurnOfThread: true, now: NOW });
    return planTurn({ trip: first.trip, profile: first.profile, message, today: TODAY, catalogPath: config.catalogPath, firstTurnOfThread: false, now: NOW, scheduled });
  }

  it('makes the trip cheaper without touching the saved profile', () => {
    const saved = mergeProfile(emptyProfile(), { set: { budgetStyle: 'premium' } }, 'explicit', NOW);
    const r = after('make it cheaper', saved);
    expect(r.route).toMatchObject({ action: 'revise', state: 'revision', revision: { kind: 'cheaper' } });
    expect(r.trip.budgetStyleOverride).toBe('budget');
    expect(r.profile.budgetStyle).toBe('premium');
  });

  it('slows one day, or the whole trip', () => {
    const day = after('make day 2 more relaxed');
    expect(day.route.revision).toMatchObject({ kind: 'slower', day: 2 });
    expect(day.trip.dayPace).toEqual({ 2: 'relaxed' });
    const whole = after('can we slow it down, fewer stops please');
    expect(whole.route.revision).toMatchObject({ kind: 'slower' });
    expect(whole.trip.paceOverride).toBe('relaxed');
  });

  it('removes a scheduled place the traveller does not want, without changing their tastes', () => {
    const likesHistory = mergeProfile(emptyProfile(), { add: { interests: ['history'] } }, 'explicit', NOW);
    const r = after("I don't want to go to the old fort", likesHistory);
    expect(r.route.revision).toMatchObject({ kind: 'remove', poiId: 'osm:node/3' });
    expect(r.trip.excludedPoiIds).toEqual(['osm:node/3']);
    expect(r.profile).toMatchObject({ interests: ['history'], dislikes: [] });
  });

  it('makes the trip more adventurous for this trip only, also from the alternative\'s own words', () => {
    const saved = mergeProfile(emptyProfile(), { set: { travelStyle: 'relaxed' }, add: { interests: ['beach'] } }, 'explicit', NOW);
    for (const m of ['Make it more adventurous', 'More nature and adventure, at a quicker pace', 'add more adventure please', 'Add more nature and adventure and see more']) {
      const r = after(m, saved);
      expect(r.route, m).toMatchObject({ action: 'revise', state: 'revision', revision: { kind: 'adventurous' } });
      expect(r.trip, m).toMatchObject({ paceOverride: 'balanced', addedInterests: ['adventure', 'nature', 'trekking'] });
      // the saved profile keeps its pace and tastes: liking adventure on this trip isn't a lasting preference
      expect(r.profile, m).toMatchObject({ travelStyle: 'relaxed', interests: ['beach'] });
      expect(Object.keys(r.profile.sourceByField), m).not.toContain('interests:adventure');
    }
    expect(after('less adventurous, please').route.revision?.kind).not.toBe('adventurous');
    expect(after('a quicker pace please').route.revision).toMatchObject({ kind: 'faster' });
  });

  it('replans when the party size or dates change', () => {
    expect(after('we are 4 people now').route.revision).toMatchObject({ kind: 'replan' });
    expect(after('move it to 21 to 24 December').trip).toMatchObject({ startDate: '2026-12-21', endDate: '2026-12-24' });
  });

  it('leaves questions and searches to the model', () => {
    expect(after('is the fort worth it?').route.action).toBe('converse');
    expect(after('find me a cheaper hotel').route.action).toBe('converse');
  });
});
