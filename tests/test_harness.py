import json

from travel import harness


class FakeLLM:
    """Returns scripted model messages and records what it was sent."""

    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.seen = []

    def __call__(self, messages, tools):
        self.seen.append(messages)
        return self.outputs.pop(0)


class SpyBackend:
    def __init__(self, booking_result=None):
        self.calls = []
        self.booking_result = booking_result or {"status": "CONFIRMED", "booking_ref": "TRV-1001", "charged_inr": 24640}
        self.offers = {"H-1": {"offer_id": "H-1", "hotel": "Lotus Inn Pune", "city": "Pune", "room": "Deluxe Room",
                               "nights": 2, "guests": 2, "total_inr": 22000, "taxes_included": False, "taxes_estimate_inr": 2640,
                               "rate_rule": "NON_REFUNDABLE", "check_in": "2027-01-03", "check_out": "2027-01-05"}}

    def call(self, name, args):
        args = json.loads(args) if isinstance(args, str) else args
        self.calls.append((name, args))
        if name == "create_booking":
            return self.booking_result
        if name == "handoff_to_human":
            return {"status": "TRANSFERRED", "queue": "urgent", "expected_wait_minutes": 2}
        if name == "search_hotels":
            return {"results": [self.offers["H-1"]]}
        return {}

    def get_offer(self, offer_id):
        return self.offers.get(offer_id)


def tool_call(name, args, cid="c1"):
    return {"content": "", "tool_calls": [{"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


def make(llm, backend=None):
    return harness.Harness(llm=llm, backend=backend or SpyBackend(), system_prompt="You are a travel advisor.", today="2026-10-10")


def test_emergency_gets_fixed_112_reply_without_the_model():
    llm, backend = FakeLLM(), SpyBackend()
    reply = make(llm, backend).send("My father collapsed in the hotel lobby and is not responding!")
    assert reply.kind == "emergency" and "112" in reply.text
    assert llm.seen == []                                        # model never consulted
    assert backend.calls[0][0] == "handoff_to_human" and backend.calls[0][1]["urgency"] == "urgent"


def test_missed_flight_is_not_an_emergency():
    llm = FakeLLM({"content": "I'm sorry about the missed connection. Let me check your booking.", "tool_calls": []})
    reply = make(llm).send("I missed my connecting flight in Delhi, help me now!")
    assert reply.kind == "message" and "112" not in reply.text and llm.seen


def test_card_and_aadhaar_numbers_never_reach_the_model():
    llm = FakeLLM({"content": "Happy to suggest weekend trips from Pune.", "tool_calls": []})
    h = make(llm)
    reply = h.send("My card is 4111 1111 1111 1111 CVV 123 and Aadhaar 4821 7735 9012, suggest a weekend trip from Pune")
    sent = json.dumps(llm.seen[0])
    for secret in ["4111", "7735", "CVV 123"]:
        assert secret not in sent and secret not in json.dumps(h.messages)
    assert "removed" in reply.text.lower()


def test_model_cannot_book_on_its_own():
    backend = SpyBackend()
    llm = FakeLLM(tool_call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 22000, "customer_confirmed_terms": True}))
    reply = make(llm, backend).send("Book it and charge my card")
    assert reply.kind == "confirm_booking"
    assert not any(name == "create_booking" for name, _ in backend.calls)
    # the summary comes from the supplier data, not the model: total with taxes and the cancellation rule
    assert "₹24,640" in reply.text and "non-refundable" in reply.text.lower()
    assert reply.pending_booking["offer_id"] == "H-1"


def booked(result):
    backend = SpyBackend(result)
    llm = FakeLLM(tool_call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 22000, "customer_confirmed_terms": True}))
    h = make(llm, backend)
    h.send("Book it")
    return h.confirm_booking(), backend


def test_confirm_button_books_and_reports_status_from_the_tool():
    reply, backend = booked({"status": "CONFIRMED", "booking_ref": "TRV-1001", "charged_inr": 24640})
    assert ("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 24640, "customer_confirmed_terms": True}) in backend.calls
    assert reply.kind == "booking_result" and "TRV-1001" in reply.text and "confirmed" in reply.text.lower()


def test_pending_is_never_reported_as_confirmed():
    reply, _ = booked({"status": "PENDING_SUPPLIER_CONFIRMATION", "request_id": "REQ-8812", "payment": "AUTHORISED_NOT_CAPTURED"})
    assert "not confirmed yet" in reply.text.lower() and "REQ-8812" in reply.text


def test_failed_payment_says_not_booked():
    reply, _ = booked({"status": "FAILED", "reason": "PAYMENT_DECLINED", "charged": False})
    assert "not booked" in reply.text.lower() and "declined" in reply.text.lower()


def test_cancel_drops_the_pending_booking():
    llm = FakeLLM(tool_call("create_booking", {"offer_id": "H-1", "travelers": 2, "total_price_inr": 22000, "customer_confirmed_terms": True}))
    h = make(llm)
    h.send("Book it")
    assert h.cancel_booking().kind == "message" and h.pending is None
    assert h.confirm_booking().kind == "message"                 # nothing left to confirm


def test_tool_results_flow_back_to_the_model():
    backend = SpyBackend()
    llm = FakeLLM(tool_call("search_hotels", {"city": "Pune", "check_in": "2027-01-03", "check_out": "2027-01-05", "guests": 2}),
                  {"content": "Lotus Inn Pune is ₹22,000 plus about ₹2,640 tax, non-refundable.", "tool_calls": []})
    reply = make(llm, backend).send("Hotel in Pune 3 to 5 Jan for 2")
    assert backend.calls[0][0] == "search_hotels" and "Lotus Inn" in reply.text
    assert llm.seen[1][-1]["role"] == "tool"


def test_ordinary_messages_are_not_emergencies():
    for text in ["I booked this hotel by accident, can I change it?", "We want to see the Diwali fireworks in Jaipur",
                 "A non-smoking room please", "I missed my connecting flight and lost my bag"]:
        assert not harness.EMERGENCY.search(text), text


def test_phone_numbers_and_prices_are_not_redacted():
    text = "Call me on 98765 43210, my budget is ₹24,640 for 2 nights from 12 to 14 Dec"
    assert harness.redact(text) == (text, False)
