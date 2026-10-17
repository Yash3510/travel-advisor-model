import { describe, expect, it } from 'vitest';
import { applyProfileEdit, emptyProfile, mergeProfile, normalizeItems, profileSummary } from '../src/domain/profile.js';

const NOW = '2026-10-18T10:00:00.000Z';

describe('normalizeItems', () => {
  it('canonicalises synonyms, case and duplicates', () => {
    expect(normalizeItems('interests', ['Beaches', 'seaside', ' Hiking ', 'trekking', 'Heritage'])).toEqual(['beach', 'trekking', 'history']);
    expect(normalizeItems('dietaryNeeds', ['Pure Veg', 'vegetarian'])).toEqual(['vegetarian']);
  });
  it('keeps short free-text items and drops empty or overlong ones', () => {
    expect(normalizeItems('interests', ['street art', '', 'x'.repeat(41)])).toEqual(['street art']);
  });
});

describe('mergeProfile', () => {
  it('adds preferences and records where each came from', () => {
    const p = mergeProfile(emptyProfile(), { set: { travelStyle: 'relaxed' }, add: { interests: ['beach'] } }, 'explicit', NOW);
    expect(p.travelStyle).toBe('relaxed');
    expect(p.interests).toEqual(['beach']);
    expect(p.sourceByField).toEqual({ travelStyle: 'explicit', 'interests:beach': 'explicit' });
    expect(p.updatedAt).toBe(NOW);
  });

  it('merges lists without duplicates', () => {
    const a = mergeProfile(emptyProfile(), { add: { interests: ['beach', 'food'] } }, 'explicit', NOW);
    const b = mergeProfile(a, { add: { interests: ['food', 'history'] } }, 'explicit', NOW);
    expect(b.interests).toEqual(['beach', 'food', 'history']);
  });

  it('lets an explicit value replace an inferred one, never the other way round', () => {
    const inferred = mergeProfile(emptyProfile(), { set: { homeCity: 'Pune' } }, 'inferred', NOW);
    const corrected = mergeProfile(inferred, { set: { homeCity: 'Delhi' } }, 'explicit', NOW);
    expect(corrected.homeCity).toBe('Delhi');
    const notOverwritten = mergeProfile(corrected, { set: { homeCity: 'Mumbai' } }, 'inferred', NOW);
    expect(notOverwritten.homeCity).toBe('Delhi');
    expect(notOverwritten.sourceByField.homeCity).toBe('explicit');
  });

  it('applies the latest explicit correction', () => {
    const relaxed = mergeProfile(emptyProfile(), { set: { travelStyle: 'relaxed' } }, 'explicit', NOW);
    expect(mergeProfile(relaxed, { set: { travelStyle: 'packed' } }, 'explicit', NOW).travelStyle).toBe('packed');
  });

  it('moves an item between interests and dislikes instead of keeping both', () => {
    const likes = mergeProfile(emptyProfile(), { add: { interests: ['nightlife'] } }, 'explicit', NOW);
    const dislikes = mergeProfile(likes, { add: { dislikes: ['nightlife'] } }, 'explicit', NOW);
    expect(dislikes.interests).toEqual([]);
    expect(dislikes.dislikes).toEqual(['nightlife']);
    expect(dislikes.sourceByField['interests:nightlife']).toBeUndefined();
  });

  it('never lets an inferred interest override an explicit dislike', () => {
    const dislike = mergeProfile(emptyProfile(), { add: { dislikes: ['beach'] } }, 'explicit', NOW);
    const after = mergeProfile(dislike, { add: { interests: ['beach'] } }, 'inferred', NOW);
    expect(after.interests).toEqual([]);
    expect(after.dislikes).toEqual(['beach']);
  });

  it('removes items and deletes fields set to null', () => {
    const p = mergeProfile(emptyProfile(), { set: { budgetStyle: 'premium' }, add: { interests: ['beach', 'food'] } }, 'explicit', NOW);
    const q = mergeProfile(p, { set: { budgetStyle: null }, remove: { interests: ['beach'] } }, 'explicit', NOW);
    expect(q.budgetStyle).toBeUndefined();
    expect(q.interests).toEqual(['food']);
    expect(Object.keys(q.sourceByField)).toEqual(['interests:food']);
  });
});

describe('applyProfileEdit (PATCH /api/profile)', () => {
  it('replaces the lists it is given and keeps the rest', () => {
    const p = mergeProfile(emptyProfile(), { add: { interests: ['beach', 'food'], dietaryNeeds: ['vegetarian'] } }, 'explicit', NOW);
    const edited = applyProfileEdit(p, { interests: ['food', 'wildlife'], travelStyle: 'balanced' }, NOW);
    expect(edited.interests).toEqual(['food', 'wildlife']);
    expect(edited.dietaryNeeds).toEqual(['vegetarian']);
    expect(edited.travelStyle).toBe('balanced');
  });
  it('rejects unknown fields and invalid values', () => {
    expect(() => applyProfileEdit(emptyProfile(), { travelStyle: 'speedy' }, NOW)).toThrow(/travelStyle/);
    expect(() => applyProfileEdit(emptyProfile(), { passport: 'X' }, NOW)).toThrow(/passport/);
    expect(() => applyProfileEdit(emptyProfile(), { interests: 'beach' }, NOW)).toThrow(/interests/);
  });
});

describe('profileSummary', () => {
  it('describes saved preferences in one line, or nothing when empty', () => {
    const p = mergeProfile(emptyProfile(), { set: { travelStyle: 'relaxed' }, add: { interests: ['beach', 'food'], dislikes: ['crowds'], dietaryNeeds: ['vegetarian'] } }, 'explicit', NOW);
    expect(profileSummary(p)).toBe('relaxed pace; likes beach and food; avoids crowds; vegetarian');
    expect(profileSummary(emptyProfile())).toBe('');
  });
});
