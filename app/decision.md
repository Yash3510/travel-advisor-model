# decision.md

Decisions log — newest at bottom. Never delete an entry; strike through if reversed.

## D-001 — Reference product
- We replicate the **backend behaviour** of `https://takeoff.wwmib.com/chat` as closely as possible.
- Its wire contract was reverse-engineered by browsing (Playwright + curl):
  - `POST /api/session` → `{sessionId}`
  - `GET /api/threads?sessionId=` → `{threads:[...]}`
  - `POST /api/chat` → SSE with events: `destination_selected`, `campaign_deals`, `done`
  - `POST /api/events/track` → `{ok:true}`
  - Greeting assistant message is a fixed string kept client-side and re-sent with every request.
  - Full message arrives in ONE `event: done`; typing animation is client-side.
- Screenshots and captured payloads: `/Users/rituraj/Desktop/Projects/model/site/network_log.txt`, `network_log2.txt`.

## D-002 — Model choice: friend's model wins
- Compared two fine-tunes:
  1. Mine — `~/Desktop/Projects/personalized-ai-travel-agent/outputs/{pilot,smoke}` LoRA. Eval: **0/30 cases passed**; adapter ≈ base or worse (`json_object` 0.80→0.73, `clarify_signal` 1.00→0.11). Rejected: undertrained.
  2. Friend's — `~/Downloads/Projects/travel-advisor-model/models/trained-v2-gguf/travel-advisor-qwen3.5-0.8b-v2-Q8_0.gguf`. Eval: **2.13/4 avg, only 2 critical failures**, ~2.5 with the guardrail harness. Wins.
- Teacher fallback available: `teacher-Qwen3.5-4B-GGUF/Qwen3.5-4B-Q6_K.gguf`.
- Runtime: local `llama-server` (llama.cpp, OpenAI-compatible `POST /v1/chat/completions`).

## D-003 — Grounding principle (mirrors Takeoff)
- **The model never states facts or prices.** It drives the conversation and makes personalized picks (pace, hotel style, city split).
- Facts/numbers come from a **local catalog data layer** (`catalog.json` + deals + route SSE payloads), mirroring Pickyourtrail's inventory/OceanJar which we cannot access.

## D-004 — Tech stack
- **Frontend:** Next.js 15 (App Router) + TypeScript + Tailwind CSS — same stack as the reference site, single deployable unit.
- **Backend (revised per user: "frontend fine, solid backend"):** standalone **Fastify + TypeScript** server in `backend/`, decoupled from frontend. Own SSE streaming, sessions/threads store (SQLite via better-sqlite3), model client adapter, guardrail layer, catalog data layer. Testable headless (vitest). Next.js only serves the UI and proxies `/api/*` to the Fastify server.
- **Model server:** `llama-server` from llama.cpp as a separate process on `:8081`, app talks to it over the OpenAI-compatible API (kept out of the app's memory).
- **Guardrails:** Node port of friend's `harness.py` gate: "book it" → confirmation summary; no fake bookings; card/Aadhaar redaction; out-of-scope refusals.

## D-006 — Transport layer: Fastify → plain Node HTTP
- Fastify 5's reply proxy made the raw response unusable mid-handler, silently dropping the SSE stream (`reply.raw` resolved `undefined` after the first await, even before hijack).
- Replaced with a **plain `node:http` server** (`src/dev.ts`) + pure route handlers in `src/routes.ts`. Nothing magical, full byte-level control over the SSE stream, no dependency. Solidity requirement satisfied.

## D-005 — Repository layout
- Frontend *and* backend live in `/Users/rituraj/Desktop/travel AI agent project` (Next.js app covers both).

## D-007 — Cleaned & hardened
- Server owns the authoritative message history (client-sent arrays are not trusted).
- Thread titles/PII: created from the **redacted** first user message.
- Booking confirm endpoint `POST /api/confirm` exists but always returns `PENDING_SUPPLIER_CONFIRMATION` (never a fake "confirmed").
- Tool trace is logged when `LOG_TOOLS=1`.
- `backend/run.sh` boots llama-server (:8081) + backend (:5590).
- Backend also serves `frontend/index.html` at `http://127.0.0.1:5590` when run via `npx tsx src/static.ts`.

## D-009 — Packaging & GitHub
- Repo lives at github.com/riturajthakur1/travel-agent. Source-only archive (00.5 MB). The 795 MB model (models/travel-advisor-qwen3.5-0.8b-v2-Q8_0.gguf) is shipped via the v1 GitHub release (downloaded by `setup.sh` at install time).
- Friend's onboarding: `git clone` → `./setup.sh` → `./run.sh`. (Source-only because plain git rejects files >100 MB; LFS burns the bandwidth quota.)

## D-008 — Outside repos
- Model GPU/CPU fine-tuning work continues separately (`~/Desktop/Projects/model`, friend's repo untouched).
- Friend's repos are read-only for us.

## D-010 — Backend rebuild for production
- **Install:** vitest pinned to `~4.0.15`; vitest 4.1's optional peer set crashes npm 10.9 (`edgesOut` of null). The old lockfile did not match package.json. Unused fastify/@fastify/cors removed (D-006 had already dropped them).
- **Guardrails moved from prompt to code:** `gatePrices` replaces unbacked rupee amounts. A booking intent gets a deterministic `bookingSummary` and skips the model.
- **Offers live in SQLite per thread** (`offers`, `booking_requests`). `/api/confirm` accepts only offers or deals shown in that thread, and returns an idempotent `bookingRef`. Offer ids are full UUIDs.
- **Threads are scoped to their session** (ids are sequential, so an id alone proves nothing). Added `GET /api/threads/:id/messages` so a client can restore a conversation.
- **A turn is persisted only after the model answers.** A model failure returns `model_unavailable` and leaves no half turn.
- **Model client is provider-agnostic** (`MODEL_URL`, `MODEL_NAME`, `MODEL_API_KEY`). The local llama-server stays the default.
- **Additive wire changes only:** `done.offers`, `error.code`, `/ready`, the messages endpoint. Existing payloads are unchanged.
- **Ops:** single `server.ts` entry with graceful shutdown; CORS allowlist; per-IP chat rate limit; 64 KB body cap; Dockerfile (compiled JS, non-root, health check), docker-compose with llama.cpp's server image, GitHub Actions CI.
- **.env:** secrets may go in git-ignored `backend/.env`, loaded with `process.loadEnvFile`. Real env vars win.

## D-011 — Use the model's real prompt, tools and harness
- The prompt in prompts.ts had been reconstructed and did not match training. Replaced with the trained `runtime_system_prompt.txt` plus the deployment block in its exact date format ("Saturday, 17 October 2026"). Tool schemas now match `travel/tools.py`, including the 8th tool `get_destination_info`.
- Ported `travel/harness.py`: the narrow emergency list (the old one fired on "booked by accident") with an urgent handoff, CVV/OTP/PAN redaction with the PII notice, `create_booking` held as a confirmation summary (`pendingBooking`), status templates for the Confirm outcome, sampling `top_p 0.8, top_k 20, max_tokens 600`, 4 tool rounds. The regex "book it" shortcut is gone: the trained create_booking flow picks the exact offer.
- Tool calls and results are stored as messages (migration rebuilds older `messages` tables), so the model can act on offers from earlier turns. History sent to the model is trimmed to a character budget.
- `/api/confirm` requires `sessionId`. `get_booking` reads the session's own booking requests.
- SSE comment heartbeats; a client disconnect cancels the model call and stores nothing. Logs are JSON lines without message text or query strings.
- Verified with the real model (llama.cpp b11714, CPU): search → "book the cheapest one" → summary of the right offer → Confirm → pending → `get_booking` reports pending.

## D-012 — Align with the production frontend
- The frontend (React 19, Vite, Tailwind v4, Bun, oxlint) has no backend calls yet; everything is faked in the browser. So the backend ships a typed, dependency-free client (`client/takeoff-api.ts`), tested against the real routes, plus a wiring guide (now `integration.md`).
- The assistant is Kodi: the server greeting no longer uses another company's persona.
- Replies are plain text with no emojis (`toPlainText` in harness.ts). The frontend renders plain text, and its design rules ban emojis. Stripping in code keeps the trained prompt unchanged.
- oxlint (the frontend's linter) now runs on the backend and the client, in CI too.

## D-013 — Planning flow: profile, trip context and a question budget (Phase 1)
- **Goal:** a first plan within three to four customer messages, personalised by a reusable profile.
- **Profile vs trip:** preferences that carry over (pace, budget style, interests, dislikes, diet, mobility, stay type, home city) live in a per-user profile; the facts of one trip live per thread. Until accounts exist, the session is the user. Both are JSON in SQLite (`profiles`, `trips`).
- **Merge rules:** explicit beats inferred; the newest explicit value wins; an item moves between interests and dislikes; an inferred item never displaces an explicit opposite. API edits replace lists and reject unknown fields.
- **Deterministic parsing, not the model:** the 0.8B model isn't trained for JSON extraction, so destination (from `travel/kb.py`'s place list, exported to `data/places.json` and kept in sync by a test), dates, duration, party, budget, purpose and preferences are parsed with rules.
- **Router:** at most three questions, most useful field first; one refinement question; one trade-off question for conflicts. Questions are answered without a model call (instant, and the budget is guaranteed). The draft is written by the model with a plain-language summary added to the customer's message for that call only, so the trained system prompt stays exactly as it was. Side questions, searches, bookings and revisions go to the model unchanged.
- **Not in Phase 1:** POI-based feasibility, live insights, accounts, Postgres, fine-tuning, the full release suite, frontend changes.

## D-014 — Phase 2 data sources: OpenStreetMap, Wikivoyage, Open-Meteo, computed travel time
- **Goal:** a deterministic itinerary engine needs places with coordinates, categories and, where known, opening hours and access. The 0.8B model is not a source of facts (Phase 1 real run: it searched hotels instead of planning).
- **Places: OpenStreetMap (ODbL 1.0).** Legally clear, reproducible, good coverage of Indian attractions. Dev imports use the public Overpass API lightly (identified, cached, one query per destination); production uses a regional extract or a self-hosted Overpass, per Overpass's commercial-use guidance. Normalised files are an ODbL derived database: kept separate, reproducible from raw responses with a SHA-256 manifest, and not committed (regenerated by the importer).
- **Guide: Wikivoyage (CC BY-SA 4.0),** from the 121 pages the model repo already caches. Attribution and share-alike are carried on every guide insight.
- **Weather: Open-Meteo (data CC BY 4.0).** The free API is non-commercial only, so production requires a paid key or self-hosting (AGPL-3.0); without one, weather is "not checked" in production.
- **Travel time: computed estimate** (haversine × 1.35, 25/40 km/h, +10 min), labelled as an estimate. The OSRM demo server is non-commercial, 1 req/s; self-hosted OSRM (BSD-2-Clause) is the Phase 3 option.
- **Unknowns stay unknown:** missing opening hours and visit lengths are shown as assumptions with low confidence. Events, extra closures, advisories and entry rules have no approved source and are reported as "not checked".
- Full details and attribution wording: `docs/data-sources.md`.

## D-015 — Itinerary engine in code; the model only presents
- **Problem:** in the Phase 1 real run, the 0.8B model searched hotels instead of planning days. More prompting or a changed system prompt was ruled out.
- **Engine:** plans are built deterministically from OpenStreetMap places (D-014): hard filters, ranking with recorded reasons and trade-offs, per-day clusters within 45 min, pace budgets with meal and rest breaks, opening hours, rain and closures, diet-matching meal options, cheaper, relaxed and adventurous alternatives. The best of three starting points per day is kept. Every plan goes through `validateItinerary` and deterministic `repairItinerary`; an unsavable day is kept free with a warning.
- **Presentation:** the plan text is rendered by code. The model, called without tools, writes a two-to-three sentence note; notes with prices, dates, times, bookings or places outside the plan are replaced with a template, as is any model failure. The structured itinerary (`done.itinerary`, stored per version) is authoritative.
- **Revisions** ("cheaper", "slower", "day N more relaxed", "skip X", new dates or party size) rebuild the plan from trip-only overrides; the saved profile keeps its pace, budget style and tastes.
- **Insights:** Open-Meteo forecasts within 16 days change the plan when rain is likely (stale forecasts don't); Wikivoyage season notes are shown with attribution; events, closures beyond OSM hours, advisories and entry rules are reported as not checked.
- **Unknowns:** visit lengths are category defaults labelled as assumptions; unknown hours lower confidence; costs only from published fees.

## D-016 — Travel times behind a provider: self-hosted OSRM, else a labelled estimate
- **Interface:** `TravelTimeProvider.estimate(from, to) → {minutes, distanceKm, mode, source, checkedAt, confidence, isEstimate}`. OSRM when `ROUTING_URL` is set; the Phase 2 straight-line estimate otherwise or on failure.
- **Why not per pair everywhere:** the search compares hundreds of pairs, which no routing call budget allows. The search uses the estimate; the plan's own legs are asked of OSRM (cached per request), the plan is rebuilt with the answers (up to three rounds), and the validator checks the result against them.
- **Failure:** timeout, non-200 or malformed reply → the estimate, labelled "road routing unavailable", one warning per plan; one failure stops further calls for that plan. The public demo server is refused in production.
- **Confidence:** a stop's confidence uses the confidence of the leg into it (road 0.8, estimate 0.5, unknown start 0.5); the validator recomputes legs, confidence and the travel assumption from the times it checked.
- **Wire:** `travelToNext` keeps `minutes`, `km`, `basis` and adds `source`, `isEstimate`, `confidence`; `basis` can now be `road`. `/ready` adds `data` and `routing`. Additive.

## D-017 — An alternative and its revision are the same change
- **Problem:** the plan offers cheaper, more relaxed and more adventurous alternatives, but "make it more adventurous" (even the alternative's own summary) wasn't a revision, and on a packed trip "more relaxed" stepped to balanced while the alternative previewed relaxed. A chip could promise one plan and deliver another.
- **Rule:** the alternative builds exactly what its message does. "More relaxed" and "more adventurous" move the pace one step (`slowerPace`, `fasterPace`); "more adventurous" also adds adventure, nature and trekking. The relaxed summary mentions the rest break only when the step reaches relaxed. An alternative that doesn't change the plan isn't offered.
- **Trip only:** the added interests live on the trip (`addedInterests`) and count as explicit for that plan; the saved profile doesn't learn them from this message, as with cheaper and slower.
- **Check:** `matchesAlternative` scenarios rebuild the plan from the message and compare it with the alternative's `changes`.

## D-018 — The frontend integration is a brief its coding agent carries out
- **Why:** Pranay integrates through a coding agent he directs remotely, with no access to this repository. So `integration.md` is a step-by-step brief that agent follows on its own: rules, steps with checks, and a final report.
- **What it embeds:** `client/takeoff-api.ts`, the new `client/takeoff-plan.ts` (quick replies the planner understands, the message for each alternative, labels, and the plan in the frontend's `DayPlan`/`Activity` shapes) and `scripts/smoke.mjs` as the live check. `npm run docs:sync` writes them in; `test/integration-doc.test.ts` fails while a copy is out of date.
- **Verified against the frontend's toolchain:** the frontend runs TypeScript 6 (strict by default), `erasableSyntaxOnly` and its own oxlint config. The brief's tagged snippets were assembled into a stand-in `App.tsx` with the frontend's real types, compiled and linted under those settings, and run in a browser against the backend. That run found two wording bugs, now fixed: meal blocks showed "Entry fee not published", and reasons read "For suits a honeymoon" (now "Why: …").
- **The brief stays in its lane:** it keeps the design, adds no dependencies, deletes nothing, and turns off the checkout's fake payment and prefilled personal data.


## D-019 — Live replies, and taking a turn back

**Context.** The reply arrived only when complete (5–60 s on CPU), with no sign of progress; the frontend faked typing afterwards. Customers also had no way to edit a message or ask for another answer, and the thread rename/delete endpoints answered "ok" for any thread id, deleting another session's messages before checking ownership.

**Decision.**
- `POST /api/chat` adds two event types before `done`, both ignorable: `status` (the step under way: model rounds, each tool, the planner's weather, plan and note steps) and `delta` (the reply in whole sentences, streamed from the model with `stream: true`). Each sentence goes through the same checks as the final reply before it is sent: `gateAssistantOutput` (a blocked sentence ends the stream and resets it), `gatePrices` against the tool results so far, the deals for the known region and the customer's words, and `toPlainText`. Text that turns out to precede a tool call is reset. `done` is still the one authoritative reply; planner questions and itinerary notes are not streamed (the note is validated as a whole).
- Every customer message records the trip and the plan version from before it (`turns` table). `POST /api/threads/:id/rewind` deletes that message and everything after it and restores both, so the client can edit or regenerate by resending. A turn followed by a booking request (`/api/confirm`) cannot be rewound: it is a record of a supplier request. Profile changes picked up from a rewound message stay (the profile is shared by the session's threads; the customer can edit it).
- Rename and delete check the session owns the thread first, in one transaction; titles are one line of at most 80 characters. CORS allows DELETE.

**Why not stream raw tokens.** The price and booking guards work on text; streaming unchecked tokens would show a fabricated price before it is replaced. Sentence granularity keeps the guards and still shows text within a sentence of the model writing it.

## D-020 — Feedback and contact messages are stored
- **Why:** the chat's thumbs up/down and the site's contact form went nowhere: `/api/events/track` discarded everything, and the contact page only pretended to send.
- **What:** `events` keeps client events with a plain snake_case name and up to 4 KB of props (the endpoint still answers ok for anything, as the original contract says). `contact_messages` keeps contact-form messages after the same redaction as chat (card and ID numbers out). Both are rate limited per IP. Reading them is for the team (SQL for now; an admin view belongs with Phase 4's booking admin).
