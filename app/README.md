# Takeoff — travel AI agent backend

AI travel-planning chat backend. The client sends a message, and the server streams back the
destination it detected, matching deals and the assistant's reply over SSE. A fine-tuned model
handles the conversation. Prices and bookings only come from tool results and the catalog,
never from the model.

The production frontend lives elsewhere. To connect it, copy `client/takeoff-api.ts` into it and follow
[integration.md](integration.md). `frontend/index.html` is only a test client.

## Quickstart

```bash
./setup.sh   # backend deps + the 795 MB fine-tuned model (one time)
./run.sh     # llama-server (:8081) + backend (:5590); stops llama-server on exit
```

Open http://127.0.0.1:5590 for the test client. To use a hosted OpenAI-compatible model
instead of the local one, set `MODEL_URL`, `MODEL_NAME` and `MODEL_API_KEY`. See
`backend/.env.example`.

## Place data

Plans are built from OpenStreetMap places, imported per region: `cd backend && npm run data:import -- goa`.
The files are generated, not committed (see `docs/data-sources.md` for licences and attribution).

## Production

```bash
cd backend && npm run data:import -- goa && cd ..   # place files, mounted read-only into the backend
docker compose up -d --build   # model server + backend, SQLite on a named volume
curl -s localhost:5590/ready   # 200 once the model answers and the place files, guide pages and database are there
```

The image holds the compiled backend, `catalog.json`, `places.json` and the region list; the place files
(`POI_DIR`, default `backend/data/poi`) and the guide pages (`GUIDE_HOST_DIR`, default `../data/raw/wikivoyage`)
are mounted at run time. A missing directory stops Compose; a missing file inside it makes `/ready` return 503 and
name it. Set `ALLOWED_ORIGINS` to the frontend's origin, `TRUST_PROXY=1` behind a reverse proxy,
`OPEN_METEO_API_KEY` for weather and `ROUTING_URL` for road times (`docs/data-sources.md`). The backend image runs
compiled JS as a non-root user with a health check.

```bash
scripts/docker-smoke.sh          # clean build, real model, four-message plan, revision, restart, then cleanup
scripts/docker-smoke.sh --stub   # the same with a stub model and synthetic places (what CI runs)
```

## API

The full contract with payloads is in [AGENTS.md](AGENTS.md).

| Endpoint | Purpose |
|---|---|
| `POST /api/session` | new session id |
| `GET /api/threads?sessionId=` | a session's threads |
| `GET /api/threads/:id/messages?sessionId=` | a thread's messages (only its own session) |
| `GET /api/threads/:id/trip?sessionId=` | the trip facts the planner has gathered for that thread |
| `GET /api/threads/:id/itinerary?sessionId=` | the latest structured itinerary for that thread |
| `GET`, `PATCH /api/profile`, `POST /api/profile/reset` | the traveler profile (reusable preferences) of a session |
| `POST /api/chat` | SSE: `destination_selected` → `campaign_deals` → `done` (or `error`) |
| `POST /api/confirm` | request booking of an offer shown in that thread → `PENDING_SUPPLIER_CONFIRMATION` |
| `POST /api/events/track` | analytics sink |
| `GET /health`, `GET /ready` | liveness; readiness (model reachable, place data and guide pages present, database writable) |

## Guardrails (enforced in code, not just the prompt)

- **Prices:** any rupee amount in a reply that isn't backed by a tool result, a deal on screen or
  the user's own words is replaced with "(price to be confirmed)".
- **Bookings:** the model's `create_booking` never runs. It becomes a confirmation summary built
  from the offer (`pendingBooking`). Only `/api/confirm` (the Confirm button, which needs the session)
  sends a request, and its outcome text comes from a template.
- **Privacy and emergencies:** card, CVV, OTP, Aadhaar, PAN, passport, email and phone numbers are
  removed before the model or storage see them. Real emergencies get the 112 message and an
  urgent handoff without calling the model.
- **Isolation:** threads belong to a session, so a guessed thread id is never readable or
  writable.

## Development

```bash
cd backend
npm test            # vitest: guardrails, tools, history trimming, full API flow against a stub model
npm run typecheck
LOG_TOOLS=1 ../run.sh
```

Read `decision.md` before changing the architecture, and log new decisions there as `## D-0XX`.
