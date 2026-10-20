// Facts the code can check about a request before the model answers (D-023): plans that can't work as asked.
// The model is told these facts; if its reply leaves them out, the customer is told anyway.
import fs from 'node:fs';
import type { TripContext } from './trip.js';

export interface FeasibilityNote {
  kind: 'island_by_land' | 'too_many_places';
  /** what the customer is told (plain text) */
  text: string;
  /** a reply that matches this has already said it */
  covered: RegExp;
}

const ISLANDS = /\b(andaman(s| and nicobar| islands)?|nicobar|havelock|swaraj dweep|neil island|shaheed dweep|port blair|lakshadweep|agatti|kavaratti|bangaram)\b/i;
const BY_LAND = /\b(train|trains|rail|railway|by road|road ?trip|drive|driving|by car|by bus|bus)\b/i;

const PLACES_FILE = new URL('../../data/places.json', import.meta.url);
let placeNames: { name: string; re: RegExp; canonical: string }[] | undefined;
function places(placesFile: string | URL = PLACES_FILE) {
  if (!placeNames) {
    const { places: p, aliases } = JSON.parse(fs.readFileSync(placesFile, 'utf8')) as { places: Record<string, unknown>; aliases: Record<string, string> };
    const names = [...Object.keys(p).map((n) => [n, n] as const), ...Object.entries(aliases)];
    // longest first, so "andaman and nicobar islands" wins over "andaman"
    placeNames = names.toSorted((a, b) => b[0].length - a[0].length).map(([name, canonical]) => ({
      name, canonical, re: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    }));
  }
  return placeNames;
}

/** Distinct known places named in a message. */
export function placesMentioned(text: string, placesFile?: string | URL): string[] {
  let rest = text;
  const found = new Set<string>();
  for (const p of places(placesFile)) {
    if (p.re.test(rest)) { found.add(p.canonical); rest = rest.replace(p.re, ' '); }
  }
  return [...found];
}

export function feasibilityNotes(message: string, trip: Partial<TripContext>, placesFile?: string | URL): FeasibilityNote[] {
  const notes: FeasibilityNote[] = [];
  if (ISLANDS.test(message) && BY_LAND.test(message)) {
    notes.push({
      kind: 'island_by_land',
      text: 'Good to know: there is no train or road to the Andaman Islands or Lakshadweep. You fly (to Port Blair or Agatti) or take a ship, from Chennai, Kolkata or Visakhapatnam for the Andamans, or Kochi for Lakshadweep.',
      covered: /\b(fly|flight|ship|ferry|cruise|no (train|rail|road))\b/i,
    });
  }
  const days = trip.durationDays;
  const named = placesMentioned(message, placesFile);
  if (days && named.length >= 4 && named.length > days * 0.75) {
    const relaxed = trip.paceOverride === 'relaxed' || /\b(relax|relaxed|slow|easy|unhurried|leisurely)\b/i.test(message);
    notes.push({
      kind: 'too_many_places',
      text: `Good to know: ${named.length} places in ${days} days leaves less than a day in each, with long journeys between them${relaxed ? ', so it can\'t feel relaxed' : ''}. Two or three places would give you time to enjoy them; tell me which matter most.`,
      covered: /\b(too many|too much|rushed|fewer|cut down|narrow|prioriti[sz]e|pick (two|three|2|3)|two or three|2[–-]3)\b/i,
    });
  }
  return notes;
}

/** Add what the reply left out. */
export function withFeasibility(reply: string, notes: FeasibilityNote[]): string {
  const missing = notes.filter((n) => !n.covered.test(reply));
  return missing.length ? `${reply}\n\n${missing.map((n) => n.text).join('\n\n')}` : reply;
}

/** For the model's copy of the customer's message only: what the code checked. */
export const feasibilityBrief = (notes: FeasibilityNote[]) =>
  notes.length ? `\n\n(Checked by the system, tell the customer: ${notes.map((n) => n.text.replace(/^Good to know: /, '')).join(' ')})` : '';
