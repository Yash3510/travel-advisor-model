import { describe, expect, it } from 'vitest';
import type { TripInsight } from '../src/domain/insights.js';
import { fromClock, type ItineraryDraft } from '../src/domain/itinerary.js';
import { emptyProfile } from '../src/domain/profile.js';
import type { TripContext } from '../src/domain/trip.js';
import { buildItinerary } from '../src/services/itineraryService.js';
import { at, NOW, poi, profileWith, TOWN, tripWith } from './fixtures.js';

const build = (trip: TripContext, profile = emptyProfile(), insights: TripInsight[] = [], pois = TOWN) =>
  buildItinerary({ trip, profile, insights, pointsOfInterest: pois, version: 1 });

const activities = (d: ItineraryDraft) => d.days.flatMap((day) => day.items.filter((i) => i.kind === 'activity'));

function expectValidDays(d: ItineraryDraft) {
  for (const day of d.days) {
    let cursor = 0;
    for (const item of day.items) {
      expect(fromClock(item.start)).toBeGreaterThanOrEqual(cursor); // no overlaps, in order
      expect(fromClock(item.end)).toBeGreaterThan(fromClock(item.start));
      cursor = fromClock(item.end);
    }
  }
}

describe('buildItinerary', () => {
  it('builds a dated day-by-day plan with blocks, breaks, travel times and reasons', () => {
    const d = build(tripWith({ destination: 'Goa', startDate: '2026-12-15', endDate: '2026-12-16', durationDays: 2, travelers: 2, travelerTypes: ['couple'], purpose: 'honeymoon' }),
      profileWith({ set: { travelStyle: 'relaxed' }, add: { interests: ['beach', 'food'] } }));
    expect(d.days.map((x) => x.date)).toEqual(['2026-12-15', '2026-12-16']);
    expectValidDays(d);
    for (const day of d.days) {
      expect(day.items.filter((i) => i.kind === 'activity').length).toBeLessThanOrEqual(3); // relaxed
      expect(day.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['meal', 'rest']));
    }
    const acts = activities(d);
    // one beach a day for a beach lover, rather than both on day 1
    expect(d.days.map((day) => day.items.find((i) => i.kind === 'activity')!.title).toSorted()).toEqual(['Quiet Beach', 'Sunny Beach']);
    expect(acts[0].why!.matched).toContain('your interest in beach');
    expect(acts.every((a) => a.block && a.source?.attribution === '© OpenStreetMap contributors')).toBe(true);
    expect(d.days[0].items.filter((i) => i.kind === 'activity').slice(0, -1).every((a) => a.travelToNext?.basis === 'straight_line_estimate')).toBe(true);
    expect(d.sources).toContainEqual(expect.objectContaining({ name: 'OpenStreetMap', attribution: '© OpenStreetMap contributors' }));
    expect(d.assumptions).toEqual(expect.arrayContaining([expect.stringMatching(/typical/), expect.stringMatching(/straight-line/)]));
  });

  it('never breaks hard constraints: wheelchair access, dislikes, nightlife with children', () => {
    const wheelchair = build(tripWith({ destination: 'Goa', durationDays: 2, travelers: 2 }), profileWith({ add: { mobilityNeeds: ['wheelchair'], interests: ['nightlife'] } }));
    expect(activities(wheelchair).map((a) => a.title)).not.toContain('Club Neon');
    expect(wheelchair.rejected).toContainEqual(expect.objectContaining({ poiId: 'osm:node/6', reason: 'Club Neon is not wheelchair accessible' }));
    expect(activities(wheelchair).filter((a) => a.title === 'Town Museum').every((a) => a.notes.includes('Wheelchair access is not confirmed for Town Museum'))).toBe(true);

    const noHistory = build(tripWith({ destination: 'Goa', durationDays: 3, travelers: 2 }), profileWith({ add: { dislikes: ['history'] } }));
    expect(activities(noHistory).map((a) => a.title)).not.toEqual(expect.arrayContaining(['Old Fort']));
    expect(activities(noHistory).map((a) => a.title)).not.toContain('Town Museum');

    const kids = build(tripWith({ destination: 'Goa', durationDays: 3, travelers: 4, travelerTypes: ['family', 'kids'] }), profileWith({ add: { interests: ['nightlife'] } }));
    expect(activities(kids).map((a) => a.title)).not.toContain('Club Neon');
  });

  it('keeps places out on days they are closed, and visits only inside known hours', () => {
    // 2026-12-14 is a Monday: the museum is closed
    const d = build(tripWith({ destination: 'Goa', startDate: '2026-12-14', endDate: '2026-12-14', durationDays: 1, travelers: 2 }), profileWith({ set: { travelStyle: 'packed' }, add: { interests: ['history'] } }));
    expect(activities(d).map((a) => a.title)).not.toContain('Town Museum');
    const fort = activities(d).find((a) => a.title === 'Old Fort')!;
    expect(fromClock(fort.start)).toBeGreaterThanOrEqual(9 * 60);
    expect(fromClock(fort.end)).toBeLessThanOrEqual(17 * 60 + 30);
    expect(fort.hours).toBe('open');
  });

  it('marks unknown opening hours with an assumption and lower confidence', () => {
    const d = build(tripWith({ destination: 'Goa', durationDays: 1, travelers: 2 }), profileWith({ add: { interests: ['beach', 'history'] } }));
    const beach = activities(d).find((a) => a.title.endsWith('Beach'))!;
    const fort = activities(d).find((a) => a.title === 'Old Fort')!;
    expect(beach.hours).toBe('unknown');
    expect(beach.confidence).toBeLessThan(fort.confidence);
    expect(d.assumptions).toEqual(expect.arrayContaining([expect.stringMatching(/opening hours/i)]));
  });

  it('moves outdoor places off a rainy day and says so', () => {
    const rain: TripInsight = { type: 'weather', title: 'Heavy rain likely', detail: '', source: 'Open-Meteo', checkedAt: NOW, severity: 'warning', confidence: 0.7, status: 'checked', date: '2026-12-15', effect: 'rain' };
    const d = build(tripWith({ destination: 'Goa', startDate: '2026-12-15', endDate: '2026-12-16', durationDays: 2, travelers: 2 }), profileWith({ add: { interests: ['beach'] } }), [rain]);
    const day1 = d.days[0].items.filter((i) => i.kind === 'activity');
    expect(day1.every((a) => TOWN.find((p) => p.id === a.poiId)!.indoor)).toBe(true);
    expect(d.days[0].warnings.join(' ')).toMatch(/rain/i);
    expect(d.days[1].items.some((i) => i.title.endsWith('Beach'))).toBe(true);
  });

  it('does not join places that are too far apart for one day', () => {
    const far = poi({ id: 'osm:node/50', name: 'Distant Falls', category: 'waterfall', interests: ['nature'], indoor: false, location: { lat: 14.2, lon: 74.4 } });
    const d = build(tripWith({ destination: 'Goa', durationDays: 1, travelers: 2 }), profileWith({ add: { interests: ['nature', 'beach'] } }), [], [...TOWN, far]);
    const titles = activities(d).map((a) => a.title);
    expect(titles.includes('Distant Falls') && titles.includes('Sunny Beach')).toBe(false);
    expect(d.warnings.join(' ')).toMatch(/too far/);
  });

  it('totals only costs backed by data, per traveller, and warns when over budget', () => {
    const d = build(tripWith({ destination: 'Goa', durationDays: 1, travelers: 3, budgetInr: 100 }), profileWith({ set: { travelStyle: 'packed' }, add: { interests: ['history'] } }));
    const fort = activities(d).find((a) => a.title === 'Old Fort')!;
    expect(fort).toMatchObject({ costInr: 150, costBasis: 'osm_charge' });
    expect(d.totalEstimatedCostInr).toBe(activities(d).reduce((s, a) => s + (a.costInr ?? 0), 0));
    expect(d.warnings.join(' ')).toMatch(/budget/);
    expect(activities(d).filter((a) => a.title !== 'Old Fort').every((a) => a.costInr === undefined)).toBe(true);
  });

  it('suggests only meal places that match a vegetarian or Jain diet', () => {
    const d = build(tripWith({ destination: 'Goa', durationDays: 1, travelers: 2 }), profileWith({ add: { dietaryNeeds: ['jain'] } }));
    const lunch = d.days[0].items.find((i) => i.kind === 'meal')!;
    expect(lunch.suggestions).toEqual([{ poiId: 'osm:node/9', name: 'Veg Thali House', diet: ['vegetarian', 'jain'] }]);
    const none = build(tripWith({ destination: 'Goa', durationDays: 1, travelers: 2 }), profileWith({ add: { dietaryNeeds: ['vegan'] } }));
    expect(none.days[0].items.find((i) => i.kind === 'meal')!.notes.join(' ')).toMatch(/no vegan/i);
  });

  it('steers vegetarians away from fish and meat markets, and says it cannot check crowds', () => {
    const fish = poi({ id: 'osm:node/60', name: 'Harbour Fish Market', category: 'market', interests: ['shopping', 'food'], indoor: false, location: at(10), wikidata: 'Q9' });
    const d = build(tripWith({ destination: 'Goa', durationDays: 1, travelers: 2 }), profileWith({ add: { interests: ['food'], dislikes: ['crowds'], dietaryNeeds: ['vegetarian'] } }), [], [...TOWN, fish]);
    expect(activities(d).map((a) => a.title)).toContain('Spice Market');
    expect(activities(d).map((a) => a.title)).not.toContain('Harbour Fish Market');
    expect(d.assumptions).toContain("Crowd levels aren't in our data, so quieter times can't be guaranteed");
  });

  it('offers cheaper, more relaxed and more adventurous alternatives from the same places', () => {
    const d = build(tripWith({ destination: 'Goa', durationDays: 2, travelers: 2 }), profileWith({ set: { travelStyle: 'packed' }, add: { interests: ['history'] } }));
    const kinds = d.alternatives.map((a) => a.kind);
    expect(kinds).toContain('more_relaxed');
    expect(d.alternatives.every((a) => a.changes.length > 0)).toBe(true);
  });

  it('is deterministic', () => {
    const t = tripWith({ destination: 'Goa', durationDays: 2, travelers: 2 });
    expect(build(t)).toEqual(build(t));
  });
});
