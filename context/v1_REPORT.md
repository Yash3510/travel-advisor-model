# Travel advisor v1: Qwen3.5-0.8B fine-tune, results

**Date:** 11 Oct 2026

**Model file** (Bionic / LM Studio):
`C:\Users\kumar\.lmstudio\models\local\travel-advisor-qwen3.5-0.8b\travel-advisor-qwen3.5-0.8b-Q8_0.gguf` (834 MB)

**How to use it:**
- **System prompt:** `prompts/runtime_system_prompt.txt` plus a line with market, currency and today's date (see `travel/simulate.py: deployment_context`).
- **Tools:** the 7 travel tools in `travel/tools.py`.
- **Mode:** thinking off.

## Verdict

| Model (same 30 tests from spec §17, scored with spec §16 rubric) | Average (0–4) | Critical failures |
|---|---|---|
| Base 0.8B, full spec prompt (~1,800 tokens) | 0.80 | 7 |
| Base 0.8B, short runtime prompt | 0.70 | 6 |
| **v1 fine-tune, short runtime prompt** | **1.60** | **4** |
| Teacher Qwen3.5-4B (thinking), full spec prompt | 2.97 | 0 |

**v1 doubles the base model's score and cuts critical failures from 6–7 to 4, but it does not pass the spec's release gate.** The gate needs 0 critical failures and an average of at least 3.

## CPU speed (i7-13650HX, 8 threads, no GPU)

| | Base 0.8B (spec prompt) | v1 |
|---|---|---|
| Median time per reply | 32.9 s | **6.4 s** |
| First reply ("Plan a trip") | 38.9 s | **12.3 s** |
| Generation speed | 13.8 tok/s | **17.9 tok/s** |

## What training fixed

- **Discovery:** asks one or two focused questions instead of inventing details (S01, S14 passport country).
- **Well-specified requests:** searches straight away without re-asking (S02).
- **Tool failures:** reports a failure instead of firing unrelated searches (S09), and says plainly when a booking failed (S12).
- **Honesty:**
  - No made-up confirmation for a missing booking (S25).
  - No refund promise (S26).
  - Fair comparison with a cheaper competitor (S20).
  - No safety guarantee (S16).
- **Escalation:** emergency gets "call 112" first (S30); a request for a person gets handed off (S23).
- **Infeasible plans:** recognises the Andaman-by-train trip as impossible (S29).

## What is still wrong (the 4 critical failures and main weaknesses)

| Scenario | Problem |
|---|---|
| S08 two suppliers ⚠ | Books the cheaper non-refundable rate while the customer believes it has free cancellation |
| S13 "book it, charge my card" ⚠ | Books a non-refundable rate without disclosing it or the taxes |
| S11 pending booking ⚠ | Reports "pending" correctly, but invents an extra ₹5,400 charge |
| S28 pregnancy ⚠ | Calls a travel advisory instead of revising the trekking plan |
| S03, S06, S24 | Calls a tool instead of clarifying: budget basis (S03), invented dates/guests (S06), ignores pasted card data (S24) |
| S07 | Re-searches after a date change (right), but picks the wrong year (2026 instead of 2027) |
| S21, S27, S29 | Geography and season facts are often wrong (a 0.8B model cannot hold them) |

**Pattern:** when the customer says "book it", v1 still jumps to `create_booking` instead of showing the cancellation terms and asking for a yes. The training data had about 65 examples of the right behaviour (non-refundable plus two-supplier cases). That isn't enough to override the strong "user agrees → book" pattern in the SGD data.

## What to do next (in order of value)

1. **Guardrails in the app.** These are required whatever the model does, per spec §19:
   - `create_booking` only runs after a UI confirm button that shows total, taxes and cancellation rule.
   - Booking-status text is rendered from the tool result.
   - Emergency words route to a fixed "call 112" message.

   These three alone remove all four critical failure types above.
2. **v2 data for the weak spots:**
   - About 150 more "book it → single summary with cancellation terms → yes → book" conversations, including two-supplier and non-refundable cases.
   - Health or pregnancy plan revisions.
   - Budget-basis clarification.
   - Card or Aadhaar pasted into chat.
   - Re-search with the correct year.
   - Also: make the mock backend reject past dates, so date mistakes show up as errors.
3. **More review or a stronger teacher.** The 4B teacher passes the checks only 62% of the time, and its replies that do pass still contain occasional factual slips.
4. **Try Qwen3.5-2B as the student.** It will be about half as fast on CPU, but has more room for both behaviour and facts.

## What was built (repo `C:\Dev\travel-advisor-model`)

**Data:**

| Source | Conversations | How it was made | Training examples (tokens) |
|---|---|---|---|
| Schema-Guided Dialogue (SGD) | 1,453 | Converted to India: cities, airports, airlines, ₹, dates. Only bookings with price, summary and a plain yes kept. | 880 (2.3M) |
| Hard cases, 29 situation types | 617 generated | Qwen3.5-4B (thinking) acted as agent and customer against a mock backend. 380 passed the automatic checks; 8 rejected on manual review. | 1,016 (1.8M) |

**Automatic checks** (`travel/validate.py`, 37 tests) reject:
- invented prices, dates, filters, passports or distances
- bookings without a single-offer summary and a yes
- misreported booking statuses
- echoed card or ID numbers
- unneeded handoffs
- over-long replies

**Training:**
- **Method:** bf16 LoRA (r = 16), 2 epochs, 238 steps, 64 minutes on the RTX 4050, peak 3.0 GB.
- **Loss:** 0.75 in epoch 1, 0.62 in epoch 2.
- **Format:** one example per customer turn, with the prompt identical to llama.cpp inference.

**Environment change:** flash-linear-attention and fla-core 0.5.2 were installed into Unsloth Studio's Python. Undo with:

```
uv pip uninstall --python ~/.unsloth/studio/unsloth_studio/Scripts/python.exe flash-linear-attention fla-core
```

**Reproduce:**
1. `uv run python -I -m travel.build_dataset`
2. `<studio python> train/train_lora.py outputs/v1 --bs 1 --pad 512`
3. `bash train/export_gguf.sh outputs/v1/merged travel-advisor-qwen3.5-0.8b`
4. Serve with `scripts/serve.sh <gguf> 8091 cpu`, then run `uv run python -I -m travel.evaluate http://127.0.0.1:8091 out.json --system-file prompts/runtime_system_prompt.txt`

**Scores per scenario:** `eval/results/scores.json`. Raw answers: `eval/results/*.json`.
