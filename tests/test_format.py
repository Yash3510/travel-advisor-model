import json

import pytest

from travel import format as fmt

transformers = pytest.importorskip("transformers")
TOK = transformers.AutoTokenizer.from_pretrained("unsloth/Qwen3.5-0.8B")
TOOLS = [{"type": "function", "function": {"name": "search_hotels", "description": "Hotel search",
          "parameters": {"type": "object", "properties": {"city": {"type": "string"}, "guests": {"type": "integer"}},
                         "required": ["city", "guests"]}}}]
CONV = {"tools": TOOLS, "messages": [
    {"role": "system", "content": "You are a travel advisor."},
    {"role": "user", "content": "Hotel in Pune for 2?"},
    {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function",
     "function": {"name": "search_hotels", "arguments": json.dumps({"city": "Pune", "guests": 2})}}]},
    {"role": "tool", "tool_call_id": "c1", "content": "{\"results\": [{\"hotel\": \"Lotus Inn\", \"total_inr\": 9000}]}"},
    {"role": "assistant", "content": "Lotus Inn is ₹9,000 total. Shall I book it?"},
    {"role": "user", "content": "Not yet, thanks."},
    {"role": "assistant", "content": "Sure, I'll keep it here for when you're ready."},
]}


def trained_text(sample):
    return TOK.decode([i for i, l in zip(sample["input_ids"], sample["labels"]) if l != -100])


def test_one_sample_per_customer_turn():
    samples = fmt.encode(TOK, CONV, max_len=4096)
    assert len(samples) == 2


def test_tool_call_arguments_are_rendered_as_parameters():
    first = trained_text(fmt.encode(TOK, CONV, max_len=4096)[0])
    assert "<function=search_hotels>" in first and "<parameter=city>\nPune\n</parameter>" in first


def test_only_the_reply_to_the_last_customer_turn_is_trained():
    first, second = (trained_text(s) for s in fmt.encode(TOK, CONV, max_len=4096))
    assert "Lotus Inn is ₹9,000 total" in first
    assert "<tool_response>" not in first and "<think>" not in first and "Hotel in Pune" not in first
    assert second.strip() == "Sure, I'll keep it here for when you're ready.<|im_end|>"


def test_training_prompt_matches_inference_prompt():
    sample = fmt.encode(TOK, CONV, max_len=4096)[1]
    first_label = next(k for k, l in enumerate(sample["labels"]) if l != -100)
    prompt = TOK.decode(sample["input_ids"][:first_label])
    expected = TOK.apply_chat_template(fmt.normalise(CONV)["messages"][:6], tools=TOOLS, tokenize=False,
                                       add_generation_prompt=True, enable_thinking=False)
    assert prompt == expected


def test_overlong_samples_are_dropped():
    assert fmt.encode(TOK, CONV, max_len=50) == []
