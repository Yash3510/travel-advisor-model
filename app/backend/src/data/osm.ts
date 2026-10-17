// OpenStreetMap elements (Overpass JSON with `out center tags`) → PointOfInterest. Pure and deterministic:
// the same raw elements always give the same places in the same order.

import { haversineKm, validLatLon } from '../domain/geo.js';
import { parseOpeningHours } from '../domain/openingHours.js';
import { CATEGORY, type PoiCategory, type PointOfInterest } from '../domain/poi.js';

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const DUPLICATE_NAME_KM = 0.3;
const DUPLICATE_WIKIDATA_KM = 5;
const STALE_CHECK_YEARS = 2;

function categoryOf(t: Record<string, string>): PoiCategory | undefined {
  if (t.natural === 'beach' || t.leisure === 'beach_resort') return 'beach';
  if (t.tourism === 'museum') return 'museum';
  if (t.tourism === 'gallery') return 'gallery';
  if (t.amenity === 'place_of_worship') return 'place_of_worship';
  if (t.historic && t.historic !== 'yes') return 'heritage';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  if (t.natural === 'waterfall' || t.waterway === 'waterfall') return 'waterfall';
  if (t.leisure === 'nature_reserve' || t.boundary === 'protected_area' || t.boundary === 'national_park') return 'nature_reserve';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.tourism === 'zoo' || t.tourism === 'aquarium') return 'zoo';
  if (t.tourism === 'theme_park' || t.leisure === 'water_park') return 'theme_park';
  if (t.amenity === 'marketplace') return 'market';
  if (t.amenity === 'nightclub') return 'nightlife';
  if (t.amenity === 'restaurant' || t.amenity === 'cafe') return 'restaurant';
  if (t.tourism === 'attraction') return 'attraction';
  return undefined;
}

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
const nameKey = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const TYPE_ORDER = { node: 0, way: 1, relation: 2 } as const;
const idParts = (id: string) => { const [, type, n] = /^osm:(\w+)\/(\d+)$/.exec(id)!; return [TYPE_ORDER[type as keyof typeof TYPE_ORDER], Number(n)]; };
const byId = (a: string, b: string) => { const [ta, na] = idParts(a); const [tb, nb] = idParts(b); return ta - tb || na - nb; };

function feeOf(t: Record<string, string>): Pick<PointOfInterest, 'fee' | 'feeInr'> {
  const m = /(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:₹|rs\.?|inr)\b/i.exec(t.charge ?? '');
  if (m) return { fee: 'paid', feeInr: Number(m[1] ?? m[2]) };
  if (t.fee === 'no') return { fee: 'free' };
  if (t.fee === 'yes' || t.charge) return { fee: 'paid' };
  return { fee: 'unknown' };
}

export function normalizeOsm(elements: OsmElement[], meta: { destination: string; checkedAt: string }) {
  const rejected: { id: string; reason: string }[] = [];
  const candidates: { poi: PointOfInterest; richness: number }[] = [];

  for (const el of elements) {
    const id = `osm:${el.type}/${el.id}`;
    const t = el.tags ?? {};
    const name = cleanName(t['name:en'] ?? t.name ?? '');
    if (!name) { rejected.push({ id, reason: 'no name' }); continue; }
    const location = el.type === 'node' ? { lat: el.lat!, lon: el.lon! } : el.center;
    if (!validLatLon(location)) { rejected.push({ id, reason: 'invalid coordinates' }); continue; }
    const category = categoryOf(t);
    if (!category) { rejected.push({ id, reason: 'not a place to visit' }); continue; }

    const info = CATEGORY[category];
    const verifiedOn = t['check_date:opening_hours'] ?? t.check_date;
    const openingHours = parseOpeningHours(t.opening_hours);
    if (verifiedOn && openingHours.basis === 'osm' && Number(meta.checkedAt.slice(0, 4)) - Number(verifiedOn.slice(0, 4)) > STALE_CHECK_YEARS) {
      openingHours.confidence = Math.round(openingHours.confidence * 0.7 * 100) / 100;
    }
    const interests = [...info.interests];
    if (category === 'place_of_worship' && !t.historic && !t.wikidata) interests.pop(); // only notable ones count as history
    const diet = [['diet:vegetarian', 'vegetarian'], ['diet:vegan', 'vegan'], ['diet:jain', 'jain']]
      .filter(([k]) => t[k] === 'yes' || t[k] === 'only').map(([, v]) => v);
    const wheelchair = (['yes', 'limited', 'no'] as const).find((w) => t.wheelchair === w) ?? 'unknown';

    const poi: PointOfInterest = {
      id, name, destination: meta.destination, location: { lat: location.lat, lon: location.lon }, category, interests,
      indoor: info.indoor, kidFriendly: info.kidFriendly, goodSlots: [...info.slots],
      visitDuration: { minutes: info.minutes, basis: 'category_default', confidence: 0.4 },
      openingHours, accessibility: { wheelchair }, ...feeOf(t),
      ...(diet.length ? { diet } : {}),
      ...(t.wikidata ? { wikidata: t.wikidata } : {}),
      source: {
        name: 'OpenStreetMap', licence: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
        url: `https://www.openstreetmap.org/${el.type}/${el.id}`, checkedAt: meta.checkedAt,
        ...(verifiedOn ? { verifiedOn } : {}),
      },
    };
    const richness = Object.keys(t).length + (t.opening_hours ? 5 : 0) + (t.wikidata ? 3 : 0) + (el.type === 'node' ? 0 : 1);
    candidates.push({ poi, richness });
  }

  // duplicates: the same name within 300 m, or the same Wikidata item within 5 km (union-find)
  candidates.sort((a, b) => byId(a.poi.id, b.poi.id));
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(b)] = find(a); };
  const groups = new Map<string, number[]>();
  candidates.forEach((c, i) => {
    for (const key of [`name:${nameKey(c.poi.name)}`, c.poi.wikidata && `wd:${c.poi.wikidata}`]) {
      if (!key) continue;
      const limit = key.startsWith('wd:') ? DUPLICATE_WIKIDATA_KM : DUPLICATE_NAME_KM;
      for (const j of groups.get(key) ?? []) if (haversineKm(c.poi.location, candidates[j].poi.location) <= limit) union(j, i);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
  });
  const clusters = new Map<number, number[]>();
  candidates.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));

  const pois: PointOfInterest[] = [];
  for (const members of clusters.values()) {
    const best = members.reduce((a, b) => (candidates[b].richness > candidates[a].richness ? b : a));
    const others = members.filter((m) => m !== best).map((m) => candidates[m].poi.id).toSorted(byId);
    pois.push(others.length ? { ...candidates[best].poi, duplicates: others } : candidates[best].poi);
  }
  pois.sort((a, b) => byId(a.id, b.id));
  rejected.sort((a, b) => byId(a.id, b.id));
  return { pois, rejected };
}
