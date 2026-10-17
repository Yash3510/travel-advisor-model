// Runs app/eval/scenarios/itinerary.json: whole conversations through the planner, the itinerary engine and
// the renderer (no model, no network), with release assertions checked on every plan produced.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { gatePrices } from '../src/harness.js';
import type { TripInsight } from '../src/domain/insights.js';
import type { ItineraryDraft } from '../src/domain/itinerary.js';
import type { PointOfInterest } from '../src/domain/poi.js';
import { applyProfileEdit, emptyProfile, type TravelerProfile } from '../src/domain/profile.js';
import { emptyTrip, type TripContext } from '../src/domain/trip.js';
import { diff } from '../src/services/itineraryService.js';
import { validateItinerary } from '../src/services/itineraryValidator.js';
import { buildCheckedPlan, forThisTrip } from '../src/services/planBuilder.js';
import { renderItinerary } from '../src/services/presentation.js';
import { planTurn, type Route } from '../src/services/promptRouter.js';

interface Scenario { name: string; profile?: Record<string, unknown>; insights?: TripInsight[]; turns: string[]; expect: Record<string, any> }
const dir = new URL('../../eval/scenarios/', import.meta.url);
const file = JSON.parse(fs.readFileSync(new URL('itinerary.json', dir), 'utf8')) as { today: string; places: string; scenarios: Scenario[] };
const POIS = (JSON.parse(fs.readFileSync(new URL(file.places, dir), 'utf8')) as { pois: PointOfInterest[] }).pois;
const byName = new Map(POIS.map((p) => [p.name, p]));
const NOW = '2026-12-10T06:00:00.000Z';

const stops = (d: ItineraryDraft) => d.days.flatMap((day) => day.items.filter((i) => i.kind === 'activity'));

function releaseAssertions(draft: ItineraryDraft, rendered: string, trip: TripContext, profile: TravelerProfile, insights: TripInsight[]) {
  // every day has a valid schedule; no hard constraint, closure or unsupported claim survives
  expect(validateItinerary(draft, { pois: new Map(POIS.map((p) => [p.id, p])), trip, profile: forThisTrip(profile, trip), insights, dayPace: trip.dayPace })).toEqual([]);
  for (const day of draft.days) {
    for (const a of day.items.filter((i) => i.kind === 'activity')) {
      const p = POIS.find((x) => x.id === a.poiId)!;
      for (const x of insights.filter((i) => i.status === 'checked' && i.date === day.date)) {
        expect(x.effect === 'closed' && x.poiId === p.id, `${p.name} scheduled while closed`).toBe(false);
        expect(x.effect === 'rain' && !p.indoor, `${p.name} scheduled outdoors in the rain`).toBe(false);
      }
    }
  }
  // every factual insight names its source and when it was checked
  for (const x of insights.filter((i) => i.status !== 'not_checked')) expect(Boolean(x.source && x.checkedAt)).toBe(true);
  // no unsupported prices: every amount in the text is one the plan's data backs
  expect(gatePrices(rendered, { facts: JSON.stringify(draft), user: '' })).toBe(rendered);
}

describe('itinerary scenarios', () => {
  it.each(file.scenarios.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    const insights = s.insights ?? [];
    let trip = emptyTrip();
    let profile = s.profile ? applyProfileEdit(emptyProfile(), s.profile, NOW) : emptyProfile();
    const routes: Route[] = [];
    const plans: { draft: ItineraryDraft; rendered: string; profile: TravelerProfile }[] = [];
    let current: ItineraryDraft | undefined;
    for (const [i, message] of s.turns.entries()) {
      const scheduled = current ? stops(current).map((a) => ({ poiId: a.poiId!, name: a.title })) : undefined;
      const r = planTurn({ trip, profile, message, today: file.today, catalogPath: config.catalogPath, firstTurnOfThread: i === 0, now: NOW, scheduled });
      trip = r.trip;
      profile = r.profile;
      routes.push(r.route);
      if (r.route.action === 'draft' || r.route.action === 'revise') {
        const { draft } = await buildCheckedPlan({ trip, profile, insights, pois: POIS });
        trip = { ...trip, status: 'drafted', itineraryVersion: draft.version };
        current = draft;
        plans.push({ draft, rendered: renderItinerary(draft, insights), profile });
        releaseAssertions(draft, plans.at(-1)!.rendered, trip, profile, insights);
      }
    }

    const e = s.expect;
    const draftAt = routes.findIndex((r) => r.action === 'draft') + 1;
    expect(draftAt, 'turn with the first plan').toBe(e.draftOnTurn);
    expect(draftAt, 'first plan within the four-message budget').toBeLessThanOrEqual(4);
    const final = plans.at(-1)!;
    const titles = stops(final.draft).map((a) => a.title);
    const allWarnings = [...final.draft.warnings, ...final.draft.days.flatMap((d) => d.warnings)].join(' | ');
    if (e.versions) expect(final.draft.version).toBe(e.versions);
    for (const t of e.planHas ?? []) expect(titles).toContain(t);
    for (const t of e.planLacks ?? []) expect(titles).not.toContain(t);
    if (e.notBoth) expect(e.notBoth.every((t: string) => titles.includes(t))).toBe(false);
    if (e.maxStopsPerDay) for (const d of final.draft.days) expect(d.items.filter((i) => i.kind === 'activity').length).toBeLessThanOrEqual(e.maxStopsPerDay);
    for (const [day, max] of Object.entries(e.maxStopsOnDay ?? {})) expect(final.draft.days[Number(day) - 1].items.filter((i) => i.kind === 'activity').length).toBeLessThanOrEqual(max as number);
    if (e.fewerStopsOnDay) {
      const count = (d: ItineraryDraft) => d.days[e.fewerStopsOnDay - 1].items.filter((i) => i.kind === 'activity').length;
      expect(count(final.draft)).toBeLessThan(count(plans[0].draft));
    }
    // tapping an alternative gives exactly the plan its preview described
    if (e.matchesAlternative) {
      const alt = plans[0].draft.alternatives.find((a) => a.kind === e.matchesAlternative);
      expect(alt, `the first plan offers ${e.matchesAlternative}`).toBeDefined();
      expect(diff(plans[0].draft, final.draft)).toEqual(alt!.changes);
    }
    if (e.restEveryDay) for (const d of final.draft.days) expect(d.items.some((i) => i.kind === 'rest')).toBe(true);
    if (e.assumptionsMatch) expect(final.draft.assumptions.join(' | ')).toMatch(new RegExp(e.assumptionsMatch));
    if (e.warningsMatch) expect(allWarnings).toMatch(new RegExp(e.warningsMatch));
    if (e.notesMatch) expect(stops(final.draft).flatMap((a) => a.notes).join(' | ')).toMatch(new RegExp(e.notesMatch));
    for (const key of ['renderedMatch', 'renderedMatch2']) if (e[key]) expect(final.rendered).toMatch(new RegExp(e[key]));
    if (e.mealSuggests) expect(final.draft.days.flatMap((d) => d.items).flatMap((i) => i.suggestions ?? []).map((x) => x.name)).toContain(e.mealSuggests);
    if (e.asked) expect(trip.asked).toEqual(e.asked);
    if (e.finalTrip) expect(trip).toMatchObject(e.finalTrip);
    if (e.dates) expect(final.draft.days.map((d) => d.date)).toEqual(e.dates);
    for (const [name, cost] of Object.entries(e.costOf ?? {})) expect(stops(final.draft).find((a) => a.title === name)?.costInr).toBe(cost);
    if (e.costNotAbove) expect(final.draft.totalEstimatedCostInr ?? 0).toBeLessThanOrEqual(plans[0].draft.totalEstimatedCostInr ?? 0);
    // revisions keep the traveller's saved preferences
    for (const field of e.profileUnchanged ?? []) expect(final.profile[field as keyof TravelerProfile]).toEqual(plans[0].profile[field as keyof TravelerProfile]);
    if (e.outdoorOnDate) {
      const day = final.draft.days.find((d) => d.date === e.outdoorOnDate)!;
      expect(day.items.some((i) => i.kind === 'activity' && !byName.get(i.title)!.indoor), 'a stale forecast must not change the plan').toBe(true);
    }
  });
});
