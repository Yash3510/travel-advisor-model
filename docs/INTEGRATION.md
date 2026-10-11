# Integrating the travel advisor into an app

This guide is for putting the model behind a real product: a website chat, a WhatsApp bot, or an agent console. The short version:

1. Serve the GGUF on CPU with an OpenAI-compatible server.
2. Put the **guardrail harness** between your app and the model.
3. Implement the **7 tools** against your real suppliers, keeping the field names the model was trained on.
4. Give the customer a real **Confirm** button for bookings.

```
 ┌──────────────┐  text   ┌───────────────────────────┐  chat + tools  ┌──────────────────────────┐
 │  Your app/UI │ ──────▶ │  Guardrail harness         │ ─────────────▶ │  Model server (CPU)       │
 │  (web, bot)  │ ◀────── │  travel/harness.py         │ ◀───────────── │  llama-server / LM Studio │
 └──────┬───────┘  Reply  │  - 112 router              │  tool calls    └──────────────────────────┘
        │                 │  - PII removal             │
        │ Confirm button  │  - booking gate            │  call(name, args)  ┌────────────────────────┐
        └───────────────▶ │  - status templates        │ ─────────────────▶ │  Your tool backend      │
          confirm_booking │                            │ ◀───────────────── │  (flights, hotels, CRM) │
                          └───────────────────────────┘      result dict    └────────────────────────┘
```

## 1. Serve the model

**llama.cpp** (what the tests use; CPU only, 8 threads was fastest on an i7-13650HX):

```bash
llama-server -m travel-advisor-qwen3.5-0.8b-Q8_0.gguf -ngl 0 -t 8 --jinja -c 16384 --host 127.0.0.1 --port 8091
```

`scripts/serve.sh <gguf> <port> cpu` does the same with Unsloth Studio's bundled llama.cpp.

**`--jinja` is required.** Tool calling depends on the model's own chat template.

**LM Studio / Bionic:** load *local / travel-advisor-qwen3.5-0.8b*. If your build has the OpenAI-compatible local server, point the harness's `OpenAIClient` at it (LM Studio's default is `http://localhost:1234`). Settings:
- thinking off
- temperature about 0.7
- context of at least 8k

**Every request must send** `chat_template_kwargs: {"enable_thinking": false}`. The model was trained without thinking.

## 2. System prompt

The model was trained with this system prompt: the contents of `prompts/runtime_system_prompt.txt`, followed by a deployment block:

```
DEPLOYMENT CONTEXT
Market: India. Currency: INR. Today's date: Saturday, 10 October 2026. You can only use the tools provided in this conversation; if a check needs a tool you do not have, say so.
```

- **Today's date must be the real date.** The model works out "next Friday" and "15 January" (next year) from it.
- **Build the block in code:** `travel.simulate.deployment_context("2026-10-10")` produces exactly this text.
- **Keep the wording** close to the original. The model learned its behaviour from this prompt. Rewriting it heavily (for example, pasting the full spec) makes it worse, not better.

## 3. Tools: the contract the model was trained on

Schemas are in `travel/tools.py` (OpenAI function format). Send all 7 unless you deliberately want the model to say it cannot do something. Keep names and fields as below; the model learned to read these exact shapes.

| Tool | Arguments | Return (fields the model reads) |
|---|---|---|
| `search_flights` | `origin`, `destination`, `date` (YYYY-MM-DD), `passengers`, `return_date`? | `{"checked_at", "results": [{"offer_id", "airline", "from", "to", "date", "departs", "duration_min", "stops", "fare_per_person_inr", "passengers", "total_inr", "baggage", "fare_rule"}]}` |
| `search_hotels` | `city`, `check_in`, `check_out`, `guests`, `max_price_per_night`? | `{"checked_at", "results": [{"offer_id", "hotel", "city", "room", "price_per_night_inr", "nights", "guests", "check_in", "check_out", "amenities": [...], "rate_rule", "total_inr", "taxes_included", "taxes_estimate_inr"?, "supplier"?}]}` |
| `create_booking` | `offer_id`, `travelers`, `total_price_inr`, `customer_confirmed_terms` | `{"status": "CONFIRMED", "booking_ref", "charged_inr"}`, or `{"status": "PENDING_SUPPLIER_CONFIRMATION", "request_id", "payment"}`, or `{"status": "FAILED", "reason": "PAYMENT_DECLINED" \| "NO_LONGER_AVAILABLE" \| "PRICE_MISMATCH" \| ..., "charged": false}` |
| `get_booking` | `booking_ref` | The booking record (`booking_ref`, `status`, `product`, `travelers`, ...) or `{"status": "NOT_FOUND"}` |
| `get_entry_requirements` | `passport_country`, `destination_country`, `purpose`?, `transit_countries`? | `{"source", "checked_at", "result", "also_required", "note"}` |
| `get_travel_advisory` | `destination` | `{"source", "checked_at", "destination", "advisory"}` |
| `handoff_to_human` | `summary`, `urgency` (`normal` / `urgent`) | `{"status": "TRANSFERRED", "queue", "expected_wait_minutes"}` |

**Rules for your implementations:**
- **Prices are integers in rupees.** Say whether taxes are included; if not, give `taxes_estimate_inr`.
- **`rate_rule` / `fare_rule` must state the cancellation terms.** Use `"NON_REFUNDABLE"` or text such as `"Free cancellation until 2027-01-02 23:59"`. The confirmation summary prints it.
- **On failure, return** `{"error": "...", "message": "..."}` (for example, a supplier timeout) or an empty `results` list with a `message`. The model was trained to say plainly that the check did not happen. Never return made-up results.
- **`checked_at`** helps the model and the customer know how fresh a price is.

## 4. Implement the backend

The harness needs an object with two methods:

```python
class MyBackend:
    def call(self, name: str, args: dict) -> dict:
        """Run a tool against your real systems and return the dict described above."""

    def get_offer(self, offer_id: str) -> dict | None:
        """Return an offer previously returned by search_flights/search_hotels (cache them by offer_id)."""
```

`travel/backend.py` is a working mock: deterministic fake inventory, failure modes, and an offer cache. Start from it and replace one tool at a time.

## 5. Use the harness

```python
from travel.harness import Harness, OpenAIClient
from travel.simulate import deployment_context

system = open("prompts/runtime_system_prompt.txt", encoding="utf-8").read().strip() + deployment_context("2026-10-10")
bot = Harness(llm=OpenAIClient("http://127.0.0.1:8091"), backend=MyBackend(), system_prompt=system, today="2026-10-10")

reply = bot.send("Hotel in Udaipur for 2, 12 to 15 December")
```

`reply` is a `Reply(kind, text, pending_booking)`. What your UI does with each kind:

| `reply.kind` | What happened | What your UI does |
|---|---|---|
| `message` | Normal advisor reply (questions, options, answers) | Show `text` |
| `confirm_booking` | The model wants to book. **Nothing is booked yet.** `text` is a summary built from supplier data (product, dates, travellers, total with taxes, cancellation rule); `pending_booking` has `offer_id`, `travelers`, `total_price_inr` | Show the summary with **Confirm** and **Change** buttons |
| `booking_result` | The booking ran after `confirm_booking()`. `text` comes from the real status (confirmed / pending / failed) | Show `text`. For pending, show the request as *not yet confirmed* |
| `emergency` | The message looked like an emergency. The model was not consulted; the customer was told to call 112 and an urgent handoff was raised | Show `text` prominently. Alert your support staff |

- Confirm button → `bot.confirm_booking()`.
- Change button, or the customer types something else → `bot.cancel_booking()`, then carry on with `send()`.

`bot.messages` is the conversation (without the system prompt), already stripped of card and ID numbers. Store it per customer session to keep context. Create one `Harness` per conversation.

## 6. Guardrails: what they enforce and why

| Guardrail | Why it exists (spec section) | Do not remove because |
|---|---|---|
| **Booking gate.** `create_booking` from the model never runs; the harness shows a supplier-data summary and books only on `confirm_booking()` | §10.1–10.2: consent before consequential actions | In testing, the model booked non-refundable rates without disclosure (v1 scenarios S08, S13) |
| **Status templates.** Confirmed / pending / failed text comes from the tool result | §10.1: never upgrade a status | The model once added an invented ₹5,400 charge to a pending booking (S11) |
| **112 router.** Danger phrases get a fixed reply before the model runs, plus an urgent handoff | §11.5: emergencies take precedence | A 0.8B model can miss or misread an emergency (the base model called a travel advisory for an unresponsive person) |
| **PII removal.** Card, CVV, OTP, Aadhaar, PAN and passport numbers are replaced before the model or the history sees them | §10.3: data minimisation | Customers paste these into chat; they must never reach logs or prompts |

The 112 trigger list (`EMERGENCY` in `travel/harness.py`) is deliberately narrow, so that "missed my flight" or "booked by accident" don't trigger it. Extend it for your audience, including Hindi and Hinglish phrases, and keep tests like `test_ordinary_messages_are_not_emergencies` passing.

## 7. Calling the model without the Python harness

If your app is in another language, call the model server directly and **re-implement the four guardrails**. The request:

```json
POST /v1/chat/completions
{
  "messages": [{"role": "system", "content": "<runtime prompt + deployment context>"}, ...conversation...],
  "tools": [ ...the 7 schemas from travel/tools.py... ],
  "chat_template_kwargs": {"enable_thinking": false},
  "temperature": 0.7, "top_p": 0.8, "top_k": 20, "max_tokens": 600
}
```

The response message has `content` and/or `tool_calls` (OpenAI format). Run each tool, append a `{"role": "tool", "tool_call_id": ..., "content": "<json>"}` message, and call again, until a reply has no tool calls. Allow up to 4 tool rounds per customer message. Never execute `create_booking` from the model directly: route it to your confirmation screen.

## 8. Performance (CPU)

Measured on an i7-13650HX, Q8_0, no GPU:

| Measure | Value |
|---|---|
| Generation | 17–21 tokens/s |
| Prompt reading | ~110 tokens/s |
| Median reply | about 6 s; first reply about 12 s while the ~1,000-token prompt and tool schemas are read |

- **Threads:** use `-t` equal to your performance-core count (8 was fastest; all 14 cores was slower).
- **Context:** 16k is plenty. Conversations rarely pass 4k tokens.
- **Smaller file:** a Q4_K_M export (about 530 MB) would be faster still, at some quality cost. Use `--outtype` in `train/export_gguf.sh`, or `llama-quantize`.

## 9. Testing your integration

- **`uv run pytest`:** unit tests for the harness, checks, data conversion and formatting.
- **`uv run python -I -m travel.evaluate <server> out.json --system-file prompts/runtime_system_prompt.txt`:** the 30 spec scenarios. Score with the §16 rubric and compare with `eval/results/scores.json`.
- **Before going live, run your real backend's failure modes through the chat:**
  - supplier timeout
  - pending booking
  - declined payment
  - price changed between search and booking

  The customer should never read "booked" unless your system said so.

## 10. What not to rely on the model for

- **Facts:** geography, distances, seasons, opening hours or visa rules from memory. Give it tools or a knowledge base for these.
- **Arithmetic:** across many items. The harness computes the booking total itself.
- **Policy judgement:** refunds, waivers, compensation. The model is trained to say these depend on supplier terms; your backend and staff decide.
