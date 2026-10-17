import { describe, expect, it } from 'vitest';
import { emptyProfile, mergeProfile } from '../src/domain/profile.js';
import type { TripInsight } from '../src/domain/insights.js';
import { parseOpeningHours } from '../src/domain/openingHours.js';
import { blockedOn, dayPlanRules, eligibility, estimateTravel, fitsOpeningHours, MAX_LEG_MINUTES } from '../src/services/constraints.js';
import { poi } from './fixtures.js';

const NOW = '2026-10-18T00:00:00.000Z';

describe('estimateTravel', () => {
  it('labels straight-line estimates and adds a fixed buffer', () => {
    const t = estimateTravel({ lat: 15.5, lon: 73.8 }, { lat: 15.5, lon: 73.8 });
    expect(t).toEqual({ km: 0, minutes: 10, basis: 'straight_line_estimate', confidence: 0.5 });
    const far = estimateTravel({ lat: 15.0, lon: 74.0 }, { lat: 15.75, lon: 73.75 }); // ~88 km apart
    expect(far.minutes).toBeGreaterThan(MAX_LEG_MINUTES);
  });
});

describe('dayPlanRules', () => {
  it('gives relaxed travellers fewer activities and a rest break, and families less than couples', () => {
    const relaxed = dayPlanRules({ pace: 'relaxed', travelerTypes: [] });
    const packed = dayPlanRules({ pace: 'packed', travelerTypes: [] });
    expect(relaxed.maxActivities).toBeLessThan(packed.maxActivities);
    expect(relaxed.activityMinutes).toBeLessThan(packed.activityMinutes);
    expect(relaxed.breaks.map((b) => b.kind)).toEqual(['lunch', 'rest', 'dinner']);
    expect(packed.breaks.map((b) => b.kind)).toEqual(['lunch', 'dinner']);
    expect(dayPlanRules({ pace: 'packed', travelerTypes: ['kids'] }).maxActivities).toBeLessThan(packed.maxActivities);
  });
});

describe('eligibility', () => {
  const wheelchair = mergeProfile(emptyProfile(), { add: { mobilityNeeds: ['wheelchair'] } }, 'explicit', NOW);
  it('excludes places a wheelchair user cannot reach, and flags unconfirmed access', () => {
    expect(eligibility(poi({ accessibility: { wheelchair: 'no' } }), { profile: wheelchair, travelerTypes: [], excluded: [] })).toMatchObject({ eligible: false });
    expect(eligibility(poi({ category: 'waterfall', accessibility: { wheelchair: 'unknown' } }), { profile: wheelchair, travelerTypes: [], excluded: [] }).eligible).toBe(false);
    const unknown = eligibility(poi({}), { profile: wheelchair, travelerTypes: [], excluded: [] });
    expect(unknown).toMatchObject({ eligible: true });
    expect(unknown.notes).toContain('Wheelchair access is not confirmed for Place');
  });
  it('filters explicit dislikes, nightlife with children, and places the traveller removed', () => {
    const noTemples = mergeProfile(emptyProfile(), { add: { dislikes: ['spiritual'] } }, 'explicit', NOW);
    expect(eligibility(poi({ interests: ['spiritual'] }), { profile: noTemples, travelerTypes: [], excluded: [] }).eligible).toBe(false);
    expect(eligibility(poi({ category: 'nightlife', interests: ['nightlife'] }), { profile: emptyProfile(), travelerTypes: ['kids'], excluded: [] }).eligible).toBe(false);
    expect(eligibility(poi({}), { profile: emptyProfile(), travelerTypes: [], excluded: ['osm:node/1'] }).eligible).toBe(false);
    expect(eligibility(poi({}), { profile: emptyProfile(), travelerTypes: [], excluded: [] }).eligible).toBe(true);
  });
});

describe('fitsOpeningHours and blockedOn', () => {
  it('rejects visits outside known hours and flags unknown hours', () => {
    const open = poi({ openingHours: parseOpeningHours('Tu-Su 09:30-17:30') });
    expect(fitsOpeningHours(open, '2026-12-15', 600, 720)).toBe('yes'); // Tuesday
    expect(fitsOpeningHours(open, '2026-12-14', 600, 720)).toBe('no'); // Monday: closed
    expect(fitsOpeningHours(poi({}), '2026-12-15', 600, 720)).toBe('unknown');
  });
  it('blocks outdoor places on rainy days and places closed on a date', () => {
    const rain: TripInsight = { type: 'weather', title: 'Heavy rain likely', detail: '', source: 'Open-Meteo', checkedAt: NOW, severity: 'warning', confidence: 0.7, status: 'checked', date: '2026-12-15', effect: 'rain' };
    const closed: TripInsight = { type: 'closure', title: 'Closed', detail: '', source: 'OpenStreetMap', checkedAt: NOW, severity: 'blocking', confidence: 0.7, status: 'checked', date: '2026-12-16', poiId: 'osm:node/9', effect: 'closed' };
    expect(blockedOn(poi({ indoor: false, category: 'beach' }), '2026-12-15', [rain])).toBe('rain');
    expect(blockedOn(poi({ indoor: true }), '2026-12-15', [rain])).toBeUndefined();
    expect(blockedOn(poi({ id: 'osm:node/9' }), '2026-12-16', [closed])).toBe('closed');
    expect(blockedOn(poi({ id: 'osm:node/9' }), '2026-12-17', [closed])).toBeUndefined();
  });
});
