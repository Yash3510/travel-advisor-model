# v4 on CUDA: run notes

v4 = v3's recipe (Recipe A in [HANDOFF_V3_TRAINING.md](HANDOFF_V3_TRAINING.md)) plus new teacher conversations aimed at the
weak spots in [eval/results/v3_cuda_REPORT.md](../eval/results/v3_cuda_REPORT.md). Trained overnight on the RTX 4050 laptop,
22 Oct 2026, hands-off with `scripts/overnight.ps1 -Version v4` (then named `scripts/v4_overnight.ps1`). Setup, versions and kernels are the same as
[V3_CUDA_RUN.md](V3_CUDA_RUN.md). Scores: [eval/results/v4_cuda_REPORT.md](../eval/results/v4_cuda_REPORT.md) (not the official judge).

## New data: `data/gap/gap_v4.jsonl`

Briefs: `travel/scenarios.py` `build_v4()` (`python -I -m travel.simulate <teacher> data/gap/gap_v4.jsonl --catalog v4`).
Teacher: Qwen3.5-4B Q6_K with thinking, llama.cpp b11786 on the GPU, 3 parallel conversations (~30 s each). Failed
conversations were dropped (`scripts/keep_clean.py`) and generated once more.

| Category | Aimed at | Briefs | Passed |
|---|---|---|---|
| `v4_visa_ask`: ask the passport before checking visa rules | S14 | 30 | 30 |
| `v4_unknown_attraction`: say a made-up attraction can't be found | S27 | 45 | 27 |
| `v4_infeasible`: no rail link / too many cities for the days | S29, S04 | 30 | 20 |
| `v4_pii_answer`: warn about pasted card/Aadhaar first, then answer | S24 | 25 | 16 |
| `v4_disruption_calm`: missed connection, nobody hurt: support, no 112 | S18 | 20 | 20 |
| `v4_supplier_mismatch`: correct "it has free cancellation too" before booking | S08 | 30 | 28 |
| **Total** | | **180** | **141** |

New checks in `travel/validate.py`, applied only to these categories (the v1–v3 data passes and fails exactly as before;
every per-category drop count in `reports/dataset.md` matches v3's): the acknowledgement the category teaches must appear
(`no_unknown_ack`, `no_infeasible_ack`), the first reply must warn about pasted data (`pii_not_warned`), and the reply
right after the customer's free-cancellation assumption must say non-refundable (`no_nonrefundable_warning`). A pilot
of 9 conversations was read by hand before the run; it led to the stricter supplier check and the clearer supplier brief.

## Training

```
uv run python train/train_lora.py outputs/v4 --bs 1 --pad 512 --epochs 2 --max-len 4096 --base <unsloth snapshot>
```

| | |
|---|---|
| Rows | **3,158** train (v3: 2,778; +400 from v4 conversations, which split into several rows each), 161 val |
| Steps | 396 (2 epochs), effective batch 16, LoRA r16, bf16, cosine LR 2e-4, max-len 4096 |
| Speed | ~22 s per step |
| Time | 8,635 s train_runtime (04:35–07:00) |
| **train_loss** | **0.704** (v3 0.671 on easier data; not comparable) |

Loss by 50 steps: 0.835 → 0.764 → 0.770 → 0.716 → 0.633 → 0.632 → 0.617 → 0.662 (steps 351–396); last step 0.594.

## Export and eval

| File | Bytes |
|---|---|
| `models/trained-v4-gguf/travel-advisor-qwen3.5-0.8b-v4-Q8_0.gguf` | 811,843,424 |
| `models/trained-v4-gguf/travel-advisor-qwen3.5-0.8b-v4-bf16.gguf` | 1,516,744,544 |

Same converter and server flags as v3. Answers: `eval/results/v4_cuda_deploy.json` (Q8_0) and `v4_cuda_bf16_deploy.json`;
gate samples: `eval/results/v4_cuda_gate_samples.json`. 30/30 answers each, no empty replies or `<think>` leaks.
CPU speed is the same as v3 (same architecture and file sizes).

## Timeline (22 Oct, IST)

| | |
|---|---|
| 02:40–04:00 | 180 conversations generated, 112 passed |
| 04:00–04:35 | 68 failed ones generated again, 141 passed in total |
| 04:35–07:00 | dataset + training |
| 07:00–07:04 | export (Q8_0, bf16), 30-scenario evals, gate samples |
