# Wiring the Takeoff frontend to this backend

The frontend (React 19 + Vite) currently fakes every reply with `setTimeout`. This guide replaces the fakes with the
real backend. The full wire contract is in [AGENTS.md](../AGENTS.md).

## 1. Add the client

Copy [`client/takeoff-api.ts`](../client/takeoff-api.ts) into the frontend as `src/services/takeoffApi.ts`. It has no
dependencies and is tested against this backend (`backend/test/api.test.ts`). It handles:

- creating and storing the session (`localStorage` key `takeoff.sessionId`), and replacing it if the server forgets it
- the chat stream: one reply per message, skipping the `: keep-alive` lines the server sends while the model works
- Confirm, the threads list and a thread's messages
- error codes (`TakeoffApiError.code`) and customer-facing error text (`errorText`)
- `toDealCard`, which maps backend deals to the card shape `App.tsx` already renders

## 2. Point it at the backend

Dev, in `vite.config.ts`, so the browser calls the Vite origin and CORS doesn't come into play:

```ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:5590' } },
})
```

Production: set `VITE_API_URL` to the backend's URL, and on the backend set `ALLOWED_ORIGINS` to the frontend's
origin (comma-separated if more than one).

```ts
import { createTakeoffApi, errorText, toDealCard, type PendingBooking } from './services/takeoffApi';

export const api = createTakeoffApi({ baseUrl: import.meta.env.VITE_API_URL ?? '' });
```

## 3. Replace the fake chat (`startChatWithPrompt` / `handleSend` in `App.tsx`)

```ts
const threadIdRef = useRef<number | undefined>(undefined);
const abortRef = useRef<AbortController | null>(null);

async function send(prompt: string) {
  if (isTyping || !prompt.trim()) return; // the server answers one message at a time per thread
  setHasStarted(true);
  setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: prompt, timestamp: 'Just now' }]);
  setInputText('');
  setIsTyping(true);
  abortRef.current = new AbortController();
  try {
    const reply = await api.chat(prompt, {
      threadId: threadIdRef.current,
      signal: abortRef.current.signal,
      onDestination: (d) => setTrip((t) => ({ ...t, destination: d.regionName })),
      onDeals: (deals) => setDeals(deals.map(toDealCard)),
    });
    threadIdRef.current = reply.threadId;
    setMessages((prev) => [...prev, {
      id: `bot-${Date.now()}`, role: 'assistant', content: reply.message, timestamp: 'Just now',
      pendingBooking: reply.pendingBooking, // add `pendingBooking?: PendingBooking` to the Message type
    }]);
  } catch (err) {
    setMessages((prev) => [...prev, { id: `bot-${Date.now()}`, role: 'assistant', content: errorText(err), timestamp: 'Just now' }]);
  } finally {
    setIsTyping(false);
  }
}
```

- **Lock the input while a reply is pending:** `disabled={!inputText.trim() || isTyping}` on both send buttons, and
  `maxLength={4000}` on the inputs.
- **Replies take 5–60 s** with the local model. Keep the typing dots. A Stop button can call `abortRef.current?.abort()`;
  the server then cancels that turn and stores nothing.
- **"New journey":** in `resetChat`, also call `abortRef.current?.abort()` and set `threadIdRef.current = undefined`.
- **Don't send the welcome text.** The frontend shows its own greeting; the server keeps its own history and only reads
  the newest message.
- **Text is plain.** The server strips emojis and markdown, so the existing `whitespace-pre-line` rendering is right.
  Lists arrive as lines starting with `•`.
- **Safety notice:** if a customer pastes card or ID numbers, the server removes them and the reply starts with a
  notice. Nothing to do on the frontend.

## 4. Booking: Confirm and Change

When a reply has `pendingBooking`, its text is a booking summary (dates, travellers, total with taxes, cancellation
terms). Render two buttons under it:

```ts
async function onConfirm(p: PendingBooking) {
  const result = await api.confirm({ threadId: threadIdRef.current!, offerId: p.offer_id, travelers: p.travelers });
  setMessages((prev) => [...prev, { id: `bot-${Date.now()}`, role: 'assistant', content: result.message, timestamp: 'Just now' }]);
}
// Change: focus the input. The customer's next message carries on the conversation.
```

`result.status` is `PENDING_SUPPLIER_CONFIRMATION`: show it as *requested, not confirmed*. Never show "booked",
"confirmed" or confetti for it.

Deals can be requested the same way: `api.confirm({ threadId, offerId: deal.campaignItineraryId, travelers })`, but only
for a deal the server sent in that thread.

## 5. Sidebar: real conversations

Replace the four hard-coded expeditions with `await api.threads()`. On click, load `await api.messages(thread.id)`
into `messages` and set `threadIdRef.current = thread.id`.

## 6. Error codes

| `err.code` | When | What to show |
|---|---|---|
| `model_unavailable` | model server down or timed out | `errorText(err)` and a Retry button that resends the same text |
| `rate_limited` | over 20 messages a minute from one IP | `errorText(err)` |
| `thread_busy` | a second message while one is pending | shouldn't happen once the input is locked |
| `message_too_long` | over 4,000 characters | `errorText(err)` |
| `aborted` | Stop or New journey | nothing |
| `network`, `stream_ended` | connection dropped | `errorText(err)` and Retry |

`session_not_found` is handled inside the client (it starts a new session once).

## 7. What the backend does not provide yet

These parts of the UI have no backend behind them; decide whether to hide them or build them:

- **The itinerary dossier** (`TripState`: day plans, hotels, activities, totals, "Open Canvas"). The backend returns chat
  text, deals (with `cityHotelStay` and `activities`), and hotel or flight offers, but no day-by-day plan.
- **Suggestion chips** under replies, hotel swap cards, multi-currency prices.
- **The checkout drawer** ("Pay ₹10,000 refundable token"): there is no payment system. It must not collect names,
  emails or phone numbers, or show a success alert, until there's a backend that receives and stores them.
- Saved trips, the contact form, careers applications and pricing plans.
