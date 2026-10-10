"""Conversation -> per-turn training samples for Qwen3.5.

One sample per customer turn: the conversation up to that turn is the prompt (exactly what llama.cpp sends at
inference, ending in an empty <think></think> block), and only the agent's reply to that turn is trained, with tool
results inside the reply masked out. Tool-call arguments become dicts, because the Qwen3.5 template silently drops
string arguments.
"""
import copy
import json

HEADER = "<|im_start|>assistant\n"
EMPTY_THINK = "<think>\n\n</think>\n\n"
END = "<|im_end|>"


def normalise(conv):
    conv = copy.deepcopy(conv)
    for m in conv["messages"]:
        if m.get("content") is None:
            m["content"] = ""
        for c in m.get("tool_calls") or []:
            args = c["function"]["arguments"]
            if isinstance(args, str):
                c["function"]["arguments"] = json.loads(args) if args.strip() else {}
    return conv


def _render(tok, msgs, tools, gen):
    return tok.apply_chat_template(msgs, tools=tools or None, tokenize=False, add_generation_prompt=gen, enable_thinking=False)


def _reply_spans(text, start):
    """Character spans of the agent's own words after `start`: each assistant block minus its header, through <|im_end|>."""
    spans, pos = [], start
    while pos < len(text):
        end = text.find(END, pos)
        if end < 0:
            break
        spans.append((pos, end + len(END)))
        nxt = text.find(HEADER, end)
        if nxt < 0:
            break
        pos = nxt + len(HEADER)
        if text.startswith(EMPTY_THINK, pos):
            pos += len(EMPTY_THINK)
    return spans


def reply_segments(conv):
    """(turn number, messages of the agent's reply to that customer turn) for every customer turn."""
    msgs = conv["messages"]
    user_idx = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    return [(n, msgs[ui + 1:(user_idx[n + 1] if n + 1 < len(user_idx) else len(msgs))]) for n, ui in enumerate(user_idx)]


def encode(tok, conv, max_len, turns=None):
    """Samples for every customer turn, or only for the turn numbers in `turns`."""
    conv = normalise(conv)
    msgs, tools = conv["messages"], conv.get("tools")
    user_idx = [i for i, m in enumerate(msgs) if m["role"] == "user"]
    samples = []
    for n, ui in enumerate(user_idx):
        if turns is not None and n not in turns:
            continue
        end = user_idx[n + 1] if n + 1 < len(user_idx) else len(msgs)
        if not any(m["role"] == "assistant" for m in msgs[ui + 1:end]):
            continue
        prompt = _render(tok, msgs[:ui + 1], tools, gen=True)
        full = _render(tok, msgs[:end], tools, gen=False)
        if not full.startswith(prompt):
            raise ValueError("template is not prefix-stable for this conversation")
        enc = tok(full, add_special_tokens=False, return_offsets_mapping=True)
        if len(enc["input_ids"]) > max_len:
            continue
        spans = _reply_spans(full, len(prompt))
        labels = [tid if any(s <= a and b <= e for s, e in spans) and b > a else -100
                  for tid, (a, b) in zip(enc["input_ids"], enc["offset_mapping"])]
        samples.append({"input_ids": enc["input_ids"], "labels": labels})
    return samples
