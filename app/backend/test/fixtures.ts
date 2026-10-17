// Shared builders for tests.
import type { PointOfInterest } from '../src/domain/poi.js';

export const poi = (over: Partial<PointOfInterest>): PointOfInterest => ({
  id: 'osm:node/1', name: 'Place', destination: 'goa', location: { lat: 15.5, lon: 73.8 }, category: 'museum', interests: ['history'],
  indoor: true, kidFriendly: false, goodSlots: ['morning', 'afternoon'], visitDuration: { minutes: 120, basis: 'category_default', confidence: 0.4 },
  openingHours: { basis: 'unknown', confidence: 0 }, accessibility: { wheelchair: 'unknown' }, fee: 'unknown',
  source: { name: 'OpenStreetMap', licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/node/1', checkedAt: '2026-10-17' },
  ...over,
});
