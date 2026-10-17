// The app sends the model the exact prompt and tool schemas it was trained with. Both live in this
// repository's Python side too; these tests fail if the two copies drift apart.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/prompts.js';
import { toolSchemas } from '../src/tools.js';

const repoFile = (p: string) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('model sync', () => {
  it('uses prompts/runtime_system_prompt.txt word for word', () => {
    const trained = repoFile('prompts/runtime_system_prompt.txt').trim();
    expect(buildSystemPrompt('2026-10-17').startsWith(`${trained}\n\nDEPLOYMENT CONTEXT\n`)).toBe(true);
  });

  it('sends the tools from travel/tools.py with the same names, descriptions and fields', () => {
    const py = repoFile('travel/tools.py');
    const trained = [...py.matchAll(/_fn\("(\w+)",\s*((?:"[^"]*"\s*)+),\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map((m) => ({
      name: m[1],
      description: [...m[2].matchAll(/"([^"]*)"/g)].map((s) => s[1]).join(''),
      fields: [...m[3].matchAll(/"(\w+)":/g)].map((f) => f[1]).filter((f) => !["type", "items", "enum"].includes(f)).toSorted(),
    }));
    const sent = toolSchemas.map(({ function: f }) => ({ name: f.name, description: f.description, fields: Object.keys(f.parameters.properties).toSorted() }));
    expect(trained).toHaveLength(8);
    expect(sent).toEqual(trained);
  });

  it('knows every place in the travel guide list (travel/kb.py → data/places.json)', () => {
    const py = repoFile('travel/kb.py');
    const keys = (name: string) => {
      const start = py.indexOf(`${name} = {`);
      const block = py.slice(start, py.indexOf('\n}', start));
      return [...block.matchAll(/"([^"]+)":\s*"/g)].map((m) => m[1]).toSorted();
    };
    const exported = JSON.parse(repoFile('app/backend/data/places.json')) as { places: object; aliases: object };
    expect(keys('DESTINATIONS').length).toBeGreaterThan(100);
    expect(Object.keys(exported.places).toSorted()).toEqual(keys('DESTINATIONS'));
    expect(Object.keys(exported.aliases).toSorted()).toEqual(keys('ALIASES'));
  });
});
