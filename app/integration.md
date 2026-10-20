# Takeoff: connect the frontend to the backend

This file is a complete brief for the coding agent working in the Takeoff frontend (`takeoff-travel-planner`: React 19,
Vite 8, TypeScript 6, Tailwind v4, Bun, oxlint). Give the agent this whole file and ask it to carry it out. Everything
it needs is here: the client code to copy (appendices A and B), every change to make, the checks to run, and how to
start the backend for a live test. No access to the backend repository is needed for the code changes.

What changes for the customer: the chat stops faking replies and talks to Kodi on the real backend; the planner asks
a few short questions and builds a day-by-day plan from real place data (Goa so far); the dossier shows that plan,
with weather and what was not checked; revisions ("make it cheaper") rebuild it; the sidebar lists real conversations;
booking requests go to the backend and are never shown as confirmed.

---

## For the agent: how to work

Carry out the steps in order. After each step, run its check; don't start the next step until it passes. Don't ask the
user questions: when this brief and the code disagree (a function was renamed or moved), find the equivalent code by
what it does, adapt, and write down what you did for the report (step 12).

**Rules (all steps):**

1. **Keep the design.** Change only what a step says. Don't restyle, rename, reformat or reorder unrelated code. Don't
   touch the marketing pages (`src/pages/*`), `KodiCompanion`, animations, fonts or icons. New UI reuses the classes
   of the elements around it (cards `rounded-[32px]`, pills `rounded-full`, the existing text styles).
2. **No new dependencies.** The client uses `fetch`; everything else is React that is already installed.
3. **Copy appendices A, B and C byte for byte, and never edit them.** If one of them reports a type or lint error,
   stop and write that in the report instead of changing it.
4. **Don't weaken the checks.** No `any`, `@ts-ignore`, `@ts-expect-error`, lint-disable comments, or edits to
   `tsconfig*.json` or `.oxlintrc.json`.
5. **No emojis** anywhere (a project rule).
6. **No invented data next to real data.** No mock hotels, prices, photos or "confirmed" states beside a plan from the
   backend. An unknown price is shown as unknown, never as ₹0.
7. **Delete nothing.** Mock data files (`src/data/destinationProfiles.ts`, `initialTripData`) stay; the marketing
   pages still use them. Code that only the old fake chat used may be removed from `App.tsx` once nothing refers to it.
8. **Commit after each step** (step 0 sets up git) with a short message saying what changed. No tool names or
   co-author lines in commit messages.
9. **Stop what you start.** Stop the dev server and the backend (step 11) when you are done.

---

## Step 0. Prepare

1. In the frontend's root folder (it has `package.json`, `vite.config.ts` and `src/App.tsx`), set up git if there is
   none, so every change can be reviewed and undone:

   ```bash
   git rev-parse --is-inside-work-tree 2>/dev/null || git init
   ```

   Make sure `.gitignore` lists `node_modules`, `dist` and `.env`; add any that are missing. Then
   `git add -A && git commit -m "Baseline before backend integration"`.
2. Run `bun install`, then `bun run build` and `bun run lint`, and note whether each passed **before** your changes.
3. Find these in `src/App.tsx` and note their line numbers: the `Message` interface; the state `messages`,
   `inputText`, `isTyping`, `hasStarted`, `trip` (with `setTrip`) and `activeDrawer`; the functions
   `startChatWithPrompt`, `handleSend` and `resetChat`; the chat inputs and their send buttons
   (`disabled={!inputText.trim()}`); the suggestion chips under assistant messages; the itinerary card
   (`cardType === 'itinerary'`, `msg.itineraryCard`); the itinerary drawer (`activeDrawer === 'itinerary'`); the sidebar's
   four hard-coded expeditions; the checkout drawer (`activeDrawer === 'checkout'`) and its "Pay ₹10,000 Refundable
   Token" button.

**Check:** a baseline commit exists, and you have the list.

## Step 1. Add the client files

1. Create `src/services/takeoff-api.ts` with the exact content of **appendix A**, and `src/services/takeoff-plan.ts`
   with the exact content of **appendix B**. (They are the backend team's client: typed API calls, the chat stream,
   and helpers that turn a plan into this app's `DayPlan` and `Activity` shapes. They are tested against the backend,
   and with this app's TypeScript 6 settings and lint rules.)
2. Create `src/services/api.ts`:

   <!-- check:file src/services/api.ts -->
   ```ts
   import { createTakeoffApi } from './takeoff-api';

   // '' in development (the Vite proxy sends /api to the backend); the backend's URL in production builds
   export const api = createTakeoffApi({ baseUrl: import.meta.env.VITE_API_URL ?? '' });
   ```

3. Create `src/env.d.ts`:

   <!-- check:file src/env.d.ts -->
   ```ts
   interface ImportMetaEnv {
     /** the backend's URL for production builds, e.g. https://api.example.com; unset in development */
     readonly VITE_API_URL?: string;
   }
   ```

4. In `vite.config.ts`, add the dev proxy so the browser calls the Vite origin and CORS never comes into play:

   ```ts
   export default defineConfig({
     plugins: [react(), tailwindcss()],
     server: { proxy: { '/api': 'http://127.0.0.1:5590' } },
   })
   ```

5. Create `.env.example` with one line, `VITE_API_URL=`, and a comment above it:
   `# Backend URL for production builds. Leave empty in development: the Vite proxy is used.`

**Check:** `bun run build` and `bun run lint` pass (or fail only as they did at baseline). Commit.

## Step 2. Types

1. In `src/data/tripData.ts`, change the `Activity` interface: make `priceINR` optional and add two optional fields.

   ```ts
     /** absent when no entry fee is published: show "Entry fee not published", never ₹0 */
     priceINR?: number;
     image: string;
     badge?: string;
     /** the place's OpenStreetMap page */
     mapUrl?: string;
     /** to the next stop, e.g. "about 37 min (estimated)" */
     travelToNext?: string;
   ```

2. In `src/App.tsx`, import the client, and extend `Message`. In `itineraryCard`, make `totalINR`, `perPersonINR`
   and `hotel` optional (a plan from the backend has no hotel and no trip price), and add the new fields at the end:

   <!-- check:types -->
   ```ts
   import { errorText, toDealCard, type ItineraryDraft, type PendingBooking, type PlanningInfo, type Thread, type TripInsight } from './services/takeoff-api';
   import { ALTERNATIVE_MESSAGE, insightLine, noTrip, planSummary, planTrip, planWarnings, quickReplies } from './services/takeoff-plan';
   import { api } from './services/api';

   type DealCard = ReturnType<typeof toDealCard>;

   interface Message {
     id: string;
     role: 'user' | 'assistant';
     content: string;
     timestamp: string;
     cardType?: 'date' | 'traveller' | 'occasion' | 'pace' | 'hotel_style' | 'experiences' | 'itinerary' | 'hotel_swap' | 'attractions' | 'cities';
     itineraryCard?: {
       destination: string;
       duration: string;
       dates: string;
       totalINR?: number;
       perPersonINR?: number;
       hotel?: Hotel;
       daysCount: number;
       activitiesCount: number;
       day1Activities: Activity[];
     };
     suggestions?: string[];
     hotelSwapCard?: Hotel;
     pendingBooking?: PendingBooking; // Confirm / Change buttons (step 9)
     planning?: PlanningInfo;         // what the planner did this turn
     itinerary?: ItineraryDraft;      // the plan this reply built or revised
     insights?: TripInsight[];        // weather, season notes and what was not checked
     deals?: DealCard[];              // packages for the destination, shown under the reply (step 7)
   }
   ```

   Keep any other fields the existing `Message` has. (Some of these imports are first used in step 3.)
3. Run `bunx tsc -b`. Making these fields optional surfaces every place that assumed them: sums of `priceINR`, and
   reads of `itineraryCard.hotel`, `.totalINR` and `.perPersonINR`. Fix each error, and only those:
   - **Sums** of prices use `(act.priceINR ?? 0)`.
   - **Displays** of an activity price show `₹{act.priceINR.toLocaleString('en-IN')}` when it is defined, and
     "Entry fee not published" when it isn't.
   - **The itinerary card's hotel row, total, per-person price and currency switcher** render only when that value is
     defined.

**Check:** `bun run build` passes. Commit.

## Step 3. Chat

Replace the fake replies with the backend. Keep the names `startChatWithPrompt`, `handleSend` and `resetChat` so every
place that calls them (starter prompts, deal cards, the hero search, chips) keeps working.

1. Add this state and these refs to the `App` component, next to the existing state:

   <!-- check:state -->
   ```ts
   const [plan, setPlan] = useState<{ itinerary: ItineraryDraft; insights: TripInsight[] } | null>(null);
   const [threads, setThreads] = useState<Thread[]>([]);
   const threadIdRef = useRef<number | undefined>(undefined);
   const abortRef = useRef<AbortController | null>(null);
   const requestRef = useRef(0);
   const inputRef = useRef<HTMLInputElement>(null);
   ```

   Add `ref={inputRef}` to the chat input in the workspace (the capsule input under the conversation).

2. Add these functions to the component:

   <!-- check:functions -->
   ```ts
   const say = (content: string, extra: Partial<Message> = {}) =>
     setMessages((prev) => [...prev, { id: `bot-${Date.now()}-${prev.length}`, role: 'assistant', content, timestamp: 'Just now', ...extra }]);

   async function loadThreads() {
     try {
       setThreads(await api.threads());
     } catch {
       // the sidebar keeps the list it has; the chat itself reports errors
     }
   }

   async function showPlan(threadId: number, itinerary: ItineraryDraft, insights: TripInsight[]) {
     setPlan({ itinerary, insights });
     const facts = await api.trip(threadId).catch(() => undefined);
     setTrip((t) => ({ ...t, ...planTrip(itinerary, facts) }));
   }

   async function send(prompt: string) {
     const text = prompt.trim();
     if (!text) return;
     abortRef.current?.abort(); // only a new conversation can start while a reply is pending: the input is locked
     const controller = new AbortController();
     abortRef.current = controller;
     const request = ++requestRef.current;
     setHasStarted(true);
     setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', content: text, timestamp: 'Just now' }]);
     setInputText('');
     setIsTyping(true);
     let deals: DealCard[] = [];
     try {
       const reply = await api.chat(text, {
         threadId: threadIdRef.current,
         signal: controller.signal,
         onDestination: (d) => setTrip((t) => ({ ...t, destination: d.regionName })),
         onDeals: (list) => { deals = list.map(toDealCard); },
       });
       if (controller.signal.aborted) return;
       threadIdRef.current = reply.threadId;
       const chips = reply.itinerary
         ? reply.itinerary.alternatives.map((a) => ALTERNATIVE_MESSAGE[a.kind])
         : quickReplies(reply.planning?.action === 'ask' ? reply.planning.field : undefined);
       say(reply.message, {
         pendingBooking: reply.pendingBooking,
         planning: reply.planning,
         itinerary: reply.itinerary,
         insights: reply.insights,
         ...(deals.length ? { deals } : {}),
         ...(chips.length ? { suggestions: chips } : {}),
         ...(reply.itinerary ? { cardType: 'itinerary' as const, itineraryCard: planSummary(reply.itinerary) } : {}),
       });
       if (reply.itinerary) await showPlan(reply.threadId, reply.itinerary, reply.insights ?? []);
       void loadThreads();
     } catch (err) {
       if (controller.signal.aborted) return;
       say(errorText(err), { suggestions: [text] }); // the chip sends the same message again
     } finally {
       if (requestRef.current === request) setIsTyping(false);
     }
   }

   async function openThread(id: number) {
     abortRef.current?.abort();
     try {
       const [history, itinerary] = await Promise.all([api.messages(id), api.itinerary(id)]);
       threadIdRef.current = id;
       setMessages(history.map((m, n) => ({ id: `${m.role}-${id}-${n}`, role: m.role, content: m.content, timestamp: new Date(m.createdAt).toLocaleDateString('en-IN') })));
       setHasStarted(true);
       setPlan(null);
       setTrip(noTrip());
       if (itinerary) await showPlan(id, itinerary, []);
     } catch (err) {
       say(errorText(err));
     }
   }

   async function onConfirm(p: PendingBooking) {
     if (threadIdRef.current === undefined) return;
     try {
       const result = await api.confirm({ threadId: threadIdRef.current, offerId: p.offer_id, travelers: p.travelers });
       say(result.message);
     } catch (err) {
       say(errorText(err));
     }
   }
   ```

3. Replace the **body** of `startChatWithPrompt` (keep its signature) so a starter prompt, deal card or hero search
   starts a new conversation:

   <!-- check:start -->
   ```ts
   const startChatWithPrompt = (prompt: string) => {
     threadIdRef.current = undefined;
     setMessages([]);
     setPlan(null);
     setTrip(noTrip());
     void send(prompt);
   };
   ```

4. Replace the **body** of `handleSend` (keep its signature):

   <!-- check:handle -->
   ```ts
   const handleSend = (textToSend?: string) => {
     const prompt = (textToSend || inputText).trim();
     if (!prompt || isTyping) return;
     if (!hasStarted) {
       startChatWithPrompt(prompt);
       return;
     }
     void send(prompt);
   };
   ```

5. In `resetChat` ("New journey"), keep what it does and add, at the top:

   <!-- check:reset -->
   ```ts
   abortRef.current?.abort();
   threadIdRef.current = undefined;
   setPlan(null);
   ```

   and change its `setTrip(initialTripData)` to `setTrip(noTrip())`.
6. Load the sidebar's conversations once on mount, next to the other effects:

   <!-- check:effect -->
   ```ts
   useEffect(() => {
     let live = true;
     api.threads().then((list) => { if (live) setThreads(list); }, () => undefined);
     return () => { live = false; };
   }, []);
   ```

7. Every chat send button gets `disabled={!inputText.trim() || isTyping}`, and every chat `<input>` gets
   `maxLength={4000}`.
8. If `trip` starts from `initialTripData` (`useState<TripState>(initialTripData)`), start it from `noTrip()` instead,
   so no mock Bali trip appears in the dossier before the backend has sent anything.
9. Remove what only the fake chat used: the `setTimeout` replies, the `DESTINATION_PROFILES` matching and the intro
   text built from mock trips inside these functions. Keep imports that other code still uses.
10. **Guard empty data.** With `noTrip()` the trip has no days and no hotels until a plan arrives. Search `App.tsx` for
    `hotels[0]`, `days[0]`, `.hotel.` and `trip.days.` and make each place render nothing (or its empty state) when
    the list is empty, instead of crashing.

**What the customer sees:** the typing dots while Kodi works (questions come back at once; a plan takes about 5 to 15
seconds), then one full reply. Text arrives plain, without markdown or emojis; lists start with `•`, so the
existing `whitespace-pre-line` rendering is right.

**Check:** `bun run build` and `bun run lint` pass, and `grep -n "setTimeout" src/App.tsx` shows no reply timers in
the chat functions. Commit.

## Step 4. The planner's questions and the chips

Nothing more to build: `send` already puts the right chips on each reply.

- When Kodi asks a question, `reply.planning.field` says which (`destination`, `when`, `travelers`, `budget`, `pace`,
  `interests`, or a trade-off), and `quickReplies(field)` gives short replies the planner understands, such as
  "December, 5 days", "me and my wife" or "about 60k".
- Under a plan, the chips are the plan's alternatives: "Make it cheaper", "Make it more relaxed", "Make it more
  adventurous". Each rebuilds exactly the version its preview described.

Make sure the existing suggestion chips call `handleSend(chip)` when tapped (they already do in the fake chat). The
customer can always type instead. Phrases the planner understands for changing a plan, if you want to show hints:
"Make day 2 more relaxed", "See more", "Skip <place>", "Move it to 21 to 23 December", "We are 4 people now".

**Check:** nothing new to run. Move on.

## Step 5. The plan in the chat and the dossier

`showPlan` already fills `trip` from the plan (`planTrip`), so the itinerary drawer and the dossier read the real
days. Make them honest about what a backend plan has and lacks:

1. **Activities** (wherever `trip.days[].activities` are rendered), with `act` being the activity:

   <!-- check:jsx-act -->
   ```tsx
   <>
     {act.image ? <img src={act.image} alt="" /> : <div aria-hidden className="h-full w-full rounded-[24px] bg-stone-100" />}
     {act.category === 'Sightseeing' && <span>{act.priceINR !== undefined ? `₹${act.priceINR.toLocaleString('en-IN')}` : 'Entry fee not published'}</span>}
     {act.mapUrl && <a href={act.mapUrl} target="_blank" rel="noreferrer">Map</a>}
     {act.travelToNext && <p>Then {act.travelToNext} to the next stop</p>}
   </>
   ```

   Use the existing image box's size and radius for the placeholder, the existing price style for the price text,
   and the existing secondary-text style for the map link and travel line. Meals and rest blocks come through as
   `Culinary` and `Relaxation` activities with no entry fee, so the price line is for sights only. `description` already says why a stop
   was picked, and "Opening hours not published" when that's the case.
2. **Hotels:** a plan has none. Hide the hotel section and hotel cards when `trip.hotels` is empty, and the "Alternative
   Stays" button with them.
3. **Price claims:** in the chat workspace and its drawers, remove or hide "Wholesale Total", "Live GDS Wholesale",
   "Direct resort rates locked for 72 hrs · Zero markup fees" and the USD/EUR converter. The plan has no trip price, and
   these claim one.
4. **The itinerary card** in the chat (`cardType === 'itinerary'`) already gets `planSummary(itinerary)`: destination,
   "N Days", dates, the number of activities and day 1's stops. After step 2 its hotel and price rows only render when
   they are defined, so they stay hidden for backend plans.

**Check:** `bun run build` and `bun run lint` pass. Commit.

## Step 6. Before you go: insights, warnings, sources

Add one panel to the itinerary drawer (below the days), and render it only when `plan` is set:

<!-- check:jsx -->
```tsx
{plan && (
  <section className="mt-6 space-y-3">
    <h3>Before you go</h3>
    <ul className="space-y-1">
      {plan.insights.map((i) => (
        <li key={`${i.type}-${i.date ?? ''}-${i.title}`}>
          {insightLine(i)}
          {i.sourceUrl && <> · <a href={i.sourceUrl} target="_blank" rel="noreferrer">{i.source}{i.licence ? ` (${i.licence})` : ''}</a></>}
        </li>
      ))}
    </ul>
    {planWarnings(plan.itinerary).map((w) => <p key={w}>{w}</p>)}
    <details>
      <summary>How this plan was made</summary>
      <ul>{plan.itinerary.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
    </details>
    <p className="text-xs">
      {plan.itinerary.sources.map((s) => (
        <a key={s.name} className="mr-3" href={s.url} target="_blank" rel="noreferrer">{s.attribution}{s.licence ? ` (${s.licence})` : ''}</a>
      ))}
    </p>
  </section>
)}
```

Style it like the drawer's other sections. Keep its meaning:

- An insight with status `not_checked` (events, closures, advisories, entry rules, sometimes weather) is shown as not
  checked, never as "all clear".
- Warnings include rain moving a day indoors, and travel times being estimates.
- **The source credits are required by the data's licences** (OpenStreetMap, Wikivoyage, Open-Meteo). Never hide them
  while the plan is shown.
- A conversation reopened from the sidebar has its plan but not its insights (they aren't stored), so the list is empty
  there; the warnings and credits still show.

**Check:** `bun run build` and `bun run lint` pass. Commit.

## Step 7. Deals under a reply

When Kodi names a destination, the reply can carry `msg.deals` (packages from the backend). Under that assistant
message, render them with the same card markup and classes as the landing page's curated deal cards (title, route,
nights, `priceINR` as "from ₹… per person", `originalINR` struck through, tag, image). Tapping one calls
`handleSend(deal.prompt)`, which continues the same conversation.

The landing page's own curated deals stay as they are (they still start a chat with their prompt).

**Check:** `bun run build` and `bun run lint` pass. Commit.

## Step 8. Sidebar: real conversations

Replace the four hard-coded expeditions with `threads`, keeping the existing item markup: the title from
`thread.title`, the subtitle from `thread.destination ?? 'Planning'`, and the date from `thread.updatedAt`
(`new Date(thread.updatedAt).toLocaleDateString('en-IN')`). Clicking one calls `openThread(thread.id)`. With no
threads, show the sidebar's empty state (a short "No conversations yet" line in its secondary style).

**Check:** `bun run build` and `bun run lint` pass. Commit.

## Step 9. Booking

1. **Confirm and Change.** When an assistant message has `pendingBooking`, its text is a booking summary built from
   supplier data. Under it, render two buttons in the chat's pill style, with `msg` being the message:

   <!-- check:jsx-msg -->
   ```tsx
   {msg.pendingBooking && (
     <div className="mt-3 flex gap-2">
       <button type="button" className="rounded-full" onClick={() => { if (msg.pendingBooking) void onConfirm(msg.pendingBooking); }}>Confirm</button>
       <button type="button" className="rounded-full" onClick={() => inputRef.current?.focus()}>Change</button>
     </div>
   )}
   ```

   The reply to Confirm is a request, not a booking: its text says it is pending. Never show "booked", "confirmed" or
   confetti for it.
2. **The checkout drawer.** There is no payment system yet, so the drawer must not collect personal data or pretend to
   take a payment:
   - Remove the prefilled name, email and phone values.
   - Remove the "Pay ₹10,000 Refundable Token & Lock Itinerary" button's `onClick` (confetti and `alert`), make the
     button `disabled`, and change its label to "Token payments are coming soon".
   - Remove the "Hold Trip Token (₹10,000)" chip wherever it is still offered.

**Check:** `bun run build` and `bun run lint` pass. Commit.

## Step 10. Preferences from the quiz

The backend keeps the traveller's preferences and reuses them in every new trip (Kodi then skips those questions).
If `TravelMatchQuiz` has a completion handler with answers about pace, interests, diet or mobility, save them there,
for example:

```ts
void api.updateProfile({ travelStyle: 'relaxed', interests: ['beach', 'food'] }).catch(() => undefined);
```

Use only these values; map the quiz's answers onto them, and leave out anything that doesn't map:

| Field | Values |
|---|---|
| `travelStyle` | `relaxed`, `balanced`, `packed` |
| `budgetStyle` | `budget`, `value`, `comfort`, `premium` |
| `interests` | `beach`, `mountains`, `nature`, `wildlife`, `adventure`, `trekking`, `culture`, `history`, `spiritual`, `food`, `nightlife`, `shopping`, `wellness`, `photography` |
| `dietaryNeeds` | `vegetarian`, `vegan`, `jain`, `halal`, `gluten-free`, `eggless` |
| `mobilityNeeds` | `wheelchair`, `limited walking` |

If the quiz has no such handler, skip this step and say so in the report.

**Check:** `bun run build` and `bun run lint` pass. Commit.

## Step 11. Verify

**Static checks (required):** `bun run build` and `bun run lint` both pass. Then run
`grep -n "priceINR: 0\|Rajesh Sharma\|confetti(" src/App.tsx`: it must find nothing in the chat, its drawers or
the checkout.

**Live check (when a backend can run):**

1. See whether a backend is already running: `curl -s http://127.0.0.1:5590/ready`. If it answers with `"ok":true`,
   go to point 3.
2. Otherwise follow **appendix D** to start one. If that isn't possible (no access to the backend repository, no
   network, not enough disk space), skip the live check and say why in the report.
3. Save **appendix C** as `scripts/check-backend.mjs` and run
   `node scripts/check-backend.mjs flow http://127.0.0.1:5590 /tmp/takeoff-check.json` (or `bun` instead of `node`).
   Every line must start with `ok:`. This checks the backend itself: a four-message plan, then a revision.
4. Start the frontend with `bun run dev`, open `http://localhost:5173` in the browser, and run through this:
   1. Type `I want to plan a trip`. Kodi asks where to, with a "Goa" chip.
   2. Tap `Goa`: Kodi asks when, with month chips. Type `15 to 17 December, me and my wife`: Kodi asks about the budget.
   3. Type `around 60k`: within about 15 seconds the itinerary card appears. The drawer shows three days with times,
      travel between stops marked "(estimated)", "Entry fee not published" where there is no fee, no hotels, the
      "Before you go" panel and the source credits.
   4. Tap "Make it more relaxed": a new version of the plan replaces the old one.
   5. Reload the page: the conversation is in the sidebar, and opening it restores the messages and the plan.
   6. "New journey" clears the chat and the dossier.

   Take one screenshot of the drawer with the plan for the report. No screen recordings.
5. Stop the dev server, and the backend if you started it.

## Step 12. Report

Write `INTEGRATION_REPORT.md` in the frontend's root folder:

- The results of `bun run build` and `bun run lint`, before and after.
- Each step: done, partly done, or skipped, and why.
- Files changed, with a line each on what changed.
- Every place where the code differed from this brief, and what you did about it.
- The live check's output (appendix C), what you saw in the browser for each point in step 11.4, and the screenshot's
  file name. If the live check was skipped, the reason.
- Anything left that a person has to decide. For example: the landing page's curated deals still show sample prices;
  the starter prompts name destinations that have chat but no day plans yet (only Goa has them).

Commit the report.

---

## Appendix A: `src/services/takeoff-api.ts`

Copy exactly. This is the API client: session handling, the chat stream (it skips `: keep-alive` lines and handles
chunks split anywhere), typed responses, errors with codes (`TakeoffApiError`, `errorText`) and `toDealCard`.

<!-- BEGIN FILE takeoff-api.ts -->
```ts
// Typed client for the Takeoff backend. No dependencies: works in the browser (React + Vite) and in Node 22.
// Copy this file into the frontend as-is (src/services/takeoff-api.ts). The contract it speaks is in
// app/AGENTS.md in the model repo; app/integration.md shows how to wire it into the UI.

export interface Deal {
  campaignItineraryId: string; sourceItineraryId: string; title: string; image: string; images: string[];
  destinationString: string; nights: number; tripType: string;
  itineraryCost: number; itineraryCostWithoutFlights: number; strikedCost: number; dealDiscountPercentage: number;
  hotelStarRating: number; numBookings: number; slug: string; pills: string[];
  cityHotelStay: { cityName: string; hotelName: string; nights: number; hotelImages: string[] }[];
  activities: string[]; highlights: string[]; regionName: string; regionCode: string; type: string;
}

export interface HotelOffer {
  offer_id: string; hotel: string; city: string; room: string; price_per_night_inr: number; nights: number; guests: number;
  check_in: string; check_out: string; amenities: string[]; rate_rule: string; total_inr: number;
  taxes_included: boolean; taxes_estimate_inr?: number;
}

export interface FlightOffer {
  offer_id: string; airline: string; from: string; to: string; date: string; departs: string; duration_min: number; stops: number;
  fare_per_person_inr: number; passengers: number; total_inr: number; baggage: string; fare_rule: string;
}

export type Offer = HotelOffer | FlightOffer;

/** Present when the reply is a booking summary: show Confirm (call `confirm`) and Change (just send the next message). */
export interface PendingBooking { offer_id: string; travelers: number; total_price_inr: number }

// ── Planning (additive to the original contract): profile, trip, itinerary, insights ──────────────────────

export type TravelStyle = 'relaxed' | 'balanced' | 'packed';
export type BudgetStyle = 'budget' | 'value' | 'comfort' | 'premium';

/** The traveller's reusable preferences (the session is the user until accounts exist). Only code writes it. */
export interface TravelerProfile {
  homeCity?: string; travelStyle?: TravelStyle; budgetStyle?: BudgetStyle;
  interests: string[]; dislikes: string[];
  /** hard constraints: the planner never breaks them */
  dietaryNeeds: string[]; mobilityNeeds: string[];
  accommodationPreferences: string[];
  /** 'travelStyle' or 'interests:beach' → said by the traveller ('explicit') or picked up from chat ('inferred') */
  sourceByField: Record<string, 'explicit' | 'inferred'>;
  updatedAt: string;
}

/** An edit from a preferences screen: a list replaces the saved list, null clears a field. */
export interface ProfilePatch {
  homeCity?: string | null; travelStyle?: TravelStyle | null; budgetStyle?: BudgetStyle | null;
  interests?: string[]; dislikes?: string[]; dietaryNeeds?: string[]; mobilityNeeds?: string[]; accommodationPreferences?: string[];
}

/** What the customer has said about one trip. Dates are YYYY-MM-DD; `month` (1-12) when only the month is known. */
export interface TripFacts {
  destination?: string; origin?: string; startDate?: string; endDate?: string; month?: number; durationDays?: number;
  travelers?: number;
  /** solo, couple, family, friends, kids, seniors */
  travelerTypes: string[];
  purpose?: string; budgetInr?: number; budgetPerPerson?: boolean;
}

export interface TripContext extends TripFacts {
  /** questions the planner has asked, in order */
  asked: string[]; planningTurns: number; status: 'collecting' | 'drafted';
  /** revisions for this trip only ("skip X", "make day 2 more relaxed", "cheaper"); the profile is untouched */
  excludedPoiIds: string[]; dayPace: Record<string, TravelStyle>; paceOverride?: TravelStyle; budgetStyleOverride?: BudgetStyle;
  addedInterests?: string[];
  itineraryVersion: number; updatedAt: string;
}

export type PlanningAction = 'ask' | 'draft' | 'revise' | 'converse';
export type PlanningState = 'trip_basics' | 'profile_context' | 'high_value_refinement' | 'draft_ready' | 'revision';
/** `done.planning`: what the planner did this turn; `field` is the question it asked. */
export interface PlanningInfo { state: PlanningState; action: PlanningAction; field?: string; assumptions: string[]; missing: string[] }

/** A road time from the routing server, or a straight-line estimate (`isEstimate`): show estimates as estimated. */
export interface TravelLeg { minutes: number; km: number; basis: 'road' | 'straight_line_estimate'; source: string; isEstimate: boolean; confidence: number }

export interface ItinerarySource { name: string; licence?: string; attribution: string; url?: string }

/** One block of a day: a visit (activity), a meal break or a rest. Times are HH:MM. */
export interface ItineraryItem {
  kind: 'activity' | 'meal' | 'rest'; block: 'morning' | 'afternoon' | 'evening';
  start: string; end: string; title: string; poiId?: string; durationMinutes: number;
  /** the place's position, for the map (activities only) */
  coordinates?: { lat: number; lng: number };
  durationBasis?: 'category_default' | 'fixed';
  /** to the next activity of the day */
  travelToNext?: TravelLeg;
  /** 'open': checked against published hours; 'unknown': none published */
  hours?: 'open' | 'unknown';
  costInr?: number; costBasis?: 'osm_charge';
  why?: { matched: string[]; tradeoffs: string[] };
  notes: string[];
  /** meal blocks: nearby places that match the traveller's diet */
  suggestions?: { poiId: string; name: string; diet: string[] }[];
  source?: { name: string; url: string; licence: string; attribution: string };
  confidence: number;
}

export interface ItineraryDay { day: number; date?: string; items: ItineraryItem[]; warnings: string[] }
export interface ItineraryAlternative { kind: 'cheaper' | 'more_relaxed' | 'more_adventurous'; summary: string; changes: string[] }

/** `done.itinerary`: the plan itself and the source of truth (`message` is its rendering). Show `sources`: the OpenStreetMap credit is required by its licence. */
export interface ItineraryDraft {
  version: number; destination: string; startDate?: string; days: ItineraryDay[];
  totalEstimatedCostInr?: number; assumptions: string[]; warnings: string[]; alternatives: ItineraryAlternative[];
  confidence: number; sources: ItinerarySource[];
  /** places considered and left out, with the reason */
  rejected: { poiId: string; name: string; reason: string }[];
}

/** `done.insights`: facts from outside sources. 'not_checked' means there is no approved source: say so, never guess. */
export interface TripInsight {
  type: 'weather' | 'season' | 'guide' | 'event' | 'closure' | 'travel_time' | 'price' | 'advisory' | 'visa';
  title: string; detail: string; source: string; sourceUrl?: string; licence?: string; checkedAt: string;
  severity: 'info' | 'warning' | 'blocking'; confidence: number; status: 'checked' | 'not_checked' | 'stale';
  date?: string; poiId?: string; effect?: 'rain' | 'closed';
}

/** The `done` event. Fields a newer backend adds are kept as they arrive. */
export interface ChatReply {
  message: string; threadId: number; offers: Offer[]; pendingBooking?: PendingBooking;
  planning?: PlanningInfo; itinerary?: ItineraryDraft; insights?: TripInsight[];
  [key: string]: unknown;
}
export interface Destination { regionName: string; regionCode: string }
/** Topics the contact form accepts. */
export const CONTACT_TOPICS = ['trip', 'feedback', 'partnership', 'other'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** Additive `status` event: what the server is doing right now ("Searching hotels"). */
export interface ChatStatus { step: string; label: string }
export interface Thread { id: number; title: string; destination: string | null; isActive: boolean; createdAt: string; updatedAt: string }
export interface ThreadMessage { role: 'user' | 'assistant'; content: string; createdAt: string }
export interface BookingResult { status: string; bookingRef: string; message: string; offer: Record<string, unknown> }

/**
 * `code` is the backend's: bad_request, session_not_found, message_too_long, thread_busy, model_unavailable,
 * rate_limited, body_too_large, offer_not_found, thread_not_found, invalid_profile; plus network, aborted, stream_ended and
 * bad_response from here.
 */
export class TakeoffApiError extends Error {
  // plain fields, not constructor parameter properties: the frontend compiles with erasableSyntaxOnly
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'TakeoffApiError';
    this.code = code;
    this.status = status;
  }
}

export const MAX_MESSAGE_CHARS = 4000;

/** Customer-facing text for an error. */
export function errorText(err: unknown): string {
  const code = err instanceof TakeoffApiError ? err.code : 'network';
  switch (code) {
    case 'rate_limited': return (err as TakeoffApiError).message || 'Please wait a minute and try again.';
    case 'thread_busy': return "I'm still answering your last message.";
    case 'message_too_long': return `Please keep messages under ${MAX_MESSAGE_CHARS} characters.`;
    case 'model_unavailable': return 'The travel assistant is unavailable right now. Please try again in a minute.';
    case 'cannot_rewind': return 'That message can no longer be changed.';
    case 'account_locked': case 'bot_check': case 'email_failed':
    case 'invalid_login': case 'weak_password': case 'invalid_email': case 'invalid_name': case 'email_taken': case 'invalid_token': case 'wrong_password': case 'not_confirmed':
      return (err as TakeoffApiError).message;
    case 'not_signed_in': return 'Please sign in again.';
    case 'invalid_google': return 'Google sign-in did not work. Please try again.';
    case 'aborted': return 'Stopped.';
    default: return 'Something went wrong. Please try again.';
  }
}

/** Server-sent events from a fetch body. Skips comment lines (": keep-alive"); handles CRLF and multi-line data. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += value ? decoder.decode(value, { stream: true }) : '';
    for (;;) {
      const end = /\r?\n\r?\n/.exec(buf);
      if (!end) break;
      const block = buf.slice(0, end.index);
      buf = buf.slice(end.index + end[0].length);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const v = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = v;
        else if (field === 'data') data.push(v);
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
    if (done) return;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const listOf = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** A plan from `done.itinerary` or the itinerary endpoint. Lists an older backend left out become []; extra fields stay. */
export function parseItinerary(x: unknown): ItineraryDraft | undefined {
  if (!isObject(x) || typeof x.version !== 'number' || !Array.isArray(x.days)) return undefined;
  const days = x.days.filter(isObject).map((d) => ({ ...d, items: listOf<unknown>(d.items).filter(isObject).map((i) => ({ ...i, notes: listOf(i.notes) })), warnings: listOf(d.warnings) }));
  return { ...x, days, assumptions: listOf(x.assumptions), warnings: listOf(x.warnings), alternatives: listOf(x.alternatives), sources: listOf(x.sources), rejected: listOf(x.rejected) } as unknown as ItineraryDraft;
}

/** `done.insights`, keeping only entries that are insights. */
export function parseInsights(x: unknown): TripInsight[] {
  return listOf<unknown>(x).filter((i): i is TripInsight => isObject(i) && typeof i.type === 'string' && typeof i.title === 'string' && typeof i.status === 'string');
}

function parsePlanning(x: unknown): PlanningInfo | undefined {
  if (!isObject(x) || typeof x.action !== 'string' || typeof x.state !== 'string') return undefined;
  return { ...x, assumptions: listOf(x.assumptions), missing: listOf(x.missing) } as unknown as PlanningInfo;
}

/** The `done` event's data. The original keys read as before; additive ones are kept, known ones checked. */
export function parseDone(x: unknown): ChatReply {
  if (!isObject(x) || typeof x.message !== 'string' || typeof x.threadId !== 'number') throw new TakeoffApiError('bad_response', 'The reply was not in the expected format.');
  const { planning, itinerary, insights, ...rest } = x;
  const reply: ChatReply = { ...rest, message: x.message, threadId: x.threadId, offers: listOf<Offer>(x.offers) };
  const p = parsePlanning(planning);
  if (p) reply.planning = p;
  const plan = parseItinerary(itinerary);
  if (plan) reply.itinerary = plan;
  if (insights !== undefined) reply.insights = parseInsights(insights);
  return reply;
}

/** The deal-card shape the Takeoff frontend renders today. `itineraryCost` is per person, hence pax 1. */
export function toDealCard(d: Deal) {
  return {
    id: d.campaignItineraryId,
    title: d.title,
    route: d.destinationString.split(',').map((s) => s.trim()).join(' · '),
    nights: d.nights,
    pax: 1,
    priceINR: d.itineraryCost,
    originalINR: d.strikedCost,
    tag: d.tripType.toUpperCase(),
    stat: `${d.numBookings.toLocaleString('en-IN')} booked`,
    image: d.image,
    prompt: `I'd like the "${d.title}" trip. Help me plan it.`,
  };
}

interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

async function failure(res: Response): Promise<TakeoffApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return new TakeoffApiError(body.error?.code ?? `http_${res.status}`, body.error?.message ?? res.statusText, res.status);
}

/**
 * `baseUrl`: '' when the dev server proxies /api to the backend, else e.g. 'https://api.example.com'.
 * `storage`: where the session id lives (default localStorage, so threads survive a reload).
 */
/** What a share link shows (D-024): the plan and the trip's basics, never the conversation. */
export interface SharedTrip {
  title: string; destination: string | null; updatedAt: string; itinerary: ItineraryDraft | null;
  trip: Pick<TripFacts, 'destination' | 'startDate' | 'endDate' | 'month' | 'durationDays' | 'travelers' | 'travelerTypes' | 'purpose'>;
}

/** The signed-in user, as the server shows it (D-021). */
/** A browser signed in to the account (`id` signs it out). */
export interface SignedInDevice { id: string; current: boolean; userAgent: string; createdAt: string; lastSeenAt: string }

export interface Account { id: number; name: string; email: string; emailVerified: boolean; hasPassword: boolean; google: boolean; createdAt: string }

/**
 * `credentials`: 'same-origin' (default) when the API is served from the site's own origin, 'include' when it lives on
 * another origin listed in the backend's ALLOWED_ORIGINS (the sign-in cookie must travel with each request).
 */
export function createTakeoffApi(opts: { baseUrl?: string; storage?: KeyValueStore; credentials?: RequestCredentials } = {}) {
  const base = (opts.baseUrl ?? '').replace(/\/$/, '');
  const storage = opts.storage ?? (globalThis as { localStorage?: KeyValueStore }).localStorage;
  const KEY = 'takeoff.sessionId';
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const credentials = opts.credentials ?? 'same-origin';

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(base + path, { credentials, ...init });
    } catch (err) {
      throw new TakeoffApiError('network', (err as Error).message);
    }
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  }
  const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });

  /** The stored session id, or a new one from the server. Calls made at the same time share one new session. */
  let creating: Promise<string> | undefined;
  async function session(): Promise<string> {
    const saved = storage?.getItem(KEY);
    if (saved) return saved;
    creating ??= post<{ sessionId: string }>('/api/session', {})
      .then(({ sessionId }) => { storage?.setItem(KEY, sessionId); return sessionId; })
      .finally(() => { creating = undefined; });
    return creating;
  }

  /** Forget the session (e.g. a "start over" action). The next call creates a new one. */
  function resetSession(): void {
    storage?.removeItem(KEY);
  }

  /**
   * Send one customer message and wait for the reply (5–60 s on CPU). The destination and deals arrive first,
   * through the callbacks. Keep the returned threadId and pass it with the next message. If the server no longer
   * knows the session (e.g. after a reset), a new session is made once and the reply starts a new thread.
   */
  async function chat(text: string, o: {
    threadId?: number; signal?: AbortSignal;
    onDestination?: (d: Destination) => void; onDeals?: (deals: Deal[]) => void;
    /** progress while the reply is prepared */
    onStatus?: (s: ChatStatus) => void;
    /** the reply so far, in checked sentences; '' when the server takes back what it sent. `done` replaces it. */
    onText?: (soFar: string) => void;
  } = {}): Promise<ChatReply> {
    const content = text.trim();
    if (!content) throw new TakeoffApiError('bad_request', 'Message is empty.');
    if (content.length > MAX_MESSAGE_CHARS) throw new TakeoffApiError('message_too_long', `Messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
    let threadId = o.threadId;
    for (let attempt = 0; ; attempt++) {
      const sessionId = await session();
      let error: TakeoffApiError | undefined;
      try {
        const res = await fetch(base + '/api/chat', {
          credentials,
          method: 'POST', headers: jsonHeaders, signal: o.signal,
          body: JSON.stringify({ sessionId, threadId, messages: [{ role: 'user', content, timestamp: new Date().toISOString() }] }),
        });
        if (!res.ok || !res.body) throw await failure(res);
        let soFar = '';
        for await (const { event, data } of readSse(res.body)) {
          const d = JSON.parse(data);
          if (event === 'status') o.onStatus?.(d as ChatStatus);
          else if (event === 'delta') { soFar = d.reset ? '' : soFar + String(d.text ?? ''); o.onText?.(soFar); }
          else if (event === 'destination_selected') o.onDestination?.(d as Destination);
          else if (event === 'campaign_deals') o.onDeals?.((d as { deals: Deal[] }).deals);
          else if (event === 'done') return parseDone(d);
          else if (event === 'error') error = new TakeoffApiError(d.code ?? 'error', d.message);
        }
      } catch (err) {
        if (o.signal?.aborted) throw new TakeoffApiError('aborted', 'Request cancelled.');
        if (err instanceof TakeoffApiError) throw err;
        throw new TakeoffApiError('network', (err as Error).message);
      }
      if (error?.code === 'session_not_found' && attempt === 0) {
        resetSession();
        threadId = undefined;
        continue;
      }
      throw error ?? new TakeoffApiError('stream_ended', 'The reply ended before it finished. Please try again.');
    }
  }

  /** The Confirm button for a pendingBooking (offer_id) or a deal (campaignItineraryId). Show `message` to the customer. */
  async function confirm(a: { threadId: number; offerId: string; travelers?: number }): Promise<BookingResult> {
    return post<BookingResult>('/api/confirm', { sessionId: await session(), ...a });
  }

  async function threads(): Promise<Thread[]> {
    return (await call<{ threads: Thread[] }>(`/api/threads?sessionId=${encodeURIComponent(await session())}`)).threads;
  }

  async function messages(threadId: number): Promise<ThreadMessage[]> {
    return (await call<{ messages: ThreadMessage[] }>(`/api/threads/${threadId}/messages?sessionId=${encodeURIComponent(await session())}`)).messages;
  }

  const withSession = async (path: string) => `${path}?sessionId=${encodeURIComponent(await session())}`;

  /** The traveller's saved preferences. */
  async function profile(): Promise<TravelerProfile> {
    return (await call<{ profile: TravelerProfile }>(await withSession('/api/profile'))).profile;
  }

  /** Save edits from a preferences screen. Unknown fields or values reject with code invalid_profile. */
  async function updateProfile(patch: ProfilePatch): Promise<TravelerProfile> {
    const body = JSON.stringify({ ...patch, sessionId: await session() });
    return (await call<{ profile: TravelerProfile }>('/api/profile', { method: 'PATCH', headers: jsonHeaders, body })).profile;
  }

  /** Forget the saved preferences; returns the empty profile. */
  async function resetProfile(): Promise<TravelerProfile> {
    return (await post<{ profile: TravelerProfile }>('/api/profile/reset', { sessionId: await session() })).profile;
  }

  /** What the planner knows about the trip in a thread. */
  async function trip(threadId: number): Promise<TripContext> {
    return (await call<{ trip: TripContext }>(await withSession(`/api/threads/${threadId}/trip`))).trip;
  }

  /** The latest plan of a thread (revisions included), or null before the first one. */
  async function itinerary(threadId: number): Promise<ItineraryDraft | null> {
    return parseItinerary((await call<{ itinerary: unknown }>(await withSession(`/api/threads/${threadId}/itinerary`))).itinerary) ?? null;
  }

  /** Take back the newest message and its reply (also its plan and trip changes); returns the message text. Edit and regenerate resend after this. */
  async function rewind(threadId: number): Promise<string> {
    return (await post<{ removed: string }>(`/api/threads/${threadId}/rewind`, { sessionId: await session() })).removed;
  }

  /** Rename a thread; returns the title as stored (one line, at most 80 characters). */
  async function renameThread(threadId: number, title: string): Promise<string> {
    const body = JSON.stringify({ sessionId: await session(), title });
    return (await call<{ title: string }>(`/api/threads/${threadId}`, { method: 'PATCH', headers: jsonHeaders, body })).title;
  }

  /** Delete a thread and everything in it. */
  async function deleteThread(threadId: number): Promise<void> {
    await call(await withSession(`/api/threads/${threadId}`), { method: 'DELETE' });
  }

  /** Product analytics (e.g. a thumbs up or down on a reply); never throws. */
  async function track(name: string, props: Record<string, unknown> = {}): Promise<void> {
    await post('/api/events/track', { name, ...props, sessionId: await session().catch(() => null) }).catch(() => undefined);
  }

  /** The contact form: stored for the team to answer by email. Rejects with bad_request or rate_limited. */
  async function contact(m: { name: string; email: string; topic: ContactTopic; message: string; turnstileToken?: string }): Promise<void> {
    await post('/api/contact', m);
  }

  // ── share links (D-024) ──
  /** The thread's live share token, or null. */
  async function shareStatus(threadId: number): Promise<string | null> {
    return (await call<{ token: string | null }>(await withSession(`/api/threads/${threadId}/share`))).token;
  }
  /** Turn on sharing (or get the existing link's token). */
  async function share(threadId: number): Promise<string> {
    return (await post<{ token: string }>(`/api/threads/${threadId}/share`, { sessionId: await session() })).token;
  }
  async function stopSharing(threadId: number): Promise<void> {
    await call(await withSession(`/api/threads/${threadId}/share`), { method: 'DELETE' });
  }
  /** What anyone with the link sees. */
  async function sharedTrip(token: string): Promise<SharedTrip> {
    const t = await call<SharedTrip>(`/api/share/${encodeURIComponent(token)}`);
    return { ...t, itinerary: parseItinerary(t.itinerary) ?? null };
  }

  // ── accounts (D-021): the server keeps the sign-in in an HttpOnly cookie; the client keeps the account's chat session id ──
  const browserSession = () => storage?.getItem(KEY) ?? undefined;
  const signedIn = (r: { user: Account; sessionId: string }) => { storage?.setItem(KEY, r.sessionId); return r.user; };

  /** Whether "Continue with Google" is available, and its client id. */
  async function authConfig(): Promise<{ googleClientId: string | null }> {
    return call('/api/auth/config');
  }
  /** The signed-in user, or null. Signed in, the account's chat session becomes this browser's. */
  async function me(): Promise<Account | null> {
    const r = await call<{ user: Account | null; sessionId?: string }>('/api/auth/me');
    if (r.user && r.sessionId) storage?.setItem(KEY, r.sessionId);
    return r.user;
  }
  /** Create an account and sign in; trips planned in this browser move into it. Rejects with weak_password, invalid_email, email_taken… */
  async function signup(a: { name: string; email: string; password: string; turnstileToken?: string }): Promise<Account> {
    return signedIn(await post('/api/auth/signup', { ...a, sessionId: browserSession() }));
  }
  async function login(a: { email: string; password: string }): Promise<Account> {
    return signedIn(await post('/api/auth/login', { ...a, sessionId: browserSession() }));
  }
  /** `credential` is the ID token from Google Identity Services. */
  async function google(credential: string): Promise<Account> {
    return signedIn(await post('/api/auth/google', { credential, sessionId: browserSession() }));
  }
  /** Sign out; this browser forgets the account's chat session. */
  async function logout(): Promise<void> {
    await post('/api/auth/logout', {}).catch(() => undefined);
    resetSession();
  }
  async function verifyEmail(token: string): Promise<void> { await post('/api/auth/verify', { token }); }
  async function resendVerification(): Promise<void> { await post('/api/auth/resend-verification', {}); }
  /** Always resolves the same way, whether or not the email has an account. */
  async function forgotPassword(email: string, turnstileToken?: string): Promise<void> { await post('/api/auth/forgot', { email, turnstileToken }); }
  /** Choose a new password from an emailed link; signs in. */
  async function resetPassword(token: string, password: string): Promise<Account> {
    return signedIn(await post('/api/auth/reset', { token, password, sessionId: browserSession() }));
  }
  async function updateAccount(a: { name: string }): Promise<Account> {
    return (await call<{ user: Account }>('/api/account', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(a) })).user;
  }
  /** Other browsers are signed out. Accounts without a password (Google only) can set one without `currentPassword`. */
  async function changePassword(a: { currentPassword?: string; newPassword: string }): Promise<Account> {
    return (await post<{ user: Account }>('/api/account/password', a)).user;
  }
  /** Start changing the email: a link goes to the new address (and a notice to the old one). */
  async function changeEmail(a: { newEmail: string; password?: string }): Promise<string> {
    return (await post<{ pendingEmail: string }>('/api/account/email', a)).pendingEmail;
  }
  async function confirmEmailChange(token: string): Promise<void> { await post('/api/auth/confirm-email', { token }); }
  async function devices(): Promise<SignedInDevice[]> { return (await call<{ sessions: SignedInDevice[] }>('/api/account/sessions')).sessions; }
  async function signOutDevice(id: string): Promise<SignedInDevice[]> {
    return (await call<{ sessions: SignedInDevice[] }>(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })).sessions;
  }
  async function signOutOtherDevices(): Promise<SignedInDevice[]> { return (await post<{ sessions: SignedInDevice[] }>('/api/account/sessions/sign-out-others', {})).sessions; }
  /** Everything stored about the account, as JSON. */
  async function exportData(): Promise<unknown> { return call('/api/account/export'); }
  /** Confirm with the password, or `confirm: 'DELETE'` for Google-only accounts. */
  async function deleteAccount(a: { password?: string; confirm?: string }): Promise<void> {
    await call('/api/account', { method: 'DELETE', headers: jsonHeaders, body: JSON.stringify(a) });
    resetSession();
  }

  return {
    session, resetSession, chat, confirm, threads, messages, profile, updateProfile, resetProfile, trip, itinerary, rewind, renameThread, deleteThread, track, contact,
    authConfig, me, signup, login, google, logout, verifyEmail, resendVerification, forgotPassword, resetPassword, updateAccount, changePassword, exportData, deleteAccount,
    changeEmail, confirmEmailChange, devices, signOutDevice, signOutOtherDevices,
    shareStatus, share, stopSharing, sharedTrip,
  };
}

export type TakeoffApi = ReturnType<typeof createTakeoffApi>;
```
<!-- END FILE takeoff-api.ts -->

## Appendix B: `src/services/takeoff-plan.ts`

Copy exactly. Helpers for plans: quick replies, the message for each alternative, labels for travel times, insights
and sources, and the plan in this app's `DayPlan` and `Activity` shapes.

<!-- BEGIN FILE takeoff-plan.ts -->
```ts
// Plan helpers for the Takeoff frontend, used next to takeoff-api.ts: quick replies for the planner's questions, the
// message that applies each alternative, labels for travel times, insights and sources, and the plan in the shapes of
// the frontend's DayPlan and Activity. No dependencies, no React. Copy it into the frontend as-is
// (src/services/takeoff-plan.ts); it is tested against the backend's planner in backend/test/client-plan.test.ts.

import type { ItineraryAlternative, ItineraryDraft, TravelLeg, TripContext, TripInsight } from './takeoff-api';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Replies to the question the planner just asked (`reply.planning.field`); each one is text the planner understands. */
export function quickReplies(field: string | undefined, today = new Date()): string[] {
  const month = (ahead: number) => MONTHS[(today.getMonth() + ahead) % 12];
  switch (field) {
    case 'destination': return ['Goa']; // the destinations with day-by-day plans so far
    case 'when': return [`${month(1)}, 4 days`, `${month(2)}, 5 days`];
    case 'travelers': return ['just me', 'me and my wife', '2 of us', 'we are 4 people'];
    case 'budget': return ['about 30k', 'about 60k', 'budget 1 lakh'];
    case 'pace': return ['relaxed', 'balanced', 'packed'];
    case 'interests': return ['beaches and food', 'history and culture', 'nature and adventure'];
    case 'tradeoff:pace': return ['relaxed', 'packed'];
    case 'tradeoff:luxury_budget': return ['keep the budget, comfortable stays are fine', 'keep luxury, I can spend more'];
    default: return [];
  }
}

/** The message that applies an alternative: the backend then rebuilds exactly the plan its `changes` described. */
export const ALTERNATIVE_MESSAGE: Record<ItineraryAlternative['kind'], string> = {
  cheaper: 'Make it cheaper',
  more_relaxed: 'Make it more relaxed',
  more_adventurous: 'Make it more adventurous',
};

/** "about 37 min (estimated)" or "about 24 min by road": an estimate is never shown as an exact time. */
export const travelLabel = (leg: TravelLeg) => (leg.isEstimate ? `about ${leg.minutes} min (estimated)` : `about ${leg.minutes} min by road`);

export const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

/** "Tue, 15 Dec" from "2026-12-15"; '' when there is no date. */
export const niceDate = (iso?: string) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';

/** One line per insight, saying plainly what was checked and what was not. */
export function insightLine(i: TripInsight): string {
  if (i.status === 'not_checked') return `${i.title}: ${i.detail}`;
  const when = i.date ? `, ${niceDate(i.date)}` : '';
  const stale = i.status === 'stale' ? ` (${i.type === 'weather' ? 'earlier forecast' : 'checked earlier'})` : '';
  return `${i.title}${when}${stale}: ${i.detail}`;
}

/** The credit line the plan's licences require, e.g. "© OpenStreetMap contributors (ODbL-1.0)". */
export const sourcesLine = (it: ItineraryDraft) => it.sources.map((s) => (s.licence ? `${s.attribution} (${s.licence})` : s.attribution)).join(' · ');

/** Plan-wide warnings, then each day's, labelled with the day. */
export const planWarnings = (it: ItineraryDraft) => [...it.warnings, ...it.days.flatMap((d) => d.warnings.map((w) => `Day ${d.day}: ${w}`))];

/** The frontend's Activity, plus what the plan adds; `priceINR` is absent when no fee is published (never 0). */
export interface PlanActivity {
  id: string; time: string; title: string; location: string; description: string; duration: string;
  category: 'Sightseeing' | 'Culinary' | 'Relaxation';
  priceINR?: number;
  /** no photos come from the backend: show a neutral placeholder */
  image: string;
  /** the place's OpenStreetMap page */
  mapUrl?: string;
  /** to the next stop, e.g. "about 37 min (estimated)" */
  travelToNext?: string;
}

/** The frontend's DayPlan. Hotels are not part of a plan, so `stayHotelId` is ''. */
export interface PlanDay { dayNumber: number; date: string; title: string; tagline: string; activities: PlanActivity[]; stayHotelId: string }

export function toDayPlans(it: ItineraryDraft): PlanDay[] {
  return it.days.map((d) => ({
    dayNumber: d.day,
    date: niceDate(d.date) || `Day ${d.day}`,
    title: `Day ${d.day}`,
    tagline: d.items.filter((i) => i.kind === 'activity').map((i) => i.title).join(' · '),
    activities: d.items.map((i, n): PlanActivity => ({
      id: i.poiId ?? `day${d.day}-${i.kind}-${n}`,
      time: `${i.start}–${i.end}`,
      title: i.title,
      location: it.destination,
      description: [
        ...(i.why?.matched.length ? [`Why: ${i.why.matched.join(', ')}`] : []),
        ...(i.suggestions?.length ? [`Nearby: ${i.suggestions.map((s) => s.name).join(', ')}`] : []),
        ...i.notes,
        ...(i.kind === 'activity' && i.hours === 'unknown' ? ['Opening hours not published'] : []),
      ].join('. '),
      duration: duration(i.durationMinutes),
      category: i.kind === 'meal' ? 'Culinary' : i.kind === 'rest' ? 'Relaxation' : 'Sightseeing',
      ...(i.costInr !== undefined ? { priceINR: i.costInr } : {}),
      image: '',
      ...(i.source?.url ? { mapUrl: i.source.url } : {}),
      ...(i.travelToNext ? { travelToNext: travelLabel(i.travelToNext) } : {}),
    })),
    stayHotelId: '',
  }));
}

/** A TripState with nothing in it, for a new conversation: the dossier shows only what the backend has sent. */
export const noTrip = () => ({
  destination: '', country: '', dates: '', durationDays: 0, travelers: 0, tripType: '',
  flightIncluded: false, flightPriceINR: 0, hotels: [] as never[], days: [] as PlanDay[],
});

/** The frontend's TripState fields that a plan fills: spread it over the current state (`{ ...trip, ...planTrip(...) }`). */
export function planTrip(it: ItineraryDraft, trip: Partial<Pick<TripContext, 'travelers' | 'purpose'>> = {}) {
  const first = it.days[0]?.date;
  const last = it.days.at(-1)?.date;
  return {
    destination: it.destination,
    country: 'India',
    dates: first && last ? `${niceDate(first)} – ${niceDate(last)}` : 'Flexible dates',
    durationDays: it.days.length,
    travelers: trip.travelers ?? 2,
    tripType: trip.purpose ?? '',
    flightIncluded: false,
    flightPriceINR: 0, // not shown: there are no flights in a plan
    hotels: [] as never[],
    days: toDayPlans(it),
  };
}

/** What the chat's itinerary card needs: no hotel and no price, since a plan has neither. */
export function planSummary(it: ItineraryDraft) {
  const days = toDayPlans(it);
  const first = it.days[0]?.date;
  const last = it.days.at(-1)?.date;
  return {
    destination: it.destination,
    duration: `${it.days.length} ${it.days.length === 1 ? 'Day' : 'Days'}`,
    dates: first && last ? `${niceDate(first)} – ${niceDate(last)}` : 'Flexible dates',
    daysCount: it.days.length,
    activitiesCount: it.days.flatMap((d) => d.items).filter((i) => i.kind === 'activity').length,
    day1Activities: (days[0]?.activities ?? []).filter((a) => a.category === 'Sightseeing'),
  };
}
```
<!-- END FILE takeoff-plan.ts -->

## Appendix C: `scripts/check-backend.mjs`

Copy exactly. It runs a four-message plan and a revision against a running backend and checks every response; each
check prints `ok:` or `FAIL:`.

<!-- BEGIN FILE check-backend.mjs -->
```js
// End-to-end check against a running backend (scripts/docker-smoke.sh runs it, and integration.md has the frontend
// run it as scripts/check-backend.mjs): a four-message plan and a revision
// ("flow"), then, after the backend restarts, that the thread, messages, trip and plan are all still there
// ("persist"). Exits non-zero at the first failed check.
import fs from 'node:fs';

const [mode, base, stateFile] = process.argv.slice(2);
const headers = { 'Content-Type': 'application/json' };

function check(ok, what, detail) {
  if (!ok) {
    console.error(`FAIL: ${what}${detail === undefined ? '' : `\n  ${JSON.stringify(detail).slice(0, 800)}`}`);
    process.exit(1);
  }
  console.log(`ok: ${what}`);
}

async function get(path) {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
}

async function chat(sessionId, content, threadId) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ sessionId, threadId, messages: [{ role: 'user', content, timestamp: null }] }) });
  const events = (await res.text()).split(/\r?\n\r?\n/).filter((b) => b.trim() && !b.startsWith(':')).map((b) => ({
    event: /^event: ?(.*)$/m.exec(b)?.[1],
    data: JSON.parse(b.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')),
  }));
  const done = events.find((e) => e.event === 'done')?.data;
  check(done, `"${content}" answered with a done event`, events);
  console.log(`   ${done.planning?.action ?? '-'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return done;
}

const activities = (plan, day) => plan.days[day].items.filter((i) => i.kind === 'activity');

if (mode === 'flow') {
  const ready = await get('/ready');
  check(ready.status === 200 && ready.body.data?.ok && ready.body.data.regions.includes('goa'), 'ready: model reachable; place data, guide pages and database present', ready.body);
  console.log(`   routing: ${ready.body.routing}`);
  const { sessionId } = await (await fetch(`${base}/api/session`, { method: 'POST', headers, body: '{}' })).json();

  let threadId;
  let done;
  const actions = [];
  for (const text of ['I want to plan a trip', 'Goa', '15 to 17 December, me and my wife', 'around 60k']) {
    done = await chat(sessionId, text, threadId);
    threadId = done.threadId;
    actions.push(done.planning?.action);
  }
  check(actions.join() === 'ask,ask,ask,draft', 'three questions, then a plan on the fourth message', actions);
  const plan = done.itinerary;
  check(plan?.version === 1 && plan.days.length === 3, 'done.itinerary: version 1, three days', plan && { version: plan.version, days: plan.days.length });
  const stops = plan.days.flatMap((d) => d.items.filter((i) => i.kind === 'activity'));
  check(stops.length > 0 && stops.every((s) => s.poiId && s.source?.attribution), `every stop (${stops.length}) is a known place with its source`);
  check(plan.sources.some((s) => s.attribution === '© OpenStreetMap contributors'), 'OpenStreetMap credit in the plan sources');
  check(Array.isArray(done.insights) && done.insights.length > 0 && done.insights.every((i) => i.source && i.status), 'done.insights present, each with a source and status');
  console.log(`   insights: ${done.insights.map((i) => `${i.type}=${i.status}`).join(', ')}`);
  const legs = stops.flatMap((s) => (s.travelToNext ? [s.travelToNext] : []));
  check(legs.every((l) => typeof l.isEstimate === 'boolean' && l.source), `every travel leg says where it came from (${legs.filter((l) => l.isEstimate).length} estimated, ${legs.filter((l) => !l.isEstimate).length} by road)`);

  const before = activities(plan, 1).length;
  const revised = await chat(sessionId, 'make day 2 more relaxed', threadId);
  check(revised.planning?.action === 'revise' && revised.itinerary?.version === 2, 'revision: done.itinerary version 2', revised.planning);
  console.log(`   day 2: ${before} → ${activities(revised.itinerary, 1).length} stops`);
  const stored = (await get(`/api/threads/${threadId}/itinerary?sessionId=${sessionId}`)).body.itinerary;
  check(stored?.version === 2, 'the stored plan is version 2');
  const messages = (await get(`/api/threads/${threadId}/messages?sessionId=${sessionId}`)).body.messages;
  fs.writeFileSync(stateFile, JSON.stringify({ sessionId, threadId, messages: messages.length, itinerary: stored }));
} else if (mode === 'persist') {
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const q = `sessionId=${encodeURIComponent(s.sessionId)}`;
  check((await get(`/api/threads?${q}`)).body.threads.some((t) => t.id === s.threadId), 'after the restart: the thread is still listed');
  check((await get(`/api/threads/${s.threadId}/messages?${q}`)).body.messages.length === s.messages, `after the restart: all ${s.messages} messages kept`);
  check(JSON.stringify((await get(`/api/threads/${s.threadId}/itinerary?${q}`)).body.itinerary) === JSON.stringify(s.itinerary), 'after the restart: plan version 2 unchanged');
  const trip = (await get(`/api/threads/${s.threadId}/trip?${q}`)).body.trip;
  check(trip.status === 'drafted' && trip.itineraryVersion === 2, 'after the restart: trip context kept', trip);
} else {
  console.error('usage: smoke.mjs flow|persist <base-url> <state-file>');
  process.exit(2);
}
```
<!-- END FILE check-backend.mjs -->

## Appendix D: start the backend on this computer

The backend is Node 22 with npm (not Bun: it uses a native SQLite module), plus a local model server. It needs access
to the private repository `Yash3510/travel-advisor-model`, about 1 GB of free disk space for the model, and the network
for the first setup.

```bash
node -v                       # must be v22 or later; install Node 22 if it isn't
command -v llama-server || brew install llama.cpp   # the model server (on a Mac it uses the GPU)
git clone --branch takeoff-app https://github.com/Yash3510/travel-advisor-model.git ../travel-advisor-model
cd ../travel-advisor-model/app
./setup.sh                    # installs the backend and downloads the model (about 834 MB), once
(cd backend && npm run data:import -- goa)   # Goa's places from OpenStreetMap, once
./run.sh                      # model server on :8081, backend on :5590; keep it running in the background
```

Wait until `curl -s http://127.0.0.1:5590/ready` answers `"ok":true` (the model takes up to a minute to load). If it
answers `"ok":false`, its `missing` list names what is missing. Stop it afterwards by ending `./run.sh`, which also
stops the model server it started.

Don't copy the place files (`backend/data/poi/`) into the frontend repository. They come from OpenStreetMap under the
ODbL licence and stay with the backend.

## Appendix E: backend reference

The client covers all of this; it's here for when something needs checking.

| Client call | Endpoint | Returns |
|---|---|---|
| `api.chat(text, { threadId, onDestination, onDeals, signal })` | `POST /api/chat` (event stream) | `ChatReply`: `message`, `threadId`, `offers`, `pendingBooking?`, `planning?`, `itinerary?`, `insights?` |
| `api.threads()` | `GET /api/threads` | the session's conversations, most recently active first |
| `api.messages(threadId)` | `GET /api/threads/:id/messages` | what the customer saw, in order |
| `api.itinerary(threadId)` | `GET /api/threads/:id/itinerary` | the latest plan, or `null` |
| `api.trip(threadId)` | `GET /api/threads/:id/trip` | what the planner knows: destination, dates, travellers, purpose, budget |
| `api.profile()`, `api.updateProfile(patch)`, `api.resetProfile()` | `/api/profile` | the traveller's saved preferences |
| `api.confirm({ threadId, offerId, travelers })` | `POST /api/confirm` | a booking **request** (`PENDING_SUPPLIER_CONFIRMATION`) |

The session id is kept in `localStorage` (`takeoff.sessionId`); the client replaces it by itself if the server no
longer knows it. The session is the user until accounts exist.

**Error codes** (`TakeoffApiError.code`; `errorText(err)` gives the customer-facing text):

| Code | When |
|---|---|
| `model_unavailable` | the model server is down or timed out (questions and plans still work: code builds them) |
| `rate_limited` | over 20 messages a minute from one address |
| `thread_busy` | a second message while one is pending (the locked input prevents it) |
| `message_too_long` | over 4,000 characters |
| `aborted` | Stop or New journey |
| `network`, `stream_ended`, `bad_response` | the connection dropped, or a reply was incomplete |
| `invalid_profile` | `updateProfile` with an unknown field or value |
| `thread_not_found`, `offer_not_found` | a thread or offer this session doesn't own |

**Production:** set `VITE_API_URL` to the backend's URL at build time, and ask the backend team to add the site's
origin to the backend's `ALLOWED_ORIGINS`. No cookies or auth headers are involved.
