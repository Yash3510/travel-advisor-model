// The destination guide behind get_destination_info: verbatim Wikivoyage sentences per place, built by the model
// repo (travel/build_kb.py writes data/guide.json). Lookup follows travel/kb.py exactly, so the model sees at runtime
// what it was trained on: whole names, aliases or one comma part; never a substring ("Glass Temple near Bundi" ≠ Bundi).
import fs from 'node:fs';

interface GuideFile { aliases: Record<string, string>; fallback: Record<string, string>; entries: Record<string, Record<string, unknown>> }

const GUIDE_FILE = new URL('../../data/guide.json', import.meta.url);
let guide: GuideFile | undefined;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ');

export function guideEntry(name: string, file: string | URL = GUIDE_FILE): Record<string, unknown> | null {
  const all = entries(file);
  const { aliases, fallback } = guide!;
  const resolve = (key: string) => {
    for (const k of [key, aliases[key]]) {
      if (k && Object.hasOwn(all, k)) return all[k];
      if (k && fallback[k] && all[fallback[k]]) return all[fallback[k]];
    }
    return null;
  };
  for (const cand of [norm(name), ...name.split(',').map(norm)]) {
    const hit = resolve(cand.replace(/\b(india|district|town|city)$/, '').trim());
    if (hit) return hit;
  }
  return null;
}

// ── public destination pages (/destinations): the same verbatim sentences, tidied for reading ──

export interface GuidePage {
  slug: string; name: string; summary: string | null; whenToGo: string[]; permits: string[];
  gettingThere: { air: string[]; rail: string[]; road: string[]; sea: string[] };
  source: string; sourceUrl: string; retrieved: string;
}

// Wikivoyage list markers ("1 Dabolim Airport") and doubled spaces; closures are left out: the rule also catches "close to"
const tidy = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((s) => String(s).replace(/^\d+\s+/, '').replace(/\s{2,}/g, ' '));
export const slugOf = (key: string) => key.replace(/\s+/g, '-');

function entries(file: string | URL = GUIDE_FILE) {
  guide ??= JSON.parse(fs.readFileSync(file, 'utf8')) as GuideFile;
  return guide.entries;
}

export function guidePage(slug: string): GuidePage | null {
  const key = slug.toLowerCase().replace(/-/g, ' ');
  const e = Object.hasOwn(entries(), key) ? entries()[key] : undefined;
  if (!e) return null;
  const g = (e.getting_there ?? {}) as Record<string, unknown>;
  return {
    // "(Hindi: आगरा Āgrā, Urdu: …)" after the name reads as clutter on a page
    slug: slugOf(key), name: String(e.destination), summary: e.summary ? String(e.summary).replace(/\s*\([^()]*:[^()]*\)/g, '').replace(/\s{2,}/g, ' ') : null,
    whenToGo: tidy(e.climate), permits: tidy(e.permits),
    gettingThere: { air: tidy(g.air), rail: tidy(g.rail), road: tidy(g.road), sea: tidy(g.sea) },
    source: String(e.source), sourceUrl: String(e.source_url), retrieved: String(e.retrieved),
  };
}

export function guideList(): Pick<GuidePage, 'slug' | 'name' | 'summary'>[] {
  return Object.keys(entries()).map((k) => guidePage(slugOf(k))!)
    .map(({ slug, name, summary }) => ({ slug, name, summary }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}
