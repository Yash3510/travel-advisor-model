// Runs app/eval/scenarios/*.json through the planner (no model, no HTTP). Each scenario is one thread.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { applyProfileEdit, emptyProfile } from '../src/domain/profile.js';
import { emptyTrip } from '../src/domain/trip.js';
import { MAX_QUESTIONS, planTurn, type Route } from '../src/services/promptRouter.js';

interface Scenario {
  name: string;
  profile?: Record<string, unknown>;
  turns: string[];
  expect: {
    draftOnTurn: number; asked?: string[]; neverAsk?: string[]; briefIncludes?: string[]; assumptionsInclude?: string[];
    firstReplyIncludes?: string; finalTrip?: Record<string, unknown>; conversedOnTurns?: number[];
  };
}

const dir = new URL('../../eval/scenarios/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const NOW = '2026-10-14T10:00:00.000Z';

describe.each(files)('%s', (file) => {
  const { today, scenarios } = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8')) as { today: string; scenarios: Scenario[] };

  it.each(scenarios.map((s) => [s.name, s] as const))('%s', (_name, s) => {
    let trip = emptyTrip();
    let profile = s.profile ? applyProfileEdit(emptyProfile(), s.profile, NOW) : emptyProfile();
    const routes: Route[] = [];
    s.turns.forEach((message, i) => {
      const r = planTurn({ trip, profile, message, today, catalogPath: config.catalogPath, firstTurnOfThread: i === 0, now: NOW });
      trip = r.trip;
      profile = r.profile;
      routes.push(r.route);
    });

    const draftAt = routes.findIndex((r) => r.action === 'draft') + 1;
    expect(draftAt, 'turn with the first plan').toBe(s.expect.draftOnTurn);
    expect(draftAt, 'plan within four planning messages').toBeLessThanOrEqual(4 + (s.expect.conversedOnTurns?.length ?? 0));
    expect(trip.asked.length).toBeLessThanOrEqual(MAX_QUESTIONS);
    const draft = routes[draftAt - 1];
    if (s.expect.asked) expect(trip.asked).toEqual(s.expect.asked);
    for (const f of s.expect.neverAsk ?? []) expect(trip.asked).not.toContain(f);
    for (const text of s.expect.briefIncludes ?? []) expect(draft.brief).toContain(text);
    for (const a of s.expect.assumptionsInclude ?? []) expect(draft.assumptions).toContain(a);
    if (s.expect.firstReplyIncludes) expect(routes[0].text).toContain(s.expect.firstReplyIncludes);
    if (s.expect.finalTrip) expect(trip).toMatchObject(s.expect.finalTrip);
    for (const t of s.expect.conversedOnTurns ?? []) expect(routes[t - 1].action).toBe('converse');
  });
});
