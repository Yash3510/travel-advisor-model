# Integrating the Takeoff frontend with the backend

For Pranay: how to replace the frontend's `setTimeout` fakes with the real backend, step by step, using the names in
`src/App.tsx` and `src/data/tripData.ts`. The exact wire contract (every endpoint and payload) is in
[AGENTS.md](AGENTS.md); this guide is how to use it from the UI.

You only need one file from this repository: [`client/takeoff-api.ts`](client/takeoff-api.ts). It has no
dependencies, is tested against the real backend routes (`backend/test/api.test.ts`, `backend/test/client.test.ts`),
type-checks with the frontend's own compiler settings (`erasableSyntaxOnly`, `lib: ES2023, DOM`) and passes the
frontend's `.oxlintrc.json`.

## Contents

1. [What the backend gives you](#1-what-the-backend-gives-you)
2. [Run the backend](#2-run-the-backend)
3. [Add the client and point it at the backend](#3-add-the-client-and-point-it-at-the-backend)
4. [Replace the fake chat](#4-replace-the-fake-chat)
5. [The planner's questions](#5-the-planners-questions)
6. [Show the plan (`reply.itinerary`)](#6-show-the-plan-replyitinerary)
7. [Insights, warnings and sources](#7-insights-warnings-and-sources)
8. [Revisions and alternatives](#8-revisions-and-alternatives)
9. [Preferences screen (profile)](#9-preferences-screen-profile)
10. [Sidebar: real conversations, restored](#10-sidebar-real-conversations-restored)
11. [Booking: Confirm and Change](#11-booking-confirm-and-change)
12. [Errors](#12-errors)
13. [Rules the UI must keep](#13-rules-the-ui-must-keep)
14. [What the backend does not provide yet](#14-what-the-backend-does-not-provide-yet)
15. [Check the integration](#15-check-the-integration)

## 1. What the backend gives you

| Frontend piece today | Backend | Client call |
|---|---|---|
| Fake replies in `startChatWithPrompt` / `handleSend` | Real chat with Kodi, one full reply per message | `api.chat(text, { threadId, onDestination, onDeals })` |
| Hard-coded curated deals | Deals for the destination the customer names | `onDeals` callback, then `toDealCard` |
| `itineraryCard`, `TripState.days` from `tripData.ts` | A day-by-day plan built by code from real place data (Goa so far) | `reply.itinerary`, `api.itinerary(threadId)` |
| Trip summary (destination, dates, travellers) | What the planner knows about the trip | `api.trip(threadId)` |
| Nothing | Weather, season notes, and what was **not** checked | `reply.insights` |
| Nothing yet (the `TravelMatchQuiz` could feed it) | Saved preferences, reused in every new trip | `api.profile()`, `api.updateProfile()`, `api.resetProfile()` |
| Four hard-coded expeditions in the sidebar | The session's real conversations | `api.threads()`, `api.messages(threadId)` |
| Checkout drawer `alert()` | A booking request (never "confirmed" until a supplier confirms) | `api.confirm(...)` |

How a conversation goes: the planner asks at most three short questions (destination, dates, who is travelling,
then one of budget, pace or interests), and builds the first plan by the third or fourth message. Questions come
back instantly. A plan takes about 5 to 15 seconds on the local model (CPU), and other model replies 5 to 60 seconds.

## 2. Run the backend

The backend is Node 22 (npm, not Bun: it uses a native SQLite module). From the `app/` folder of this repository:

```bash
./setup.sh                      # npm ci, and downloads the model (about 834 MB) to ../models/trained-v2-gguf/
cd backend && npm run data:import -- goa && cd ..   # Goa's places from OpenStreetMap (one-off)
./run.sh                        # model server on :8081, backend on :5590
```

- `run.sh` needs `llama-server` (on a Mac: `brew install llama.cpp`, which uses the GPU through Metal). If you'd rather
  not install it, `docker compose up -d --build` runs the model and backend in containers, but on a Mac the model then
  runs on the CPU and replies are slower.
- The place files (`backend/data/poi/`) are generated from OpenStreetMap and must not be committed to the frontend
  repository (ODbL licence). Yash can also send you `goa.json`.
- `run.sh` also serves a bare test page at `http://127.0.0.1:5590`; it is not the product UI.

Check it is up:

```bash
curl -s http://127.0.0.1:5590/health   # {"ok":true}
curl -s http://127.0.0.1:5590/ready    # {"ok":true,"model":"ok","data":{"ok":true,"regions":["goa"],"missing":[]},"routing":"estimate"}
```

If `/ready` says `"ok":false`, its `missing` list names the file that is missing, and `"model":"unreachable"` means
the model server isn't running.

## 3. Add the client and point it at the backend

1. Copy `client/takeoff-api.ts` into the frontend as `src/services/takeoffApi.ts`, unchanged. When the backend changes,
   copy it again; don't edit it in place.
2. Dev proxy, in `vite.config.ts`, so the browser calls the Vite origin and CORS never comes into play:

   ```ts
   export default defineConfig({
     plugins: [react(), tailwindcss()],
     server: { proxy: { '/api': 'http://127.0.0.1:5590' } },
   })
   ```

3. One shared instance, `src/services/api.ts`:

   ```ts
   import { createTakeoffApi } from './takeoffApi';

   // '' in dev (the Vite proxy); the backend's URL in production, e.g. VITE_API_URL=https://api.example.com
   export const api = createTakeoffApi({ baseUrl: import.meta.env.VITE_API_URL ?? '' });
   ```

4. Production: set `VITE_API_URL` at build time, and ask for the frontend's origin to be added to the backend's
   `ALLOWED_ORIGINS` (comma-separated). No cookies or auth headers are involved.

The client keeps the session id in `localStorage` (`takeoff.sessionId`) so conversations survive a reload, and starts a
new session by itself if the server no longer knows the old one. The session is the user until accounts exist.

## 4. Replace the fake chat

Extend the `Message` type in `App.tsx` with what a reply can carry:

```ts
import type { ItineraryDraft, PendingBooking, PlanningInfo, TripInsight } from './services/takeoffApi';

interface Message {
  // ...the existing fields
  pendingBooking?: PendingBooking; // render Confirm / Change (section 11)
  planning?: PlanningInfo;         // what the planner did this turn (section 5)
  itinerary?: ItineraryDraft;      // a new or revised plan (section 6)
  insights?: TripInsight[];        // with every plan (section 7)
}
```

Then one `send` replaces both `startChatWithPrompt` and `handleSend`:

```ts
import { errorText, toDealCard } from './services/takeoffApi';
import { api } from './services/api';

const threadIdRef = useRef<number | undefined>(undefined);
const abortRef = useRef<AbortController | null>(null);

async function send(prompt: string) {
  const text = prompt.trim();
  if (isTyping || !text) return; // one message at a time per thread
  setHasStarted(true);
  setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text, timestamp: 'Just now' }]);
  setInputText('');
  setIsTyping(true);
  abortRef.current = new AbortController();
  try {
    const reply = await api.chat(text, {
      threadId: threadIdRef.current,
      signal: abortRef.current.signal,
      onDestination: (d) => setTrip((t) => ({ ...t, destination: d.regionName })),
      onDeals: (deals) => setDeals(deals.map(toDealCard)),
    });
    threadIdRef.current = reply.threadId;
    setMessages((prev) => [...prev, {
      id: `bot-${Date.now()}`, role: 'assistant', content: reply.message, timestamp: 'Just now',
      pendingBooking: reply.pendingBooking, planning: reply.planning, itinerary: reply.itinerary, insights: reply.insights,
    }]);
    if (reply.itinerary) await showPlan(reply.threadId, reply.itinerary); // section 6
  } catch (err) {
    setMessages((prev) => [...prev, { id: `bot-${Date.now()}`, role: 'assistant', content: errorText(err), timestamp: 'Just now' }]);
  } finally {
    setIsTyping(false);
  }
}
```

- **Lock the input while a reply is pending:** `disabled={!inputText.trim() || isTyping}` on both send buttons, and
  `maxLength={4000}` on the inputs.
- **Keep the typing dots.** A Stop button can call `abortRef.current?.abort()`; the server cancels that turn and stores
  nothing.
- **"New journey":** in `resetChat`, also call `abortRef.current?.abort()` and set `threadIdRef.current = undefined`.
  The next message starts a new thread.
- **Don't send the welcome text.** Show the frontend's own greeting, but only send what the customer typed. The server
  keeps the history and reads only the newest message.
- **The fake greeting with a trip overview** ("I've designed a bespoke travel plan for…") must go: no plan exists until
  the backend sends one.
- **Text is plain.** The server removes emojis and markdown, so the existing `whitespace-pre-line` rendering is right.
  Lists arrive as lines starting with `•`. If a customer pastes card or ID numbers, the server removes them and the
  reply starts with a notice; nothing to do on the frontend.
- `reply` keeps any field a newer backend adds, so you can read new fields without updating the client.

## 5. The planner's questions

When the planner asks a question itself, `reply.planning` is `{ action: 'ask', state, field, assumptions, missing }`
and `reply.message` is the question. Render it as a normal message, and use `field` for quick replies (the existing
`cardType` cards fit):

| `planning.field` | The question | Existing card | Quick replies to send (as plain text) |
|---|---|---|---|
| `destination` | Where would you like to go? | `cities` | the place name, e.g. `Goa` |
| `when` | When, and for how many days? | `date` | `15 to 17 December`, or `December, 5 days` |
| `travelers` | Who's travelling, and how many? | `traveller` | `me and my wife`, `2 of us`, `we are 4 people` |
| `budget` | A rough total budget? | (none yet) | `about 50k`, `around 80k`, `budget 1 lakh` |
| `pace` | Relaxed, balanced or packed? | `pace` | `relaxed`, `balanced`, `packed` |
| `interests` | What do you enjoy most? | `experiences` | `beaches and food`, `history`, `nature and adventure` |
| `tradeoff:pace` | Relaxed with free time, or packed? | `pace` | `relaxed`, `packed` |
| `tradeoff:luxury_budget` | Keep the budget, or keep luxury? | (none yet) | `keep the budget, comfortable stays are fine`, `keep luxury, I can spend more` |

A date picker should send its range as text in the same form, for example `15 to 17 December`. The customer can always
type instead; chips are a shortcut, not the only way.

`planning.action` is `draft` for the first plan, `revise` when a plan was rebuilt, and `converse` when the model
answered something else (a side question, a hotel or flight search).

## 6. Show the plan (`reply.itinerary`)

`reply.itinerary` (type `ItineraryDraft`) is the plan itself, built and checked by code. `reply.message` is a text
rendering of the same plan with a short note on top. Render the dossier from `itinerary`, not by parsing the text.
A trimmed real example (Goa, 15 December):

```json
{
  "version": 1, "destination": "Goa", "startDate": "2026-12-15", "confidence": 0.47,
  "days": [{
    "day": 1, "date": "2026-12-15", "warnings": [],
    "items": [
      { "kind": "activity", "block": "morning", "start": "09:00", "end": "10:30", "title": "Chapora Fort",
        "poiId": "osm:relation/15959326", "durationMinutes": 90, "durationBasis": "category_default", "hours": "open",
        "travelToNext": { "minutes": 37, "km": 11.3, "basis": "straight_line_estimate", "source": "Straight-line estimate", "isEstimate": true, "confidence": 0.5 },
        "why": { "matched": [], "tradeoffs": [] }, "notes": [],
        "source": { "name": "OpenStreetMap", "url": "https://www.openstreetmap.org/relation/15959326", "licence": "ODbL-1.0", "attribution": "© OpenStreetMap contributors" },
        "confidence": 0.53 },
      { "kind": "meal", "block": "afternoon", "start": "13:00", "end": "14:00", "title": "Lunch", "durationMinutes": 60, "durationBasis": "fixed", "notes": [], "confidence": 1 }
    ]
  }],
  "assumptions": ["A balanced pace", "Visit lengths are typical times for each kind of place, not published figures", "..."],
  "warnings": ["Travel times between stops are straight-line estimates, not road routes, so allow extra time"],
  "alternatives": [{ "kind": "more_relaxed", "summary": "Fewer stops a day, with a rest break", "changes": ["Day 1: drop …; add …"] }],
  "sources": [
    { "name": "OpenStreetMap", "licence": "ODbL-1.0", "attribution": "© OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright" },
    { "name": "Wikivoyage", "licence": "CC BY-SA 4.0", "attribution": "Wikivoyage", "url": "https://en.wikivoyage.org/wiki/Goa" }
  ],
  "rejected": []
}
```

What each part means for the UI:

- **`days[].items`** are timed blocks: `activity` (a place to visit), `meal` (a break, with `suggestions` of nearby
  places that fit the traveller's diet when there are any) and `rest`. Times are `HH:MM`, in order.
- **`hours`**: `open` means checked against published opening hours; `unknown` means none are published. Show
  "Opening hours not published" for `unknown`.
- **`costInr`** appears only when an entry fee is published, and is the total for the group. When it is missing, the
  fee is unknown, not zero: show nothing or "Entry fee not published", never ₹0.
- **`totalEstimatedCostInr`** adds up published entry fees only (often absent). Hotels, food and transport are not in
  it. Never label it as the trip price.
- **`why.matched`** says why a stop was picked ("your interest in beaches"); **`why.tradeoffs`** says what it costs
  ("about 37 min from the previous stop"). Good material for the activity description.
- **`notes`** and **`days[].warnings`** belong next to the stop or the day; show them.
- **`confidence`** (0 to 1) is how sure the plan is (published hours, typical visit lengths, travel estimates). Use it
  for a subtle "check before you go" hint if you like; don't present it as a score.
- **`rejected`**: places considered and left out, with the reason. Don't offer them as suggestions.
- There are **no photos, hotels or flights** in the plan. Don't fill them in with stock images or the old mock hotels.

An adapter to the frontend's existing types, `src/services/planAdapters.ts`. Two type changes in `tripData.ts` make
it honest: `priceINR?: number` (optional, since most fees aren't published) and an optional `mapUrl?: string` on
`Activity`.

```ts
import type { ItineraryDraft, ItineraryItem, TripContext } from './takeoffApi';
import type { Activity, DayPlan, TripState } from '../data/tripData';

const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
export const niceDate = (iso?: string) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';

function toActivity(i: ItineraryItem, n: number, destination: string): Activity {
  const description = [
    ...(i.why?.matched.length ? [`For ${i.why.matched.join(' and ')}`] : []),
    ...(i.suggestions?.length ? [`Nearby: ${i.suggestions.map((s) => s.name).join(', ')}`] : []),
    ...i.notes,
    ...(i.kind === 'activity' && i.hours === 'unknown' ? ['Opening hours not published'] : []),
  ].join('. ');
  return {
    id: i.poiId ?? `${i.kind}-${n}`,
    time: `${i.start}–${i.end}`,
    title: i.title,
    location: destination,
    mapUrl: i.source?.url, // the place's OpenStreetMap page
    description,
    duration: duration(i.durationMinutes),
    category: i.kind === 'meal' ? 'Culinary' : i.kind === 'rest' ? 'Relaxation' : 'Sightseeing',
    priceINR: i.costInr, // undefined = no published fee
    image: '', // no photos from the backend: show a neutral placeholder
  };
}

export const toDayPlans = (it: ItineraryDraft): DayPlan[] =>
  it.days.map((d) => ({
    dayNumber: d.day,
    date: niceDate(d.date) || `Day ${d.day}`,
    title: `Day ${d.day}`,
    tagline: d.items.filter((i) => i.kind === 'activity').map((i) => i.title).join(' · '),
    activities: d.items.map((i, n) => toActivity(i, n, it.destination)),
    stayHotelId: '', // hotels are not part of the plan
  }));

export const toTripState = (it: ItineraryDraft, trip: TripContext, current: TripState): TripState => ({
  ...current,
  destination: it.destination,
  country: 'India',
  dates: it.days.length && it.days[0].date ? `${niceDate(it.days[0].date)} – ${niceDate(it.days.at(-1)!.date)}` : 'Flexible dates',
  durationDays: it.days.length,
  travelers: trip.travelers ?? 2,
  tripType: trip.purpose ?? '',
  flightIncluded: false,
  flightPriceINR: 0, // not shown: there are no flights in the plan
  hotels: [],
  days: toDayPlans(it),
});
```

And in `App.tsx`:

```ts
async function showPlan(threadId: number, it: ItineraryDraft) {
  const trip = await api.trip(threadId); // travellers, dates and purpose, as the planner understood them
  setTrip((current) => toTripState(it, trip, current));
}
```

The existing `itineraryCard` on `Message` needs `totalINR`, `perPersonINR` and a `hotel`, which the backend doesn't
have. Build the summary card from `message.itinerary` instead: destination, `days.length` days, the date range,
the number of activities, and day 1's activities from `toDayPlans(itinerary)[0]`. Hide the hotel and price rows rather
than showing mock values. In the dossier, hide the hotel section when `trip.hotels` is empty.

**Travel between stops.** `travelToNext` on an activity is the trip to the next stop. When `isEstimate` is `true` it is
a straight-line estimate: show "about 37 min (estimated)". When `basis` is `road` it comes from a road routing server:
"about 37 min by road". Never show an estimate as an exact time.

## 7. Insights, warnings and sources

`reply.insights` (type `TripInsight[]`) comes with every plan. Show them in a small "Before you go" panel:

| `status` | Meaning | How to show it |
|---|---|---|
| `checked` | From an approved source, as of `checkedAt` | `title`: `detail`, with the date for day-specific ones |
| `stale` | An older check that no longer changes the plan | the same, marked "earlier forecast" |
| `not_checked` | No approved source, or the check failed | "Not checked: events" (from `title`); never as "all clear" |

- `severity: 'warning'` with `effect: 'rain'` means heavy rain is likely on `date`; the plan has already moved that day
  indoors and says so in the day's `warnings`.
- Each insight names its `source`, `sourceUrl` and `licence`. Link them: Open-Meteo data is CC BY 4.0 and Wikivoyage
  is CC BY-SA 4.0, and both require the credit.
- Events, one-off closures, travel advisories and entry rules are always `not_checked` for now. That is honest, not a
  bug: keep showing them as not checked.

**Warnings and assumptions.** `itinerary.warnings` (plan-wide) and `days[].warnings` (per day) are things the traveller
should know, such as "Heavy rain is likely on 15 December, so this day keeps to indoor places" or that travel times are
estimates. Show them where they apply. `itinerary.assumptions` ("A balanced pace", "2 travellers", "Visit lengths are
typical times…") can sit in a collapsible "How this plan was made" section.

**Sources (required).** Wherever the plan is shown, render `itinerary.sources`, for example in the dossier footer:

```tsx
<p className="text-xs">
  {itinerary.sources.map((s) => (
    <a key={s.name} href={s.url} target="_blank" rel="noreferrer">{s.attribution}{s.licence ? ` (${s.licence})` : ''}</a>
  ))}
</p>
```

The "© OpenStreetMap contributors" credit is a condition of the place data's licence, so it can't be hidden or left
out.

## 8. Revisions and alternatives

Revisions are ordinary chat messages. The backend rebuilds the plan and sends a new `itinerary` with `version` one
higher and `planning.action: 'revise'`. The saved preferences stay as they are ("make it cheaper" is for this trip
only). Phrases the planner recognises:

| The customer wants | Send (or let them type) |
|---|---|
| A cheaper plan | `Make it cheaper` |
| A slower trip, or one slower day | `Make it more relaxed`, `Make day 2 more relaxed` |
| A busier trip | `See more`, `Add more stops` |
| To drop a place in the plan | `Skip Chapora Fort`, `I don't want to go to Chapora Fort` |
| Other dates or party size | `Move it to 21 to 23 December`, `We are 4 people now` |

`itinerary.alternatives` lists ready-made variations the backend has already checked. Show them as suggestion chips
(the existing `suggestions` field fits) with `summary` as the label and `changes` as the detail, and send this text
when one is tapped:

| `alternative.kind` | Send |
|---|---|
| `cheaper` | `Make it cheaper` |
| `more_relaxed` | `Make it more relaxed` |
| `more_adventurous` | `Add more nature and adventure and see more` |

Use exactly these messages. "Make it more adventurous", for example, is answered as a question and does not rebuild
the plan.

## 9. Preferences screen (profile)

The traveller's preferences are saved per session and reused for every new trip: the planner then skips those
questions and says "I'll use your saved preferences: …". The `TravelMatchQuiz` answers can be saved here.

```ts
const profile = await api.profile();
const saved = await api.updateProfile({ travelStyle: 'relaxed', interests: ['beach', 'food'], dietaryNeeds: ['vegetarian'] });
await api.updateProfile({ travelStyle: null }); // null clears a field
const empty = await api.resetProfile();         // "Forget my preferences"
```

| Field | Values |
|---|---|
| `travelStyle` | `relaxed`, `balanced`, `packed` (or `null`) |
| `budgetStyle` | `budget`, `value`, `comfort`, `premium` (or `null`) |
| `homeCity` | short text (or `null`) |
| `interests`, `dislikes` | e.g. `beach`, `mountains`, `nature`, `wildlife`, `adventure`, `trekking`, `culture`, `history`, `spiritual`, `food`, `nightlife`, `shopping`, `wellness`, `photography`; `dislikes` also `crowds`, `long drives`, `early mornings`, `heat` |
| `dietaryNeeds` | `vegetarian`, `vegan`, `jain`, `halal`, `gluten-free`, `eggless` |
| `mobilityNeeds` | `wheelchair`, `limited walking` |
| `accommodationPreferences` | e.g. `villa`, `resort`, `homestay`, `hostel`, `boutique`, `beachfront`, `private pool`, `pet-friendly` |

- A list you send replaces the saved list. Common synonyms are folded into these words ("veg" becomes `vegetarian`);
  other words are kept as typed, in lower case.
- An unknown field or a `travelStyle`/`budgetStyle` outside the list rejects with code `invalid_profile` and a message
  you can show next to the field.
- Diet and mobility are hard constraints: the planner never puts a wheelchair user somewhere marked inaccessible, and
  meal suggestions only list places that match the diet.
- `sourceByField` says whether each preference was set by the traveller (`explicit`) or picked up from chat
  (`inferred`). A preferences screen can mark inferred ones as "learned from your chats".

## 10. Sidebar: real conversations, restored

Replace the four hard-coded expeditions with the session's threads, and restore a thread on click:

```ts
const threads = await api.threads(); // most recently active first: { id, title, destination, isActive, createdAt, updatedAt }

async function openThread(id: number) {
  const [history, plan] = await Promise.all([api.messages(id), api.itinerary(id)]);
  threadIdRef.current = id;
  setMessages(history.map((m, n) => ({ id: `${m.role}-${n}`, role: m.role, content: m.content, timestamp: m.createdAt })));
  if (plan) await showPlan(id, plan); // the latest version, revisions included; null before the first plan
  setHasStarted(true);
}
```

`messages` returns what the customer saw (user and assistant text). The structured plan comes from `itinerary`, and
the trip facts from `trip`.

## 11. Booking: Confirm and Change

When a reply has `pendingBooking`, its text is a booking summary built from supplier data (dates, travellers, total
with taxes, cancellation terms). Render two buttons under it:

```ts
async function onConfirm(p: PendingBooking) {
  try {
    const result = await api.confirm({ threadId: threadIdRef.current!, offerId: p.offer_id, travelers: p.travelers });
    setMessages((prev) => [...prev, { id: `bot-${Date.now()}`, role: 'assistant', content: result.message, timestamp: 'Just now' }]);
  } catch (err) {
    setMessages((prev) => [...prev, { id: `bot-${Date.now()}`, role: 'assistant', content: errorText(err), timestamp: 'Just now' }]);
  }
}
// Change: focus the input. The customer's next message carries on the conversation.
```

`result.status` is `PENDING_SUPPLIER_CONFIRMATION`: show it as *requested, not confirmed*. Never show "booked",
"confirmed" or confetti for it. Pressing Confirm twice returns the same request, not a second booking.

A deal can be requested the same way, `api.confirm({ threadId, offerId: deal.campaignItineraryId, travelers })`, but only
for a deal the server sent in that thread.

## 12. Errors

Every failure is a `TakeoffApiError` with a `code`; `errorText(err)` gives customer-facing text for the chat ones.

| `err.code` | When | What to show |
|---|---|---|
| `model_unavailable` | model server down or timed out | `errorText(err)` and a Retry button that resends the same text |
| `rate_limited` | over 20 messages a minute from one IP | `errorText(err)` |
| `thread_busy` | a second message while one is pending | shouldn't happen once the input is locked |
| `message_too_long` | over 4,000 characters | `errorText(err)` |
| `aborted` | Stop or New journey | nothing |
| `network`, `stream_ended` | connection dropped | `errorText(err)` and Retry |
| `bad_response` | a reply without its message | `errorText(err)` and Retry |
| `invalid_profile` | `updateProfile` with an unknown field or value | `err.message` next to the field |
| `thread_not_found` | `trip`, `itinerary` or `messages` for a thread this session doesn't own | drop it from the sidebar |
| `offer_not_found` | Confirm on an offer not shown in that thread | `errorText(err)` |

`session_not_found` is handled inside the client: it starts a new session once and the reply begins a new thread.

## 13. Rules the UI must keep

These keep the product honest; the backend enforces its side, and the UI must not undo it.

- **No invented data.** Prices, hotels, photos, ratings and availability shown to the customer come from the backend
  (deals, offers, `itinerary`) or are clearly marked as examples. No mock hotels or prices next to a real plan.
- **Requested is not booked.** Booking requests stay "requested" until the backend says otherwise.
- **Unknown stays unknown.** Unpublished hours, unpublished fees, estimated travel times and `not_checked` insights are
  shown as such, never as confirmed, free or all clear.
- **Credit the sources.** `itinerary.sources` and each insight's source are shown with the plan.
- **No personal data in forms that go nowhere.** The checkout drawer must not collect names, emails, phone numbers or
  payment details, or show a success alert, until a backend receives them.
- **One message at a time,** under 4,000 characters, and only what the customer typed.

## 14. What the backend does not provide yet

- **Place data outside Goa.** Other destinations still get chat replies and deals, but no `itinerary`; the reply is
  then text only. More regions are being added.
- **Hotels, flights and trip totals inside the plan.** Hotel and flight offers arrive separately as `reply.offers`
  when the customer asks for them.
- **Photos** of places, and **multi-currency** prices (everything is in INR).
- **Payments.** There is no payment system; the "Pay ₹10,000 refundable token" drawer has nothing behind it.
- **Accounts and login.** The session in `localStorage` is the user for now.
- **Saved trips, the contact form, careers applications and pricing plans.**

## 15. Check the integration

With the backend running (section 2) and the frontend on `bun run dev`:

1. Type `I want to plan a trip`. Kodi asks where to; `planning.field` is `destination`.
2. `Goa`: Kodi asks when. `15 to 17 December, me and my wife`: Kodi asks about the budget.
3. `around 60k`: a three-day plan appears in the dossier within about 15 seconds, with times, travel between stops
   marked "(estimated)", warnings, a "Before you go" panel and the OpenStreetMap credit.
4. Type `Make day 2 more relaxed`: day 2 is rebuilt with fewer stops, and the plan is version 2. (The "Fewer stops a
   day" chip sends `Make it more relaxed`, which relaxes every day.)
5. Reload the page: the conversation is in the sidebar, and opening it restores the messages and the latest plan.
6. Save `relaxed` and `beach` in preferences, start a New journey and type `Plan a trip to Goa`: Kodi says it will use
   your saved preferences and doesn't ask about pace.
7. Stop the model server and ask a side question such as `Is Goa safe in the monsoon?`: the reply is the
   `model_unavailable` text, not a hang or a blank bubble. Questions and plans still work without the model, because
   code builds them; only the short note above a plan falls back to a fixed sentence.

If something doesn't match, compare with the backend's own end-to-end check, which runs the same flow against a
running server:

```bash
node scripts/smoke.mjs flow http://127.0.0.1:5590 /tmp/takeoff-state.json
```
