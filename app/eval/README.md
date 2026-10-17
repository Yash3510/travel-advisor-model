# App scenarios

Conversation scenarios for the Takeoff app's planning flow. They're separate from the model evaluation in the
repository's top-level `eval/`, which scores the model itself.

`scenarios/*.json` lists conversations (one thread each) with what must happen, for example which message gets the
first plan, which questions are asked or never asked, and what the trip summary sent to the model must contain.
They run through the planner deterministically, with no model or server, as part of the backend tests:

```bash
cd app/backend && npx vitest run test/eval-scenarios.test.ts
```

Every scenario also checks the hard limits: at most three questions, and a plan within four planning messages
(side questions don't count).

- `planner.json`: the three-to-four message planner (Phase 1), run by `test/eval-scenarios.test.ts`.
- `itinerary.json`: 15 whole conversations through the planner, the itinerary engine and the renderer, on the synthetic
  places in `fixtures/town.json`, run by `test/eval-itinerary.test.ts`. Every plan they produce must also pass the
  release assertions: it validates (schedule, hard constraints, closures, claims), nothing closed or rained out is
  scheduled, insights name a source and time, every price in the text is backed by data, the first plan comes within
  four messages, and revisions keep saved preferences.

Scenarios against the running model and live providers (latency, note acceptance rate, grounding) come with the
release suite in Phase 3.
