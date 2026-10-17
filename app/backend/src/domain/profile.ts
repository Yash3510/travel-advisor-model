// Traveler profile: preferences that carry over from trip to trip, kept per user (the session until accounts
// exist). Trip-specific facts live in trip.ts. Only deterministic code writes it; the model never does.

export type TravelStyle = 'relaxed' | 'balanced' | 'packed';
export type BudgetStyle = 'budget' | 'value' | 'comfort' | 'premium';
export type FieldSource = 'explicit' | 'inferred';

export const TRAVEL_STYLES: readonly TravelStyle[] = ['relaxed', 'balanced', 'packed'];
export const BUDGET_STYLES: readonly BudgetStyle[] = ['budget', 'value', 'comfort', 'premium'];
export const LIST_FIELDS = ['interests', 'dislikes', 'dietaryNeeds', 'mobilityNeeds', 'accommodationPreferences'] as const;
export type ListField = (typeof LIST_FIELDS)[number];

interface Scalars { homeCity?: string; travelStyle?: TravelStyle; budgetStyle?: BudgetStyle }
type ScalarField = keyof Scalars;
const SCALAR_FIELDS: readonly ScalarField[] = ['homeCity', 'travelStyle', 'budgetStyle'];

export interface TravelerProfile extends Scalars {
  interests: string[];
  dislikes: string[];
  dietaryNeeds: string[]; // hard constraints
  mobilityNeeds: string[]; // hard constraints
  accommodationPreferences: string[];
  /** 'travelStyle' for a scalar, 'interests:beach' for a list item */
  sourceByField: Record<string, FieldSource>;
  updatedAt: string;
}

export interface ProfilePatch {
  set?: { [K in ScalarField]?: Scalars[K] | null };
  add?: Partial<Record<ListField, string[]>>;
  remove?: Partial<Record<ListField, string[]>>;
}

// canonical item → the words people use for it. Shared with the message parser (extract.ts).
const INTERESTS: Record<string, string[]> = {
  beach: ['beach', 'beaches', 'seaside', 'coast', 'coastline', 'island', 'islands', 'sea'],
  mountains: ['mountain', 'mountains', 'hills', 'hill station', 'hill stations', 'himalaya', 'himalayas', 'snow'],
  nature: ['nature', 'greenery', 'forest', 'forests', 'waterfall', 'waterfalls', 'scenery', 'scenic', 'lake', 'lakes'],
  wildlife: ['wildlife', 'safari', 'safaris', 'national park', 'national parks', 'tiger', 'tigers', 'bird watching', 'birding'],
  adventure: ['adventure', 'adventures', 'rafting', 'paragliding', 'scuba', 'diving', 'snorkelling', 'snorkeling', 'bungee', 'zipline', 'water sports'],
  trekking: ['trek', 'treks', 'trekking', 'hike', 'hikes', 'hiking', 'camping'],
  culture: ['culture', 'cultural', 'local life', 'art', 'arts', 'crafts', 'festivals'],
  history: ['history', 'historical', 'heritage', 'fort', 'forts', 'palace', 'palaces', 'monument', 'monuments', 'museum', 'museums', 'ruins'],
  spiritual: ['spiritual', 'temple', 'temples', 'pilgrimage', 'ashram', 'yoga', 'meditation'],
  food: ['food', 'foodie', 'cuisine', 'street food', 'cafe', 'cafes', 'restaurants', 'local food'],
  nightlife: ['nightlife', 'parties', 'partying', 'clubs', 'clubbing', 'pubs', 'bars'],
  shopping: ['shopping', 'market', 'markets', 'bazaar', 'bazaars'],
  wellness: ['spa', 'spas', 'wellness', 'ayurveda', 'massage'],
  photography: ['photography', 'photos', 'instagram'],
};
export const DISLIKE_ONLY: Record<string, string[]> = {
  crowds: ['crowds', 'crowded', 'crowd', 'touristy', 'tourist traps'],
  'long drives': ['long drives', 'long drive', 'long journeys', 'long road trips'],
  'early mornings': ['early mornings', 'early morning', 'waking up early'],
  heat: ['heat', 'hot weather'],
};
export const VOCAB: Record<ListField, Record<string, string[]>> = {
  interests: INTERESTS,
  dislikes: { ...INTERESTS, ...DISLIKE_ONLY },
  dietaryNeeds: {
    vegetarian: ['vegetarian', 'veg', 'pure veg', 'veggie'],
    vegan: ['vegan'],
    jain: ['jain', 'jain food'],
    halal: ['halal'],
    'gluten-free': ['gluten-free', 'gluten free', 'celiac', 'coeliac'],
    eggless: ['eggless', 'no eggs'],
  },
  mobilityNeeds: {
    wheelchair: ['wheelchair', 'wheel chair', 'wheelchair user'],
    'limited walking': ['limited mobility', 'limited walking', "can't walk much", 'cannot walk much', 'difficulty walking', 'knee problem', 'knee problems', 'bad knees'],
  },
  accommodationPreferences: {
    villa: ['villa', 'villas'],
    resort: ['resort', 'resorts'],
    homestay: ['homestay', 'homestays', 'home stay'],
    hostel: ['hostel', 'hostels'],
    boutique: ['boutique', 'boutique hotel', 'boutique hotels'],
    beachfront: ['beachfront', 'beach-facing', 'sea view', 'sea-view', 'ocean view'],
    'private pool': ['private pool', 'pool villa', 'plunge pool'],
    'pet-friendly': ['pet-friendly', 'pet friendly'],
  },
};

const CANONICAL: Record<ListField, Map<string, string>> = Object.fromEntries(
  LIST_FIELDS.map((f) => [f, new Map(Object.entries(VOCAB[f]).flatMap(([canon, words]) => [[canon, canon], ...words.map((w) => [w, canon] as [string, string])]))]),
) as Record<ListField, Map<string, string>>;

const OPPOSITE: Partial<Record<ListField, ListField>> = { interests: 'dislikes', dislikes: 'interests' };
const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 40;

/** Canonical, lower-case, de-duplicated items; unknown short phrases are kept as free text. */
export function normalizeItems(field: ListField, items: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!item || item.length > MAX_ITEM_CHARS) continue;
    const canon = CANONICAL[field].get(item) ?? item;
    if (!out.includes(canon)) out.push(canon);
  }
  return out.slice(0, MAX_ITEMS);
}

export function emptyProfile(): TravelerProfile {
  return { interests: [], dislikes: [], dietaryNeeds: [], mobilityNeeds: [], accommodationPreferences: [], sourceByField: {}, updatedAt: '' };
}

export function hasPreferences(p: TravelerProfile): boolean {
  return SCALAR_FIELDS.some((f) => p[f] !== undefined) || LIST_FIELDS.some((f) => p[f].length > 0);
}

/**
 * Merge rules:
 * - explicit values replace anything; inferred values only fill gaps or replace other inferred values
 * - list items are merged without duplicates; an item moves between interests and dislikes (latest wins),
 *   except that an inferred item never displaces an explicit opposite
 * - `null` deletes a scalar, `remove` deletes list items, and their source records go with them
 */
export function mergeProfile(existing: TravelerProfile, patch: ProfilePatch, source: FieldSource, now: string): TravelerProfile {
  const p: TravelerProfile = structuredClone(existing);
  const src = p.sourceByField;

  for (const field of SCALAR_FIELDS) {
    if (!patch.set || !(field in patch.set)) continue;
    const value = patch.set[field];
    if (value === undefined) continue;
    if (value === null) {
      if (source === 'explicit') { delete p[field]; delete src[field]; }
      continue;
    }
    if (source === 'inferred' && p[field] !== undefined && src[field] === 'explicit') continue;
    (p as Scalars)[field] = value as never;
    src[field] = source;
  }

  for (const field of LIST_FIELDS) {
    for (const item of normalizeItems(field, patch.add?.[field] ?? [])) {
      const opposite = OPPOSITE[field];
      if (opposite && p[opposite].includes(item)) {
        if (source === 'inferred' && src[`${opposite}:${item}`] === 'explicit') continue;
        p[opposite] = p[opposite].filter((x) => x !== item);
        delete src[`${opposite}:${item}`];
      }
      if (!p[field].includes(item)) p[field].push(item);
      const key = `${field}:${item}`;
      if (source === 'explicit' || !src[key]) src[key] = source;
    }
    for (const item of normalizeItems(field, patch.remove?.[field] ?? [])) {
      p[field] = p[field].filter((x) => x !== item);
      delete src[`${field}:${item}`];
    }
    p[field] = p[field].slice(-MAX_ITEMS);
  }

  p.updatedAt = now;
  return p;
}

/**
 * A profile edit from the API (PATCH /api/profile): lists given are replaced, scalars set or cleared with null.
 * Throws on unknown fields or invalid values, so nothing unexpected is ever stored.
 */
export function applyProfileEdit(existing: TravelerProfile, body: Record<string, unknown>, now: string): TravelerProfile {
  const patch: ProfilePatch = { set: {}, add: {}, remove: {} };
  for (const [key, value] of Object.entries(body)) {
    if (key === 'sessionId') continue;
    if (key === 'travelStyle' || key === 'budgetStyle') {
      const allowed: readonly string[] = key === 'travelStyle' ? TRAVEL_STYLES : BUDGET_STYLES;
      if (value !== null && !allowed.includes(value as string)) throw new Error(`${key} must be one of: ${allowed.join(', ')}, or null`);
      patch.set![key] = value as never;
    } else if (key === 'homeCity') {
      if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 60)) throw new Error('homeCity must be a short text, or null');
      patch.set!.homeCity = value === null ? null : value.trim();
    } else if ((LIST_FIELDS as readonly string[]).includes(key)) {
      const field = key as ListField;
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${field} must be a list of strings`);
      const next = normalizeItems(field, value as string[]);
      patch.add![field] = next;
      patch.remove![field] = existing[field].filter((x) => !next.includes(x));
    } else {
      throw new Error(`Unknown profile field: ${key}`);
    }
  }
  return mergeProfile(existing, patch, 'explicit', now);
}

const joinAnd = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** One line for "I'll use your saved preferences: …". Empty when nothing is saved. */
export function profileSummary(p: TravelerProfile): string {
  return [
    p.travelStyle && `${p.travelStyle} pace`,
    p.budgetStyle && `${p.budgetStyle} stays`,
    p.interests.length > 0 && `likes ${joinAnd(p.interests)}`,
    p.dislikes.length > 0 && `avoids ${joinAnd(p.dislikes)}`,
    p.dietaryNeeds.length > 0 && joinAnd(p.dietaryNeeds),
    p.mobilityNeeds.length > 0 && `needs ${joinAnd(p.mobilityNeeds)} access`,
    p.accommodationPreferences.length > 0 && `prefers ${joinAnd(p.accommodationPreferences)}`,
    p.homeCity && `travels from ${p.homeCity}`,
  ].filter(Boolean).join('; ');
}
