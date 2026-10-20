import { describe, expect, it } from 'vitest';
import { guideEntry } from '../src/domain/guide.js';
import { MockBackend } from '../src/tools.js';

describe('destination guide (same rules as travel/kb.py lookup)', () => {
  it('finds a place by name, alias, region fallback or comma part', () => {
    expect(guideEntry('Munnar')?.destination).toBe('Munnar');
    expect(guideEntry('Trivandrum')?.destination).toBe('Thiruvananthapuram');
    expect(guideEntry('Ladakh')?.destination).toBe('Ladakh');
    expect(guideEntry('Pondy')?.destination).toBe('Pondicherry');
    expect(guideEntry('Leh, Ladakh, India')?.destination).toBe('Leh');
  });
  it('never matches a substring: a made-up place is not found', () => {
    expect(guideEntry('Floating Glass Temple near Bundi')).toBeNull();
    expect(guideEntry('Atlantis')).toBeNull();
  });
  it('the tool returns verbatim sentences with the source, or found:false', async () => {
    const tools = new MockBackend('data/catalog.json');
    const hit = await tools.call('get_destination_info', { destination: 'Goa' }) as Record<string, unknown>;
    expect(hit).toMatchObject({ found: true, source: 'Wikivoyage (CC BY-SA 4.0)' });
    expect(JSON.stringify(hit.climate)).toContain('November');
    expect(await tools.call('get_destination_info', { destination: 'Atlantis' })).toMatchObject({ found: false });
  });
});

describe('public destination pages', () => {
  it('lists every place once, sorted, with a URL-safe slug', async () => {
    const { guideList } = await import('../src/domain/guide.js');
    const list = guideList();
    expect(list.length).toBe(117);
    expect(list.every((d) => /^[a-z-]+$/.test(d.slug))).toBe(true);
    expect(list.map((d) => d.name)).toEqual(list.map((d) => d.name).toSorted((a, b) => a.localeCompare(b)));
  });
  it('a page has tidy verbatim sentences and its source; unknown slugs are null', async () => {
    const { guidePage } = await import('../src/domain/guide.js');
    const goa = guidePage('goa')!;
    expect(goa.whenToGo.join(' ')).toContain('mid-November to mid-February');
    expect(goa.gettingThere.air.some((s) => /^\d+\s/.test(s))).toBe(false);
    expect(goa.sourceUrl).toMatch(/^https:\/\/en\.wikivoyage\.org\//);
    expect(guidePage('mcleod-ganj')?.slug).toBe('mcleod-ganj');
    expect(guidePage('agra')!.summary).toMatch(/^Agra, a city/);
    expect(guidePage('atlantis')).toBeNull();
    expect(guidePage('constructor')).toBeNull();
  });
});
