"""LoRA fine-tune of Qwen3.5-0.8B on the pre-tokenised travel data. Runs in Unsloth Studio's Python (GPU).

usage: <studio python> train/train_lora.py <out_dir> [--max-steps N] [--epochs 2] [--lr 2e-4]
Writes <out_dir>/lora (adapter), <out_dir>/merged (16-bit merged model for GGUF export) and <out_dir>/log.jsonl.
"""
import json
import pathlib
import sys

from unsloth import FastLanguageModel  # must be imported before transformers

import torch
from datasets import Dataset
from transformers import DataCollatorForSeq2Seq, Trainer, TrainerCallback, TrainingArguments

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE_MODEL = "unsloth/Qwen3.5-0.8B"
MAX_LEN = 4096


def arg(name, default, cast=str):
    return cast(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def load(path):
    rows = [json.loads(l) for l in open(path, encoding="utf-8")]
    return Dataset.from_list([{"input_ids": r["input_ids"], "labels": r["labels"], "attention_mask": [1] * len(r["input_ids"])}
                              for r in rows])


class JsonLog(TrainerCallback):
    def __init__(self, path):
        self.path = path

    def on_log(self, args, state, control, logs=None, **kw):
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"step": state.global_step, **(logs or {})}) + "\n")
        print(f"step {state.global_step}: {logs}", flush=True)


def main():
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    max_steps, epochs, lr = arg("--max-steps", -1, int), arg("--epochs", 2.0, float), arg("--lr", 2e-4, float)

    model, tok = FastLanguageModel.from_pretrained(BASE_MODEL, max_seq_length=MAX_LEN, load_in_4bit=False,
                                                   load_in_16bit=True, full_finetuning=False)
    model = FastLanguageModel.get_peft_model(
        model, r=16, lora_alpha=16, lora_dropout=0, bias="none", random_state=3407, use_gradient_checkpointing=(True if arg("--gc", "unsloth") == "true" else arg("--gc", "unsloth")),
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])

    train, val = load(ROOT / "data/train/train.jsonl"), load(ROOT / "data/train/val.jsonl")
    print(f"train {len(train)} samples, val {len(val)} samples", flush=True)
    text_tok = getattr(tok, "tokenizer", tok)        # Qwen3.5 loads as a multimodal processor; padding needs its tokenizer
    collator = DataCollatorForSeq2Seq(text_tok, padding=True, label_pad_token_id=-100, pad_to_multiple_of=arg("--pad", 512, int))   # few distinct shapes = few kernel re-tunes
    args = TrainingArguments(
        output_dir=str(out / "checkpoints"), per_device_train_batch_size=arg("--bs", 1, int), per_device_eval_batch_size=1, train_sampling_strategy="group_by_length",
        gradient_accumulation_steps=16 // arg("--bs", 1, int), num_train_epochs=epochs, max_steps=max_steps, learning_rate=lr,
        lr_scheduler_type="cosine", warmup_ratio=0.03, weight_decay=0.01, optim="adamw_8bit", bf16=True,
        logging_steps=1, eval_strategy="no",   # full-vocab eval logits do not fit in 6 GB; the 30-scenario eval is the real test
        save_strategy="steps", save_steps=100, save_total_limit=2, report_to="none", seed=3407,
        dataloader_num_workers=0, remove_unused_columns=False)
    trainer = Trainer(model=model, args=args, train_dataset=train, eval_dataset=val, data_collator=collator,
                      callbacks=[JsonLog(out / "log.jsonl")])
    torch.cuda.reset_peak_memory_stats()
    trainer.train()
    print(f"peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB", flush=True)

    model.save_pretrained(str(out / "lora"))
    tok.save_pretrained(str(out / "lora"))
    model.save_pretrained_merged(str(out / "merged"), tok, save_method="merged_16bit")
    print(f"saved adapter and merged model in {out}", flush=True)


if __name__ == "__main__":
    main()
