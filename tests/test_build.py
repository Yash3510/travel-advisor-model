from travel import build_dataset, tools

OLD_PROMPT = "Old runtime prompt.\n\nDEPLOYMENT CONTEXT\nMarket: India. Currency: INR. Today's date: Friday, 1 March 2030."
SEVEN = [t for t in tools.ALL if t["function"]["name"] != "get_destination_info"]


def conv(tool_list, source="gap"):
    return {"messages": [{"role": "system", "content": OLD_PROMPT}, {"role": "user", "content": "hi"}],
            "tools": tool_list, "meta": {"source": source}}


def test_refresh_uses_current_prompt_and_keeps_the_conversation_date():
    c = build_dataset.refresh(conv(SEVEN), "New runtime prompt.")
    assert c["messages"][0]["content"].startswith("New runtime prompt.\n\nDEPLOYMENT CONTEXT")
    assert "1 March 2030" in c["messages"][0]["content"]


def test_refresh_gives_every_conversation_the_destination_guide():
    names = lambda c: [t["function"]["name"] for t in c["tools"]]
    assert names(build_dataset.refresh(conv(SEVEN), "p")) == [t["function"]["name"] for t in tools.ALL]
    no_inv = [t for t in tools.NO_INVENTORY if t["function"]["name"] != "get_destination_info"]
    assert "get_destination_info" in names(build_dataset.refresh(conv(no_inv), "p"))
    sgd = [{"type": "function", "function": {"name": "SearchHotel", "parameters": {}}}]
    assert names(build_dataset.refresh(conv(sgd, "sgd"), "p")) == ["SearchHotel", "get_destination_info"]
