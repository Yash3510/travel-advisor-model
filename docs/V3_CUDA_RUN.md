# v3 on CUDA: run notes

Recipe A from [HANDOFF_V3_TRAINING.md](HANDOFF_V3_TRAINING.md), trained on the RTX 4050 laptop, 2026-10-21. Eval answers are
in `eval/results/` and are **not scored**: score them side by side with v2 using the same judge.

## Setup

| | |
|---|---|
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU, 6 GB (6,141 MiB), driver 617.42 |
| CPU | Intel i7-13650HX, Windows 11 Home |
| Python | 3.12.15 (uv 0.13.4) |
| Pinned | torch 2.14.1+cu126, transformers 5.19.0, peft 0.21.2, datasets 5.1.0, accelerate 1.15.0, safetensors 0.8.0, huggingface-hub 2.2.0 |
| Added | fla-core 0.5.2, flash-linear-attention 0.5.2, triton-windows 3.8.0.post29, einops 0.8.2 (fast linear-attention kernels, see below). `causal-conv1d` is not installed (reference fallback). |
| Base | `unsloth/Qwen3.5-0.8B` rev `23c69c53358a07516b5827588b3fdb12ae78fd65`, the base v1/v2 were trained from, already on the laptop. Safetensors SHA-256 `04b1c301…4696` matches Hugging Face's recorded hash; 0 of 488 tensors constant. The corrupt `base-Qwen3.5-0.8B-hf-weights` copy was not used (its hash differs). |

## Data

`uv run python -I -m travel.build_dataset`: **2,778 train rows, 117 val rows**. `reports/dataset.md` came out byte-identical
to the committed one. Rows are 877–4,091 tokens (median 2,118); none exceed 4,096, 106 exceed 3,584, 1,520 exceed 2,048.
`gap_v3_concierge` is excluded and all 8 `gap_v3_kb` categories are in (484 train rows).

## Training

```
uv run python train/train_lora.py outputs/v3 --bs 1 --pad 512 --epochs 2 --max-len 4096 --base <unsloth snapshot>
```

| | |
|---|---|
| max-len | **4096**, all **2,778** rows trained (`train 2778 samples`) |
| Steps | 348 (2 epochs × 174), effective batch 16, LoRA r16 (6,389,760 trainable params), bf16, cosine LR 2e-4 |
| Speed | 22–25 s per optimizer step (~1.4 s per row) |
| Time | 8,384 s train_runtime, 2 h 20 min wall (15:31–17:51 IST) |
| Peak memory | 2.2 GiB allocated on the 4,091-token row |
| **train_loss** | **0.6707** (mean over all steps) |

Loss by 50 steps: 0.803 → 0.747 → 0.704 → 0.642 → 0.567 → 0.612 → 0.619 (steps 301–348). Epoch 1 mean 0.740, epoch 2
mean 0.601, last step 0.668.

## Anything unusual

1. **First-step loss is ~0.72, not 1.1–1.4.** Not bad weights: the untrained base scores 0.923 on 48 random training
   rows (v2: 0.672). Split by length, the base scores **1.24 on rows ≤2,048 tokens** (the only rows the Mac run kept) and
   0.67 on longer rows. 1.1–1.4 is what the truncated set gives; with every row kept, ~0.9 at the start is expected.
   Likewise the final loss is below the 0.8–0.9 you might expect from the Mac run.
2. **val is 117 rows, not 150–180.** That is what this data produces (the committed report says 117 too). Val is not used
   in training (`eval_strategy="no"`).
3. **Fast kernels.** A first run on the reference PyTorch linear-attention kernels ran at ~68 s/step (~6.5 h total); it was
   stopped at step 72 and restarted from scratch with `fla` 0.5.2 (the kernel version v1/v2 used). Same command, data,
   seed and recipe. Equivalence checks: kernel outputs and gradients within 0.3–0.8% (bf16 rounding; ~16× faster); the
   2-step smoke test gave 0.7193 / 0.2277 vs 0.7173 / 0.2265 on the reference kernels; steps 1–50 averaged 0.8026 vs
   0.803 on the stopped run.
4. **Merged model is text-only** (`Qwen3_5ForCausalLM`, no vision tower or MTP head), 1,435 MB. That is why the Q8_0 GGUF
   is 811.8 MB while v2's (exported from a multimodal checkpoint) is 833.6 MB.
5. **GGUF export** needs `gguf-py` from llama.cpp itself: PyPI `gguf` 0.19.0 lacks `gguf.LazyChunkedTensor`. Used tag
   b11786 in a throwaway env: `uv run --with "gguf @ https://github.com/ggml-org/llama.cpp/archive/refs/tags/b11786.zip#subdirectory=gguf-py"`.
   Re-exporting v2 this way reproduced v2's GGUF size to within 64 bytes.
6. **Loss on held-out rows** (bf16, GPU):

   | | 48 train rows | 117 val rows | 12 val rows, new guide categories | 53 val rows, v1/v2-era categories |
   |---|---|---|---|---|
   | base | 0.924 | 0.872 | | |
   | v2 | 0.672 | 0.594 | 1.023 | 0.822 |
   | v3 | 0.585 | 0.669 | **0.981** | 0.980 |

   v2 was built from an earlier split and almost certainly trained on most of the v1/v2-era val conversations, so only
   the guide-category column is a fair v2-vs-v3 comparison. The 30-scenario eval is the real test.
7. Laptop setup: Windows Smart App Control had to be turned off (it blocked Git's `libcurl-4.dll`), and uv's managed
   Python lives in `C:\Dev\.uv` because the Claude desktop app virtualises `AppData`.

## Export

| File | Bytes |
|---|---|
| `models/trained-v3-gguf/travel-advisor-qwen3.5-0.8b-v3-Q8_0.gguf` | 811,843,424 |
| `models/trained-v3-gguf/travel-advisor-qwen3.5-0.8b-v3-bf16.gguf` | 1,516,744,544 |

## Eval (unscored)

llama.cpp b11786 (`win-cuda-12.4-x64` build, CUDA runtime DLLs from the venv's torch), exactly as in the brief:

```
llama-server -m <gguf> -ngl 99 -c 16384 -np 2 --jinja --port 8091
uv run python -I -m travel.evaluate http://127.0.0.1:8091 <out.json> --system-file prompts/runtime_system_prompt.txt --deploy-sampling
```

| File | GGUF | Answers | Ended with a tool call | Empty / `<think>` leaks | Median reply on GPU |
|---|---|---|---|---|---|
| `eval/results/v3_cuda_deploy.json` | Q8_0 (the official v3) | 30 | 14 | 0 / 0 | 0.6 s |
| `eval/results/v3_cuda_bf16_deploy.json` | bf16 (exact trained weights) | 30 | 10 | 0 / 0 | 0.9 s |

Each scenario is one sample at the deployed temperature (0.7). Q8_0 and bf16 differ in their tool-call choice on 6 of 30
scenarios (S4, S8, S10, S22, S28, S29); with one sample each, that is sampling as much as precision. The Q8_0 file is the
one to compare with `v2_deploy.json`; the bf16 file shows whether Q8_0 costs anything.

## CPU speed

No GPU, 8 threads (the `scripts/serve.sh` "cpu" setting), same llama.cpp b11786 build with its CUDA backend not loaded,
laptop on mains power. `llama-bench -t 8 -p 1024 -n 128 -r 3`:

| GGUF | Prompt (pp1024) | Generation (tg128) |
|---|---|---|
| v3 Q8_0 | 137 ± 12 tok/s | 25.5 ± 4.2 tok/s |
| v3 bf16 | 162 ± 6 tok/s | 13.6 ± 0.6 tok/s |
| v2 Q8_0 | 157 ± 4 tok/s | 23.2 ± 1.2 tok/s |

The 30 scenarios served on CPU (`llama-server -ngl 0 -t 8 -c 16384 --jinja`, `--deploy-sampling`; timing only, these
answers are not in the repo):

| GGUF | Median reply | Mean | p90 | Median generation | Whole eval |
|---|---|---|---|---|---|
| v3 Q8_0 | **4.2 s** | 4.7 s | 9.1 s | 21.7 tok/s | 141 s |
| v3 bf16 | 7.5 s | 8.3 s | 14.0 s | 13.0 tok/s | 249 s |
| v2 Q8_0 | 4.9 s | 5.5 s | 10.5 s | 21.6 tok/s | 165 s |

v3 Q8_0 and v2 Q8_0 generate at the same speed; v3's shorter replies come from shorter answers (mean 76 vs 92 generated
tokens). bf16 generates at about 60% of Q8_0's speed on CPU, so Q8_0 stays the one to deploy unless the judge finds
bf16 clearly better.
