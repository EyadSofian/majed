"""End-to-end tests over the real ASGI app + real LangGraph agent + real
catalogue logic. Only the model and Odoo are faked."""
import asyncio
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


async def test_checkout_tool_keeps_post_only_url_out_of_model_text(loaded_catalog):
    """The widget needs the internal URL, but exposing it to the model makes it
    paste a broken GET link into the answer."""
    from app import tools as tools_mod

    cards: list = []
    ct = tools_mod.CARD_SINK.set(cards)
    cu = tools_mod.CURRENCY.set("EGP")
    try:
        raw = await tools_mod.build_checkout_link.ainvoke({"course_id": 2092})
    finally:
        tools_mod.CARD_SINK.reset(ct)
        tools_mod.CURRENCY.reset(cu)
    payload = json.loads(raw)

    assert payload["purchase_action"] == "attached_to_course_card"
    assert "checkout_url" not in payload
    assert "/shop/cart/update" not in raw
    assert cards[0]["checkout_url"].endswith(
        "product_id=2046&add_qty=1&express=1")


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
    # The course map is pruned to what this catalogue publishes, and the fixture
    # publishes none of its courses — so the shop category answers instead. That
    # fallback is the point: the map never speaks for courses Odoo does not have.
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
    # worded exactly like the shop's category sidebar
    assert {"title": "دورات الـ BIM", "value": "أنا في تخصص BIM"} in chips


async def test_specialization_chips_reach_the_widget(client_factory):
    script = [{"tool": "list_specializations", "args": {}},
              {"text": "اختار تخصصك."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "أنا مهندس، عندكم إيه؟")
        events = parse_sse(r.text)
    chips = next(e for e in events if e["type"] == "chips")["chips"]
    assert any(c["title"] in ("ميكانيكا", "الادارة والسلامة") for c in chips)


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


async def test_comprehensive_followup_inherits_recent_mechanical_context(
        client_factory, loaded_catalog, monkeypatch):
    """Regression: «المسار الشامل» after Mechanical must not drift to CFM."""
    from app import curriculum as curriculum_mod

    seen: list[str] = []
    real_match = curriculum_mod.match_group

    def capture(query: str):
        seen.append(query)
        return real_match(query)

    monkeypatch.setattr(curriculum_mod, "match_group", capture)
    script = [{"tool": "recommend_track", "args": {"track": "مسار شامل"}},
              {"text": "هذا هو المسار الميكانيكي الشامل."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "هات لي المسار الشامل",
                        history=[
                            {"role": "user", "content": "أريد دورات في الميكانيكا"},
                            {"role": "assistant", "content": "هل تفضّل مسارًا شاملًا؟"},
                        ])
        events = parse_sse(r.text)

    assert events[0] == {"type": "status", "stage": "thinking"}
    assert "ميكانيكا شاملة" in seen
    assert "CFM" not in "".join(e.get("content", "") for e in events)


async def test_sse_keeps_connection_alive_during_package_webhook_wait(
        client_factory, loaded_catalog, monkeypatch):
    """A slow n8n pull must emit traffic before the bridge's socket timeout."""
    from app import main as main_mod

    real_ensure = catalog_mod.ensure_packages

    async def slow_ensure(*args, **kwargs):
        await asyncio.sleep(0.04)
        return await real_ensure(*args, **kwargs)

    monkeypatch.setattr(catalog_mod, "ensure_packages", slow_ensure)
    monkeypatch.setattr(main_mod, "SSE_HEARTBEAT_SECONDS", 0.01)
    script = [{"tool": "recommend_track", "args": {"track": "التصميم الداخلي"}},
              {"text": "هذه خطة المسار."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "اعرض مسار التصميم الداخلي")
        events = parse_sse(r.text)

    assert events[0]["type"] == "status"
    assert "ping" in [event["type"] for event in events]
    assert events[-1]["type"] == "done"


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


def test_a_mechanical_query_picks_the_mechanical_track_not_a_bim_track():
    """Regression (live bug): a mechanical engineer was recommended
    "BIM MEP Professional Track" instead of the Mechanical one, because "MEP" is
    a mechanical word that appears in that BIM track's NAME. A package's
    discipline must be read from its COURSES, not its name."""
    from app import tools
    data = {
        "available": True,
        "packages": [
            {"id": 6, "name": "Mechanical Engineering Professional Track ",
             "public_categ_ids": []},
            {"id": 12, "name": "BIM MEP Professional Track ", "public_categ_ids": []},
        ],
        # real Engosoft product ids: 1223/1224/1226 are Mechanical in the KB;
        # 1988/1995 are BIM courses the KB does not field-map.
        "lines": [
            {"id": 1, "package_id": [6, "M"], "product_id": [1223, "HVAC System Design"]},
            {"id": 2, "package_id": [6, "M"], "product_id": [1224, "Firefighting Design System"]},
            {"id": 3, "package_id": [6, "M"], "product_id": [1226, "Plumbing Systems Design"]},
            {"id": 4, "package_id": [12, "B"], "product_id": [1988, "BIM fundamentals Architecture"]},
            {"id": 5, "package_id": [12, "B"], "product_id": [1995, "Navisworks Architecture"]},
        ],
        "attendee_lines": [], "levels": [], "groups": [], "outcomes": [],
    }
    lines_by = tools._by_package(data["lines"])
    assert tools._package_field(lines_by[6]) == "Mechanical"
    assert tools._package_field(lines_by[12]) is None
    for q in ("ميكانيكا", "المسار الاحترافي للميكانيكا", "عايز مسار ميكانيكا"):
        assert tools._match_package(data, q)["id"] == 6, q


async def test_lead_carries_field_specialization_and_experience(client_factory,
                                                                fake_odoo):
    """The funnel qualifies before it captures: the field, specialization and
    years of experience the agent gathered land on the lead so the advisor opens
    it knowing who this is."""
    script = [{"tool": "create_lead",
               "args": {"name": "منى", "phone": "01555000000",
                        "field": "Mechanical", "specialization": "HVAC",
                        "experience": "3 سنوات"}},
              {"text": "تمام يا مهندسة منى."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        await _chat(client, tok, "كلموني")
    assert len(fake_odoo.leads) == 1
    desc = fake_odoo.leads[0]["description"]
    assert "المجال: Mechanical" in desc
    assert "التخصص: HVAC" in desc
    assert "سنوات الخبرة: 3 سنوات" in desc


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


async def test_empty_worker_recovers_history_from_chatwoot(client_factory):
    client, model = client_factory([{"text": "نعم، ما زلنا نتحدث عن دورة CFM."}])
    async with client:
        tok = await _token(client)
        r = await client.post(
            "/api/v1/ai-chat/chat/",
            headers={"X-Guest-Token": tok},
            json={
                "message": "وما موعدها؟",
                "fahem_session_id": "recovered-worker",
                "history": [
                    {"role": "user", "content": "أريد معلومات عن دورة CFM."},
                    {"role": "assistant", "content": "سأعرض لك الدورة المناسبة."},
                ],
            },
        )
    assert r.status_code == 200
    calls = model.calls[-1]
    assert [m.type for m in calls if m.type in ("human", "ai")] == ["human", "ai", "human"]
    assert calls[-1].content == "وما موعدها؟"


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
    """An n8n fallback survives a later direct Odoo AccessError."""
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


# ============================================================ course naming
async def test_courses_are_named_the_way_the_shop_names_them(loaded_catalog):
    """The page beside the chat says «تنسيق أنظمة الميكانيكا (Navisworks MEP)».
    Odoo serves the bot's user English, so without a language read the assistant
    would answer with a different product name than the one on screen."""
    nav = loaded_catalog.courses[2107]
    assert nav.display_name == "تنسيق أنظمة الميكانيكا (Navisworks MEP)"
    assert nav.name == "Navisworks MEP"          # English kept for matching
    # both spellings still find it
    assert catalog_mod.search("navisworks")[0].id == 2107
    assert catalog_mod.search("تنسيق أنظمة الميكانيكا")[0].id == 2107


async def test_cards_carry_the_arabic_title(client_factory):
    script = [{"tool": "search_courses", "args": {"query": "navisworks"}},
              {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "navisworks")
        events = parse_sse(r.text)
    card = next(c for c in next(e for e in events if e["type"] == "cards")
                ["course_cards"] if c["course_id"] == 2107)
    assert card["title"] == "تنسيق أنظمة الميكانيكا (Navisworks MEP)"


async def test_missing_translation_leaves_the_english_name(fake_odoo):
    """An unknown language code or an untranslated course must not blank a
    title — it falls back to what Odoo already gave us."""
    fake_odoo.no_translations = True
    snap = await catalog_mod.refresh(full=True)
    assert snap.courses[2107].display_name == "Navisworks MEP"


async def test_title_follows_the_language_the_visitor_is_browsing_in(loaded_catalog):
    """Two visitors, two languages, one catalogue: each is answered with the
    title their own page is showing."""
    await catalog_mod.ensure_language("fr_FR")
    nav = loaded_catalog.courses[2107]
    assert catalog_mod.title_for(nav, "fr_FR") == "Coordination MEP (Navisworks)"
    assert catalog_mod.title_for(nav, "ar_001") == "تنسيق أنظمة الميكانيكا (Navisworks MEP)"
    # a language Odoo has nothing for falls back to the site default, not blank
    assert catalog_mod.title_for(nav, "de_DE") == nav.display_name
    # browsers write ar-001, Odoo stores ar_001
    assert catalog_mod.normalize_lang("ar-001") == "ar_001"
    assert catalog_mod.normalize_lang("../etc") == ""


async def test_cards_are_titled_in_the_requested_language(client_factory):
    script = [{"tool": "search_courses", "args": {"query": "navisworks"}},
              {"text": "Voilà."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "navisworks", lang="fr-FR")
        events = parse_sse(r.text)
    card = next(c for c in next(e for e in events if e["type"] == "cards")
                ["course_cards"] if c["course_id"] == 2107)
    assert card["title"] == "Coordination MEP (Navisworks)"


async def test_a_language_is_read_once_not_every_turn(client_factory, fake_odoo):
    script = [{"text": "أهلاً."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        for _ in range(3):
            await _chat(client, tok, "هاي", lang="fr_FR")
    # once for the request language; the rest come from the snapshot
    assert fake_odoo.lang_calls.count("fr_FR") == 1


# ======================================================= money & deferral
async def test_payment_answer_lists_only_what_the_shop_switched_on(loaded_catalog):
    """The bot answered a "do you do instalments?" question with valU and
    تمارا — from general knowledge, not from this shop. Now the only names it
    can say are the live providers, and a test-mode one is not live."""
    from app import tools as tools_mod
    payload = json.loads(await tools_mod.get_payment_options.ainvoke({}))
    assert payload["available"] is True
    assert payload["methods"] == ["Bank Transfer", "Paymob Card"]
    assert "Tamara" not in payload["methods"]


async def test_unreadable_payment_config_tells_the_model_to_defer(fake_odoo):
    from app import tools as tools_mod
    fake_odoo.payments_denied = True
    payload = json.loads(await tools_mod.get_payment_options.ainvoke({}))
    assert payload["available"] is False
    assert payload["note"] == "ask_a_human_or_defer"


async def test_deferring_discards_the_turn_so_the_other_bot_can_answer(
        client_factory):
    """A question this brain cannot prove must leave NOTHING delivered — the
    bridge only falls back to Botpress when nothing was shown."""
    script = [{"tool": "defer_to_bot", "args": {"reason": "instalment terms"}},
              {"text": "هذا نص لا يجب أن يصل للعميل أبداً"}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عندكم طرق تقسيط متاحة؟")
        events = parse_sse(r.text)
    kinds = [e["type"] for e in events]
    assert "defer" in kinds
    assert kinds[-1] == "done"
    assert "cards" not in kinds and "packages" not in kinds
    assert next(e for e in events if e["type"] == "defer")["reason"] == "instalment terms"


# ============================================================== instructors
async def _ask_instructor(**args) -> dict:
    from app import tools as tools_mod
    return json.loads(await tools_mod.get_instructor.ainvoke(args))


async def test_arabic_spelling_finds_the_english_record(loaded_catalog):
    """A customer asked about «عمرو كمال» and was told no such instructor is in
    the database — while he teaches a course on the site. Names are stored in
    English; a substring match can never bridge that."""
    from app.catalog import name_key
    assert name_key("عمرو") == name_key("Amr")
    assert name_key("كمال") == name_key("Kamal")
    assert name_key("محمد") == name_key("Mohamed")

    out = await _ask_instructor(name="أيمن عاطف")
    assert out["matched"] is True
    assert out["instructors"][0]["name"] == "Dr.Ayman Atef Ali Fawzi"
    # what he teaches, instead of the model inventing a speciality
    assert out["instructors"][0]["teaches"]
    assert out["instructors"][0]["title"] == "PRIMAVERA & PMP Instructor"


async def test_an_unmatched_name_is_never_reported_as_nonexistent(loaded_catalog):
    out = await _ask_instructor(name="خالد الشناوي")
    assert out["matched"] is False
    # the tool tells the model what to do instead of denying the person exists
    assert "ask_which_course" in out["note"] or "confirm_the_course" in out["note"]


async def test_asking_by_course_is_the_exact_answer(loaded_catalog):
    out = await _ask_instructor(course_id=2092)
    assert out["matched"] is True
    assert {i["name"] for i in out["instructors"]} == {
        "Dr.Ayman Atef Ali Fawzi", "Eng.Mohamed Hamdy"}


async def test_the_model_is_given_the_real_staff_list_to_match_against(
        loaded_catalog):
    """Matching a name across scripts is language work — the model does it. Our
    job is to make sure it can only pick from people who exist."""
    from app.prompts import build_system_prompt
    digest = catalog_mod.instructor_digest()
    assert "#4129 | Dr.Ayman Atef Ali Fawzi | PRIMAVERA & PMP Instructor" in digest
    # whoever teaches the most comes first, so a cap never drops the busiest
    assert digest.splitlines()[0].endswith("كورس")

    prompt = build_system_prompt(catalog_mod.catalog_digest(), digest)
    assert "مدربو Engosoft" in prompt
    assert "Dr.Ayman Atef Ali Fawzi" in prompt
    # and the prompt tells it whose job the matching is
    assert "طابق اسم العميل عليها بنفسك" in prompt


async def test_picking_an_id_from_that_list_returns_the_exact_person(
        loaded_catalog):
    out = await _ask_instructor(instructor_id=4129)
    assert out["matched"] is True
    assert out["instructors"][0]["name"] == "Dr.Ayman Atef Ali Fawzi"
    assert out["instructors"][0]["teaches"]


async def test_repeated_instructor_lookup_emits_one_card(loaded_catalog):
    """The model may refine an answer with the same tool twice; one person must
    still produce one card in the final assistant turn."""
    from app import tools as tools_mod

    sink_token = tools_mod.INSTRUCTOR_SINK.set([])
    try:
        await _ask_instructor(instructor_id=4129)
        await _ask_instructor(instructor_id=4129)
        cards = list(tools_mod.INSTRUCTOR_SINK.get() or [])
    finally:
        tools_mod.INSTRUCTOR_SINK.reset(sink_token)

    assert len(cards) == 1
    assert cards[0]["id"] == 4129
    assert len(cards[0]["sections"]) == len({
        section["label"] for section in cards[0]["sections"]
    })


async def test_english_profile_content_is_translated_not_hidden(
        loaded_catalog, fake_odoo, monkeypatch):
    """The official name may stay as stored, but buying evidence must be Arabic."""
    from app import localization
    from app import tools as tools_mod

    fake_odoo.no_translations = True
    calls = []

    async def translate(payload):
        calls.append(payload)
        return {
            "title": "مدرب PRIMAVERA وPMP وإدارة المشروعات",
            "department": "قسم المدربين غير التقنيين",
            # Existing Arabic Odoo text is authoritative and stays byte-for-byte.
            "bio": payload["bio"],
            "sections": [
                {
                    "label": "التخصصات",
                    "items": [
                        "إدارة المرافق",
                        "إدارة المشروعات",
                        "أنظمة إدارة المباني (BMS)",
                    ],
                },
                {
                    "label": "الخبرة",
                    "items": payload["sections"][1]["items"],
                },
                {
                    "label": "جهة الخبرة",
                    "items": ["Engosoft"],
                },
            ],
        }

    monkeypatch.setattr(localization, "_request_translation", translate)
    lang_token = tools_mod.LANG.set("ar_001")
    try:
        first = await _ask_instructor(instructor_id=4129)
        second = await _ask_instructor(instructor_id=4129)
    finally:
        tools_mod.LANG.reset(lang_token)

    card = first["instructors"][0]
    assert card["name"] == "Dr.Ayman Atef Ali Fawzi"  # official name is irrelevant
    assert card["title"] == "مدرب PRIMAVERA وPMP وإدارة المشروعات"
    assert "أبرز الخبراء" in card["bio"]
    assert next(s for s in card["sections"] if s["label"] == "التخصصات")[
        "items"] == [
            "إدارة المرافق",
            "إدارة المشروعات",
            "أنظمة إدارة المباني (BMS)",
        ]
    assert second["instructors"][0]["sections"] == card["sections"]
    assert len(calls) == 1  # repeated model calls do not pay for translation twice


async def test_instructor_profile_follows_the_visitors_arabic_language(
        loaded_catalog, fake_odoo):
    """Profile fields are translatable Odoo data just like course titles."""
    from app import tools as tools_mod

    lang_token = tools_mod.LANG.set("ar_001")
    try:
        out = await _ask_instructor(instructor_id=4129)
    finally:
        tools_mod.LANG.reset(lang_token)

    card = out["instructors"][0]
    assert card["name"] == "د. أيمن عاطف علي فوزي"
    assert card["title"] == "مدرب بريمفيرا وإدارة المشروعات"
    assert "إدارة المشروعات" in card["bio"]
    specialisms = next(
        s for s in card["sections"] if s["label"] == "التخصصات")
    assert "إدارة المرافق" in specialisms["items"]
    assert "ar_001" in fake_odoo.lang_calls


async def test_an_id_that_is_not_a_person_does_not_pretend_to_be_one(
        loaded_catalog):
    out = await _ask_instructor(instructor_id=999999)
    assert out["matched"] is False
    assert out["instructors"] == []


async def test_instructor_answers_carry_a_card_with_a_photo(client_factory):
    """A trainer is a face and a track record; a paragraph of text is not the
    same thing to someone deciding whether to pay."""
    script = [{"tool": "get_instructor", "args": {"instructor_id": 4129}},
              {"text": "ده المدرب."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "مين مدرب PMP؟")
        events = parse_sse(r.text)
    card = next(e for e in events if e["type"] == "instructors")["instructor_cards"][0]
    assert card["name"] == "Dr.Ayman Atef Ali Fawzi"
    assert card["image_url"] == (
        "https://engosoft.com/web/image/hr.employee/4129/image_512")
    assert card["teaches"] and card["courses_count"] >= 1


async def test_the_full_site_profile_reaches_the_card(loaded_catalog):
    """The site shows a biography, specialisations and an experience list for a
    trainer; the bot used to have none of it. The lists live in ONE text field
    as "✔ item" lines — a list pretending to be a paragraph."""
    out = await _ask_instructor(instructor_id=4129)
    card = out["instructors"][0]
    assert "أبرز الخبراء" in card["bio"]
    labels = [s["label"] for s in card["sections"]]
    assert labels == ["التخصصات", "الخبرة", "جهة الخبرة"]   # the popup's order

    spec = next(s for s in card["sections"] if s["label"] == "التخصصات")
    assert spec["items"] == ["Facility Management", "Project Management",
                             "Building Management Systems (BMS)"]
    assert all("✔" not in x for x in spec["items"])


async def test_odoo_internals_never_leak_onto_a_customer_card(loaded_catalog):
    """"Biometric IDs" matches the hint "bio" and "Next Activity Summary"
    matches "summary" — both are real hr.employee fields, and either one on a
    trainer's card is nonsense the customer reads."""
    out = await _ask_instructor(instructor_id=4129)
    text = json.dumps(out, ensure_ascii=False)
    for junk in ("Biometric", "HR Orientation", "Activity", "Messages"):
        assert junk not in text


async def test_a_database_without_those_fields_still_answers(fake_odoo):
    """Not every Odoo has the custom profile fields — the trainer must still
    come back with what does exist."""
    fake_odoo.no_profiles = True
    await catalog_mod.refresh(full=True)
    out = await _ask_instructor(instructor_id=4129)
    assert out["instructors"][0]["bio"] is None
    assert out["instructors"][0]["name"] == "Dr.Ayman Atef Ali Fawzi"


async def test_a_track_question_refreshes_directly_from_odoo_before_n8n(
        fake_odoo, monkeypatch):
    """A trainee asking about a track is the highest-value question we get;
    Odoo is canonical now that training.package access has been granted."""
    from app import catalog as cat
    from app.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "packages_webhook_url", "https://n8n.example/webhook/pkg")
    monkeypatch.setattr(s, "packages_max_age_seconds", 0)   # always stale
    calls = []

    class _Client:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, **kw):
            calls.append(url)
            raise AssertionError("n8n must not be called while Odoo is readable")

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    await catalog_mod.refresh(full=True)
    data = await cat.ensure_packages()
    assert fake_odoo.package_calls >= 2  # startup + forced stale refresh
    assert calls == []                  # n8n is fallback, never the first source
    assert data["available"] is True
    assert catalog_mod.snapshot().packages_source == "odoo"


async def test_n8n_is_only_used_when_direct_package_access_is_denied(
        fake_odoo, monkeypatch):
    from app import catalog as cat
    from app.config import get_settings
    from .fakes import PACKAGES

    s = get_settings()
    monkeypatch.setattr(s, "packages_webhook_url", "https://n8n.example/webhook/pkg")
    monkeypatch.setattr(s, "packages_max_age_seconds", 0)
    fake_odoo.packages_denied = True
    calls = []

    class _Resp:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return [PACKAGES]

    class _Client:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, **kw):
            calls.append(url)
            return _Resp()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    await catalog_mod.refresh(full=True)
    data = await cat.ensure_packages()
    assert fake_odoo.package_calls >= 2
    assert calls == ["https://n8n.example/webhook/pkg"]
    assert data["available"] is True
    assert catalog_mod.snapshot().packages_source == "ingest"


async def test_a_new_package_permission_is_detected_without_a_course_edit(
        fake_odoo, monkeypatch):
    """Granting training.package access must take effect on the next poll."""
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "packages_max_age_seconds", 0)
    fake_odoo.packages_denied = True
    await catalog_mod.refresh(full=True)
    assert catalog_mod.snapshot().packages.get("available") is False

    fake_odoo.packages_denied = False
    await catalog_mod.refresh(full=False)  # fetch_courses(since=...) is empty
    snap = catalog_mod.snapshot()
    assert snap.packages.get("available") is True
    assert snap.packages_source == "odoo"


async def test_a_failed_pull_never_breaks_the_answer(fake_odoo, monkeypatch):
    from app import catalog as cat
    from app.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "packages_webhook_url", "https://n8n.example/webhook/pkg")
    monkeypatch.setattr(s, "packages_max_age_seconds", 0)

    calls = []

    class _Client:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **kw):
            calls.append(True)
            raise RuntimeError("n8n down")

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    await catalog_mod.refresh(full=True)
    fake_odoo.packages_denied = True
    data = await cat.ensure_packages()          # must not raise
    assert data.get("available") is True        # falls back to what Odoo gave us
    assert calls == [True]
    assert catalog_mod.snapshot().packages_source == "odoo"


# ============================================================ wiring guard
def test_every_odoo_call_in_the_app_exists_on_the_real_client():
    """A deleted data-layer method must fail here, not in production.

    `FakeOdoo` overrides the methods the app calls, so a method removed from
    the real `Odoo` class stays invisible to every other test — and then the
    catalogue fails to load on boot with an AttributeError. This reads the app's
    own source and checks each call against the real class.
    """
    import re
    from pathlib import Path

    from app.odoo import Odoo

    app_dir = Path(__file__).resolve().parents[1] / "app"
    called: dict[str, str] = {}
    for path in sorted(app_dir.glob("*.py")):
        for name in re.findall(r"\bodoo\.(\w+)\s*\(", path.read_text(encoding="utf-8")):
            called.setdefault(name, path.name)
    assert called, "no odoo calls found — the scan is broken, not the code"
    missing = {n: f for n, f in called.items() if not hasattr(Odoo, n)}
    assert not missing, f"called but not defined on Odoo: {missing}"


# ======================================================= Engosoft course map
def test_a_discipline_question_never_lands_in_another_discipline():
    """«مسار ميكانيكا» was answered with BIM courses: the Arabic question shared
    no word with any Odoo category, so the filter did nothing and a plain
    keyword search picked whatever matched. The KB's own map decides now."""
    from app import curriculum as cur
    assert cur.ready(), "curriculum.json must ship with the service"
    assert cur.field_of_query("مسار ميكانيكا") == "Mechanical"
    assert cur.field_of_query("انا في تخصص ميكانيكا") == "Mechanical"
    assert cur.field_of_query("عايز اتعلم تكييف") == "Mechanical"   # via keywords
    assert cur.field_of_query("تصميم كهرباء") == "Electrical"
    assert cur.field_of_query("مسار الديكور") == "Interior Design"
    assert cur.field_of_query("BIM structure") in ("Civil", "Architecture", "Mechanical")


def test_a_named_package_returns_the_exact_courses_engosoft_lists():
    """"الميكانيكا الشاملة" is not a search — it is a list somebody wrote."""
    from app import curriculum as cur
    group = cur.match_group("عايز باقة الميكانيكا الشامله")
    assert group and group["rule"] == "MECHANICAL GROUPING RULE"
    # HVAC · Fire Fighting · Plumbing · Shop Drawing · Medical Gas, as Odoo ids
    # so the answer comes back priced and buyable
    assert cur.group_members(group) == [1223, 1224, 1226, 1535, 1229]

    # word order and spelling vary; the rule still has to fire
    assert cur.match_group("الميكانيكا الشامله")["rule"] == "MECHANICAL GROUPING RULE"
    assert cur.match_group("Comprehensive Mechanics Package")["rule"] == \
        "MECHANICAL GROUPING RULE"
    assert cur.match_group("عايز كورس تكييف بس") is None      # not a package ask


async def test_the_map_goes_silent_about_courses_odoo_does_not_publish(fake_odoo):
    """The map is an overlay, never a second catalogue. This fixture publishes
    three courses, none of them in the map — so after a load the map must have
    nothing to say, rather than recommending pages that do not exist."""
    from app import curriculum as cur
    assert cur.ready()                       # shipped map is there before a load
    await catalog_mod.refresh(full=True)
    assert cur.fields() == {}
    assert cur.field_of_query("مسار ميكانيكا") is None
    assert cur.group_members(cur.match_group("الميكانيكا الشامله")) == []
    assert cur.keywords_for(1223) == []

    # and with a catalogue that does publish them, it speaks again
    cur.prune([1223, 1224, 1226, 1535, 1229])
    assert cur.group_members(cur.match_group("الميكانيكا الشامله")) == \
        [1223, 1224, 1226, 1535, 1229]


def test_the_map_carries_relations_and_audience_and_nothing_else():
    """Scope guard: prices, names, descriptions, durations, instructors and
    links are Odoo's. If any of them appear in the shipped data, the map has
    started to be a second source of truth."""
    import json as _json
    from pathlib import Path
    raw = _json.loads((Path(__file__).resolve().parents[1] /
                      "data" / "curriculum.json").read_text(encoding="utf-8"))
    assert set(raw) == {"source", "fields", "courses", "groups", "mapping"}
    for row in raw["courses"].values():
        assert set(row) == {"field", "audience", "level", "keywords"}
    for g in raw["groups"]:
        assert set(g) == {"rule", "triggers", "course_ids"}
    # nothing outside the six disciplines the business sells against
    assert set(raw["fields"]) == {"Mechanical", "Electrical", "Civil",
                                  "Architecture", "Interior Design", "Management"}


def test_the_sales_mapping_holds_a_decision_tree_not_a_catalogue():
    """The mapping is the sales tree — states, goals, routes. The same scope
    guard applies to it: the moment it starts carrying a price, a duration or a
    course URL, the shop has a rival copy of itself that nobody updates."""
    import json as _json
    from pathlib import Path
    raw = _json.loads((Path(__file__).resolve().parents[1] /
                      "data" / "curriculum.json").read_text(encoding="utf-8"))
    m = raw["mapping"]
    assert set(m) == {"note", "states", "job_titles", "goals", "comprehensive",
                      "bim_tracks", "work_fields", "certifications",
                      "interest_topics"}

    # every goal routes somewhere the tool can actually execute
    assert {g["route"] for g in m["goals"]} == {"comprehensive", "bim",
                                                "certification"}
    # comprehensive tracks are referenced by RULE, never by a copied course list
    rules = {g["rule"] for g in raw["groups"]}
    for spec, wanted in m["comprehensive"].items():
        assert spec in raw["fields"], spec
        assert set(wanted) <= rules, spec
    # certifications point at a declared work field and carry no course ids:
    # whether a programme is sellable is the live catalogue's answer, not ours
    work_fields = {w["key"] for w in m["work_fields"]}
    for cert in m["certifications"]:
        assert cert["work_field"] in work_fields
        assert set(cert) == {"code", "work_field", "min_years", "max_years",
                             "label", "match"}

    # no Odoo-owned attribute anywhere in the tree, at any depth
    owned = {"price", "price_display", "currency", "url", "website_url",
             "image_url", "duration", "duration_text", "description",
             "instructor", "instructors", "rating", "seats", "product_id",
             "course_id", "course_ids"}

    def walk(node, path="mapping"):
        if isinstance(node, dict):
            leaked = owned & set(node)
            assert not leaked, f"{path} carries Odoo's data: {leaked}"
            for k, v in node.items():
                walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")

    walk(m)


async def test_keywords_from_the_map_reach_the_search_index(fake_odoo, monkeypatch):
    """A course carries the KB's Arabic keywords, so «تكييف» finds HVAC even
    though Odoo holds that word nowhere."""
    from app import curriculum as cur
    monkeypatch.setattr(cur, "keywords_for", lambda i: ["تكييف", "HVAC", "تبريد"]
                        if i == 2107 else [])
    monkeypatch.setattr(cur, "field_for", lambda i: "Mechanical" if i == 2107 else "")
    await catalog_mod.refresh(full=True)
    hits = catalog_mod.search("تكييف", top_k=3)
    assert hits and hits[0].id == 2107
    assert [c.id for c in catalog_mod.search("", field_name="Mechanical")] == [2107]


async def test_every_recommended_course_can_be_bought_from_its_card(client_factory):
    """A recommendation without a buy button makes the customer go and find the
    course themselves — which is the moment most of them leave."""
    script = [{"tool": "search_courses", "args": {"query": "PMP"}},
              {"text": "أهو."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "PMP")
        events = parse_sse(r.text)
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    priced = [c for c in cards if c["price_display"]]
    assert priced, "the fixture must price at least one course"
    for c in priced:
        assert c["checkout_url"], f"no buy button on {c['title']}"
        assert "add_qty=1&express=1" in c["checkout_url"]


def test_deep_details_routing_follows_the_setting(monkeypatch):
    """STAGE 3 of the funnel is a switch: with DETAILS_TO_BOTPRESS on, a deep
    course-detail request is deferred to Botpress; off (default), Nabras answers
    it itself. The marker must never survive into the served prompt."""
    from app import prompts
    from app.config import get_settings
    s = get_settings()

    monkeypatch.setattr(s, "details_to_botpress", True)
    to_bot = prompts.build_system_prompt()
    assert prompts._DETAILS_MARKER not in to_bot
    assert "التقييمات" in to_bot and "course_details" in to_bot

    monkeypatch.setattr(s, "details_to_botpress", False)
    in_nabras = prompts.build_system_prompt()
    assert prompts._DETAILS_MARKER not in in_nabras
    assert "الريفيوهات" not in in_nabras
    assert "get_course_details" in in_nabras


# ================================================== digital-sales mapping
def test_the_goal_is_what_branches_not_the_specialization():
    """The sales doc's tree: four goals, and only the certification branch asks
    about years. A maintenance engineer who wants a certificate and one who
    wants to learn design must not share a path."""
    from app import curriculum as cur
    assert cur.resolve_goal("عايز اتأهل لسوق العمل")["route"] == "comprehensive"
    assert cur.resolve_goal("نفسي اتعلم التصميم الهندسي")["route"] == "comprehensive"
    assert cur.resolve_goal("عايز اتعلم نمذجة BIM")["route"] == "bim"
    assert cur.resolve_goal("عايز شهادة احترافيه")["route"] == "certification"
    # nothing said about a goal -> the caller must ask, never guess
    assert cur.resolve_goal("انا مهندس ميكانيكا") is None


def test_certification_is_chosen_by_work_field_and_years():
    """إدارة المرافق 1-3 → FMP · 5+ → CFM · الصيانة → CMRP · المشاريع 3+ → PMP."""
    from app import curriculum as cur
    assert cur.resolve_work_field("بشتغل في ادارة المرافق")["key"] == "facility_management"
    assert cur.resolve_work_field("انا في الصيانه")["key"] == "maintenance"
    assert cur.resolve_work_field("بشتغل ادارة المشاريع")["key"] == "project_management"

    assert cur.certification_for("facility_management", 2)["code"] == "FMP"
    assert cur.certification_for("facility_management", 6)["code"] == "CFM"
    assert cur.certification_for("project_management", 5)["code"] == "PMP"
    # CMRP has no year bound, so it resolves on the work field alone
    assert cur.certification_for("maintenance", None)["code"] == "CMRP"
    # two bounded rungs and unknown years -> refuse to pick, so the bot asks
    assert cur.certification_for("facility_management", None) is None


def test_the_comprehensive_track_of_a_specialization_is_a_written_list():
    from app import curriculum as cur
    rules = [g["rule"] for g in cur.comprehensive_groups("Mechanical")]
    assert rules == ["MECHANICAL GROUPING RULE"]
    # Civil is genuinely sold as three tracks — collapsing them into one
    # «المدني الشاملة» would put a bridge engineer in a concrete-design path
    assert len(cur.comprehensive_groups("Civil")) == 3
    assert cur.bim_track("Electrical")["code"] == "BIM Electrical"
    assert cur.bim_track("Management and Safety") is None


async def _by_goal(**args) -> tuple[dict, list, list]:
    """Run the mapping tool with the sinks a real turn installs."""
    from app import tools as tools_mod
    cards: list = []
    chips: list = []
    ct = tools_mod.CARD_SINK.set(cards)
    ch = tools_mod.CHIP_SINK.set(chips)
    cu = tools_mod.CURRENCY.set("EGP")
    try:
        raw = await tools_mod.recommend_by_goal.ainvoke(args)
    finally:
        tools_mod.CARD_SINK.reset(ct)
        tools_mod.CHIP_SINK.reset(ch)
        tools_mod.CURRENCY.reset(cu)
    return json.loads(raw), cards, chips


async def test_an_unknown_goal_asks_instead_of_recommending(loaded_catalog):
    payload, cards, chips = await _by_goal(goal="مش عارف", specialization="ميكانيكا")
    assert payload["need"] == "goal"
    assert not cards                                  # nothing recommended yet
    assert {c["title"] for c in chips} == {
        "التأهيل لسوق العمل", "تعلّم التصميم الهندسي",
        "نمذجة وتقنيات BIM", "شهادة احترافية أو إدارية"}


async def test_certification_branch_asks_for_the_work_field_first(loaded_catalog):
    payload, cards, chips = await _by_goal(goal="عايز شهادة احترافيه")
    assert payload["need"] == "work_field"
    assert not cards
    assert "إدارة المرافق" in {c["title"] for c in chips}


async def test_certification_returns_the_programme_as_a_priced_card(loaded_catalog):
    """A 5-year project manager maps to PMP — and the answer is the real,
    buyable Odoo course, not the model's memory of what PMP is."""
    payload, cards, _ = await _by_goal(
        goal="عايز شهادة احترافيه", work_field="ادارة المشاريع",
        experience_years=5, specialization="ادارة", job_title="مدير")
    assert payload["code"] == "PMP"
    assert payload["rationale"]["job_title"] == "مدير"
    assert payload["rationale"]["experience_years"] == 5
    assert [c["course_id"] for c in cards] == [2092]
    assert cards[0]["price_display"] == "6,900 EGP"        # live pricelist
    assert cards[0]["checkout_url"].endswith("product_id=2046&add_qty=1&express=1")


async def test_a_mapped_programme_the_shop_does_not_sell_says_so(loaded_catalog):
    """The mapping says FMP; the catalogue has no FMP. Substituting the nearest
    certificate would quote a customer a programme they did not ask for, so the
    tool returns nothing and the prompt has to admit it."""
    payload, cards, _ = await _by_goal(
        goal="عايز شهادة", work_field="ادارة المرافق", experience_years=2)
    assert payload["status"] == "not_in_catalog"
    assert payload["code"] == "FMP"
    assert not cards


async def test_bim_goal_returns_the_bim_track_of_that_discipline(loaded_catalog):
    payload, cards, _ = await _by_goal(goal="نمذجة BIM", specialization="كهرباء")
    assert payload["code"] == "BIM Electrical"
    assert [c["course_id"] for c in cards] == [2116]       # Revit Electrical Design

    payload, cards, _ = await _by_goal(goal="BIM", specialization="ميكانيكا")
    assert payload["code"] == "BIM Mechanical"
    assert [c["course_id"] for c in cards] == [2107]       # Navisworks MEP


async def test_the_mapping_reaches_the_widget_as_cards(client_factory):
    """End to end: one turn, and the recommendation arrives as a card the
    widget can render — the same surface search_courses uses."""
    script = [{"tool": "recommend_by_goal",
               "args": {"goal": "شهادة احترافيه", "work_field": "ادارة المشاريع",
                        "experience_years": 4}},
              {"text": "بناءً على خبرتك وهدفك أرشح لك PMP."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "عايز شهادة في ادارة المشاريع")
        events = parse_sse(r.text)
    cards = next(e for e in events if e["type"] == "cards")["course_cards"]
    assert [c["course_id"] for c in cards] == [2092]
    assert events[-1]["type"] == "done"


async def test_client_state_chips_open_the_qualification(loaded_catalog):
    from app import tools as tools_mod
    chips: list = []
    ch = tools_mod.CHIP_SINK.set(chips)
    try:
        payload = json.loads(await tools_mod.list_client_states.ainvoke({}))
    finally:
        tools_mod.CHIP_SINK.reset(ch)
    assert len(payload["states"]) == 8
    titles = {c["title"] for c in chips}
    assert "حديث التخرج" in titles and "أرغب في تغيير المجال" in titles
    # the state carries the experience band, so it is not asked twice
    from app import curriculum as cur
    assert cur.resolve_state("خبرة أكثر من 5 سنوات")["years"] == 6


def test_the_prompt_teaches_the_mapping_and_its_order():
    from app import prompts
    p = prompts.build_system_prompt()
    for marker in ("list_client_states", "recommend_by_goal", "المسمى الوظيفي",
                   "الهدف من الدورة", "FMP", "CFM", "CMRP", "PMP",
                   "not_in_catalog"):
        assert marker in p, marker
    # the goal branches, and only the certification branch asks about years
    assert "المتغيّر الذي يفرّع هو الهدف" in p
    assert "**هنا فقط** اسأل عن مجال العمل + سنوات الخبرة" in p


async def test_the_mapping_audit_names_the_dead_branches(loaded_catalog, capsys):
    """`scripts/check_mapping_catalog.py` answers "does the shop actually sell
    what the mapping recommends?". It must use the production matcher, so its
    verdict is the same one a customer would get — and it must point at the
    near-miss titles, because a dead branch is usually a naming difference."""
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import check_mapping_catalog as audit

    # the fake shop publishes PMP and two BIM courses, and no FMP/CFM/CMRP
    assert audit._report("cert", "PMP", ["PMP", "Project Management Professional"])
    assert audit._report("bim", "BIM Electrical", ["Revit Electrical"])
    assert not audit._report("cert", "FMP", ["FMP", "Facility Management Professional"])
    assert not audit._report("bim", "BIM Structure", ["Revit Structure", "BIM Structure"])

    out = capsys.readouterr().out
    assert "PMP Preparation Course" in out
    assert out.count("NOT PUBLISHED") == 2

    # two different dead branches, two different diagnoses: nothing in the shop
    # shares a word with FMP, so it is simply not sold — while "Revit Structure"
    # shares "Revit" with a course that IS sold, which is the shape of a naming
    # difference the operator can fix in `match`.
    fmp, structure = out.split("BIM Structure")[0], out.split("BIM Structure")[1]
    assert "does not sell it at all" in fmp
    assert "Revit Electrical Design" in structure
    assert "closest titles in the shop" in structure


# ============================================== lead capture reaches the SLA
async def _capture(fake_odoo, **args) -> tuple[dict, dict]:
    """Run create_lead with the lead sink a real turn installs."""
    from app import tools as tools_mod
    lead: dict = {}
    lt = tools_mod.LEAD_SINK.set(lead)
    try:
        raw = await tools_mod.create_lead.ainvoke(
            {"name": "إياد", "phone": "0100000000", **args})
    finally:
        tools_mod.LEAD_SINK.reset(lt)
    return json.loads(raw), lead


async def test_a_captured_lead_lands_in_the_advisors_activity_queue(fake_odoo):
    """«Activity Today» and «Overdue» are views over mail.activity. A lead with
    no activity is in neither, so nobody is ever late on it — which is how every
    lead Majed captured used to fall outside the sales SLA entirely."""
    from datetime import date
    payload, _ = await _capture(
        fake_odoo, field="Mechanical", specialization="HVAC",
        job_title="مهندس", experience="4", goal="شهادة احترافية")

    assert payload["lead_id"] == 5001
    assert payload["activity_id"] is not None
    activity = fake_odoo.activities[0]
    assert activity["model"] == "crm.lead" and activity["res_id"] == 5001
    assert activity["date_deadline"] == date.today().isoformat()   # due today
    assert activity["user_id"] == 2                                # the advisor

    # the advisor opens the lead already knowing who this is
    description = fake_odoo.leads[0]["description"]
    for expected in ("المجال: Mechanical", "التخصص: HVAC",
                     "المسمى الوظيفي: مهندس", "سنوات الخبرة: 4",
                     "الهدف: شهادة احترافية"):
        assert expected in description, expected
    # and "how many came from Majed?" is a CRM filter, not a guess from the name
    assert fake_odoo.leads[0]["source_id"] == fake_odoo.sources["ماجد"]


async def test_the_contact_survives_when_the_follow_up_cannot_be_filed(fake_odoo):
    """The lead is saved before the activity is scheduled. If Odoo will not give
    us an activity type, we lose the queue entry — never the phone number."""
    fake_odoo.no_activity_type = True
    fake_odoo.no_utm = True
    payload, lead = await _capture(fake_odoo)
    assert payload["lead_id"] == 5001
    assert payload["activity_id"] is None
    assert "source_id" not in fake_odoo.leads[0]
    assert lead["captured"] is True          # ops is still told


async def test_trial_mode_captures_nothing_at_all(fake_odoo, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "allow_crm_writes", False)
    payload, lead = await _capture(fake_odoo)
    assert payload["simulated"] is True
    assert fake_odoo.leads == [] and fake_odoo.activities == []
    assert lead == {}                        # and no alert for a fake lead


async def test_a_lead_without_a_contact_method_is_refused(fake_odoo):
    from app import tools as tools_mod
    payload = json.loads(await tools_mod.create_lead.ainvoke({"name": "إياد"}))
    assert payload["error"] == "need_contact"
    assert fake_odoo.leads == []


async def test_the_captured_contact_reaches_the_bridge_as_a_lead_event(client_factory):
    """The ops alert for a captured lead was written and unit-tested in the
    bridge but never fired, because nothing told the bridge a lead happened.
    This is that signal."""
    script = [{"tool": "create_lead",
               "args": {"name": "إياد", "phone": "0100000000",
                        "specialization": "HVAC", "job_title": "مهندس"}},
              {"text": "تمام، هيتواصل معك مستشار."}]
    client, _ = client_factory(script)
    async with client:
        tok = await _token(client)
        r = await _chat(client, tok, "رقمي 0100000000")
        events = parse_sse(r.text)
    lead = next(e for e in events if e["type"] == "lead")
    assert lead["captured"] is True
    assert lead["name"] == "إياد" and lead["phone"] == "0100000000"
    assert lead["specialization"] == "HVAC" and lead["job_title"] == "مهندس"
    assert events[-1]["type"] == "done"


def test_the_prompt_refuses_to_guess_the_four_unanswerable_questions():
    """هدف · رسوم الاختبار الدولي · لغة الشرح · التطبيق العملي — four of the most
    asked questions have no tool and no field behind them. Guessing any of them
    costs a customer, so each has a scripted honest answer instead."""
    from app import prompts
    p = prompts.build_system_prompt()
    assert "صندوق تنمية الموارد البشرية" in p        # هدف, named explicitly
    assert "رسوم الاختبار الدولي تُدفع للجهة المانحة" in p
    assert "لغة الشرح غير مسجّلة في بيانات الدورة" in p
    assert "لا تَعِد بتطبيق عملي لم يُذكر فيه" in p
