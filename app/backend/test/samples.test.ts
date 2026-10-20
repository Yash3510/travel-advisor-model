import { describe, expect, it } from 'vitest';
import { sample, sampleList } from '../src/domain/samples.js';

describe('sample itineraries', () => {
  it('each sample is a full plan from the engine: the days it promises, mapped stops, no prices', () => {
    const list = sampleList();
    expect(list.length).toBeGreaterThanOrEqual(10);
    for (const card of list) {
      expect(card.slug).toMatch(/^[a-z0-9-]+$/);
      expect(card).not.toHaveProperty('itinerary'); // the list stays small
      const s = sample(card.slug)!;
      expect(s.itinerary.days).toHaveLength(s.days);
      const stops = s.itinerary.days.flatMap((d) => d.items).filter((i) => i.kind === 'activity');
      expect(stops.length).toBeGreaterThanOrEqual(s.days * 2);
      expect(stops.every((i) => i.coordinates)).toBe(true);
      expect(JSON.stringify(s.itinerary)).not.toMatch(/₹|INR/);
    }
  });
  it('unknown slugs are null', () => {
    expect(sample('5-days-on-the-moon')).toBeNull();
  });
});

describe('sitemap', () => {
  it('lists public pages, every destination and sample, and nothing private', async () => {
    const { sitemap } = await import('../src/domain/sitemap.js');
    const xml = sitemap('https://takeoff.example');
    expect(xml).toContain('<loc>https://takeoff.example/destinations/goa</loc>');
    expect(xml).toContain('<loc>https://takeoff.example/trips/3-days-in-jaipur</loc>');
    expect(xml.match(/<url>/g)!.length).toBe(10 + 117 + sampleList().length);
    expect(xml).not.toMatch(/\/(chat|account|trip\/|saved-trips|login)/);
  });
});
