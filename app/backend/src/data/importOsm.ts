// Reproducible import of OpenStreetMap places for one region.
//   npm run data:import -- goa                 fetch from Overpass, save the raw response, normalise
//   npm run data:import -- goa --from-raw FILE  normalise a saved raw response again (no network)
// Raw responses and normalised files go to data/poi/ (git-ignored: an ODbL derived database, regenerated);
// data/poi-manifest.json (committed) records what each file was built from.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeOsm, type OsmElement } from './osm.js';

export interface PoiRegion { slug: string; name: string; bbox: [number, number, number, number]; names: string[] }

const DATA = new URL('../../data/', import.meta.url);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function loadRegions(): PoiRegion[] {
  return (JSON.parse(fs.readFileSync(new URL('poi-regions.json', DATA), 'utf8')) as { regions: PoiRegion[] }).regions;
}

export function regionFor(destination: string | undefined, regions: PoiRegion[] = loadRegions()): PoiRegion | undefined {
  const d = destination?.trim().toLowerCase();
  return d ? regions.find((r) => r.names.some((n) => n.toLowerCase() === d)) : undefined;
}

export function overpassQuery(r: PoiRegion): string {
  const bb = `(${r.bbox.join(',')})`;
  return [
    '[out:json][timeout:180];',
    '(',
    `  nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|aquarium|theme_park)$"]["name"]${bb};`,
    `  nwr["historic"~"^(fort|castle|monument|memorial|ruins|archaeological_site)$"]["name"]${bb};`,
    `  nwr["natural"~"^(beach|waterfall)$"]["name"]${bb};`,
    `  nwr["waterway"="waterfall"]["name"]${bb};`,
    `  nwr["leisure"~"^(park|garden|nature_reserve|water_park|beach_resort)$"]["name"]${bb};`,
    `  nwr["amenity"="place_of_worship"]["name"]["wikidata"]${bb};`,
    `  nwr["amenity"="place_of_worship"]["name"]["historic"]${bb};`,
    `  nwr["amenity"="marketplace"]["name"]${bb};`,
    `  nwr["amenity"="nightclub"]["name"]${bb};`,
    `  nwr["amenity"~"^(restaurant|cafe)$"]["name"]["diet:vegetarian"~"^(yes|only)$"]${bb};`,
    ');',
    'out center tags;',
  ].join('\n');
}

export function buildImport(raw: string, region: PoiRegion, extractedAt: string) {
  const elements = (JSON.parse(raw) as { elements: OsmElement[] }).elements;
  const { pois, rejected } = normalizeOsm(elements, { destination: region.slug, checkedAt: extractedAt });
  const rejectedReasons: Record<string, number> = {};
  for (const r of rejected) rejectedReasons[r.reason] = (rejectedReasons[r.reason] ?? 0) + 1;
  const manifest = {
    region: region.slug, extractedAt, source: 'OpenStreetMap via Overpass API', licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors', rawSha256: sha256(raw), querySha256: sha256(overpassQuery(region)),
    counts: { elements: elements.length, pois: pois.length, rejected: rejected.length }, rejectedReasons,
  };
  return { manifest, pois };
}

async function main(args: string[]) {
  const slug = args[0];
  const region = loadRegions().find((r) => r.slug === slug);
  if (!region) throw new Error(`Unknown region "${slug}". Add it to data/poi-regions.json.`);
  const poiDir = new URL('poi/', DATA);
  fs.mkdirSync(poiDir, { recursive: true });

  let raw: string;
  let extractedAt: string;
  const fromRaw = args.indexOf('--from-raw');
  if (fromRaw >= 0) {
    const file = args[fromRaw + 1];
    raw = fs.readFileSync(file, 'utf8');
    extractedAt = /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? fs.statSync(file).mtime.toISOString().slice(0, 10);
  } else {
    const url = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'takeoff-app/0.2 (github.com/Yash3510/travel-advisor-model)' },
      body: new URLSearchParams({ data: overpassQuery(region) }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
    raw = await res.text();
    extractedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(new URL(`raw-${slug}-${extractedAt}.json`, poiDir), raw);
  }

  const { manifest, pois } = buildImport(raw, region, extractedAt);
  fs.writeFileSync(new URL(`${slug}.json`, poiDir), JSON.stringify({ manifest, pois }) + '\n');
  const manifestFile = new URL('poi-manifest.json', DATA);
  const all = fs.existsSync(manifestFile) ? (JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>) : {};
  all[slug] = manifest;
  fs.writeFileSync(manifestFile, JSON.stringify(all, null, 2) + '\n');
  console.log(JSON.stringify(manifest));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: Error) => { console.error(err.message); process.exit(1); });
}
