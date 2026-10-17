# must-know.md (draft — finalized at end of build)

Things you must know once this is done.

## Facts about the reference site
- Takeoff is Pickyourtrail's AI consultant ("Trippie") on Next.js. Chat responses are NOT streamed token-by-token: server sends one `done` SSE event with the whole message; their typing animation is client-side.
- Pricing and inventory come from their own warehouse (OceanJar/Hotelbeds); we substitute a static local catalog — so the "prices" you see in our product are demo data, not live quotes.

## Facts about the model
- Running a 0.8B quantized GGUF locally on this Mac M5 via `llama-server`.
- It is capped by the benchmark at 2.13/4 with ~2 critical failure scenarios even after guardrails; expect imperfection and judge accordingly. Fixing it means retraining with more data, not hacking the backend.

## Facts about the architecture
- One Next.js app = frontend + `/api/*` handlers. `llama-server` runs as a **separate process on :8081**: the app never loads the model into its own memory.
- The model never invents prices or destinations. It only picks and personalizes; numbers are injected into the wire format from `catalog.json`.

## Fact to keep for later
- Your own `~/Desktop/Projects/model` repo's catalog idea (circuit/stay/activity catalog + deterministic budget engine, no prices from model) is the cleanest satisfying design and should be merged into this project's catalog layer in future iterations.
