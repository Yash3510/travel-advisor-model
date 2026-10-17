// The validated itinerary is shown by code. The model only writes a short personal note above it, which is
// checked: no prices, dates, times, bookings, or places outside the plan. Anything else gets a template note.

import type { TripInsight } from '../domain/insights.js';
import type { ItineraryDraft, ItineraryItem } from '../domain/itinerary.js';
import type { TravelerProfile } from '../domain/profile.js';
import type { TripContext } from '../domain/trip.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const niceDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const longDate = (d: string) => `${WEEKDAYS[new Date(Date.parse(d)).getUTCDay()]} ${niceDate(d)}`;
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

const NOT_CHECKED_LABEL: Record<string, string> = {
  event: 'events', closure: 'one-off closures', advisory: 'travel advisories', visa: 'entry requirements', weather: 'weather', season: 'destination guide',
};

function itemLine(i: ItineraryItem): string {
  const parts = [`• ${i.start}–${i.end} ${i.title}`];
  if (i.kind === 'activity') {
    parts.push(`(about ${minutes(i.durationMinutes)})`);
    if (i.why?.matched.length) parts.push(`${sentence(`For ${joinAnd(i.why.matched)}`)}`);
    if (i.hours === 'unknown') parts.push('Opening hours not published.');
    if (i.costInr !== undefined) parts.push(`Entry about ${inr(i.costInr)} for the group.`);
    for (const n of i.notes) parts.push(sentence(n));
    if (i.travelToNext) parts.push(i.travelToNext.isEstimate ? `Then about ${i.travelToNext.minutes} min to the next stop (estimated).` : `Then about ${i.travelToNext.minutes} min by road to the next stop.`);
  } else if (i.kind === 'meal') {
    if (i.suggestions?.length) parts.push(`Nearby options that match your diet: ${i.suggestions.map((s) => s.name).join(', ')}.`);
    for (const n of i.notes) parts.push(sentence(n));
  }
  return parts.join(' ');
}

/** The whole plan as plain text, built only from the draft and the insights. */
export function renderItinerary(d: ItineraryDraft, insights: TripInsight[]): string {
  const out: string[] = [];
  for (const day of d.days) {
    out.push(day.date ? `Day ${day.day}, ${longDate(day.date)}` : `Day ${day.day}`);
    for (const item of day.items) out.push(itemLine(item));
    for (const w of day.warnings) out.push(`Note: ${sentence(w)}`);
    out.push('');
  }
  const weather = insights.filter((i) => i.type === 'weather' && i.status !== 'not_checked' && i.date && i.severity !== 'info');
  const guide = insights.filter((i) => i.type === 'season' && i.status !== 'not_checked');
  const notChecked = [...new Set(insights.filter((i) => i.status === 'not_checked').map((i) => NOT_CHECKED_LABEL[i.type] ?? i.type))];
  if (weather.length || guide.length || notChecked.length) {
    for (const w of weather) out.push(`Weather: ${w.title} on ${niceDate(w.date!)} (${w.detail})${w.status === 'stale' ? ', from an older forecast' : ''}.`);
    for (const g of guide) out.push(`${g.title} (${g.source}): ${sentence(g.detail)}`);
    if (notChecked.length) out.push(`Not checked: ${joinAnd(notChecked)}.`);
    out.push('');
  }
  if (d.totalEstimatedCostInr !== undefined) out.push(`Entry fees in this plan: about ${inr(d.totalEstimatedCostInr)}, counting only published fees.`, '');
  if (d.warnings.length) out.push('Please note:', ...d.warnings.map((w) => `• ${sentence(w)}`), '');
  if (d.assumptions.length) out.push('Assumptions:', ...d.assumptions.map((a) => `• ${sentence(a)}`), '');
  if (d.alternatives.length) out.push('Other options:', ...d.alternatives.map((a) => `• ${a.kind === 'cheaper' ? 'Cheaper' : a.kind === 'more_relaxed' ? 'More relaxed' : 'More adventurous'}: ${a.summary} (${a.changes.join('; ')}).`), '');
  if (d.sources.length) out.push(`Sources: ${d.sources.map((s) => (s.licence ? `${s.attribution} (${s.licence})` : s.attribution)).join('; ')}.`);
  return out.join('\n').trim();
}

export function introRequest(d: ItineraryDraft, profile: TravelerProfile, trip: TripContext): string {
  const stops = d.days.flatMap((x) => x.items.filter((i) => i.kind === 'activity').map((i) => i.title)).slice(0, 4);
  const likes = profile.interests.length ? `, as someone who likes ${joinAnd(profile.interests)}` : '';
  return `Here is my plan, already checked: ${d.days.length} days in ${d.destination}${stops.length ? `, including ${joinAnd(stops)}` : ''}${trip.purpose ? `, for our ${trip.purpose}` : ''}. ` +
    `In two or three sentences, tell me warmly why it suits me${likes}. Don't change or add places, dates, times or prices, and don't search for anything.`;
}

export function fallbackIntro(d: ItineraryDraft, profile: TravelerProfile, trip: TripContext): string {
  const pace = profile.travelStyle ?? 'balanced';
  return `Here is your ${d.days.length}-day ${pace} plan for ${d.destination}` +
    `${profile.interests.length ? `, built around ${joinAnd(profile.interests)}` : ''}${trip.purpose ? `, for your ${trip.purpose}` : ''}.`;
}

const MONEY = /₹|\bRs\.?\s?\d|\bINR\b|\b\d[\d,]*\s?(?:k|lakhs?|rupees)\b/i;
const DATE = /\b(?:January|February|March|April|June|July|August|September|October|November|December|May\s+\d)\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{4}-\d{2}-\d{2}\b/;
const TIME = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/i;
const BOOKING = /\b(?:booked|booking|confirmed|reserved|reservation|charged|paid)\b/i;
const PLACE_LIKE = /\b(?:[A-Z][a-z]+\s){1,3}(?:Beach|Fort|Temple|Church|Museum|Market|Falls|Lake|Palace|Island|Park|Sanctuary|Basilica|Cathedral|Mosque|Hill)\b/g;

/** Is the model's note safe to show above the plan? */
export function checkIntro(text: string, ctx: { draft: ItineraryDraft; knownPlaceNames: string[] }): { ok: true } | { ok: false; reason: string } {
  const t = text.trim();
  if (!t || t.length > 600) return { ok: false, reason: 'empty or too long' };
  if (MONEY.test(t)) return { ok: false, reason: 'mentions a price' };
  if (DATE.test(t)) return { ok: false, reason: 'mentions a date' };
  if (TIME.test(t)) return { ok: false, reason: 'mentions a time' };
  if (BOOKING.test(t)) return { ok: false, reason: 'talks about a booking' };
  const planned = ctx.draft.days.flatMap((x) => x.items.filter((i) => i.kind === 'activity').map((i) => i.title.toLowerCase()));
  const lower = t.toLowerCase();
  const other = ctx.knownPlaceNames.find((n) => n.length >= 5 && !planned.includes(n.toLowerCase()) && lower.includes(n.toLowerCase()));
  if (other) return { ok: false, reason: `mentions ${other}, which is not in the plan` };
  const invented = [...t.matchAll(PLACE_LIKE)].map((m) => m[0]).find((m) => !planned.some((p) => p.includes(m.toLowerCase())));
  if (invented) return { ok: false, reason: `mentions ${invented}, which is not in the plan` };
  return { ok: true };
}
