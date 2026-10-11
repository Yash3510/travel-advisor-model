from travel import kb

PAGE = """Leh is the capital of Ladakh. It is a small town in the Indus valley.

== Understand ==
Leh sits at 3,500 m.
=== Climate ===
The best time to visit is June to September. Roads over the passes close in winter, usually from November. (updated Jun 2024)

== Get in ==
=== By plane ===
Kushok Bakula Rimpochee Airport has daily flights from Delhi. A taxi to town costs ₹500.
=== By train ===
There is no railway to Leh; the nearest station is Jammu Tawi.
=== By bus ===
Buses run from Manali over two days.

== See ==
Monasteries everywhere in June.

== Stay safe ==
Foreigners need a Protected Area Permit for Nubra. Acclimatise for two days.
"""


def test_relevant_text_keeps_only_the_useful_sections():
    text = kb.relevant_text(PAGE)
    assert "June to September" in text and "Jammu Tawi" in text and "Protected Area Permit" in text
    assert "Monasteries everywhere" not in text


def test_snippets_are_verbatim_and_classified():
    s = kb.snippets(PAGE)
    assert s["summary"] == "Leh is the capital of Ladakh."
    assert "The best time to visit is June to September." in s["climate"]
    assert any("close in winter" in c for c in s["closures"])
    assert any("Kushok Bakula" in a for a in s["getting_there"]["air"])
    assert any("no railway to Leh" in r for r in s["getting_there"]["rail"])
    assert any("Buses run from Manali" in r for r in s["getting_there"]["road"])
    assert any("Protected Area Permit" in p for p in s["permits"])


def test_snippets_drop_prices_and_update_stamps():
    blob = str(kb.snippets(PAGE))
    assert "₹500" not in blob and "updated" not in blob


def test_lookup_handles_aliases_and_case():
    entries = {"leh": {"destination": "Leh"}, "port blair": {"destination": "Port Blair"}}
    assert kb.lookup(entries, "Ladakh")["destination"] == "Leh"
    assert kb.lookup(entries, "  LEH, Ladakh ")["destination"] == "Leh"
    assert kb.lookup(entries, "Andaman Islands")["destination"] == "Port Blair"
    assert kb.lookup(entries, "Crystal Sky Bridge") is None


def test_fake_attraction_near_a_real_town_is_not_found():
    entries = {"bundi": {"destination": "Bundi"}}
    assert kb.lookup(entries, "Floating Glass Temple") is None
    assert kb.lookup(entries, "Floating Glass Temple near Bundi") is None
    assert kb.lookup(entries, "Bundi")["destination"] == "Bundi"


def test_month_ranges_wrap_around_the_year():
    assert kb.months_in("Best from October to March; avoid the monsoon (Jun-Sep).") >= {
        "October", "November", "December", "January", "February", "March", "June", "July", "August", "September"}
    assert "May" not in kb.months_in("Best from October to March.")
