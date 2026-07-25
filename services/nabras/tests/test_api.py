"""End-to-end tests over the real ASGI app + real LangGraph agent.
Only the model, Pinecone and Odoo are faked."""
import pytest

from .conftest import parse_sse

RECOMMEND = [
    {"tool": "search_courses", "args": {"query": "power bi data analysis"}},
    {"text": "أنصحك تبدأ بكورس Power BI Data Analysis — عملي ومناسب لمستواك."},
]


async def _token(client) -> str:
    r = await client.post("/api/v1/user/guest-session/create/")
    assert r.status_code == 200
    return r.json()["data"]["guest_token"]


async def _chat(client, token, message, session="s1", **extra):
    body = {"message": message, "fahem_session_id": session,
            "language": "auto", **extra}
    r = await client.post("/api/v1/ai-chat/chat/", json=body,
                          headers={"X-Guest-Token": token})
    return r


# ---------------------------------------------------------------- streaming
async def test_streams_tokens_then_cards_then_done(client_factory):
    client, _ = client_factory(RECOMMEND)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز اتعلم تحليل بيانات")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        events = parse_sse(r.text)

    kinds = [e["type"] for e in events]
    assert kinds.count("token") > 1, "must stream multiple token events"
    assert kinds[-1] == "done"
    assert "cards" in kinds
    assert kinds.index("cards") > kinds.index("token")

    text = "".join(e["content"] for e in events if e["type"] == "token")
    assert "Power BI" in text

    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    assert len(cards) == 3
    assert cards[0]["title"] == "Power BI Data Analysis"
    assert cards[0]["url"].startswith("https://engosoft.com/courses/")
    assert cards[0]["price_display"] == "$120"


# ------------------------------------------------------------------ selling
async def test_checkout_link_is_attached_to_the_card(client_factory):
    script = [
        {"tool": "search_courses", "args": {"query": "power bi"}},
        {"tool": "get_course_live", "args": {"course_id": 101}},
        {"tool": "build_checkout_link", "args": {"course_id": 101}},
        {"text": "السعر الحالي $120. اضغط على زر الشراء في الكارت لإتمام الدفع."},
    ]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز اشتري الكورس ده")
        events = parse_sse(r.text)

    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    target = next(c for c in cards if c["course_id"] == 101)
    assert target["checkout_url"] == (
        "https://engosoft.com/shop/cart/update?product_id=9101&add_qty=1&express=1")
    # cards the user did not pick must NOT carry a checkout link
    assert all(c["checkout_url"] is None for c in cards if c["course_id"] != 101)


async def test_close_only_turn_still_emits_a_buyable_card(client_factory):
    """Regression: closing turns skip search_courses, so there was no card to
    hang the checkout CTA on and the widget rendered no buy button."""
    script = [
        {"tool": "build_checkout_link", "args": {"course_id": 101}},
        {"text": "اضغط زر الشراء وهيوديك على الدفع."},
    ]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز أشتري Power BI")
        events = parse_sse(r.text)

    assert "cards" in [e["type"] for e in events], "close turn must emit a card"
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    assert len(cards) == 1
    assert cards[0]["course_id"] == 101
    assert cards[0]["title"] == "Power BI Data Analysis"
    assert cards[0]["url"] == "https://engosoft.com/courses/power-bi-data-analysis"
    assert cards[0]["checkout_url"].endswith("product_id=9101&add_qty=1&express=1")


async def test_lead_is_created_and_assigned_to_the_advisor(client_factory, fake_odoo):
    script = [
        {"tool": "create_lead", "args": {"name": "أحمد", "phone": "01000000000",
                                         "course_interest": "PMP"}},
        {"text": "تمام يا أحمد، مستشار المبيعات هيكلمك."},
    ]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "عايز حد يكلمني")

    assert len(fake_odoo.leads) == 1
    lead = fake_odoo.leads[0]
    assert lead["user_id"] == 2                 # Majid
    assert lead["phone"] == "01000000000"
    assert lead["type"] == "lead"


async def test_lead_without_contact_is_refused(client_factory, fake_odoo):
    script = [
        {"tool": "create_lead", "args": {"name": "أحمد"}},   # no phone/email
        {"text": "ممكن رقم موبايلك أو إيميلك؟"},
    ]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "كلمني")
    assert fake_odoo.leads == []


# ------------------------------------------------------------------- memory
async def test_memory_persists_across_turns(client_factory):
    script = RECOMMEND + [{"text": "أرخص واحد فيهم هو Power BI بـ $120."}]
    client, model = client_factory(script)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "رشحلي كورس داتا", session="mem1")
        await _chat(client, tok, "أنهي واحد أرخص؟", session="mem1")

        h = await client.get("/api/v1/ai-chat/history/mem1/",
                             headers={"X-Guest-Token": tok})
    assert h.status_code == 200
    roles = [m["role"] for m in h.json()["data"]]
    assert roles.count("human") == 2, roles
    # second turn must see the first turn's messages in its prompt
    last_prompt = model.calls[-1]
    assert sum(1 for m in last_prompt if m.type == "human") == 2


async def test_sessions_are_isolated(client_factory):
    client, _ = client_factory(RECOMMEND * 2)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "كورس داتا", session="a")
        h = await client.get("/api/v1/ai-chat/history/b/",
                             headers={"X-Guest-Token": tok})
    assert h.json()["data"] == []


# --------------------------------------------------------------------- auth
async def test_chat_requires_a_token(client_factory):
    client, _ = client_factory(RECOMMEND)
    async with client:
        r = await client.post("/api/v1/ai-chat/chat/",
                              json={"message": "hi", "fahem_session_id": "x"})
    assert r.status_code == 401


async def test_forged_token_is_rejected(client_factory):
    import jwt
    client, _ = client_factory(RECOMMEND)
    bad = jwt.encode({"sub": "guest_hacker"}, "wrong-secret", algorithm="HS256")
    async with client:
        r = await _chat(client, bad, "hi")
    assert r.status_code == 401


async def test_chat_rate_limit_kicks_in(client_factory, monkeypatch):
    from app import main as main_mod
    monkeypatch.setattr(main_mod.s, "guest_rate_per_min", 3)
    client, _ = client_factory(RECOMMEND * 10)
    async with client:
        tok = await _token(client)
        codes = [(await _chat(client, tok, "hi", session=f"rl{i}")).status_code
                 for i in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert 429 in codes[3:]


async def test_guest_mint_is_rate_limited(client_factory, monkeypatch):
    from app import main as main_mod
    monkeypatch.setattr(main_mod.s, "guest_mint_per_hour", 2)
    client, _ = client_factory([])
    async with client:
        codes = [(await client.post("/api/v1/user/guest-session/create/")).status_code
                 for _ in range(4)]
    assert codes == [200, 200, 429, 429]


# ------------------------------------------------------- page context / input
async def test_page_context_reaches_the_model(client_factory):
    client, model = client_factory(RECOMMEND)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "الكورس ده مناسب ليا؟",
                    page_type="courseDetail", slug="pmp-exam-prep")
    human = [m for m in model.calls[0] if m.type == "human"][0]
    assert "page=courseDetail" in human.content
    assert "slug=pmp-exam-prep" in human.content


@pytest.mark.parametrize("body", [
    {"message": "", "fahem_session_id": "s"},          # empty message
    {"fahem_session_id": "s"},                          # missing message
    {"message": "hi"},                                  # missing session
])
async def test_bad_payloads_are_422(client_factory, body):
    client, _ = client_factory(RECOMMEND)
    async with client:
        tok = await _token(client)
        r = await client.post("/api/v1/ai-chat/chat/", json=body,
                              headers={"X-Guest-Token": tok})
    assert r.status_code == 422


# ---------------------------------------------------------------- resilience
async def test_pinecone_outage_degrades_gracefully(client_factory, fake_index):
    fake_index.fail = True
    script = [
        {"tool": "search_courses", "args": {"query": "power bi"}},
        {"text": "معلش، البحث مش متاح دلوقتي. تحب أوصّلك بمستشار؟"},
    ]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "رشحلي كورس")
        events = parse_sse(r.text)
    assert r.status_code == 200
    assert [e["type"] for e in events][-1] == "done"
    assert "cards" not in [e["type"] for e in events]   # no fabricated cards


async def test_odoo_outage_does_not_break_the_stream(client_factory, fake_odoo):
    fake_odoo.fail = True
    script = [
        {"tool": "build_checkout_link", "args": {"course_id": 101}},
        {"text": "في مشكلة مؤقتة في الدفع، جرّب كمان شوية."},
    ]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز ادفع")
        events = parse_sse(r.text)
    assert [e["type"] for e in events][-1] == "done"


async def test_health(client_factory):
    client, _ = client_factory([])
    async with client:
        r = await client.get("/health")
    assert r.json()["status"] == "ok"
