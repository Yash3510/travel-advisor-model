import { describe, expect, it } from 'vitest';
import { feasibilityNotes, placesMentioned, withFeasibility } from '../src/domain/feasibility.js';
import { groundSearch } from '../src/services/toolGrounding.js';

describe('feasibility notes (D-023)', () => {
  it('flags islands asked for by land, not by air or sea', () => {
    expect(feasibilityNotes('Plan a train trip from Chennai to the Andaman Islands', {}).map((n) => n.kind)).toEqual(['island_by_land']);
    expect(feasibilityNotes('Can we drive to Havelock?', {})).toHaveLength(1);
    expect(feasibilityNotes('Flights to Port Blair in December', {})).toEqual([]);
    expect(feasibilityNotes('A train trip to Kerala', {})).toEqual([]);
  });

  it('flags too many places for the days, and says why a relaxed pace cannot work', () => {
    const msg = 'I want to see Delhi, Agra, Jaipur, Udaipur, Jodhpur and Varanasi in 4 days, and I want the trip to be relaxed.';
    expect(placesMentioned(msg)).toHaveLength(6);
    const [note] = feasibilityNotes(msg, { durationDays: 4 });
    expect(note.kind).toBe('too_many_places');
    expect(note.text).toContain("6 places in 4 days");
    expect(note.text).toContain("can't feel relaxed");
    expect(feasibilityNotes(msg, { durationDays: 12 })).toEqual([]);
    expect(feasibilityNotes('Delhi and Agra in 3 days', { durationDays: 3 })).toEqual([]);
  });

  it('adds a note only when the reply has not already said it', () => {
    const notes = feasibilityNotes('train to the Andamans', {});
    expect(withFeasibility('You can fly to Port Blair from Chennai.', notes)).toBe('You can fly to Port Blair from Chennai.');
    expect(withFeasibility('Sounds lovely!', notes)).toContain('no train or road');
  });
});

const known = (trip: object, userText = '') => ({ trip, userText });

describe('searches use only what the customer said (D-023)', () => {
  it('asks for missing dates and travellers instead of guessing', () => {
    expect(groundSearch('search_hotels', { city: 'Goa', check_in: '2026-12-01', check_out: '2026-12-05', guests: 2 }, known({}))).toEqual({
      missing: ['check-in date', 'check-out date or number of nights', 'number of guests'],
    });
  });
  it('fills the search from the trip, overriding what the model made up', () => {
    const r = groundSearch('search_hotels', { city: 'Goa', check_in: '2026-12-01', check_out: '2026-12-09', guests: 4 },
      known({ startDate: '2026-12-10', durationDays: 4, travelerTypes: ['couple'] }));
    expect(r).toEqual({ args: { city: 'Goa', check_in: '2026-12-10', check_out: '2026-12-14', guests: 2 } });
  });
  it('accepts a departure city only if the customer named it', () => {
    const trip = { startDate: '2026-12-10', travelers: 2, travelerTypes: [] };
    expect(groundSearch('search_flights', { origin: 'Mumbai', destination: 'Goa' }, known(trip, 'goa for two on 10 december'))).toEqual({ missing: ['departure city'] });
    expect(groundSearch('search_flights', { origin: 'Mumbai', destination: 'Goa' }, known(trip, 'from mumbai to goa'))).toMatchObject({ args: { origin: 'Mumbai', date: '2026-12-10', passengers: 2 } });
  });
});
