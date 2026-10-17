// Shared builders for tests.
import { parseOpeningHours } from '../src/domain/openingHours.js';
import type { PointOfInterest } from '../src/domain/poi.js';
import { emptyProfile, mergeProfile, type ProfilePatch } from '../src/domain/profile.js';
import { emptyTrip, mergeTrip, type TripContext } from '../src/domain/trip.js';

export const poi = (over: Partial<PointOfInterest>): PointOfInterest => ({
  id: 'osm:node/1', name: 'Place', destination: 'goa', location: { lat: 15.5, lon: 73.8 }, category: 'museum', interests: ['history'],
  indoor: true, kidFriendly: false, goodSlots: ['morning', 'afternoon'], visitDuration: { minutes: 120, basis: 'category_default', confidence: 0.4 },
  openingHours: { basis: 'unknown', confidence: 0 }, accessibility: { wheelchair: 'unknown' }, fee: 'unknown',
  source: { name: 'OpenStreetMap', licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/node/1', checkedAt: '2026-10-17' },
  ...over,
});

export const NOW = '2026-10-18T00:00:00.000Z';
export const profileWith = (patch: ProfilePatch) => mergeProfile(emptyProfile(), patch, 'explicit', NOW);
export const tripWith = (facts: Partial<TripContext>) => mergeTrip(emptyTrip(), { travelerTypes: [], ...facts }, NOW);

// a small town: places within a few kilometres of each other
export const at = (i: number) => ({ lat: 15.5 + (i % 5) * 0.01, lon: 73.8 + Math.floor(i / 5) * 0.01 });
export const TOWN: PointOfInterest[] = [
  poi({ id: 'osm:node/1', name: 'Sunny Beach', category: 'beach', interests: ['beach'], indoor: false, kidFriendly: true, goodSlots: ['morning', 'evening'], visitDuration: { minutes: 150, basis: 'category_default', confidence: 0.4 }, location: at(1) }),
  poi({ id: 'osm:node/2', name: 'Quiet Beach', category: 'beach', interests: ['beach'], indoor: false, kidFriendly: true, goodSlots: ['morning', 'evening'], visitDuration: { minutes: 150, basis: 'category_default', confidence: 0.4 }, location: at(2) }),
  poi({ id: 'osm:node/3', name: 'Old Fort', category: 'heritage', interests: ['history'], indoor: false, location: at(3), openingHours: parseOpeningHours('Mo-Su 09:00-17:30'), fee: 'paid', feeInr: 50, visitDuration: { minutes: 90, basis: 'category_default', confidence: 0.4 } }),
  poi({ id: 'osm:node/4', name: 'Town Museum', category: 'museum', interests: ['history', 'culture'], indoor: true, location: at(4), openingHours: parseOpeningHours('Tu-Su 09:30-17:30'), fee: 'free' }),
  poi({ id: 'osm:node/5', name: 'Spice Market', category: 'market', interests: ['shopping', 'food'], indoor: false, location: at(5), goodSlots: ['morning', 'evening'], visitDuration: { minutes: 90, basis: 'category_default', confidence: 0.4 } }),
  poi({ id: 'osm:node/6', name: 'Club Neon', category: 'nightlife', interests: ['nightlife'], indoor: true, location: at(6), goodSlots: ['evening'], accessibility: { wheelchair: 'no' } }),
  poi({ id: 'osm:node/7', name: 'Hill Temple', category: 'place_of_worship', interests: ['spiritual', 'history'], indoor: true, location: at(7), visitDuration: { minutes: 45, basis: 'category_default', confidence: 0.4 }, accessibility: { wheelchair: 'yes' } }),
  poi({ id: 'osm:node/8', name: 'Green Park', category: 'park', interests: ['nature'], indoor: false, kidFriendly: true, location: at(8), visitDuration: { minutes: 60, basis: 'category_default', confidence: 0.4 }, fee: 'free' }),
  poi({ id: 'osm:node/9', name: 'Veg Thali House', category: 'restaurant', interests: ['food'], indoor: true, location: at(9), diet: ['vegetarian', 'jain'], goodSlots: [] }),
];

