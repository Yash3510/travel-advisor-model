// A place the itinerary engine can schedule, normalised from a licensed source (OpenStreetMap for now).
// Unknowns stay explicit: no hours means `basis: 'unknown'`, and visit length is a labelled assumption.

import type { LatLon } from './geo.js';
import type { OpeningHours } from './openingHours.js';

export type PoiCategory =
  | 'beach' | 'museum' | 'gallery' | 'heritage' | 'place_of_worship' | 'viewpoint' | 'waterfall'
  | 'nature_reserve' | 'park' | 'zoo' | 'theme_park' | 'market' | 'nightlife' | 'restaurant' | 'attraction';
export type Slot = 'morning' | 'afternoon' | 'evening';

export interface VisitDuration {
  minutes: number;
  /** OSM has no visit lengths, so this is always a typical time for the category, shown as an assumption */
  basis: 'category_default';
  confidence: number;
}

export interface PoiSource {
  name: 'OpenStreetMap';
  licence: 'ODbL-1.0';
  attribution: '© OpenStreetMap contributors';
  url: string;
  /** when the data was extracted */
  checkedAt: string;
  /** when a mapper last confirmed the record (OSM check_date), if known */
  verifiedOn?: string;
}

export interface PointOfInterest {
  id: string; // "osm:node/123"
  name: string;
  destination: string; // region slug, e.g. "goa"
  location: LatLon;
  category: PoiCategory;
  interests: string[]; // the profile's interest vocabulary
  indoor: boolean;
  kidFriendly: boolean;
  goodSlots: Slot[];
  visitDuration: VisitDuration;
  openingHours: OpeningHours;
  accessibility: { wheelchair: 'yes' | 'limited' | 'no' | 'unknown' };
  fee: 'free' | 'paid' | 'unknown';
  feeInr?: number;
  diet?: string[]; // restaurants: vegetarian, vegan, jain
  wikidata?: string;
  duplicates?: string[]; // ids merged into this one
  source: PoiSource;
}

export interface CategoryInfo { interests: string[]; minutes: number; indoor: boolean; kidFriendly: boolean; slots: Slot[] }

export const CATEGORY: Record<PoiCategory, CategoryInfo> = {
  beach: { interests: ['beach'], minutes: 150, indoor: false, kidFriendly: true, slots: ['morning', 'evening'] },
  museum: { interests: ['history', 'culture'], minutes: 120, indoor: true, kidFriendly: false, slots: ['morning', 'afternoon'] },
  gallery: { interests: ['culture'], minutes: 75, indoor: true, kidFriendly: false, slots: ['morning', 'afternoon'] },
  heritage: { interests: ['history'], minutes: 90, indoor: false, kidFriendly: false, slots: ['morning', 'afternoon'] },
  place_of_worship: { interests: ['spiritual', 'history'], minutes: 45, indoor: true, kidFriendly: false, slots: ['morning', 'afternoon', 'evening'] },
  viewpoint: { interests: ['nature', 'photography'], minutes: 30, indoor: false, kidFriendly: false, slots: ['morning', 'evening'] },
  waterfall: { interests: ['nature'], minutes: 120, indoor: false, kidFriendly: false, slots: ['morning', 'afternoon'] },
  nature_reserve: { interests: ['nature', 'wildlife'], minutes: 180, indoor: false, kidFriendly: false, slots: ['morning'] },
  park: { interests: ['nature'], minutes: 60, indoor: false, kidFriendly: true, slots: ['morning', 'afternoon', 'evening'] },
  zoo: { interests: ['wildlife'], minutes: 150, indoor: false, kidFriendly: true, slots: ['morning', 'afternoon'] },
  theme_park: { interests: ['adventure'], minutes: 240, indoor: false, kidFriendly: true, slots: ['morning', 'afternoon'] },
  market: { interests: ['shopping', 'food'], minutes: 90, indoor: false, kidFriendly: false, slots: ['morning', 'evening'] },
  nightlife: { interests: ['nightlife'], minutes: 120, indoor: true, kidFriendly: false, slots: ['evening'] },
  restaurant: { interests: ['food'], minutes: 75, indoor: true, kidFriendly: true, slots: [] },
  attraction: { interests: ['culture'], minutes: 60, indoor: false, kidFriendly: false, slots: ['morning', 'afternoon'] },
};
