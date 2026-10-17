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

Phase 1 covers the planner only. Scenarios against the running model and live providers (prompt count, preference
adherence, grounding, latency) come with the release suite in Phase 3.
