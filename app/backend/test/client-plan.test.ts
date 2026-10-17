import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { emptyProfile } from '../src/domain/profile.js';
import { emptyTrip, type TripContext } from '../src/domain/trip.js';
import type { TripInsight } from '../src/domain/insights.js';
import { buildItinerary } from '../src/services/itineraryService.js';
import { planTurn } from '../src/services/promptRouter.js';
import { ALTERNATIVE_MESSAGE, insightLine, noTrip, planSummary, planTrip, quickReplies, sourcesLine, toDayPlans, travelLabel } from '../../client/takeoff-plan.js';
import { parseItinerary } from '../../client/takeoff-api.js';
import { NOW, profileWith, TOWN, tripWith } from './fixtures.js';

const TODAY = '2026-10-18';
const trip = tripWith({ destination: 'Goa', startDate: '2026-12-15', endDate: '2026-12-16', durationDays: 2, travelers: 2, purpose: 'honeymoon' });
const draft = parseItinerary(JSON.parse(JSON.stringify(buildItinerary({ trip, profile: profileWith({ add: { interests: ['history', 'beach'] } }), insights: [], pointsOfInterest: TOWN, version: 1 }))))!;

/** Runs the planner over a conversation, as the chat route does. */
function talk(messages: string[], start: TripContext = emptyTrip()) {
  let t = start;
  let p = emptyProfile();
  return messages.map((message, i) => {
    const r = planTurn({ trip: t, profile: p, message, today: TODAY, catalogPath: config.catalogPath, firstTurnOfThread: i === 0, now: NOW });
    t = r.trip;
    p = r.profile;
    return r;
  });
}

describe('quickReplies', () => {
  // the conversation that makes the planner ask each field, so every chip is tried where it would be shown
  const asks: Record<string, string[]> = {
    destination: ['I want to plan a trip'],
    when: ['Plan a trip to Goa'],
    travelers: ['Plan a trip to Goa', 'December, 5 days'],
    budget: ['Plan a trip to Goa', 'December, 5 days, 2 of us'],
  };
  for (const [field, before] of Object.entries(asks)) {
    it(`offers replies to the ${field} question that the planner understands`, () => {
      expect(talk(before).at(-1)!.route.field).toBe(field);
      const chips = quickReplies(field, new Date(`${TODAY}T10:00:00`));
      expect(chips.length).toBeGreaterThan(0);
      // the planner moves on after one try either way, so check that the chip actually filled the fact in
      const filled: Record<string, (t: TripContext) => unknown> = {
        destination: (t) => t.destination, when: (t) => t.month ?? t.startDate, travelers: (t) => t.travelers, budget: (t) => t.budgetInr,
      };
      for (const chip of chips) {
        const next = talk([...before, chip]).at(-1)!;
        expect(filled[field](next.trip), `"${chip}" answers the ${field} question`).toBeDefined();
        expect(next.route.field, chip).not.toBe(field);
      }
    });
  }

  it('answers the pace, interests and trade-off questions in words the planner reads', () => {
    for (const chip of quickReplies('pace')) expect(talk([`Plan a trip to Goa in December for 2, ${chip} pace`]).at(-1)!.profile.travelStyle).toBe(chip);
    for (const chip of quickReplies('interests')) expect(talk([`Plan a trip to Goa, we like ${chip}`]).at(-1)!.profile.interests.length, chip).toBeGreaterThan(0);
    for (const chip of quickReplies('tradeoff:luxury_budget')) {
      expect(talk(['Luxury trip to Goa for 2, 5 days in December, budget 20k', chip]).at(-1)!.route.action, chip).toBe('draft');
    }
    expect(quickReplies(undefined)).toEqual([]);
  });

  it('suggests months ahead of today, never in the past', () => {
    expect(quickReplies('when', new Date('2026-12-20T10:00:00'))).toEqual(['January, 4 days', 'February, 5 days']);
  });
});

describe('ALTERNATIVE_MESSAGE', () => {
  it('sends the message that rebuilds each alternative', () => {
    const kinds = { cheaper: 'cheaper', more_relaxed: 'slower', more_adventurous: 'adventurous' } as const;
    for (const [alt, revision] of Object.entries(kinds)) {
      const [first] = talk(['Plan a 4 day Goa trip in December for 2']);
      const r = planTurn({ trip: first.trip, profile: first.profile, message: ALTERNATIVE_MESSAGE[alt as keyof typeof kinds], today: TODAY, catalogPath: config.catalogPath, firstTurnOfThread: false, now: NOW });
      expect(r.route.revision?.kind, alt).toBe(revision);
    }
  });
});

describe('toDayPlans and planTrip', () => {
  it('turns the plan into the frontend\'s day and activity shapes, without inventing prices or photos', () => {
    const days = toDayPlans(draft);
    expect(days.map((d) => d.dayNumber)).toEqual([1, 2]);
    expect(days[0]).toMatchObject({ date: 'Tue, 15 Dec', title: 'Day 1', stayHotelId: '' });
    const items = draft.days[0].items;
    days[0].activities.forEach((a, n) => {
      expect(a.time).toBe(`${items[n].start}–${items[n].end}`);
      expect(a.title).toBe(items[n].title);
      expect(a.image).toBe('');
      expect(a.priceINR).toBe(items[n].costInr);
    });
    const fort = days.flatMap((d) => d.activities).find((a) => a.title === 'Old Fort');
    expect(fort).toMatchObject({ priceINR: 100, category: 'Sightseeing', mapUrl: 'https://www.openstreetmap.org/node/1' });
    expect(days.flatMap((d) => d.activities).filter((a) => a.category === 'Culinary').every((a) => a.priceINR === undefined)).toBe(true);
    expect(days.flatMap((d) => d.activities).filter((a) => a.description).every((a) => /^Why: |^Nearby: |^Opening hours/.test(a.description))).toBe(true);
    const leg = days[0].activities.find((a) => a.travelToNext);
    expect(leg?.travelToNext).toMatch(/^about \d+ min \(estimated\)$/);
  });

  it('starts a conversation with an empty trip, and sums up a plan for the chat card without hotel or price', () => {
    expect(noTrip()).toEqual({ destination: '', country: '', dates: '', durationDays: 0, travelers: 0, tripType: '', flightIncluded: false, flightPriceINR: 0, hotels: [], days: [] });
    const card = planSummary(draft);
    expect(card).toMatchObject({ destination: 'Goa', duration: '2 Days', dates: 'Tue, 15 Dec – Wed, 16 Dec', daysCount: 2 });
    expect(card.activitiesCount).toBe(draft.days.flatMap((d) => d.items).filter((i) => i.kind === 'activity').length);
    expect(card.day1Activities.map((a) => a.title)).toEqual(draft.days[0].items.filter((i) => i.kind === 'activity').map((i) => i.title));
    expect(card).not.toHaveProperty('hotel');
    expect(card).not.toHaveProperty('totalINR');
  });

  it('fills the trip summary from the plan and the trip, with no hotels or flights', () => {
    expect(planTrip(draft, trip)).toMatchObject({
      destination: 'Goa', country: 'India', dates: 'Tue, 15 Dec – Wed, 16 Dec', durationDays: 2, travelers: 2, tripType: 'honeymoon',
      flightIncluded: false, flightPriceINR: 0, hotels: [],
    });
  });
});

describe('labels', () => {
  it('marks estimated travel times as estimates', () => {
    expect(travelLabel({ minutes: 37, km: 11, basis: 'straight_line_estimate', source: 'Straight-line estimate', isEstimate: true, confidence: 0.5 })).toBe('about 37 min (estimated)');
    expect(travelLabel({ minutes: 24, km: 4, basis: 'road', source: 'OSRM', isEstimate: false, confidence: 0.8 })).toBe('about 24 min by road');
  });

  it('says plainly what was checked and what was not', () => {
    const base = { source: 'Open-Meteo', checkedAt: NOW, severity: 'info', confidence: 0.6 } as const;
    expect(insightLine({ ...base, type: 'weather', title: 'Heavy rain likely', detail: '90% chance of rain', status: 'checked', date: '2026-12-15' } as TripInsight)).toBe('Heavy rain likely, Tue, 15 Dec: 90% chance of rain');
    expect(insightLine({ ...base, type: 'weather', title: 'Heavy rain likely', detail: '80% chance of rain', status: 'stale' } as TripInsight)).toBe('Heavy rain likely (earlier forecast): 80% chance of rain');
    expect(insightLine({ ...base, type: 'event', title: 'Events not checked', detail: 'There is no approved events source yet', status: 'not_checked' } as TripInsight)).toBe('Events not checked: There is no approved events source yet');
  });

  it('credits every source of the plan', () => {
    expect(sourcesLine(draft)).toBe('© OpenStreetMap contributors (ODbL-1.0)');
  });
});
