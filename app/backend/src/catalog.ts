import fs from 'node:fs';

export interface Deal {
  campaignItineraryId: string; sourceItineraryId: string; title: string;
  image: string; images: string[]; destinationString: string; nights: number;
  tripType: string; itineraryCost: number; itineraryCostWithoutFlights: number;
  hotelStarRating: number; slug: string; pills: string[]; numBookings: number;
  strikedCost: number; dealDiscountPercentage: number;
  cityHotelStay: { cityName: string; hotelName: string; nights: number; hotelImages: string[] }[];
  activities: string[]; highlights: string[]; regionName: string; regionCode: string;
  type: string; unityOptions: unknown[]; fixedItineraryDetails: unknown; perPersonCostByOption: Record<string, unknown>;
}

export interface Region {
  name: string; code: string; aliases: string[]; currency: string; deals: Deal[];
}

interface CatalogShape { regions: Region[] }

const cache = new Map<string, CatalogShape>();

export function loadCatalog(path: string): CatalogShape {
  let cat = cache.get(path);
  if (!cat) {
    cat = JSON.parse(fs.readFileSync(path, 'utf8')) as CatalogShape;
    cache.set(path, cat);
  }
  return cat;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Find the region mentioned in free text: aliases match as whole words, longest alias wins. */
export function detectRegion(text: string, path: string): Region | null {
  let best: { region: Region; score: number } | null = null;
  for (const region of loadCatalog(path).regions) {
    for (const alias of region.aliases) {
      if (!alias) continue;
      if (new RegExp(`\\b${escapeRe(alias)}\\b`, 'i').test(text) && (!best || alias.length > best.score)) {
        best = { region, score: alias.length };
      }
    }
  }
  return best?.region ?? null;
}

export function dealsForRegion(regionCode: string, path: string): Deal[] {
  return loadCatalog(path).regions.find((r) => r.code === regionCode)?.deals ?? [];
}

export function regionForAlias(name: string, path: string): Region | undefined {
  const lower = name.trim().toLowerCase();
  return loadCatalog(path).regions.find((r) => r.aliases.includes(lower) || r.name.toLowerCase() === lower);
}
