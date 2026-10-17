import { describe, expect, it } from 'vitest';
import { isOpen, parseOpeningHours } from '../src/domain/openingHours.js';
import { normalizeOsm, type OsmElement } from '../src/data/osm.js';

const META = { destination: 'goa', checkedAt: '2026-10-18' };
const node = (id: number, tags: Record<string, string>, lat = 15.5, lon = 73.8): OsmElement => ({ type: 'node', id, lat, lon, tags });

describe('parseOpeningHours', () => {
  it('reads day ranges, several rules and closed days', () => {
    const oh = parseOpeningHours('Mo-Fr 09:00-17:00; Sa 10:00-14:00; Su off');
    expect(oh.basis).toBe('osm');
    expect(oh.weekly![0]).toEqual([[540, 1020]]);
    expect(oh.weekly![5]).toEqual([[600, 840]]);
    expect(oh.weekly![6]).toEqual([]);
  });
  it('treats days no rule mentions as closed, as OSM does', () => {
    expect(parseOpeningHours('Tu-Su 10:00-18:00').weekly![0]).toEqual([]);
  });
  it('reads 24/7, split days, overnight hours and day lists', () => {
    expect(parseOpeningHours('24/7').weekly![3]).toEqual([[0, 1440]]);
    expect(parseOpeningHours('09:00-13:00,14:00-18:00').weekly![2]).toEqual([[540, 780], [840, 1080]]);
    expect(parseOpeningHours('Fr,Sa 18:00-02:00').weekly![4]).toEqual([[1080, 1560]]);
  });
  it('approximates sunrise-sunset with lower confidence', () => {
    const oh = parseOpeningHours('sunrise-sunset');
    expect(oh.weekly![0]).toEqual([[360, 1110]]);
    expect(oh.confidence).toBeLessThan(parseOpeningHours('Mo-Su 09:00-17:00').confidence);
  });
  it('ignores public-holiday rules, but keeps anything else it cannot read as unknown', () => {
    expect(parseOpeningHours('Mo-Sa 09:00-18:00; PH off').weekly![0]).toEqual([[540, 1080]]);
    const odd = parseOpeningHours('Jan-Mar 09:00-17:00');
    expect(odd).toMatchObject({ basis: 'unparsed', raw: 'Jan-Mar 09:00-17:00', confidence: 0.1 });
    expect(odd.weekly).toBeUndefined();
    expect(parseOpeningHours(undefined)).toEqual({ basis: 'unknown', confidence: 0 });
  });
  it('answers yes, no or unknown for a visit window', () => {
    const oh = parseOpeningHours('Mo-Fr 09:00-13:00,14:00-18:00');
    expect(isOpen(oh, '2026-12-14', 600, 720)).toBe('yes'); // Monday 10:00-12:00
    expect(isOpen(oh, '2026-12-14', 720, 870)).toBe('no'); // runs into the lunch break
    expect(isOpen(oh, '2026-12-13', 600, 660)).toBe('no'); // Sunday
    expect(isOpen(parseOpeningHours(undefined), '2026-12-14', 600, 660)).toBe('unknown');
  });
});

describe('normalizeOsm', () => {
  it('turns an OSM museum into a place with category, interests, duration assumption and source', () => {
    const { pois } = normalizeOsm([node(1, { tourism: 'museum', name: '  Goa   State Museum ', opening_hours: 'Tu-Su 09:30-17:30', wheelchair: 'yes', fee: 'no' })], META);
    expect(pois[0]).toMatchObject({
      id: 'osm:node/1', name: 'Goa State Museum', destination: 'goa', category: 'museum', interests: ['history', 'culture'], indoor: true,
      location: { lat: 15.5, lon: 73.8 }, fee: 'free', accessibility: { wheelchair: 'yes' },
      visitDuration: { minutes: 120, basis: 'category_default' },
      openingHours: { basis: 'osm' },
      source: { name: 'OpenStreetMap', licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/node/1', checkedAt: '2026-10-18' },
    });
    expect(pois[0].visitDuration.confidence).toBeLessThan(0.5);
  });

  it('uses way and relation centres, prefers English names, and reads fees, access and diet tags', () => {
    const { pois } = normalizeOsm([
      { type: 'way', id: 2, center: { lat: 15.55, lon: 73.75 }, tags: { natural: 'beach', name: 'कलंगुट', 'name:en': 'Calangute Beach' } },
      node(3, { amenity: 'restaurant', name: 'Veg Thali House', 'diet:vegetarian': 'only', 'diet:jain': 'yes' }),
      node(4, { historic: 'fort', name: 'Aguada Fort', charge: '50 INR', wheelchair: 'limited' }),
    ], META);
    expect(pois.map((p) => [p.id, p.name, p.category])).toEqual([
      ['osm:node/3', 'Veg Thali House', 'restaurant'], ['osm:node/4', 'Aguada Fort', 'heritage'], ['osm:way/2', 'Calangute Beach', 'beach'],
    ]);
    expect(pois[0].diet).toEqual(['vegetarian', 'jain']);
    expect(pois[1]).toMatchObject({ fee: 'paid', feeInr: 50, accessibility: { wheelchair: 'limited' } });
    expect(pois[2]).toMatchObject({ indoor: false, kidFriendly: true });
  });

  it('keeps unknown hours, access and fees explicit', () => {
    const { pois } = normalizeOsm([node(5, { tourism: 'viewpoint', name: 'Sunset Point' })], META);
    expect(pois[0]).toMatchObject({ openingHours: { basis: 'unknown', confidence: 0 }, accessibility: { wheelchair: 'unknown' }, fee: 'unknown' });
    expect(pois[0].feeInr).toBeUndefined();
  });

  it('rejects records without a name, with bad coordinates, or of a kind it does not plan', () => {
    const { pois, rejected } = normalizeOsm([
      node(6, { tourism: 'museum' }),
      node(7, { tourism: 'museum', name: 'Nowhere Museum' }, 95, 73.8),
      { type: 'way', id: 8, tags: { tourism: 'museum', name: 'No Centre Museum' } },
      node(9, { amenity: 'parking', name: 'Car Park' }),
      node(10, { tourism: 'museum', name: 'Null Island Museum' }, 0, 0),
    ], META);
    expect(pois).toEqual([]);
    expect(rejected).toEqual([
      { id: 'osm:node/6', reason: 'no name' },
      { id: 'osm:node/7', reason: 'invalid coordinates' },
      { id: 'osm:node/9', reason: 'not a place to visit' },
      { id: 'osm:node/10', reason: 'invalid coordinates' },
      { id: 'osm:way/8', reason: 'invalid coordinates' },
    ]);
  });

  it('merges duplicates: same name close together, or the same Wikidata item', () => {
    const { pois, rejected } = normalizeOsm([
      node(11, { tourism: 'attraction', name: 'Basilica of Bom Jesus' }, 15.5009, 73.9116),
      { type: 'way', id: 12, center: { lat: 15.501, lon: 73.9118 }, tags: { amenity: 'place_of_worship', name: 'Basilica of Bom Jesus', opening_hours: 'Mo-Su 09:00-18:30', wikidata: 'Q1' } },
      node(13, { historic: 'monument', name: 'Bom Jesus Basilica', wikidata: 'Q1' }, 15.502, 73.912),
      node(14, { amenity: 'place_of_worship', name: 'Shiva Temple' }, 15.2, 74.0),
      node(15, { amenity: 'place_of_worship', name: 'Shiva Temple' }, 15.7, 73.8),
    ], META);
    expect(pois.map((p) => p.id)).toEqual(['osm:node/14', 'osm:node/15', 'osm:way/12']);
    expect(pois[2].duplicates).toEqual(['osm:node/11', 'osm:node/13']);
    expect(rejected).toEqual([]);
  });

  it('is deterministic: the same input gives the same output in any order', () => {
    const els = [node(21, { tourism: 'museum', name: 'A' }), node(20, { natural: 'beach', name: 'B' })];
    expect(normalizeOsm(els, META)).toEqual(normalizeOsm(els.toReversed(), META));
  });
});
