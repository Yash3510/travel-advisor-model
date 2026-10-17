import { describe, expect, it } from 'vitest';
import { buildImport, overpassQuery, regionFor } from '../src/data/importOsm.js';

const REGION = { slug: 'goa', name: 'Goa', bbox: [14.88, 73.67, 15.81, 74.34] as [number, number, number, number], names: ['Goa', 'Panaji'] };

describe('OSM import', () => {
  it('builds one bounded Overpass query for the place kinds the planner uses', () => {
    const q = overpassQuery(REGION);
    expect(q).toContain('[out:json]');
    expect(q).toContain('(14.88,73.67,15.81,74.34)');
    for (const tag of ['"natural"~"^(beach|waterfall)$"', '"tourism"~"^(attraction|museum', '"diet:vegetarian"~"^(yes|only)$"', 'out center tags']) expect(q).toContain(tag);
  });

  it('records where the data came from so it can be rebuilt byte for byte', () => {
    const raw = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 15.5, lon: 73.8, tags: { tourism: 'museum', name: 'Goa State Museum' } }, { type: 'node', id: 2, lat: 15.5, lon: 73.8, tags: {} }] });
    const out = buildImport(raw, REGION, '2026-10-18');
    expect(out.manifest).toMatchObject({
      region: 'goa', extractedAt: '2026-10-18', source: 'OpenStreetMap via Overpass API', licence: 'ODbL-1.0',
      counts: { elements: 2, pois: 1, rejected: 1 }, rejectedReasons: { 'no name': 1 },
    });
    expect(out.manifest.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.manifest.querySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.pois[0]).toMatchObject({ id: 'osm:node/1', destination: 'goa', source: { checkedAt: '2026-10-18' } });
    expect(buildImport(raw, REGION, '2026-10-18')).toEqual(out);
  });

  it('maps trip destinations to a region', () => {
    expect(regionFor('Panaji', [REGION])?.slug).toBe('goa');
    expect(regionFor('Manali', [REGION])).toBeUndefined();
  });
});
