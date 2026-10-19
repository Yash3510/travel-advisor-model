"""LoRA fine-tune of Qwen3.5-0.8B on the pre-tokenised travel data.
Supports Apple Silicon MPS (Metal), CUDA, and CPU.

usage: python train/train_lora.py <out_dir> [--max-steps N] [--epochs 2] [--lr 2e-4]
Writes <out_dir>/lora (adapter), <out_dir>/merged (16-bit merged model for GGUF export) and <out_dir>/log.jsonl.
"""
import json
import pathlib
import sys

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainerCallback,
    TrainingArguments,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE_MODEL_PATH = ROOT / "models/base-Qwen3.5-0.8B-hf-weights"
TOKENIZER_PATH = ROOT / "models/trained-v2-merged"
MAX_LEN = 4096


def arg(name, default, cast=str):
    return cast(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def load(path, max_len=MAX_LEN):
    rows = [r for r in (json.loads(l) for l in open(path, encoding="utf-8")) if len(r["input_ids"]) <= max_len]
    return Dataset.from_list([{"input_ids": r["input_ids"], "labels": r["labels"], "attention_mask": [1] * len(r["input_ids"])}
                              for r in rows])


class FreeCache(TrainerCallback):
    """Release cached accelerator memory after each step."""

    def on_step_end(self, args, state, control, **kw):
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()


class JsonLog(TrainerCallback):
    def __init__(self, path):
        self.path = path

    def on_log(self, args, state, control, logs=None, **kw):
        logs = logs or {}
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"step": state.global_step, **logs}) + "\n")
        loss = logs.get("loss")
        lr = logs.get("learning_rate")
        loss_str = f"{loss:.4f}" if isinstance(loss, (int, float)) else "N/A"
        lr_str = f"{lr:.2e}" if isinstance(lr, (int, float)) else "N/A"
        print(f"step {state.global_step}: loss={loss_str}, lr={lr_str}", flush=True)


def main():
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    max_steps = arg("--max-steps", -1, int)
    epochs = arg("--epochs", 2.0, float)
    lr = arg("--lr", 2e-4, float)
    bs = arg("--bs", 1, int)
    max_len = arg("--max-len", MAX_LEN, int)

    use_mps = torch.backends.mps.is_available()
    use_cuda = torch.cuda.is_available()
    device_desc = "Apple Silicon MPS (Metal)" if use_mps else ("CUDA GPU" if use_cuda else "CPU")
    print(f"Training on: {device_desc}", flush=True)

    model_source = str(BASE_MODEL_PATH) if BASE_MODEL_PATH.exists() else "unsloth/Qwen3.5-0.8B"
    tok_source = str(TOKENIZER_PATH) if TOKENIZER_PATH.exists() else model_source

    print(f"Loading tokenizer from {tok_source}...", flush=True)
    tok = AutoTokenizer.from_pretrained(tok_source, fix_mistral_regex=True)

    print(f"Loading base model from {model_source}...", flush=True)
    dtype = torch.bfloat16 if (use_mps or use_cuda) else torch.float32
    model = AutoModelForCausalLM.from_pretrained(model_source, dtype=dtype)

    torch.manual_seed(3407)
    peft_config = LoraConfig(
        r=16,
        lora_alpha=16,
        lora_dropout=0.0,
        bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        task_type="CAUSAL_LM",
    )
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()
    model = get_peft_model(model, peft_config)
    model.print_trainable_parameters()

    train, val = load(ROOT / "data/train/train.jsonl", max_len), load(ROOT / "data/train/val.jsonl", max_len)
    print(f"train {len(train)} samples, val {len(val)} samples", flush=True)

    text_tok = getattr(tok, "tokenizer", tok)
    collator = DataCollatorForSeq2Seq(text_tok, padding=True, label_pad_token_id=-100, pad_to_multiple_of=arg("--pad", 128, int))

    accum_steps = arg("--grad-accum", max(1, 16 // bs), int)
    optim_type = "adamw_8bit" if use_cuda else "adamw_torch"

    warmup_steps = int(max_steps * 0.03) if max_steps > 0 else 10
    args = TrainingArguments(
        output_dir=str(out / "checkpoints"),
        per_device_train_batch_size=bs,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=accum_steps,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        num_train_epochs=epochs,
        max_steps=max_steps,
        learning_rate=lr,
        lr_scheduler_type="cosine",
        warmup_steps=warmup_steps,
        weight_decay=0.01,
        optim=optim_type,
        bf16=(use_mps or use_cuda),
        logging_steps=1,
        eval_strategy="no",
        save_strategy="steps",
        save_steps=100,
        save_total_limit=2,
        report_to="none",
        seed=3407,
        dataloader_num_workers=0,
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train,
        eval_dataset=val,
        data_collator=collator,
        callbacks=[JsonLog(out / "log.jsonl"), FreeCache()],
    )

    trainer.train()

    print("Saving LoRA adapter...", flush=True)
    model.save_pretrained(str(out / "lora"))
    tok.save_pretrained(str(out / "lora"))

    print("Merging LoRA weights with base model for export...", flush=True)
    merged_model = model.merge_and_unload()
    merged_model.save_pretrained(str(out / "merged"))
    tok.save_pretrained(str(out / "merged"))
    print(f"Saved adapter and merged model in {out}", flush=True)


if __name__ == "__main__":
    main()
