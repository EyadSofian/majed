"""End-to-end tests over the real ASGI app + real LangGraph agent + real
catalogue logic. Only the model and Odoo are faked."""
import pytest

from app import catalog as catalog_mod

from .conftest import parse_sse


async def _token(client) -> str:
    r = await client.post("/api/v1/user/guest-session/create/")
    assert r.status_code == 200
    return r.json()["data"]["guest_token"]


async def _chat(client, token, message, session="s1", **extra):
    body = {"message": message, "fahem_session_id": session,
            "language": "auto", **extra}
    return await client.post("/api/v1/ai-chat/chat/", json=body,
                             headers={"X-Guest-Token": token})


RECOMMEND = [
    {"tool": "search_courses", "args": {"query": "PMP project management"}},
    {"text": "أنصحك بـ PMP Preparation Course — الأنسب لهدفك."},
]


# ============================================================== catalogue
async def test_catalogue_loads_courses_categories_and_instructors(loaded_catalog):
    snap = loaded_catalog
    assert len(snap.courses) == 3
    pmp = snap.courses[2092]
    assert pmp.categories == ["Management and Safety"]
    assert pmp.delivery == "حضوري + تسجيل"
    assert pmp.duration_text == "36 Accredited Training Hours"
    # instructors resolved from hr.employee, not parsed out of names
    assert {snap.instructors[i]["name"] for i in pmp.instructor_ids} == {
        "Dr.Ayman Atef Ali Fawzi", "Eng.Mohamed Hamdy"}


async def test_product_urls_are_absolute_and_images_derived(loaded_catalog):
    c = loaded_catalog.courses[2092]
    # product.template.website_url is relative -> must gain the host exactly once
    assert c.url == "https://engosoft.com/shop/pmp-preparation-course-8th-edition-2092"
    assert c.url.count("https://") == 1
    assert c.image_url == "https://engosoft.com/web/image/product.template/2092/image_1920"


async def test_channel_join_brings_learning_side_facts(loaded_catalog):
    pmp = loaded_catalog.courses[2092]
    assert pmp.channel_id == 209        # via slide.channel.product_id -> variant -> template
    assert pmp.total_slides == 8
    assert pmp.members == 132
    assert pmp.rating == 5.0


async def test_search_ranks_title_matches_first(loaded_catalog):
    hits = catalog_mod.search("navisworks", top_k=3)
    assert hits[0].id == 2107


async def test_search_filters_by_delivery_and_category(loaded_catalog):
    assert [c.id for c in catalog_mod.search("", delivery="recorded")] == [2107]
    ids = {c.id for c in catalog_mod.search("", category="BIM")}
    assert ids == {2107, 2116}


async def test_delta_refresh_skips_untouched_rows(fake_odoo):
    await catalog_mod.refresh(full=True)
    calls_before = len(fake_odoo.price_calls)
    await catalog_mod.refresh(full=False)     # nothing edited since
    assert len(catalog_mod.snapshot().courses) == 3
    assert len(fake_odoo.price_calls) == calls_before   # no price work on refresh


# ================================================================== prices
async def test_price_comes_from_pricelist_not_list_price(loaded_catalog, fake_odoo):
    prices = await fake_odoo.fetch_prices([2092], "EGP")
    assert prices[2092]["price"] == 6900          # list_price on the row is 0.0
    assert loaded_catalog.courses[2092].id == 2092


@pytest.mark.parametrize("currency,expected", [
    ("EGP", "6,900 EGP"), ("USD", "180 USD"),
    ("SAR", "690 SAR"), ("AED", "690 AED"),
])
async def test_price_is_quoted_in_the_visitor_currency(client_factory, currency, expected):
    script = [{"tool": "get_price", "args": {"course_id": 2092}},
              {"text": "ده السعر."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "بكام؟", currency=currency)
        events = parse_sse(r.text)
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    assert cards[0]["price_display"] == expected
    assert cards[0]["currency"] == currency


async def test_placeholder_prices_are_never_shown(client_factory, monkeypatch):
    """Odoo carries 0 and 1 as placeholders; neither is a real price."""
    from app import tools as tools_mod
    assert tools_mod._fmt_price(0, "EGP") is None
    assert tools_mod._fmt_price(1, "EGP") is None
    assert tools_mod._fmt_price(6900, "EGP") == "6,900 EGP"


# ================================================================= batches
async def test_closed_registration_batches_are_never_offered(client_factory):
    script = [{"tool": "get_upcoming_batches", "args": {"course_id": 2092}},
              {"text": "دي المواعيد المتاحة."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "امتى الدفعة الجاية؟")
        assert r.status_code == 200
    snap = catalog_mod.snapshot()
    open_ids = {e["id"] for e in snap.events_by_course[2092] if e["registration_open"]}
    assert open_ids == {1400}          # 1401 is published but closed


async def test_card_carries_next_batch_and_real_seat_count(client_factory):
    script = [{"tool": "search_courses", "args": {"query": "navisworks"}},
              {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "navisworks")
        events = parse_sse(r.text)
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    nav = next(c for c in cards if c["course_id"] == 2107)
    assert nav["next_batch"]["seats_available"] == 3
    assert nav["next_batch"]["location"] == "Engosoft - KSA"
    assert nav["next_batch"]["timezone"] == "Asia/Riyadh"


# =================================================================== cards
async def test_streams_tokens_then_cards_then_done(client_factory):
    client, _ = client_factory(RECOMMEND)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز شهادة إدارة مشاريع")
        assert r.headers["content-type"].startswith("text/event-stream")
        events = parse_sse(r.text)
    kinds = [e["type"] for e in events]
    assert kinds.count("token") > 1
    assert kinds[-1] == "done"
    assert kinds.index("cards") > kinds.index("token")
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    pmp = next(c for c in cards if c["course_id"] == 2092)
    assert pmp["delivery"] == "حضوري + تسجيل"
    assert [i["name"] for i in pmp["instructors"]]


async def test_close_only_turn_still_emits_a_buyable_card(client_factory):
    """A closing turn skips search_courses, so there would be no card to hang
    the checkout CTA on and the widget would render no buy button."""
    script = [{"tool": "build_checkout_link", "args": {"course_id": 2092}},
              {"text": "اضغط زر الشراء."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز اشتري PMP")
        events = parse_sse(r.text)
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    assert len(cards) == 1
    assert cards[0]["course_id"] == 2092
    assert cards[0]["checkout_url"].endswith("product_id=2046&add_qty=1&express=1")


async def test_checkout_only_attaches_to_the_chosen_course(client_factory):
    script = [{"tool": "search_courses", "args": {"query": "PMP"}},
              {"tool": "build_checkout_link", "args": {"course_id": 2092}},
              {"text": "تمام."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز PMP")
        events = parse_sse(r.text)
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    assert next(c for c in cards if c["course_id"] == 2092)["checkout_url"]
    assert all(c["checkout_url"] is None for c in cards if c["course_id"] != 2092)


# ================================================================ packages
async def test_package_quotes_the_live_group_price_not_final_price(client_factory):
    """The Interior Design track carries final_price 12,001 while its sellable
    July group costs 31,440. Quoting final_price understates a live cohort ~2.6x
    (up to ~6x for the onsite groups), so the group price must win."""
    script = [{"tool": "search_packages", "args": {"query": "interior"}},
              {"text": "في مسار كامل."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مسار تصميم داخلي")
        events = parse_sse(r.text)
    pkgs = next(e for e in events if e["type"] == "packages")["package_cards"]
    idp = next(p for p in pkgs if p["package_id"] == 5)
    assert idp["price_display"] == "31,440 EGP"
    assert idp["price_basis"] == "group_online"
    assert idp["next_group"] == "Group July 2026 (Zyad Mohamed - 5600)"
    # the "was" price only applies to the recorded basis, so not shown here
    assert idp["list_price_display"] is None
    assert idp["discount"] is None


async def test_started_groups_are_never_priced_or_offered(client_factory):
    """Group 34 starts sooner but is already running (is_available_for_sale
    false); selling a seat in it would be selling a course that began."""
    script = [{"tool": "search_packages", "args": {"query": "interior"}},
              {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مسار تصميم داخلي")
        events = parse_sse(r.text)
    idp = next(p for p in next(e for e in events if e["type"] == "packages")
               ["package_cards"] if p["package_id"] == 5)
    assert "Amal Oraby" not in (idp["next_group"] or "")
    assert idp["starts_at"].startswith("2026-07-26")


async def test_recorded_package_uses_final_price(client_factory):
    """No live groups -> final_price IS what the customer pays."""
    script = [{"tool": "search_packages", "args": {"query": "infrastructure"}},
              {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مسار البنية التحتية")
        events = parse_sse(r.text)
    pkg = next(e for e in events if e["type"] == "packages")["package_cards"][0]
    assert pkg["package_id"] == 15
    assert pkg["price_display"] == "15,000 EGP"
    assert pkg["price_basis"] == "recorded"
    assert pkg["next_group"] is None


async def test_package_card_carries_levels_contents_and_attendance(client_factory):
    script = [{"tool": "search_packages", "args": {"query": "interior"}},
              {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مسار تصميم داخلي")
        events = parse_sse(r.text)
    idp = next(p for p in next(e for e in events if e["type"] == "packages")
               ["package_cards"] if p["package_id"] == 5)
    assert idp["levels"] == ["Level 1", "Level 2"]
    assert "Interior Design Basics Using SketchUp" in idp["includes"]
    assert idp["attendance"] == "أونلاين أو حضوري"
    assert idp["courses_count"] == 6          # num_courses_display wins
    assert idp["training_hours"] == 161       # 123 attendee + 38 recorded
    assert idp["url"].startswith("https://engosoft.com/training_package/")


async def test_missing_package_permission_degrades_quietly(client_factory, fake_odoo):
    """Until the bot's Odoo user gets eLearning/Manager + Operation Group the
    package models raise AccessError. The chat must still work."""
    fake_odoo.packages_denied = True
    await catalog_mod.refresh(full=True)
    script = [{"tool": "search_packages", "args": {"query": "interior"}},
              {"text": "أقدر أرشحلك كورسات مفردة."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مسار تصميم داخلي")
        events = parse_sse(r.text)
    assert [e["type"] for e in events][-1] == "done"
    assert "packages" not in [e["type"] for e in events]


# ================================================================= handoff
async def test_handoff_is_signalled_not_written_to_chatwoot(client_factory):
    """The bridge owns Chatwoot state; Nabras must only raise a signal."""
    script = [{"tool": "request_handoff",
               "args": {"summary": "عميل عايز يكلم مبيعات", "reason": "customer_request"}},
              {"text": "هوصلك بزميل."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز اكلم حد")
        events = parse_sse(r.text)
    h = next(e for e in events if e["type"] == "handoff")
    assert h["requested"] is True
    assert h["reason"] == "customer_request"


async def test_lead_goes_to_the_sales_advisor(client_factory, fake_odoo):
    script = [{"tool": "create_lead",
               "args": {"name": "أحمد", "phone": "01000000000",
                        "course_interest": "PMP"}},
              {"text": "تمام يا أحمد."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "كلموني")
    assert len(fake_odoo.leads) == 1
    assert fake_odoo.leads[0]["user_id"] == 2
    assert fake_odoo.leads[0]["phone"] == "01000000000"


async def test_lead_without_contact_is_refused(client_factory, fake_odoo):
    script = [{"tool": "create_lead", "args": {"name": "أحمد"}},
              {"text": "ممكن رقمك؟"}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "كلموني")
    assert fake_odoo.leads == []


# ================================================================== memory
async def test_memory_persists_across_turns(client_factory):
    client, model = client_factory(RECOMMEND + [{"text": "أرخصهم Navisworks."}])
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "رشحلي كورس", session="mem1")
        await _chat(client, tok, "أنهي أرخص؟", session="mem1")
        h = await client.get("/api/v1/ai-chat/history/mem1/",
                             headers={"X-Guest-Token": tok})
    assert [m["role"] for m in h.json()["data"]].count("human") == 2
    assert sum(1 for m in model.calls[-1] if m.type == "human") == 2


async def test_sessions_are_isolated(client_factory):
    client, _ = client_factory(RECOMMEND * 2)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "كورس", session="a")
        h = await client.get("/api/v1/ai-chat/history/b/",
                             headers={"X-Guest-Token": tok})
    assert h.json()["data"] == []


# ==================================================================== auth
async def test_chat_requires_a_token(client_factory):
    client, _ = client_factory(RECOMMEND)
    async with client:
        r = await client.post("/api/v1/ai-chat/chat/",
                              json={"message": "hi", "fahem_session_id": "x"})
    assert r.status_code == 401


async def test_forged_token_is_rejected(client_factory):
    import jwt
    client, _ = client_factory(RECOMMEND)
    bad = jwt.encode({"sub": "guest_hacker"}, "wrong-secret-wrong-secret-32ch",
                     algorithm="HS256")
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


# ================================================== page context / payloads
async def test_page_context_reaches_the_model(client_factory):
    client, model = client_factory(RECOMMEND)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "الكورس ده مناسب؟",
                    page_type="courseDetail", slug="navisworks-mep-2107")
    human = [m for m in model.calls[0] if m.type == "human"][0]
    assert "page=courseDetail" in human.content
    assert "slug=navisworks-mep-2107" in human.content


@pytest.mark.parametrize("body", [
    {"message": "", "fahem_session_id": "s"},
    {"fahem_session_id": "s"},
    {"message": "hi"},
])
async def test_bad_payloads_are_422(client_factory, body):
    client, _ = client_factory(RECOMMEND)
    async with client:
        tok = await _token(client)
        r = await client.post("/api/v1/ai-chat/chat/", json=body,
                              headers={"X-Guest-Token": tok})
    assert r.status_code == 422


async def test_unknown_currency_falls_back_instead_of_failing(client_factory):
    script = [{"tool": "get_price", "args": {"course_id": 2092}}, {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "بكام؟", currency="XYZ")
        events = parse_sse(r.text)
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    assert cards[0]["currency"] == "EGP"


# ============================================================== resilience
async def test_odoo_outage_does_not_break_the_stream(client_factory, fake_odoo):
    fake_odoo.fail = True
    script = [{"tool": "get_price", "args": {"course_id": 2092}},
              {"text": "في مشكلة مؤقتة، جرّب كمان شوية."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "بكام؟")
        events = parse_sse(r.text)
    assert [e["type"] for e in events][-1] == "done"


async def test_health_reports_catalogue_state(client_factory, loaded_catalog):
    client, _ = client_factory([])
    async with client:
        r = await client.get("/health")
    body = r.json()
    assert body["status"] == "ok"
    assert body["courses"] == 3
    assert body["packages_available"] is True
