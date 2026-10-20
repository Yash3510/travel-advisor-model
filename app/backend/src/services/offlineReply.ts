// When the model is unreachable (D-026), the chat still answers: what the destination guide says about the place the
// customer named, quoted as written, and what Kodi can still do without the model (plans are built by code).
import { guideEntry } from '../domain/guide.js';
import { placesMentioned } from '../domain/feasibility.js';
import type { TripContext } from '../domain/trip.js';

const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December|monsoon|winter|summer)\b/i;
const rank = (t: string) => (/\bbest\b/i.test(t) ? 0 : MONTH.test(t) ? 1 : 2);
const tidy = (s: unknown) => String(s).replace(/^\d+\s+/, '').replace(/\s{2,}/g, ' ');

export function offlineReply(message: string, trip: Partial<TripContext>): string {
  const lead = "Kodi's writing assistant is offline for a moment, so this is a shorter answer than usual.";
  const place = [...placesMentioned(message), trip.destination].find((p) => p && guideEntry(p));
  const entry = place ? guideEntry(place) : null;
  if (!entry) {
    return `${lead} I can still build a day-by-day plan: tell me the place and how many days, for example "4 days in Goa". For anything else, please try again in a minute.`;
  }
  const name = String(entry.destination);
  // the guide's sentences about the best time and months first; altitude or wildlife lines last
  const when = ((entry.climate as unknown[] | undefined) ?? []).map(tidy).toSorted((a, b) => rank(a) - rank(b)).slice(0, 2);
  const g = (entry.getting_there ?? {}) as Record<string, unknown[] | undefined>;
  const how = [g.air?.[0], g.rail?.[0], g.road?.[0], g.sea?.[0]].filter(Boolean).map(tidy).slice(0, 2);
  const parts = [`${lead} Here is what the travel guide says about ${name}.`];
  if (when.length) parts.push(`When to go: ${when.join(' ')}`);
  if (how.length) parts.push(`Getting there: ${how.join(' ')}`);
  parts.push(`I can still make a day-by-day plan for ${name}: tell me how many days. (Source: Wikivoyage, CC BY-SA.)`);
  return parts.join('\n\n');
}
