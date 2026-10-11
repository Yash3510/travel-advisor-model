# Travel Advisor: a CPU-sized model for Indian trips

A small language model (**Qwen3.5-0.8B**, fine-tuned) that works as a **travel advisor and booking assistant for travel within and from India**.

**Behaviour:** it follows the *AI Travel Sales Agent — Behavioral & Training Specification v1.0*.
- Find out what the traveller needs before recommending.
- Use tools for prices, availability and official rules instead of inventing them.
- Show the total and cancellation terms before any booking.
- Report booking status exactly.
- Never pressure the customer, and switch to support mode when something goes wrong.

**Runs on:** a laptop **CPU** (no GPU) as an 834 MB GGUF, in llama.cpp or LM Studio / Bionic.

**Guardrail harness:** a small layer enforces the rules a 0.8B model cannot be trusted with on its own:
- emergencies go to 112
- card and ID numbers never reach the model
- the model cannot book without a Confirm action
- booking outcomes come from the system, not the model

Integrating it into an app: see [docs/INTEGRATION.md](docs/INTEGRATION.md).

## What is in this repo

| Path | What it is |
|---|---|
| `travel/harness.py` | Guardrail harness: the piece your app talks to |
| `travel/chat.py` | Console chat to try the model end to end with a mock travel backend |
| `travel/tools.py` | The 7 travel tool schemas the model was trained on |
| `travel/backend.py` | Mock travel backend (flights, hotels, bookings, entry rules, advisories, handoff) |
| `prompts/runtime_system_prompt.txt` | The short system prompt the model was trained with |
| `travel/evaluate.py` | The 30-scenario test from the behaviour spec (§17) |
| `travel/sgd.py`, `travel/build_sgd.py` | Converts Google's Schema-Guided Dialogue travel data into Indian conversations |
| `travel/scenarios.py`, `travel/simulate.py` | Generates the hard cases (customer simulator + teacher model + mock backend) |
| `travel/validate.py`, `travel/fixes.py` | Automatic checks, plus fixes made during generation |
| `travel/format.py`, `travel/build_dataset.py` | Turns conversations into training examples |
| `train/train_lora.py`, `train/export_gguf.sh` | LoRA training (Unsloth) and GGUF export |
| `reports/` | Dataset reports, manual review rejects, evaluation reports |
| `eval/results/` | Raw answers and scores of every model tested |

## Results

All tests use the 30 pre-deployment scenarios in spec §17, scored 0–4 with the rubric in spec §16. A critical failure is one that breaks a §16 release gate. The release gate is **0 critical failures and an average of at least 3**.

| Model | Average | Critical failures | Median reply time on CPU |
|---|---|---|---|
| Qwen3.5-0.8B base, full spec prompt | 0.80 | 7 | 32.9 s |
| Qwen3.5-0.8B base, short prompt | 0.70 | 6 | — |
| **v1 fine-tune**, short prompt | **1.60** | **4** | **6.4 s** |
| Teacher Qwen3.5-4B (thinking, GPU), full spec prompt | 2.97 | 0 | — |

Reports: [reports/v1_REPORT.md](reports/v1_REPORT.md). v2 adds about 180 targeted conversations aimed at v1's failures, and in-generation corrections.

**On its own, the model does not meet the release gate yet. Use it behind the harness.** The harness removes every critical-failure type seen in testing: unconfirmed bookings, misreported status, and missed emergencies.

## Quick start

1. **Run the model on CPU.** Requires Unsloth Studio's bundled llama.cpp:
   ```bash
   bash scripts/serve.sh "$HOME/.lmstudio/models/local/travel-advisor-qwen3.5-0.8b/travel-advisor-qwen3.5-0.8b-Q8_0.gguf" 8091 cpu -c 16384
   ```
2. **Chat with it through the harness**, with mock flights and hotels:
   ```bash
   uv run python -I -m travel.chat --server http://127.0.0.1:8091
   ```
3. **Or use it in LM Studio / Bionic.** It appears under *local / travel-advisor-qwen3.5-0.8b*.
   - Set the system prompt to `prompts/runtime_system_prompt.txt` plus the deployment line from [docs/INTEGRATION.md](docs/INTEGRATION.md#2-system-prompt).
   - Turn thinking off.

   Without the harness the guardrails are not active.

## How it was built

1. **Behaviour spec → tests.** The spec's 30 scenarios became `travel/evaluate.py`, run as real chats with tool results injected.
2. **Open data, localised to India.** About 1,450 travel conversations from Google's Schema-Guided Dialogue (CC-BY-SA-4.0) were converted to Indian travel:
   - cities, airports and airlines
   - ₹ prices with Indian digit grouping
   - dates shifted to a year with the same calendar

   Only bookings where the price was stated, a summary was shown and the customer gave a plain yes were kept.
3. **Hard cases the open data lacks.** Covers emergencies, accessibility, health, visas, fictional places, refund pressure, PII, tool failures, pending and failed bookings, and non-refundable rates.
   - **Who writes what:** a local Qwen3.5-4B, thinking on, plays the advisor against a mock backend; another Qwen3.5-4B plays the customer from a short brief.
   - **Generation-time corrections:** past dates are rolled forward, unrequested price caps dropped, bookings without a summary redirected to a summary, and searches without dates redirected to a question.
   - **Checks:** every conversation passes automatic checks (`travel/validate.py`): no invented amounts, dates, passports or distances, exact status reporting, no echoed card numbers, short replies. Plus manual review.
4. **Training examples.** One example per customer turn, with the prompt identical to what llama.cpp sends at inference and loss only on the advisor's reply.
5. **Training.** bf16 LoRA (r = 16) on an RTX 4050 (6 GB) with Unsloth, 2 epochs; about 1 hour for v1.
6. **Export and test.** Q8_0 GGUF, tested CPU-only (8 threads).

Rebuild from scratch:

```bash
uv run python -I -m travel.build_sgd data/raw/sgd data/processed/sgd_india.jsonl
uv run python -I -m travel.simulate http://127.0.0.1:8093 data/gap/gap_v1.jsonl --workers 3
uv run python -I -m travel.simulate http://127.0.0.1:8093 data/gap/gap_v3_targeted.jsonl --catalog v2 --workers 3
uv run python -I -m travel.build_dataset
~/.unsloth/studio/unsloth_studio/Scripts/python.exe train/train_lora.py outputs/v2 --bs 1 --pad 512 --epochs 2
bash train/export_gguf.sh outputs/v2/merged travel-advisor-qwen3.5-0.8b-v2
uv run python -I -m travel.evaluate http://127.0.0.1:8091 eval/results/out.json --system-file prompts/runtime_system_prompt.txt
```

Unsloth Studio's Python needs `flash-linear-attention` and `fla-core` 0.5.2 for Qwen3.5 training to fit in 6 GB. Install them with `uv pip install --python <studio python> --no-deps ...`.

## Adapting it to another sector

Nothing in the pipeline is travel-specific except its inputs. To build, say, a banking or clinic-front-desk assistant:

1. **Write the behaviour spec and its test scenarios.** Copy `travel/evaluate.py`.
2. **Define the tools** the assistant may call (`travel/tools.py`), with a mock backend that can fail the way the real one does (`travel/backend.py`).
3. **Find open conversation data** for the routine flows if any exists. Otherwise generate them.
4. **Write scenario briefs** for the hard cases of that sector (`travel/scenarios.py`).
5. **Adjust the checks** (`travel/validate.py`): what counts as an invented fact, an unconfirmed action, or a misreported status in that sector.
6. **Keep the harness pattern:** consequential actions need a human confirm, and outcomes are rendered from system results.

## Limitations

- **Facts:** a 0.8B model often gets geography, distances and seasons wrong. Facts should come from tools or a knowledge base, not the model.
- **Prices:** realistic, but from a mock backend. A real deployment needs real supplier APIs behind the same tool contract.
- **Teacher quality:** the hard cases were written by a 4B model. They passed the automatic checks, and a sample was read by hand, but small factual slips remain.
- **Hinglish:** works, but the teacher handled Hindi and Hinglish less reliably than English, so the model has seen fewer such examples.

## Licences

- **Base model:** Qwen3.5 (Apache-2.0).
- **Teacher:** Qwen3.5-4B (Apache-2.0).
- **Schema-Guided Dialogue:** CC-BY-SA-4.0 (Google Research). Converted SGD data is a derivative work under the same licence.
- **Behaviour specification:** belongs to its author.
