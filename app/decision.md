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
- The frontend (React 19, Vite, Tailwind v4, Bun, oxlint) has no backend calls yet; everything is faked in the browser. So the backend ships a typed, dependency-free client (`client/takeoff-api.ts`), tested against the real routes, plus `docs/frontend-integration.md`.
- The assistant is Kodi: the server greeting no longer uses another company's persona.
- Replies are plain text with no emojis (`toPlainText` in harness.ts). The frontend renders plain text, and its design rules ban emojis. Stripping in code keeps the trained prompt unchanged.
- oxlint (the frontend's linter) now runs on the backend and the client, in CI too.
