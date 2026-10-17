import { describe, expect, it } from 'vitest';
import type { TripInsight } from '../src/domain/insights.js';
import { buildItinerary } from '../src/services/itineraryService.js';
import { checkIntro, fallbackIntro, introRequest, renderItinerary } from '../src/services/presentation.js';
import { NOW, profileWith, TOWN, tripWith } from './fixtures.js';

const trip = tripWith({ destination: 'Goa', startDate: '2026-12-15', endDate: '2026-12-16', durationDays: 2, travelers: 2, purpose: 'honeymoon' });
const profile = profileWith({ set: { travelStyle: 'relaxed' }, add: { interests: ['beach', 'food'] } });
const rain: TripInsight = { type: 'weather', title: 'Heavy rain likely', detail: '90% chance of rain', source: 'Open-Meteo', licence: 'CC BY 4.0', checkedAt: NOW, severity: 'warning', confidence: 0.7, status: 'checked', date: '2026-12-15', effect: 'rain' };
const notChecked: TripInsight = { type: 'event', title: 'Events not checked', detail: 'No approved source', source: 'No approved source yet', checkedAt: NOW, severity: 'info', confidence: 0, status: 'not_checked' };
const insights = [rain, notChecked];
const draft = buildItinerary({ trip, profile, insights, pointsOfInterest: TOWN, version: 1 });
const names = TOWN.map((p) => p.name);
const ctx = { draft, knownPlaceNames: names };

describe('renderItinerary', () => {
  it('writes every day, stop, time, warning, assumption and source from the plan itself', () => {
    const text = renderItinerary(draft, insights);
    expect(text).toMatch(/^Day 1, Tuesday 15 December/m);
    expect(text).toMatch(/^Day 2, Wednesday 16 December/m);
    for (const item of draft.days.flatMap((d) => d.items)) expect(text).toContain(`${item.start}–${item.end} ${item.title}`);
    for (const w of draft.days.flatMap((d) => d.warnings)) expect(text).toContain(w);
    for (const a of draft.assumptions) expect(text).toContain(a);
    expect(text).toContain('Heavy rain likely on 15 December');
    expect(text).toContain('Not checked: events');
    expect(text).toContain('© OpenStreetMap contributors');
    expect(text).toMatch(/Then about \d+ min to the next stop \(estimated\)\./);
    expect(text).not.toMatch(/(?![©®™])\p{Extended_Pictographic}/u);
  });
});

describe('checkIntro', () => {
  it('accepts a short personal note', () => {
    expect(checkIntro('A slow, sunny honeymoon with a beach to start each day and time for good food.', ctx)).toEqual({ ok: true });
  });
  it('rejects prices, dates, times and booking claims', () => {
    expect(checkIntro('Dinner is about ₹2,000 for two.', ctx).ok).toBe(false);
    expect(checkIntro('We start on 18 December.', ctx).ok).toBe(false);
    expect(checkIntro('Be at the beach by 07:30.', ctx).ok).toBe(false);
    expect(checkIntro('Your booking is confirmed!', ctx).ok).toBe(false);
  });
  it('rejects places that are not in the plan, known or invented', () => {
    expect(checkIntro('You will love Club Neon at night.', ctx).ok).toBe(false); // a real place the plan didn't pick
    expect(checkIntro('Finish at the famous Golden Sands Beach.', ctx).ok).toBe(false); // invented
    expect(checkIntro(`It starts at ${draft.days[0].items.find((i) => i.kind === 'activity')!.title}.`, ctx).ok).toBe(true);
  });
  it('rejects empty or overlong text', () => {
    expect(checkIntro('', ctx).ok).toBe(false);
    expect(checkIntro('word '.repeat(200), ctx).ok).toBe(false);
  });
});

describe('introRequest and fallbackIntro', () => {
  it('asks the model only for a short note, and the fallback names the plan honestly', () => {
    const req = introRequest(draft, profile, trip);
    expect(req).toMatch(/two or three sentences/);
    expect(req).toMatch(/don't change or add places, dates, times or prices/i);
    expect(fallbackIntro(draft, profile, trip)).toBe('Here is your 2-day relaxed plan for Goa, built around beach and food, for your honeymoon.');
  });
});
