import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { extractFacts } from '../src/domain/extract.js';

const TODAY = '2026-10-14'; // a Wednesday
const x = (text: string) => extractFacts(text, TODAY, config.catalogPath);

describe('destination and origin', () => {
  it('finds Indian places, aliases and catalog regions', () => {
    expect(x('Plan a trip to Goa').trip.destination).toBe('Goa');
    expect(x('thinking of pondy for a few days').trip.destination).toBe('Puducherry');
    expect(x('Bali honeymoon').trip.destination).toBe('Bali');
  });
  it('tells the origin from the destination', () => {
    expect(x('from Delhi to Manali').trip).toMatchObject({ origin: 'Delhi', destination: 'Manali' });
    expect(x('flying out of Mumbai').trip.origin).toBe('Mumbai');
  });
  it('falls back to a capitalised place name after "to" or "visit"', () => {
    expect(x('We want to visit Xyzabad next month').trip.destination).toBe('Xyzabad');
    expect(x('I want to Relax').trip.destination).toBeUndefined();
  });
});

describe('dates and duration', () => {
  it('reads day-month ranges and counts days', () => {
    expect(x('12 to 15 December').trip).toMatchObject({ startDate: '2026-12-12', endDate: '2026-12-15', durationDays: 4 });
    expect(x('Dec 28 - Jan 3').trip).toMatchObject({ startDate: '2026-12-28', endDate: '2027-01-03', durationDays: 7 });
    expect(x('from 2026-11-02 to 2026-11-05').trip).toMatchObject({ startDate: '2026-11-02', endDate: '2026-11-05' });
  });
  it('rolls past dates into next year', () => {
    expect(x('leaving 5th March').trip.startDate).toBe('2027-03-05');
  });
  it('keeps a month when no day is given', () => {
    expect(x('sometime in December').trip).toMatchObject({ month: 12 });
    expect(x('sometime in December').trip.startDate).toBeUndefined();
  });
  it('understands relative dates', () => {
    expect(x('this weekend').trip).toMatchObject({ startDate: '2026-10-17', endDate: '2026-10-18', durationDays: 2 });
    expect(x('next weekend').trip).toMatchObject({ startDate: '2026-10-24', endDate: '2026-10-25' });
    expect(x('leaving tomorrow').trip.startDate).toBe('2026-10-15');
    expect(x('next month').trip.month).toBe(11);
  });
  it('reads durations in days, nights and weeks', () => {
    expect(x('a 5 day trip').trip.durationDays).toBe(5);
    expect(x('five days').trip.durationDays).toBe(5);
    expect(x('4 nights').trip.durationDays).toBe(5);
    expect(x('a week in Kerala').trip.durationDays).toBe(7);
    expect(x('2 weeks').trip.durationDays).toBe(14);
    expect(x('a long weekend').trip.durationDays).toBe(3);
  });
});

describe('party, budget and purpose', () => {
  it('counts travellers', () => {
    expect(x('for 2').trip.travelers).toBe(2);
    expect(x('3 adults').trip.travelers).toBe(3);
    expect(x('family of 4').trip).toMatchObject({ travelers: 4, travelerTypes: ['family'] });
    expect(x('me and my wife').trip).toMatchObject({ travelers: 2, travelerTypes: ['couple'] });
    expect(x('going solo').trip).toMatchObject({ travelers: 1, travelerTypes: ['solo'] });
    expect(x('with 3 friends').trip).toMatchObject({ travelers: 4, travelerTypes: ['friends'] });
    expect(x('hum 2 log hain').trip.travelers).toBe(2);
  });
  it('does not mistake durations or money for party size', () => {
    expect(x('for 5 days').trip.travelers).toBeUndefined();
    expect(x('for 50k').trip.travelers).toBeUndefined();
  });
  it('reads budgets as totals or per person', () => {
    expect(x('budget 1 lakh').trip).toMatchObject({ budgetInr: 100000, budgetPerPerson: false });
    expect(x('under 50k per person').trip).toMatchObject({ budgetInr: 50000, budgetPerPerson: true });
    expect(x('we can spend ₹80,000').trip.budgetInr).toBe(80000);
    expect(x('a 5 day trip').trip.budgetInr).toBeUndefined();
  });
  it('reads the purpose, and a honeymoon means two travellers', () => {
    expect(x('our anniversary').trip.purpose).toBe('anniversary');
    expect(x('honeymoon in Bali').trip).toMatchObject({ purpose: 'honeymoon', travelers: 2, travelerTypes: ['couple'] });
  });
});

describe('preferences for the profile', () => {
  it('separates likes from dislikes within a sentence', () => {
    const { explicit } = x('I love beaches but hate crowds').profile;
    expect(explicit.add).toMatchObject({ interests: ['beach'], dislikes: ['crowds'] });
  });
  it('reads pace, budget style, diet, mobility and stay type as explicit', () => {
    const { explicit } = x('relaxed pace, luxury stays, vegetarian, my dad uses a wheelchair, private pool villa').profile;
    expect(explicit.set).toMatchObject({ travelStyle: 'relaxed', budgetStyle: 'premium' });
    expect(explicit.add).toMatchObject({ dietaryNeeds: ['vegetarian'], mobilityNeeds: ['wheelchair'], accommodationPreferences: ['villa', 'private pool'] });
  });
  it('does not read "non-veg" as vegetarian', () => {
    expect(x('non-veg is fine').profile.explicit.add?.dietaryNeeds ?? []).toEqual([]);
  });
  it('treats unprompted mentions and the origin as inferred', () => {
    const { inferred } = x('a beach holiday from Pune').profile;
    expect(inferred.add?.interests).toEqual(['beach']);
    expect(inferred.set?.homeCity).toBe('Pune');
  });
  it('flags contradictory pace in one message', () => {
    expect(x('relaxed, but we also want to see everything').paceConflict).toBe(true);
    expect(x('relaxed please').paceConflict).toBe(false);
  });
});

describe('Hinglish and empty messages', () => {
  it('reads a mixed-language message', () => {
    expect(x('hum 2 log hain, Goa jana hai December mein').trip).toMatchObject({ travelers: 2, destination: 'Goa', month: 12 });
  });
  it('reports when a message has no trip facts', () => {
    expect(x('hello there').hasTripFacts).toBe(false);
    expect(x('4 days').hasTripFacts).toBe(true);
  });
});
