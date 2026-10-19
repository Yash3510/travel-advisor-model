# AGENTS.md — instructions for anyone (or any coding agent) working on the Takeoff app

Started by Rituraj (github.com/riturajthakur1/travel-agent); now lives in `app/` of the model repo. The model itself (training, prompt, tools, harness) is the rest of this repository.
Read `decision.md` for the "why" behind every choice, and `flow.md` for the build history.

## What this project is

An AI travel-planning chat that replicates the **backend behaviour** of `https://takeoff.wwmib.com/chat` (Pickyourtrail's "Trippie") as closely as possible: exact endpoints, exact SSE event names, exact payload shapes. The frontend is separate (made by a friend) and will be connected to this backend.

## Architecture (do not restructure without permission)

```
frontend (friend's)  →  backend :5590  →  llama-server :8081 (0.8B v2 fine-tune)
                          │
                          ├─ SQLite: backend/data/threads.db (sessions, threads, messages)
                          └─ catalog.json (mock inventory + deals; stands in for Pickyourtrail's
                             live OceanJar/Hotelbeds inventory, which we cannot access)
```

- Frontend and backend are **independent processes**. The backend does not import the frontend and vice versa.
- The model runs as a **separate llama.cpp process** (`llama-server`). Never load model weights inside backend code.

## Run it

```bash
./setup.sh   # once: backend deps + model download
./run.sh     # boots llama-server on :8081 (waits until healthy) and backend on :5590
# test UI: http://127.0.0.1:5590 (served by src/server.ts when SERVE_TEST_UI=1, which run.sh sets)
```

Production: `docker compose up -d --build` (see README). Config is env vars, all listed in `backend/.env.example`.

- Restart only llama-server if it was restarted: health probe is `curl http://127.0.0.1:8081/health` → `{"status":"ok"}`.
- Backend health: `curl http://127.0.0.1:5590/health` (liveness) and `/ready` (503 until the model answers and the planner's data files are present).

## Backend wire contract (must stay EXACTLY this)

1. `POST /api/session` → `{"sessionId":"<uuid>","message":"Session created. Ready to start planning your trip!"}`
2. `GET /api/threads?sessionId=<id>` → `{"threads":[{"id":1,"title":"...","destination":null,"itineraryId":null,"itineraryMeta":null,"isActive":true,"createdAt":"...","updatedAt":"..."}]}`
3. `POST /api/chat` — body `{"sessionId","messages":[{"role":"user"|"assistant","content":"","timestamp":null}],"threadId"?}` → SSE (`text/event-stream`), events in order:
   - `event: destination_selected` `data: {"regionName":"Bali","regionCode":"idn"}` — only the first time a destination is detected
   - `event: campaign_deals` `data: {"deals":[<deal objects, shape below>]}` — same turn as above
   - `event: done` `data: {"message":"<full text>","threadId":1}` — ONE event with the full message, and it is authoritative.
   - Additive (D-019), before `done`, safe to ignore: `event: status` `data: {"step":"search_hotels","label":"Searching hotels"}` while the server works (steps: `thinking`, `writing`, each tool name, `weather`, `plan`, `note`), and `event: delta` `data: {"text":"<whole sentences>"}` as the model writes the reply. Each delta passed the same checks as the final reply (booking claims, unbacked prices, formatting); `{"reset":true}` means drop the text received so far. Planner questions and day-by-day plans arrive without deltas. `done` replaces whatever was streamed.
   - `event: error` `data: {"message":"...","code":"..."}` — on failure. Codes: `bad_request`, `session_not_found`, `message_too_long`, `thread_busy`, `model_unavailable`.
   - `done` may also carry (additive) `"offers":[...]`: flight/hotel offers from tools this turn, each with an `offer_id`; and `"pendingBooking":{"offer_id","travelers","total_price_inr"}` when the model wants to book. The message is then a confirmation summary built from the offer (dates, travellers, total with taxes, cancellation terms): show Confirm and Change buttons. Confirm → `/api/confirm`; Change → just send the next message.
   - While the model works the stream sends SSE comment lines (`: keep-alive`) every 15 s so proxies keep the connection open. Parsers must skip lines starting with `:` (standard SSE). If the client disconnects, the turn is cancelled and nothing is stored.
   - Validation that happens before streaming returns plain JSON `{"error":{"code","message"}}`: 400 invalid JSON, 413 body over 64 KB, 429 rate limited.
4. `POST /api/events/track` → `{"ok":true}` (accepts anything).
4b. Additive (D-019): `POST /api/threads/:id/rewind` `{"sessionId"}` → `{"ok":true,"removed":"<message text>"}` takes back the newest customer message and everything after it, restoring that thread's trip and plan to before it (edit and regenerate resend afterwards). 409 `cannot_rewind` when there is nothing to take back or a booking request came after it; 409 `thread_busy` while a reply is in progress; 404 unless the session owns the thread. `PATCH /api/threads/:id` `{"sessionId","title"}` → `{"ok":true,"title"}` (one line, at most 80 characters); `DELETE /api/threads/:id?sessionId=` → `{"ok":true}` deletes the thread and everything in it. Both 404 unless the session owns the thread.
5. `POST /api/confirm` — `{"sessionId","threadId","offerId","travelers"?}` → `{"status":"PENDING_SUPPLIER_CONFIRMATION","bookingRef":"BK-…","offer":{…},"message":"…"}` — never fabricates "confirmed". `sessionId` is required: thread ids are sequential and deal ids are public, so the session must own the thread. `offerId` is a tool `offer_id` or a deal's `campaignItineraryId` shown in that thread; anything else is 404. Repeating a request returns the same `bookingRef`. `message` comes from a status template and is also added to the thread, so the model (via `get_booking`) knows the request is pending.
6. `GET /api/threads/:id/messages?sessionId=` → `{"messages":[{"role","content","createdAt"}]}` (additive) — 404 unless the thread belongs to that session.
7. `GET /api/profile?sessionId=` → `{"profile":{…}}`; `PATCH /api/profile` `{"sessionId", "travelStyle"?, "budgetStyle"?, "homeCity"?, "interests"?, "dislikes"?, "dietaryNeeds"?, "mobilityNeeds"?, "accommodationPreferences"?}` → `{"profile"}` (lists given are replaced, `null` clears a field, unknown fields or values → 400 `invalid_profile`); `POST /api/profile/reset` `{"sessionId"}` → empty profile. Unknown session → 404. The session is the user until accounts exist (additive).
8. `GET /api/threads/:id/trip?sessionId=` → `{"trip":{destination, origin, startDate, endDate, month, durationDays, travelers, travelerTypes, purpose, budgetInr, budgetPerPerson, asked, planningTurns, status}}` — 404 unless that session's thread (additive).
9. `done` carries an additive `"planning":{"state","action","field"?,"assumptions":[…],"missing":[…]}`. `action` is `ask` (the planner asked a question itself), `draft` (first plan), `revise` (the plan was rebuilt after "make it cheaper", "slower", "more adventurous", "skip X", new dates or party size) or `converse`. `state` is `trip_basics`, `profile_context`, `high_value_refinement`, `draft_ready` or `revision`.
10. When a plan is built from place data, `done` also carries `"itinerary":{version, destination, startDate?, days:[{day, date?, items:[{kind (activity|meal|rest), block, start, end, title, poiId?, durationMinutes, durationBasis, travelToNext?:{minutes, km, basis (road|straight_line_estimate), source, isEstimate, confidence}, hours (open|unknown), costInr?, why:{matched, tradeoffs}, notes, suggestions?, source, confidence}], warnings}], totalEstimatedCostInr?, assumptions, warnings, alternatives, confidence, sources, rejected}` and `"insights":[{type, title, detail, source, sourceUrl?, licence?, checkedAt, severity, confidence, status (checked|not_checked|stale), date?, poiId?, effect?}]` (additive). The structured itinerary is the source of truth; `message` is its rendering. The frontend must show `sources` (the OpenStreetMap credit is required by its licence).
11. `GET /api/threads/:id/itinerary?sessionId=` → `{"itinerary": <latest version> | null}` — 404 unless that session's thread (additive).
12. `GET /ready` → `{"ok", "model": "ok"|"unreachable", "data": {"ok", "regions": ["goa"], "missing": ["place data for goa: /app/data/poi/goa.json", …]}, "routing": "osrm"|"estimate"}`; 503 unless the model answers and no planner file is missing (additive).

### Deal object shape (frontend must render these keys)

`campaignItineraryId, sourceItineraryId, title, image, images[], destinationString, nights, tripType, itineraryCost, itineraryCostWithoutFlights, hotelStarRating, slug, pills, numBookings, strikedCost, dealDiscountPercentage, cityHotelStay[{cityName,hotelName,nights,hotelImages[]}], activities[], highlights[], regionName, regionCode, type (UNITY|ON_SALE), unityOptions[], fixedItineraryDetails, perPersonCostByOption`

Categories code: region codes follow ISO-3 (idn, jpn, tha, are, mdv, sgp) in `backend/data/catalog.json`.

## Client expectation (how the frontend must talk to the API)

- The assistant is **Kodi**. The client shows its own welcome; it doesn't need to send it. The server stores its own greeting as the first assistant turn of each thread (`GREETING` in routes.ts).
- Replies are **plain text**: the server strips emojis and markdown (lists arrive as `•` lines), matching the frontend's plain-text rendering and its no-emoji design rule.
- The ready-made client is `client/takeoff-api.ts`, with plan helpers in `client/takeoff-plan.ts`. `integration.md` is a brief the frontend's coding agent carries out on its own; it embeds both files and `scripts/smoke.mjs`, so run `npm run docs:sync` in `backend/` after changing any of them (a test fails while a copy is out of date).
- The **server ignores the client's history** — its SQLite store is authoritative. The `messages[]` array is used only to find the latest user turn (and to replay context, which must therefore be non-spammy).
- Send `threadId` on every message after the first so the thread is reused (server auto-creates on first). A `threadId` that belongs to another session is ignored and a new thread is started.
- A turn is saved only after the model answers; on `model_unavailable` the client can simply resend.
- Set `"thinking": false` — the model was trained without thinking tags. (Backend already requests this from llama-server; the frontend never talks to llama-server directly.)

## Non-negotiable backend rules (reason in decision.md)

1. **The model never states a price/unverified number.** Prices only enter the conversation through tool results (tools.ts, deterministic mock inventory) or catalog deals. Enforced by `gatePrices` in harness.ts: unbacked amounts become "(price to be confirmed)".
2. **Bookings are never made by the model.** /api/confirm is the only path, and it always says PENDING. A model `create_booking` call is held as a confirmation summary built from the offer (`pendingBooking`); only the Confirm button reaches the supplier.
3. **PII is redacted before the model or storage see it** (card, CVV, OTP, Aadhaar, PAN, passport, email, phone) and thread titles are built from redacted text. Card/ID removal prepends a notice to the reply.
4. **Emergency phrases** (a deliberately narrow list from the model's harness, incl. Hinglish) skip the model, raise an urgent `handoff_to_human` and reply with a fixed "call 112" message. "Missed my flight" or "booked by accident" must not trigger it.
5. `POST /api/chat` streams `destination_selected` → `campaign_deals` → `done` in one response (with additive `status` and checked `delta` events before `done`), then closes. Never keep the stream open, and never send model text that has not passed the reply checks.

## Planning flow (first plan within three to four messages)

`services/promptRouter.ts`, `domain/extract.ts`, `domain/profile.ts`, `domain/trip.ts`:

- Every message is parsed **without the model** (destination, origin, dates, month, duration, party, budget, purpose, and preferences for the profile). The 0.8B model is not used for structured extraction.
- The **profile** (per session) keeps reusable preferences: pace, budget style, interests, dislikes, diet, mobility, stay type, home city. Explicit statements beat inferred ones; the newest explicit statement wins. The **trip** (per thread) keeps that trip's facts.
- The planner asks **at most three questions** per trip, most useful first (destination, when, who; then one of budget, pace, interests). It skips anything already known from the trip or the saved profile, and says which saved preferences it is using. Luxury stays on a small budget, or a contradictory pace, get one trade-off question.
- Its questions are answered **without a model call**. When it has enough (or has used its questions), the model writes the plan: a plain-language summary of the trip and the stated assumptions is added to the customer's message for that call only. The **system prompt is never changed**, and the stored message stays as typed.
- Side questions, searches, bookings, and edits after the first plan go to the model as before and don't use up questions.
- Scenarios for this flow live in `app/eval/scenarios/` and run in the backend tests.

## Itinerary engine (Phase 2)

- **Place data:** OpenStreetMap via `npm run data:import -- <region>` (regions in `backend/data/poi-regions.json`; output in git-ignored `backend/data/poi/`, an ODbL derived database; the committed `poi-manifest.json` records each extract). Licences and attribution: `docs/data-sources.md`.
- **Plan:** `services/itineraryService.ts` builds days in code: hard filters (access, dislikes, children, removed places), ranking with reasons, nearby stops per day, pace budgets, meal and rest breaks, opening hours, rain and closures, diet-matching meal options, alternatives. `services/itineraryValidator.ts` validates and repairs every plan. Unknown opening hours and visit lengths are assumptions with low confidence, never facts.
- **Model:** called without tools for a short note above the plan; `services/presentation.ts` rejects notes with prices, dates, times, bookings or places outside the plan and uses a template instead. The trained system prompt is unchanged.
- **Insights:** `services/insightsService.ts`: Open-Meteo (non-commercial free tier; production needs `OPEN_METEO_API_KEY`), the Wikivoyage guide (`GUIDE_DIR`), and "not checked" for events, closures, advisories and entry rules.
- **Revisions** apply to the trip only (`budgetStyleOverride`, `paceOverride`, `dayPace`, `excludedPoiIds`); the saved profile is unchanged.
- Destinations without place data keep the Phase 1 path (the model drafts from the trip summary).

## Adding a destination

Edit `backend/data/catalog.json`: add a `{name, code, aliases[], currency, deals[]}` entry. Aliases are matched case-insensitively as whole words against the chat text ("bali", "tokyo", "japan"...). No backend code change needed for detection.

## Testing

```bash
cd backend && npm test      # guardrails, tools, the full HTTP flow and the frontend client against a stub model server
npm run lint && npm run typecheck   # oxlint (as in the frontend repo) and tsc for the backend and client/
npx vitest run test/eval-scenarios.test.ts test/eval-itinerary.test.ts   # app/eval/scenarios/ (planner and itinerary)
npm run data:import -- goa   # refresh Goa's places from OpenStreetMap (light use of the public Overpass API)
../scripts/docker-smoke.sh --stub   # the image and Compose stack end to end with a stub model (CI runs this too)
../scripts/docker-smoke.sh          # the same with the real model weights and imported place data
```

The CI container test uses a stub model and the synthetic places in `eval/fixtures/town.json`, because the model weights
and the OSM-derived place files are not in the repository. It checks the image, mounts, readiness, the wire contract,
the planner, revisions and persistence; it does not check the model's wording.

Manual smoke test (start the stack first):

```bash
SID=$(curl -s -X POST http://127.0.0.1:5590/api/session | python3 -c "import json,sys;print(json.load(sys.stdin)['sessionId'])")
curl -s -N -X POST http://127.0.0.1:5590/api/chat -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"I want to plan a 5 day trip to Bali in December for 2 people, budget around 1 lakh\"}]}"
```

Expect: `destination_selected` (Bali) → `campaign_deals` (1 deal) → `done` with a coherent reply and a threadId.

## Known limits (do not hide these in UI copy)

- The model is a 0.8B fine-tune benchmarked at 2.13/4 with 2 critical-failure scenarios behind guardrails (source: `~/Downloads/Projects/travel-advisor-model/context/v2_REPORT.md`). Quality is imperfect — that is a training-data issue, not a backend bug.
- All prices are mock/deterministic. Label them "estimate" in the UI, never "live price".
- `backend/src/prompts.ts` is the exact prompt the model was trained with (`prompts/runtime_system_prompt.txt` in the model repo) plus its deployment block. Tool schemas in `tools.ts` match the model repo's `travel/tools.py`. Do not reword either: the model learned its behaviour from that text.
- The model was trained for trips **within India**; the catalog's international deals work but are outside its training focus.
- `get_destination_info` (a model tool) returns `found: false` until the model repo's `kb/destinations.json` is built; the itinerary engine reads the Wikivoyage pages directly for season notes.
- Place data exists for Goa only so far. OSM publishes opening hours for about 8% of Goa's places and wheelchair access for about 11%; the rest is shown as unknown. Travel times are straight-line estimates unless a self-hosted OSRM server is configured (`ROUTING_URL`); estimates are always labelled. Only published entry fees are counted.
- Tool history (calls and results) is stored per thread so the model can book an offer from an earlier turn; each model call sends the newest `MAX_HISTORY_CHARS` (default 30k) of it.

## Style for agents making changes here

- TypeScript, ESM, NodeNext, strict. No framework additions without updating `decision.md`.
- Keep files small and named for what they do: `db.ts` (SQLite), `harness.ts` (guardrails), `tools.ts` (mock inventory + tool schemas), `routes.ts` (HTTP handlers), `modelClient.ts` (OpenAI-compatible model client), `prompts.ts`, `catalog.ts`, `config.ts`, `server.ts` (bootstrap).
- Record **every** architectural decision as a new `## D-0XX` entry at the bottom of `decision.md`.
- Update `flow.md` stages as work completes.
- The model's training repo is a read-only reference; never edit it from here.
- Config is env vars (`backend/src/config.ts`, listed in `backend/.env.example`). Secrets such as `MODEL_API_KEY` may live in `backend/.env`, which is git-ignored.
