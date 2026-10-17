// End-to-end check against a running backend (scripts/docker-smoke.sh runs it): a four-message plan and a revision
// ("flow"), then, after the backend restarts, that the thread, messages, trip and plan are all still there
// ("persist"). Exits non-zero at the first failed check.
import fs from 'node:fs';

const [mode, base, stateFile] = process.argv.slice(2);
const headers = { 'Content-Type': 'application/json' };

function check(ok, what, detail) {
  if (!ok) {
    console.error(`FAIL: ${what}${detail === undefined ? '' : `\n  ${JSON.stringify(detail).slice(0, 800)}`}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
}

async function get(path) {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
}

async function chat(sessionId, content, threadId) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ sessionId, threadId, messages: [{ role: 'user', content, timestamp: null }] }) });
  const events = (await res.text()).split(/\r?\n\r?\n/).filter((b) => b.trim() && !b.startsWith(':')).map((b) => ({
    event: /^event: ?(.*)$/m.exec(b)?.[1],
    data: JSON.parse(b.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')),
  }));
  const done = events.find((e) => e.event === 'done')?.data;
  check(done, `"${content}" answered with a done event`, events);
  console.log(`   ${done.planning?.action ?? '-'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return done;
}

const activities = (plan, day) => plan.days[day].items.filter((i) => i.kind === 'activity');

if (mode === 'flow') {
  const ready = await get('/ready');
  check(ready.status === 200 && ready.body.data?.ok && ready.body.data.regions.includes('goa'), 'ready: model reachable; place data, guide pages and database present', ready.body);
  console.log(`   routing: ${ready.body.routing}`);
  const { sessionId } = await (await fetch(`${base}/api/session`, { method: 'POST', headers, body: '{}' })).json();

  let threadId;
  let done;
  const actions = [];
  for (const text of ['I want to plan a trip', 'Goa', '15 to 17 December, me and my wife', 'around 60k']) {
    done = await chat(sessionId, text, threadId);
    threadId = done.threadId;
    actions.push(done.planning?.action);
  }
  check(actions.join() === 'ask,ask,ask,draft', 'three questions, then a plan on the fourth message', actions);
  const plan = done.itinerary;
  check(plan?.version === 1 && plan.days.length === 3, 'done.itinerary: version 1, three days', plan && { version: plan.version, days: plan.days.length });
  const stops = plan.days.flatMap((d) => d.items.filter((i) => i.kind === 'activity'));
  check(stops.length > 0 && stops.every((s) => s.poiId && s.source?.attribution), `every stop (${stops.length}) is a known place with its source`);
  check(plan.sources.some((s) => s.attribution === '© OpenStreetMap contributors'), 'OpenStreetMap credit in the plan sources');
  check(Array.isArray(done.insights) && done.insights.length > 0 && done.insights.every((i) => i.source && i.status), 'done.insights present, each with a source and status');
  console.log(`   insights: ${done.insights.map((i) => `${i.type}=${i.status}`).join(', ')}`);
  const legs = stops.flatMap((s) => (s.travelToNext ? [s.travelToNext] : []));
  check(legs.every((l) => typeof l.isEstimate === 'boolean' && l.source), `every travel leg says where it came from (${legs.filter((l) => l.isEstimate).length} estimated, ${legs.filter((l) => !l.isEstimate).length} by road)`);

  const before = activities(plan, 1).length;
  const revised = await chat(sessionId, 'make day 2 more relaxed', threadId);
  check(revised.planning?.action === 'revise' && revised.itinerary?.version === 2, 'revision: done.itinerary version 2', revised.planning);
  console.log(`   day 2: ${before} → ${activities(revised.itinerary, 1).length} stops`);
  const stored = (await get(`/api/threads/${threadId}/itinerary?sessionId=${sessionId}`)).body.itinerary;
  check(stored?.version === 2, 'the stored plan is version 2');
  const messages = (await get(`/api/threads/${threadId}/messages?sessionId=${sessionId}`)).body.messages;
  fs.writeFileSync(stateFile, JSON.stringify({ sessionId, threadId, messages: messages.length, itinerary: stored }));
} else if (mode === 'persist') {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const q = `sessionId=${encodeURIComponent(s.sessionId)}`;
  check((await get(`/api/threads?${q}`)).body.threads.some((t) => t.id === s.threadId), 'after the restart: the thread is still listed');
  check((await get(`/api/threads/${s.threadId}/messages?${q}`)).body.messages.length === s.messages, `after the restart: all ${s.messages} messages kept`);
  check(JSON.stringify((await get(`/api/threads/${s.threadId}/itinerary?${q}`)).body.itinerary) === JSON.stringify(s.itinerary), 'after the restart: plan version 2 unchanged');
  const trip = (await get(`/api/threads/${s.threadId}/trip?${q}`)).body.trip;
  check(trip.status === 'drafted' && trip.itineraryVersion === 2, 'after the restart: trip context kept', trip);
} else {
  console.error('usage: smoke.mjs flow|persist <base-url> <state-file>');
  process.exit(2);
}
