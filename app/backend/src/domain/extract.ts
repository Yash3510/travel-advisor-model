// Deterministic extraction of trip facts and preferences from one customer message. No model is involved:
// the 0.8B model isn't trained for structured extraction, and these fields drive routing and storage.
// Run on the redacted text, so no card or ID numbers reach it.

import fs from 'node:fs';
import { loadCatalog } from '../catalog.js';
import { inrAmount, moneyAmounts } from '../harness.js';
import { DISLIKE_ONLY, VOCAB, type BudgetStyle, type ListField, type ProfilePatch, type TravelStyle } from './profile.js';

export interface TripFacts {
  destination?: string;
  origin?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;
  month?: number; // 1-12, when only the month is known
  durationDays?: number;
  travelers?: number;
  travelerTypes: string[]; // solo, couple, family, friends, kids, seniors
  purpose?: string;
  budgetInr?: number;
  budgetPerPerson?: boolean;
}

export interface Extraction {
  trip: TripFacts;
  profile: { explicit: ProfilePatch; inferred: ProfilePatch };
  /** "relaxed" and "see everything" in the same message */
  paceConflict: boolean;
  hasTripFacts: boolean;
}

// Place names come from the model repo's travel guide list (travel/kb.py), exported to data/places.json.
const PLACES = JSON.parse(fs.readFileSync(new URL('../../data/places.json', import.meta.url), 'utf8')) as
  { places: Record<string, string>; aliases: Record<string, string> };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w: string, flags = 'i') => new RegExp(`(?<![\\w-])${escapeRe(w)}(?![\\w-])`, flags);

let placeIndex: { name: string; display: string; re: RegExp }[] | null = null;
function places(catalogPath: string) {
  if (!placeIndex) {
    const entries: [string, string][] = [
      ...Object.entries(PLACES.places),
      ...Object.entries(PLACES.aliases).map(([alias, key]): [string, string] => [alias, PLACES.places[key] ?? key]),
      ...loadCatalog(catalogPath).regions.flatMap((r) => [r.name.toLowerCase(), ...r.aliases].map((a): [string, string] => [a, r.name])),
    ];
    // longest names first, so "nusa penida" wins over a shorter overlapping name
    placeIndex = entries.toSorted((a, b) => b[0].length - a[0].length).map(([name, display]) => ({ name, display, re: wordRe(name, 'gi') }));
  }
  return placeIndex;
}

const ORIGIN_CUE = /(?:from|out of|based in|live in|living in|staying in)\s+$/i;
const HOME_CUE = /(?:based in|live in|living in)\s+$/i;
// Capitalised words after these verbs that are never places
const NOT_PLACES = new Set(['relax', 'travel', 'go', 'plan', 'see', 'explore', 'visit', 'book', 'stay', 'have', 'enjoy', 'spend', 'celebrate', 'escape', 'india', 'somewhere', 'the', 'a', 'my', 'our']);

function findPlaces(text: string, catalogPath: string): { destination?: string; origin?: string; homeCity?: string } {
  const out: { destination?: string; origin?: string; homeCity?: string } = {};
  const taken: [number, number][] = [];
  const hits: { at: number; display: string; isOrigin: boolean; isHome: boolean }[] = [];
  for (const p of places(catalogPath)) {
    for (const m of text.matchAll(p.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      const before = text.slice(Math.max(0, start - 16), start);
      hits.push({ at: start, display: p.display, isOrigin: ORIGIN_CUE.test(before), isHome: HOME_CUE.test(before) });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  out.destination = hits.find((h) => !h.isOrigin)?.display;
  out.origin = hits.find((h) => h.isOrigin)?.display;
  out.homeCity = hits.find((h) => h.isHome)?.display;
  // an unknown place: "visit Xyzabad", "trip to Xyzabad" (case-sensitive: proper nouns only)
  if (!out.destination) {
    const m = /\b(?:to|visit|visiting|explore|exploring)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/.exec(text);
    const name = m?.[1];
    if (name && !NOT_PLACES.has(name.split(' ')[0].toLowerCase()) && monthNumber(name) === 0) out.destination = name;
  }
  if (!out.origin) {
    const m = /\bfrom\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/.exec(text);
    if (m && monthNumber(m[1]) === 0 && !NOT_PLACES.has(m[1].toLowerCase())) out.origin = m[1];
  }
  return out;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const TO = String.raw`\s*(?:-|–|to|till|until)\s*`;
const YEAR = String.raw`(?:,?\s+(\d{4}))?`;

function monthNumber(word: string): number {
  const w = word.toLowerCase();
  if (w.length < 3) return 0;
  const i = MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)) && m.startsWith(w));
  return i + 1;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addDays = (date: string, n: number) => new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** A day and month with no year means the next one from today. */
function resolve(m: number, d: number, year: string | undefined, today: string, notBefore = today): string | undefined {
  let y = year ? Number(year) : Number(today.slice(0, 4));
  if (!validDate(y, m, d)) return undefined;
  if (!year && iso(y, m, d) < notBefore) y += 1;
  return iso(y, m, d);
}

function range(start?: string, end?: string): Pick<TripFacts, 'startDate' | 'endDate' | 'durationDays'> {
  if (!start) return {};
  if (!end || end < start) return { startDate: start };
  return { startDate: start, endDate: end, durationDays: daysBetween(start, end) + 1 };
}

function findDates(text: string, today: string): Pick<TripFacts, 'startDate' | 'endDate' | 'month' | 'durationDays'> {
  let m: RegExpExecArray | null;
  if ((m = /(\d{4}-\d{2}-\d{2})(?:\s*(?:-|–|to|till|until)\s*(\d{4}-\d{2}-\d{2}))?/.exec(text))) {
    const [, a, b] = m;
    const ok = (s?: string) => s && validDate(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10)));
    return range(ok(a) ? a : undefined, ok(b) ? b : undefined);
  }
  // 12 to 15 December
  if ((m = new RegExp(`\\b${DAY}${TO}${DAY}\\s+(?:of\\s+)?${MONTH}\\b${YEAR}`, 'i').exec(text))) {
    const start = resolve(monthNumber(m[3]), Number(m[1]), m[4], today);
    return range(start, start && resolve(monthNumber(m[3]), Number(m[2]), m[4] ?? start.slice(0, 4), today, start));
  }
  // 28 December to 3 January
  if ((m = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}${TO}${DAY}\\s+(?:of\\s+)?${MONTH}\\b${YEAR}`, 'i').exec(text))) {
    const start = resolve(monthNumber(m[2]), Number(m[1]), m[5], today);
    return range(start, start && resolve(monthNumber(m[4]), Number(m[3]), undefined, today, start));
  }
  // December 12-15, Dec 28 - Jan 3
  if ((m = new RegExp(`\\b${MONTH}\\s+${DAY}${TO}(?:${MONTH}\\s+)?${DAY}\\b${YEAR}`, 'i').exec(text))) {
    const start = resolve(monthNumber(m[1]), Number(m[2]), m[5], today);
    return range(start, start && resolve(monthNumber(m[3] ?? m[1]), Number(m[4]), undefined, today, start));
  }
  // 5th March, March 5
  if ((m = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}\\b${YEAR}`, 'i').exec(text))) return range(resolve(monthNumber(m[2]), Number(m[1]), m[3], today));
  if ((m = new RegExp(`\\b${MONTH}\\s+${DAY}\\b(?!\\s*(?:days?|nights?|people|pax))${YEAR}`, 'i').exec(text))) return range(resolve(monthNumber(m[1]), Number(m[2]), m[3], today));

  const lower = text.toLowerCase();
  const dow = new Date(Date.parse(today)).getUTCDay();
  const saturday = addDays(today, (6 - dow + 7) % 7);
  if (/\bday after tomorrow\b/.test(lower)) return { startDate: addDays(today, 2) };
  if (/\btomorrow\b/.test(lower)) return { startDate: addDays(today, 1) };
  if (/\bthis weekend\b/.test(lower)) return range(saturday, addDays(saturday, 1));
  if (/\bnext weekend\b/.test(lower)) return range(addDays(saturday, 7), addDays(saturday, 8));
  if (/\bnext month\b/.test(lower)) return { month: (Number(today.slice(5, 7)) % 12) + 1 };

  // a month on its own: "in December", "December mein"; "may" only with a cue, since it's also a verb
  if ((m = new RegExp(`\\b(?:in|during|this|next|early|mid|late|end of|around|by)\\s+${MONTH}\\b`, 'i').exec(text))) return { month: monthNumber(m[1]) };
  if ((m = new RegExp(`\\b${MONTH}\\b`, 'i').exec(text)) && m[1].toLowerCase() !== 'may') return { month: monthNumber(m[1]) };
  return {};
}

// ── Duration, party, budget, purpose ─────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15 };
const NUM = String.raw`(\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;
const toNum = (s: string) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s);

function findDuration(lower: string): number | undefined {
  if (/\blong weekend\b/.test(lower)) return 3;
  if (/\bfortnight\b/.test(lower)) return 14;
  const m = new RegExp(`\\b${NUM}[\\s-]*(days?|nights?|weeks?)\\b`).exec(lower);
  if (m) {
    const n = toNum(m[1]);
    if (m[2].startsWith('week')) return n * 7;
    return m[2].startsWith('night') ? n + 1 : n;
  }
  if (/\bweekend\b/.test(lower)) return 2;
  return undefined;
}

function findParty(lower: string): { travelers?: number; types: string[] } {
  const types: string[] = [];
  let travelers: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`\\bfamily of ${NUM}\\b`).exec(lower))) travelers = toNum(m[1]);
  else if ((m = new RegExp(`\\bwith (?:my )?${NUM} friends\\b`).exec(lower))) travelers = toNum(m[1]) + 1;
  else if ((m = new RegExp(`\\b${NUM}\\s+(people|persons|adults|pax|travell?ers|guests|members|log|of us|friends)\\b`).exec(lower))) travelers = toNum(m[1]);
  else if ((m = new RegExp(`\\bfor ${NUM}\\b(?!\\d|[,.]\\d|\\s*(?:-|days?|nights?|weeks?|k\\b|lakhs?|lacs?|%|am|pm|hours?|hrs?))`).exec(lower))) travelers = toNum(m[1]);

  const couple = /\b(?:my (?:wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?)|couple|the two of us|both of us|honeymoon|babymoon)\b/.test(lower);
  const solo = /\b(?:solo|alone|just me|by myself|on my own)\b/.test(lower);
  if (couple) { types.push('couple'); travelers ??= 2; }
  if (solo) { types.push('solo'); travelers ??= 1; }
  if (/\bfamily\b/.test(lower)) types.push('family');
  if (/\bfriends\b/.test(lower)) types.push('friends');
  if (/\b(?:kids?|children|child|toddlers?|baby)\b/.test(lower)) types.push('kids');
  if (/\b(?:parents|grandparents|seniors?|elderly)\b/.test(lower)) types.push('seniors');
  return { travelers: travelers && travelers > 0 && travelers <= 20 ? travelers : undefined, types };
}

const BUDGET_CUE = /\b(?:budget|under|within|max(?:imum)?|up ?to|around|about|approx(?:imately)?|not more than|less than|below|spend|afford|total)\b[^.\d₹]{0,15}?(?:₹|rs\.?|inr)?\s?(\d+(?:,\d+)*(?:\.\d+)?)\s?(k|l|lakhs?|lacs?|crores?|cr)?\b/gi;
// "50k total", "1 lakh budget"
const BUDGET_AFTER = /(?:₹|rs\.?|inr)?\s?(\d+(?:,\d+)*(?:\.\d+)?)\s?(k|l|lakhs?|lacs?|crores?|cr)?\s+(?:total|in total|overall|budget|max|maximum|all inclusive)\b/gi;
const PER_PERSON = /^\W*(?:per (?:person|head|pax|traveller|traveler)|each|pp\b|\/person|a head)/i;

function findBudget(text: string): { budgetInr?: number; budgetPerPerson?: boolean } {
  for (const m of text.matchAll(BUDGET_CUE)) {
    const value = inrAmount(m[1], m[2]);
    if (value >= 1000) return { budgetInr: value, budgetPerPerson: PER_PERSON.test(text.slice(m.index + m[0].length, m.index + m[0].length + 20)) };
  }
  for (const m of text.matchAll(BUDGET_AFTER)) {
    const value = inrAmount(m[1], m[2]);
    if (value >= 1000) return { budgetInr: value, budgetPerPerson: /\b(?:per (?:person|head)|each)\b/i.test(text) };
  }
  const amount = moneyAmounts(text).find((v) => v >= 1000);
  return amount ? { budgetInr: amount, budgetPerPerson: /\b(?:per (?:person|head)|each)\b/i.test(text) } : {};
}

const PURPOSES: [RegExp, string][] = [
  [/\bhoneymoon\b/, 'honeymoon'],
  [/\bbabymoon\b/, 'babymoon'],
  [/\banniversary\b/, 'anniversary'],
  [/\bbirthday\b/, 'birthday'],
  [/\bbachelor(?:ette)?\b/, 'bachelor party'],
  [/\b(?:workation|business trip|work trip)\b/, 'business'],
  [/\b(?:pilgrimage|yatra|darshan)\b/, 'pilgrimage'],
  [/\bfamily (?:vacation|holiday|trip)\b/, 'family vacation'],
  [/\b(?:girls|boys|friends) trip\b/, 'friends getaway'],
  [/\badventure (?:trip|holiday)\b/, 'adventure'],
  [/\brelax(?:ing|ation)? (?:trip|holiday|break|getaway)\b/, 'relaxation'],
];

// ── Preferences ──────────────────────────────────────────────────────────────

const PACE: [RegExp, TravelStyle][] = [
  [/\b(?:relaxed|relaxing|slow|laid[- ]back|chill|unhurried|no rush|no hurry|easy pace|leisurely|take it easy)\b/, 'relaxed'],
  [/\b(?:packed|action[- ]packed|fast[- ]paced|see everything|see as much as|as much as possible|jam[- ]packed|cover everything)\b/, 'packed'],
  [/\b(?:balanced|mix of both|moderate pace|bit of both)\b/, 'balanced'],
];
const BUDGET_STYLE: [RegExp, BudgetStyle][] = [
  [/\b(?:luxury|luxurious|premium|5[- ]star|five[- ]star|high[- ]end|lavish|splurge)\b/, 'premium'],
  [/\b(?:comfortable|4[- ]star|four[- ]star|mid[- ]range|midrange)\b/, 'comfort'],
  [/\b(?:value for money|good value|reasonably priced)\b/, 'value'],
  [/\b(?:budget[- ](?:friendly|trip|travel|hotels?|stays?)|cheap|cheapest|backpack(?:ing|er)?|affordable|low[- ]budget|shoestring)\b/, 'budget'],
];
const NEG = /\b(?:hate|hates|dislike|dislikes|don'?t like|do not like|not into|not a fan of|can'?t stand|avoid|avoiding|no|without|skip|not interested in|rather not|don'?t want|do not want)\b/g;
const POS = /\b(?:love|loves|like|likes|enjoy|enjoys|into|fan of|interested in|prefer|want|would like|keen on|big on|crazy about)\b/g;
const lastMatchEnd = (re: RegExp, s: string) => Math.max(-1, ...[...s.matchAll(re)].map((m) => m.index + m[0].length));
const lastMatchStart = (re: RegExp, s: string) => Math.max(-1, ...[...s.matchAll(re)].map((m) => m.index));

const push = (list: string[], item: string) => { if (!list.includes(item)) list.push(item); };

function findPreferences(lower: string) {
  const explicit: Record<ListField, string[]> = { interests: [], dislikes: [], dietaryNeeds: [], mobilityNeeds: [], accommodationPreferences: [] };
  const inferred: Record<ListField, string[]> = { interests: [], dislikes: [], dietaryNeeds: [], mobilityNeeds: [], accommodationPreferences: [] };
  // pace phrases contain "no", which would read as a dislike
  const scan = lower.replace(/\bno (?:rush|hurry)\b/g, ' ');

  for (const clause of scan.split(/[.;!?\n]|\bbut\b|\bthough\b|\balthough\b|\bhowever\b/)) {
    for (const [canon, words] of Object.entries(VOCAB.dislikes)) {
      const hit = [canon, ...words].map((w) => wordRe(w).exec(clause)).find(Boolean);
      if (!hit) continue;
      const before = clause.slice(0, hit.index);
      const neg = lastMatchStart(NEG, before);
      const negative = neg >= 0 && lastMatchStart(POS, before) < lastMatchEnd(NEG, before) && before.slice(neg).split(/\s+/).length <= 5;
      const positive = !negative && lastMatchStart(POS, before) >= 0;
      if (negative) push(explicit.dislikes, canon);
      else if (positive) push(explicit.interests, canon);
      else if (canon in DISLIKE_ONLY) push(inferred.dislikes, canon);
      else push(inferred.interests, canon);
    }
  }
  for (const field of ['dietaryNeeds', 'mobilityNeeds', 'accommodationPreferences'] as const) {
    for (const [canon, words] of Object.entries(VOCAB[field])) {
      if (canon === 'vegetarian' && /\bnon[- ]?veg/.test(lower)) continue;
      if ([canon, ...words].some((w) => wordRe(w).test(scan))) push(explicit[field], canon);
    }
  }
  return { explicit, inferred };
}

const nonEmpty = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined))) as Partial<T>;

function findName(text: string): string | undefined {
  // case-sensitive name: "I am Excited" is rare, "I am excited" is not a name
  const m = /\b(?:[Mm]y name is|I am|I'm|[Cc]all me|[Mm]yself)\s+([A-Z][a-z]{1,25})\b/.exec(text);
  if (m) {
    const raw = m[1].toLowerCase();
    const stopWords = new Set([
      'kodi', 'planning', 'looking', 'traveling', 'travelling', 'interested', 'ready', 'here',
      'back', 'just', 'going', 'solo', 'fine', 'good', 'sure', 'from', 'a', 'an', 'the', 'not'
    ]);
    if (!stopWords.has(raw)) {
      return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    }
  }
  return undefined;
}

export function extractFacts(text: string, today: string, catalogPath: string): Extraction {
  const lower = text.toLowerCase();
  const name = findName(text);
  const where = findPlaces(text, catalogPath);
  const dates = findDates(text, today);
  const party = findParty(lower);
  const purpose = PURPOSES.find(([re]) => re.test(lower))?.[1];
  const paces = PACE.filter(([re]) => re.test(lower)).map(([, p]) => p);
  const paceConflict = paces.includes('relaxed') && paces.includes('packed');
  const budgetStyle = BUDGET_STYLE.find(([re]) => re.test(lower))?.[1];
  const prefs = findPreferences(lower);

  const trip: TripFacts = {
    ...nonEmpty({ destination: where.destination, origin: where.origin, purpose }),
    ...dates,
    ...(dates.durationDays ? {} : nonEmpty({ durationDays: findDuration(lower) })),
    ...nonEmpty({ travelers: party.travelers }),
    travelerTypes: party.types,
    ...findBudget(text),
  };
  return {
    trip,
    profile: {
      explicit: {
        set: nonEmpty({ name, travelStyle: paceConflict ? undefined : paces[0], budgetStyle, homeCity: where.homeCity }),
        add: nonEmpty(prefs.explicit),
      },
      inferred: { set: nonEmpty({ homeCity: where.homeCity ? undefined : where.origin }), add: nonEmpty(prefs.inferred) },
    },
    paceConflict,
    hasTripFacts: Object.keys(trip).length > 1 || trip.travelerTypes.length > 0,
  };
}
