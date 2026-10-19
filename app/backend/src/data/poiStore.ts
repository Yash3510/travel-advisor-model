// Normalised place files from the importer (data/poi/<region>.json), loaded on demand and cached.

import fs from 'node:fs';
import type { LatLon } from '../domain/geo.js';
import type { PointOfInterest } from '../domain/poi.js';
import { regionFor } from './importOsm.js';
import { synthesizePlacesForDestination } from './poiFallback.js';

export interface PlaceSet { slug: string; center: LatLon; pois: PointOfInterest[] }

/** where `npm run data:import` writes, and where the Docker image mounts the place files */
export const POI_DIR = new URL('../../data/poi/', import.meta.url);
const cache = new Map<string, { mtimeMs: number; set: PlaceSet }>();

export function loadPlaces(destination: string | undefined): PlaceSet | undefined {
  if (!destination) return undefined;
  const region = regionFor(destination);
  if (region) {
    const file = new URL(`${region.slug}.json`, POI_DIR);
    if (fs.existsSync(file)) {
      const { mtimeMs } = fs.statSync(file);
      const hit = cache.get(region.slug);
      if (hit && hit.mtimeMs === mtimeMs) return hit.set;
      const { pois } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pois: PointOfInterest[] };
      const [s, w, n, e] = region.bbox;
      const set = { slug: region.slug, center: { lat: (s + n) / 2, lon: (w + e) / 2 }, pois };
      cache.set(region.slug, { mtimeMs, set });
      return set;
    }
  }

  // Fallback to high-fidelity Indian destination synthesizer for any Indian destination
  return synthesizePlacesForDestination(destination);
}

