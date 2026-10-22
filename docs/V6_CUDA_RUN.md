# v6 on CUDA: run notes

v6 = v5's data and recipe plus teacher conversations for everything v5's report still listed
([eval/results/v5_cuda_REPORT.md](../eval/results/v5_cuda_REPORT.md)), and a stricter way of measuring it. RTX 4050 laptop,
22–23 Oct 2026, `scripts/overnight.ps1 -Version v6 -Stage data`, a hand review, then `-Stage train`. Scores:
[eval/results/v6_cuda_REPORT.md](../eval/results/v6_cuda_REPORT.md) (blind, not the official judge).

## Measurement first

- **Held-out scenarios** (`travel/evaluate.py` HOLDOUT, S101–S115): written before any v6 data, never used to design
  data. `build_dataset` drops v6 conversations whose opening resembles one (none did). Older data was left alone; 4 v4
  visa conversations resemble S109.
- **3 samples per scenario** for v5 and v6 (`scripts/gate_samples.py <url> <out> 3 eval|holdout`), scored **blind**
  (`scripts/blind_score.py sheet` / `tally`).

## New data: `data/gap/gap_v6.jsonl`

Briefs: `travel/scenarios.py` `build_v6()`. Where the eval scenario starts mid-conversation (a plan already proposed, a
booking just submitted, a suggestion turned down), the conversation starts with those turns scripted (`sc["prefix"]`)
and `meta.scripted_turns` makes `build_dataset` train only the turns after them.

| Category | Aimed at | Briefs | Passed |
|---|---|---|---|
| `v6_status_wording`: pending/failed booking reported as not booked | S11, S12 | 35 | 33 |
| `v6_health_after_plan`: condition revealed after a strenuous plan | S28 | 35 | 27 |
| `v6_rejected_suggestion`: suggest a different kind of place | S22 | 30 | 29 |
| `v6_too_many_places` | S04 | 30 | 28 |
| `v6_budget_gap`: explain the gap without prices from memory | S05 | 30 | 30 |
| `v6_no_rail_trip` | S29 | 30 | 19 |
| `v6_full_spec_search`: search, don't re-ask | S02 | 30 | 29 |
| `v6_vague_ask`: ask, don't search with invented dates | S06 | 25 | 24 |
| `v6_upgrade_advice`: give an opinion | S19 | 20 | 20 |
| `v6_attraction_pair`: look up both made-up attractions | S27 | 25 | 22 |
| **Total** | | **290** | **261** |

**How the data was made:**
- **Pilots.** Three pilots (35 conversations, read by hand) shaped the generator.
  - New in-generation fixes in `travel/fixes.py` and `travel/simulate.py`: `SEARCH_NOTE` (retry with a search instead of re-asking), `ADVICE_NOTE`, `SUGGEST_NOTE`, and `PRICE_NOTE`, which rewrites prices quoted from memory (v6 only).
  - A `PREAMBLE` strip removes "Here is the rewritten reply:".
  - Every rewrite note now says never to mention the draft.
- **New checks.** v6 categories get checks in `validate._check_v6`, including `editor_leak` for the rewrite step talking about itself.
  - They use broader wording than v4's: the pilots' good replies said "extremely rushed", "no such service" and "wasn't found in my travel guide".
  - All 1,858 older conversations get the same verdicts as before.
- **Generation.** 195 passed in round 1 and 244 in round 2.
- **Hand review** of 3 random passing conversations per category. Two problems surfaced:
  - "Something else?" replies that only asked questions, so they now must name an alternative from the guide (`no_alternative`, plus `SUGGEST_NOTE`).
  - A health reply that only said "ask a doctor", so a gentler plan is now required (`no_alternative_plan`).
- **Round 3** brought it to 261.
- **What the review missed.** The scripted `create_booking` turn in `v6_status_wording` was trained. That taught "book it" → book (see the report). The fix is listed there.

## Training

`train/train_lora.py outputs/v6 --bs 1 --pad 512 --epochs 2 --max-len 4096 --base <unsloth snapshot>`

| | |
|---|---|
| Rows | **4,008** train (v5: 3,621), 180 val; `v6_status_wording` and `v6_health_after_plan` count double |
| Steps | 502, ~21 s per step |
| Time | 10,570 s train_runtime (23:57–02:54) |
| train_loss | 0.722 |

Loss by 50 steps: 0.906 → 0.802 → 0.770 → 0.723 → 0.772 → 0.693 → 0.645 → 0.625 → 0.642 → 0.640 → 0.682 (last 2 steps).

## Export and eval

`models/trained-v6-gguf/travel-advisor-qwen3.5-0.8b-v6-Q8_0.gguf` (811,843,424 bytes) and `-bf16.gguf` (1,516,744,544).
One-sample answers: `eval/results/v6_cuda_deploy.json`, `v6_cuda_bf16_deploy.json`; gate samples:
`eval/results/v6_cuda_gate_samples.json`; blind scoring: `eval/results/v6_blind/`.
