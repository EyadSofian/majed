"""End-to-end tests over the real ASGI app + real LangGraph agent + real
catalogue logic. Only the model and Odoo are faked."""
import json

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
async def test_package_returns_every_buyable_option_not_one_price(client_factory):
    """A package is a recorded track PLUS an online and an onsite figure per
    cohort — same shape as a course. Collapsing that to one number misquotes by
    multiples (12,001 recorded vs 45,475 for an onsite August cohort)."""
    script = [{"tool": "search_packages", "args": {"query": "interior"}},
              {"text": "في مسار كامل."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مسار تصميم داخلي")
        events = parse_sse(r.text)
    idp = next(p for p in next(e for e in events if e["type"] == "packages")
               ["package_cards"] if p["package_id"] == 5)
    by_mode = {}
    for o in idp["price_options"]:
        by_mode.setdefault(o["mode"], []).append(o)

    # recorded: total_price * (1 - discount) == final_price, exactly
    rec = by_mode["recorded"][0]
    assert rec["price_display"] == "12,001 EGP"
    assert rec["was_display"] == "23,750 EGP"

    # attendance is priced per cohort, per mode
    online = by_mode["attendance_online"]
    assert [o["price_display"] for o in online] == ["15,000 EGP"]
    assert online[0]["group_name"] == "Group July 2026 (Zyad Mohamed - 5600)"

    onsite = by_mode["attendance_onsite"]
    assert [o["price_display"] for o in onsite] == ["33,750 EGP"]

    # the headline is the cheapest, never a merged or averaged figure
    assert idp["price_from_display"] == "12,001 EGP"


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
    names = " ".join(str(o.get("group_name")) for o in idp["price_options"])
    assert "Amal Oraby" not in names       # group 34 is `started`, not sellable
    assert idp["starts_at"].startswith("2026-07-26")


async def test_recorded_only_package_offers_just_the_recorded_option(client_factory):
    """No live cohorts -> the recorded track is the only thing to sell."""
    script = [{"tool": "search_packages", "args": {"query": "infrastructure"}},
              {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مسار البنية التحتية")
        events = parse_sse(r.text)
    pkg = next(e for e in events if e["type"] == "packages")["package_cards"][0]
    assert pkg["package_id"] == 15
    assert [o["mode"] for o in pkg["price_options"]] == ["recorded"]
    assert pkg["price_from_display"] == "15,000 EGP"
    assert pkg["price_options"][0]["was_display"] is None   # discount is 0


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


# ============================================================ track / تخصص
async def _track(**args) -> tuple[dict, list, list]:
    """Run the tool exactly as a turn does — with the sinks the SSE layer
    installs — and hand back what the model reads plus what the widget shows."""
    from app import tools as tools_mod
    cards: list = []
    packages: list = []
    ct = tools_mod.CARD_SINK.set(cards)
    pt = tools_mod.PACKAGE_SINK.set(packages)
    cu = tools_mod.CURRENCY.set("EGP")
    try:
        raw = await tools_mod.recommend_track.ainvoke(args)
    finally:
        tools_mod.CARD_SINK.reset(ct)
        tools_mod.PACKAGE_SINK.reset(pt)
        tools_mod.CURRENCY.reset(cu)
    return json.loads(raw), cards, packages


async def test_track_lists_the_package_courses_in_teaching_order(loaded_catalog):
    """"أنا في باقة كذا" has to answer with the path itself: the track's own
    courses, level by level and priced — not a generic search."""
    payload, cards, packages = await _track(track="باقة التصميم الداخلي")

    # the track itself is shown, so the trainee sees what they are on
    assert [p["package_id"] for p in packages] == [5]
    assert payload["track"]["package_id"] == 5

    # and its courses come back as real, priced, buyable cards
    assert payload["path"][0]["level"] == "Level 2"
    nav = next(c for c in cards if c["course_id"] == 2107)
    assert nav["price_display"] == "4,815 EGP"      # live pricelist, not list_price

    # the path is the union of the recorded AND attendance line models: 2116 is
    # attendance-only, and 2107 is in both but must appear once
    ids = [c["course_id"] for c in payload["path"][0]["courses"]]
    assert ids == [2107, 2116]

    # lines that are part of the path but are not published products must be
    # named, not silently dropped — otherwise the path looks shorter than it is
    assert "Interior Design Basics Using SketchUp" in payload["not_sold_separately"]


async def test_track_level_filter_narrows_to_that_level(loaded_catalog):
    payload, cards, _ = await _track(
        track="Interior Design Professional Track", level="Level 1")
    assert payload["level_filter"] == "Level 1"
    # Level 1's only line is not a published product -> report it and recommend
    # nothing false
    assert payload["path"] == []
    assert "Interior Design Basics Using SketchUp" in payload["not_sold_separately"]
    assert [c["course_id"] for c in cards] == []


async def test_specialization_without_a_package_still_recommends(loaded_catalog):
    """"أنا في تخصص إدارة مشاريع" must work even with no matching package — and
    the Arabic word has to reach the English Odoo category."""
    payload, cards, packages = await _track(track="أنا في تخصص إدارة مشاريع")
    assert payload["track"] is None
    assert payload["specialization"] == "Management and Safety"
    assert [c["course_id"] for c in payload["courses"]] == [2092]      # PMP
    assert [c["course_id"] for c in cards] == [2092]
    assert packages == []


async def test_specialization_aliases_cover_the_words_trainees_type(loaded_catalog):
    from app.tools import resolve_specialization
    assert resolve_specialization("أنا في تخصص ميكانيكا") == "Mechanical"
    assert resolve_specialization("باقة الكهربا") == "Electrical"
    assert resolve_specialization("I'm on the BIM track") == "BIM"
    assert resolve_specialization("مسار الديكور") == "Interior Design and Decoration"
    assert resolve_specialization("عايز أتعلم طبخ") is None


async def test_track_degrades_to_courses_when_packages_are_denied(fake_odoo):
    """Package permission is still missing in production, so the feature has to
    work today from the catalogue alone."""
    fake_odoo.packages_denied = True
    await catalog_mod.refresh(full=True)
    payload, cards, packages = await _track(track="BIM")
    assert payload["track"] is None
    assert payload["note"] == "package_data_unavailable"
    assert payload["courses"]                      # still recommends something
    assert cards and packages == []


async def test_specializations_list_what_is_inside_each_field(loaded_catalog):
    from app import tools as tools_mod
    chips: list = []
    ct = tools_mod.CHIP_SINK.set(chips)
    try:
        payload = json.loads(await tools_mod.list_specializations.ainvoke({}))
    finally:
        tools_mod.CHIP_SINK.reset(ct)
    names = [s["specialization"] for s in payload["specializations"]]
    assert "BIM" in names and "Management and Safety" in names
    # a merchandising tag is not a field of engineering
    assert "Best Seller" not in names
    bim = next(s for s in payload["specializations"] if s["specialization"] == "BIM")
    assert bim["courses"] == 2 and bim["examples"]
    # the visitor picks in Arabic; the value the bot receives stays the Odoo name
    assert {"title": "BIM — نمذجة المعلومات", "value": "أنا في تخصص BIM"} in chips


async def test_specialization_chips_reach_the_widget(client_factory):
    script = [{"tool": "list_specializations", "args": {}},
              {"text": "اختار تخصصك."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "أنا مهندس، عندكم إيه؟")
        events = parse_sse(r.text)
    chips = next(e for e in events if e["type"] == "chips")["chips"]
    assert any(c["title"] == "ميكانيكا" or c["title"] == "إدارة وسلامة" for c in chips)


async def test_track_reaches_the_widget_as_cards_and_a_package(client_factory):
    """End to end: one turn, and the widget gets both the track and its
    courses."""
    script = [{"tool": "recommend_track", "args": {"track": "التصميم الداخلي"}},
              {"text": "دي خطة المسار."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "أنا في باقة التصميم الداخلي، أعمل إيه؟")
        events = parse_sse(r.text)
    assert next(e for e in events if e["type"] == "packages")[
        "package_cards"][0]["package_id"] == 5
    assert 2107 in [c["course_id"] for c in
                    next(e for e in events if e["type"] == "cards")["course_cards"]]


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


# ================================================================== ingest
async def test_ingest_installs_packages_and_survives_a_denied_odoo_read(
        client_factory, fake_odoo, monkeypatch):
    """n8n pushes what the bot's own Odoo user cannot read. A later refresh
    that gets AccessError must NOT wipe what was pushed."""
    from app import catalog as cat
    from app import main as main_mod
    from .fakes import PACKAGES
    monkeypatch.setattr(main_mod.s, "ingest_token", "secret-token")

    client, _ = client_factory([])
    async with client:
        r = await client.post("/api/v1/internal/catalog/packages",
                              json=PACKAGES,
                              headers={"X-Ingest-Token": "secret-token"})
        assert r.status_code == 200
        assert r.json()["installed"]["packages"] == 2

        fake_odoo.packages_denied = True
        await cat.refresh(full=True)          # Odoo says access denied
        h = (await client.get("/health")).json()

    assert h["packages_source"] == "ingest"
    assert h["packages_available"] is True
    assert h["packages_count"] == 2


async def test_ingest_rejects_a_bad_or_missing_token(client_factory, monkeypatch):
    from app import main as main_mod
    from .fakes import PACKAGES
    monkeypatch.setattr(main_mod.s, "ingest_token", "secret-token")
    client, _ = client_factory([])
    async with client:
        assert (await client.post("/api/v1/internal/catalog/packages",
                                  json=PACKAGES)).status_code == 401
        assert (await client.post("/api/v1/internal/catalog/packages",
                                  json=PACKAGES,
                                  headers={"X-Ingest-Token": "wrong"})).status_code == 401


async def test_ingest_is_off_until_a_token_is_configured(client_factory, monkeypatch):
    from app import main as main_mod
    from .fakes import PACKAGES
    monkeypatch.setattr(main_mod.s, "ingest_token", "")
    client, _ = client_factory([])
    async with client:
        r = await client.post("/api/v1/internal/catalog/packages", json=PACKAGES,
                              headers={"X-Ingest-Token": "anything"})
    assert r.status_code == 503


async def test_ingest_refuses_an_empty_payload(client_factory, monkeypatch):
    from app import main as main_mod
    monkeypatch.setattr(main_mod.s, "ingest_token", "secret-token")
    client, _ = client_factory([])
    async with client:
        r = await client.post("/api/v1/internal/catalog/packages",
                              json={"packages": []},
                              headers={"X-Ingest-Token": "secret-token"})
    assert r.status_code == 422


# =============================================== identity & trial safety
async def test_the_assistant_is_named_majed_to_the_visitor(client_factory):
    """The visitor meets one bot: ماجد. "نبراس" is an internal codename and must
    never appear in anything customer-facing, or the site looks like it has two
    different assistants."""
    from app import prompts
    assert prompts.BOT_NAME == "ماجد"
    assert "نبراس" not in prompts.build_system_prompt("cat|alogue")
    client, _ = client_factory([])
    async with client:
        assert (await client.get("/health")).json()["assistant"] == "ماجد"


async def test_trial_mode_does_not_write_leads_to_the_live_crm(
        client_factory, fake_odoo, monkeypatch):
    from app import main as main_mod
    monkeypatch.setattr(main_mod.s, "allow_crm_writes", False)
    script = [{"tool": "create_lead",
               "args": {"name": "أحمد", "phone": "01000000000"}},
              {"text": "تمام."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "كلموني")
        assert [e["type"] for e in parse_sse(r.text)][-1] == "done"
    assert fake_odoo.leads == []          # nothing reached the production CRM


async def test_lead_name_is_tagged_majed_not_the_codename(client_factory, fake_odoo):
    script = [{"tool": "create_lead",
               "args": {"name": "أحمد", "phone": "01000000000",
                        "course_interest": "PMP"}},
              {"text": "تمام."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "كلموني")
    assert fake_odoo.leads[0]["name"].startswith("[ماجد]")


# =========================================================== model request
def test_reasoning_effort_is_sent_only_where_it_is_legal():
    """OpenAI refuses function tools + reasoning on chat-completions for gpt-5:
    "set reasoning_effort to 'none'". Sending the same field to gpt-4.1 or the
    o-series just trades that 400 for another one, so it is family-gated."""
    from app.agent import reasoning_effort_for as eff
    assert eff("gpt-5.6-terra", "none") == "none"
    assert eff("gpt-5.6-luna", "low") == "low"
    assert eff("gpt-4.1", "none") is None          # field unknown there
    assert eff("o3", "none") is None               # no "none" level there
    assert eff("gpt-5.6-terra", "") is None        # explicit opt-out
    assert eff("gpt-5.6-terra", "  NONE ") == "none"


def test_model_kwargs_pins_the_flag_for_the_configured_model(monkeypatch):
    from app import agent as agent_mod
    from app.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "agent_model", "gpt-5.6-terra")
    monkeypatch.setattr(s, "agent_reasoning_effort", "none")
    kw = agent_mod.model_kwargs()
    assert kw["reasoning_effort"] == "none"
    assert kw["model"] == "gpt-5.6-terra"
    assert kw["streaming"] is True


class _Rejects:
    """A model that 400s on one parameter, the way OpenAI does."""

    def __init__(self, kw, bad):
        self.kw, self.bad = kw, bad

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        if self.bad in self.kw:
            err = Exception(f"400 unsupported parameter: '{self.bad}'")
            err.body = {"param": self.bad, "type": "invalid_request_error"}
            raise err
        return "ok"


async def test_boot_drops_the_parameter_openai_names_instead_of_serving_400s():
    """A model swap must not turn every customer message into silence: the
    probe finds the illegal field at boot and retries without it."""
    from app import agent as agent_mod
    built = []

    def build(kw):
        built.append(dict(kw))
        return _Rejects(kw, "temperature")

    model = await agent_mod.negotiate_model(build=build)
    assert isinstance(model, _Rejects)
    assert "temperature" in built[0]                 # first attempt as configured
    assert "temperature" not in built[-1]            # retried without it
    assert built[-1]["model"]                        # everything else intact


async def test_boot_does_not_strip_anything_for_an_unrelated_failure():
    """A quota or network error is not a request-shape problem; stripping
    sampling fields would hide it and change behaviour for no reason."""
    from app import agent as agent_mod
    built = []

    class _Down:
        def __init__(self, kw):
            self.kw = kw

        def bind_tools(self, tools):
            return self

        async def ainvoke(self, messages):
            raise Exception("Connection error")

    def build(kw):
        built.append(dict(kw))
        return _Down(kw)

    await agent_mod.negotiate_model(build=build)
    assert len(built) == 1
