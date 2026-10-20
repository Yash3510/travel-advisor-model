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
