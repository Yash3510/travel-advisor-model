# v5 on CUDA: run notes

v5 = v4's data and recipe plus new teacher conversations aimed at what v4 missed
([eval/results/v4_cuda_REPORT.md](../eval/results/v4_cuda_REPORT.md)). Trained on the RTX 4050 laptop, 22 Oct 2026,
hands-off with `scripts/overnight.ps1 -Version v5`. Setup and kernels are the same as [V3_CUDA_RUN.md](V3_CUDA_RUN.md).
Scores: [eval/results/v5_cuda_REPORT.md](../eval/results/v5_cuda_REPORT.md) (not the official judge).

## New data: `data/gap/gap_v5.jsonl`

Briefs: `travel/scenarios.py` `build_v5()`. The conversations stop on the reply that matters (the correction, the
summary, the reply to the lookup), so they don't add more bookings after "book the cheaper one".

| Category | Aimed at | Ends on | Briefs | Passed |
|---|---|---|---|---|
| `v5_supplier_correction`: "it has free cancellation too, right?" → correction | S08 | the correction | 50 | 41 |
| `v5_book_now_summary`: "book it, charge my card" → summary | S13 | the summary | 30 | 30 |
| `v5_attraction_lookup`: look the made-up attraction itself up | S27 | the reply to the lookup | 45 | 35 |
| `v5_pii_first`: warn about pasted card/Aadhaar/passport first | S24 | | 50 | 35 |
| `v5_health_replan`: replan after a health reveal, suggest a doctor | S28 | | 30 | 19 |
| **Total** | | | **205** | **160** |

The two booking categories count double in training (`REPEAT` in `travel/build_dataset.py`), as v1's do.

**In-generation fixes** (`travel/fixes.py`; v4's data showed the teacher making the student's mistakes):

- `focus_first` makes the first guide lookup the attraction itself. A city lookup is pointed at the attraction, and a
  first reply that skips the lookup becomes the lookup. In v4's data, 22 of 27 conversations had looked up the city first.
- `PII_NOTE` has the teacher rewrite a first reply that doesn't warn about pasted numbers.
- `HEALTH_NOTE` replaces a tool call made right after the health reveal with a revised plan.

**New checks** (`travel/validate.py`, v5 categories only): `booked`, `no_summary`, `focus_not_looked_up`, `no_replan`,
`no_pii_in_opening` (the customer simulator sometimes leaves the numbers out), plus v4's acknowledgement checks. All
1,698 earlier conversations get the same verdicts as before. Two pilots (14 conversations, read by hand) led to
`no_pii_in_opening`, the first-reply lookup, ending attraction chats on the lookup, and PII questions that don't invite
weather facts from memory.

## Training

```
uv run python train/train_lora.py outputs/v5 --bs 1 --pad 512 --epochs 2 --max-len 4096 --base <unsloth snapshot>
```

| | |
|---|---|
| Rows | **3,621** train (v4: 3,158), 156 val |
| Steps | 454 (2 epochs), effective batch 16, LoRA r16, bf16, cosine LR 2e-4, max-len 4096 |
| Speed | ~22 s per step (fla kernels); the "CUDA allocation failed" warnings in the log are retried and harmless (v4 had 47) |
| Time | 10,080 s train_runtime (14:23–17:11) |
| **train_loss** | **0.693** |

Loss by 50 steps: 0.867 → 0.756 → 0.758 → 0.695 → 0.672 → 0.641 → 0.629 → 0.594 → 0.637, last step 0.454.

## Export and eval

| File | Bytes |
|---|---|
| `models/trained-v5-gguf/travel-advisor-qwen3.5-0.8b-v5-Q8_0.gguf` | 811,843,424 |
| `models/trained-v5-gguf/travel-advisor-qwen3.5-0.8b-v5-bf16.gguf` | 1,516,744,544 |

Answers: `eval/results/v5_cuda_deploy.json` (Q8_0), `v5_cuda_bf16_deploy.json`; gate samples:
`eval/results/v5_cuda_gate_samples.json`. 30/30 answers each, no empty replies or `<think>` leaks.

## Timeline (22 Oct, IST)

| | |
|---|---|
| 12:42–13:51 | 205 conversations generated, 116 passed |
| 13:52–14:22 | 89 failed ones generated again, 160 passed in total |
| 14:23–17:11 | dataset + training |
| 17:12–17:17 | export (Q8_0, bf16), 30-scenario evals, gate samples |
