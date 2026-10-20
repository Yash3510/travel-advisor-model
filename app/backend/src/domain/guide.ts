// The destination guide behind get_destination_info: verbatim Wikivoyage sentences per place, built by the model
// repo (travel/build_kb.py writes data/guide.json). Lookup follows travel/kb.py exactly, so the model sees at runtime
// what it was trained on: whole names, aliases or one comma part; never a substring ("Glass Temple near Bundi" ≠ Bundi).
import fs from 'node:fs';

interface GuideFile { aliases: Record<string, string>; fallback: Record<string, string>; entries: Record<string, Record<string, unknown>> }

const GUIDE_FILE = new URL('../../data/guide.json', import.meta.url);
let guide: GuideFile | undefined;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ');

export function guideEntry(name: string, file: string | URL = GUIDE_FILE): Record<string, unknown> | null {
  guide ??= JSON.parse(fs.readFileSync(file, 'utf8')) as GuideFile;
  const { aliases, fallback, entries } = guide;
  const resolve = (key: string) => {
    for (const k of [key, aliases[key]]) {
      if (k && entries[k]) return entries[k];
      if (k && fallback[k] && entries[fallback[k]]) return entries[fallback[k]];
    }
    return null;
  };
  for (const cand of [norm(name), ...name.split(',').map(norm)]) {
    const hit = resolve(cand.replace(/\b(india|district|town|city)$/, '').trim());
    if (hit) return hit;
  }
  return null;
}
