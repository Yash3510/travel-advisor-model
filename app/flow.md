# flow.md

Build flow, recorded as it happens.

## Stage 1 — Reconnaissance
- Browsed takeoff.wwmib.com (Playwright, page + full chat driven E2E).
- Captured full backend contract → see decision.md D-001.
- Verified via curl with no auth — contract works with plain HTTP.

## Stage 2 — Model selection
- Assessed my fine-tune (rejected, see decision.md D-002).
- Assessed friend's v2 GGUF (accepted).

## Stage 3 — Project setup
- Created this folder `/Users/rituraj/Desktop/travel AI agent project`.
- Docs started (decision.md, flow.md, must-know.md).
- Frontend scaffold: Next.js 15 + TS + Tailwind, called `frontend/`.

## Stage 4 — Backend contract implementation (DONE)
- `backend/` (TypeScript, plain Node HTTP, no heavy frameworks — see decision.md D-006).
- Endpoints: `/api/session`, `/api/threads`, `/api/chat` (SSE, matching Takeoff events `destination_selected` / `campaign_deals` / `done`), `/api/events/track`, `/api/confirm` (booking gate), `/health`.
- SQLite store for sessions + threads + messages.
- Guardrails: PII redaction (card / Aadhaar / email / phone / passport), emergency→112 router, self-confirmed-booking blocker.
- Tool layer with 7 tools matching the trained field names, deterministic mock inventory (`MockBackend`).
- Model client uses `chat_template_kwargs: {enable_thinking:false}`, tools passed per friend's `INTEGRATION.md` contract, agent loop ≤6 tool rounds.
- Verified E2E: Bali request → `destination_selected({"regionName":"Bali","regionCode":"idn"})` → campaign deal card → final message. Emergency prompt → 112 template. Booking prompt → refusal + redacted card.
- 11 vitest tests pass.

## Stage 5 — Frontend (DONE, minimal per user request)
- Single static file `frontend/index.html` served by the backend on :5590 (no Next.js — user said don't spend time on frontend).
- Features: chat bubbles, typewriter reveal, quick-reply chips (pace/hotel style), live deal card in sidebar (wired to `campaign_deals`), session bootstrap, "beta" disclaimer line.
- Verified in Chromium: Bali message → deal card appears → chips clickable → model answers follow-ups. Screenshot: `shots/03_after2.png`.

## Known frontend gaps (deliberate, revisit only if user asks)
- No threads list/rich sidebar, no mascot animation, no mobile polish, no Next.js, no itinerary builder page.

## Stage 6 — Production hardening (DONE)
- Fixed install, moved guardrails into code, session-scoped threads, persisted offers + booking requests, rate limits, CORS allowlist, Docker + CI. See decision.md D-010.
- Tests: guardrails, tools and the full HTTP flow against a stub model server.
