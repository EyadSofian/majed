"""Can the bot answer "أنا عايز حضور اون لاين" with dates and a price?

Production, conv 140330 — the customer picks the online attendance mode and
gets prose back:

    14:36:20  IN: حضور اون لاين  ->  tools=[-]  cards=0  packages=0

    «الحضور المباشر عبر الإنترنت متاح بالفعل لمسار الميكانيكا الشامل. السعر
     النهائي لهذا النظام سيؤكده لك الفريق المختص…»

No dates, no cohorts, no price, no "which group would you like?" — while the
package's own page was offering مجموعة أغسطس ٢٠٢٦ (١٥/٨ – ٤/١١) and مجموعة
أكتوبر ٢٠٢٦ (١٨/١٠ – ٧/١) right next to the chat.

The prompt already requires the cohort list. The model had nothing to list:
every cohort is dropped unless `is_available_for_sale` is truthy, and that is
the package twin of `event.event.event_registrations_open`, which this
codebase already documents as a computed field Odoo does not report honestly.
One falsy flag, and the whole attendance offer disappears.
"""
from app import tools

PKG = {"id": 6, "name": "Mechanical Engineering Professional Track",
       "package_type": "both", "total_price": 30000, "discount": 0,
       "attendee_online_discount": 10, "attendee_onsite_discount": 0,
       "currency_id": [73, "EGP"], "public_categ_ids": []}

# The two cohorts from the package page, priced and dated, but with the
# computed flag off — which is how they arrive over JSON-RPC.
GROUPS = [
    {"id": 41, "name": "أغسطس 2026", "full_display_name": "مجموعة أغسطس 2026",
     "package_id": [6, "MEPT"], "is_available_for_sale": False,
     "first_event_date": "2026-08-15", "online_min_date_begin": "2026-08-15",
     "online_max_date_end": "2026-11-04", "onsite_min_date_begin": "2026-08-15",
     "onsite_max_date_end": "2026-11-04",
     "online_total_price": 25000, "onsite_total_price": 40000},
    {"id": 42, "name": "أكتوبر 2026", "full_display_name": "مجموعة أكتوبر 2026",
     "package_id": [6, "MEPT"], "is_available_for_sale": False,
     "first_event_date": "2026-10-18", "online_min_date_begin": "2026-10-18",
     "online_max_date_end": "2027-01-07", "onsite_min_date_begin": "2026-10-18",
     "onsite_max_date_end": "2027-01-07",
     "online_total_price": 25000, "onsite_total_price": 40000},
]

DATA = {"available": True, "packages": [PKG], "lines": [], "attendee_lines": [],
        "levels": [], "groups": GROUPS, "outcomes": []}


def _build():
    tools.PACKAGE_SINK.set([])
    tools.CURRENCY.set("EGP")
    return tools._build_package(PKG, tools._package_index(DATA))


def test_a_cohort_is_still_offered_when_the_computed_flag_is_off():
    """One unreported field must not erase every date the customer can pick."""
    _card, brief = _build()
    online = [o for o in brief["price_options"] if o["mode"] == "attendance_online"]
    assert online, "every online cohort was dropped — this is the production bug"
    assert len(online) == 2, [o["label"] for o in online]


def test_each_cohort_carries_the_dates_the_package_page_shows():
    """The page shows a range; the bot only ever had the start date."""
    _card, brief = _build()
    august = next(o for o in brief["price_options"]
                  if o.get("group_id") == 41 and o["mode"] == "attendance_online")
    assert august["starts_at"].startswith("2026-08-15")
    assert august["ends_at"].startswith("2026-11-04")
    assert "أغسطس" in august["label"]


def test_the_model_is_told_which_cohort_each_price_belongs_to():
    """It has to be able to say "أي مجموعة؟" and price the answer."""
    _card, brief = _build()
    for opt in brief["price_options"]:
        if opt["mode"] != "recorded":
            assert opt["group_id"], opt
            assert opt["group_name"], opt


def test_the_per_mode_discount_is_still_applied_per_cohort():
    """25,000 online less the package's 10% online discount."""
    _card, brief = _build()
    online = next(o for o in brief["price_options"]
                  if o["mode"] == "attendance_online")
    assert "22,500" in online["price_display"], online["price_display"]


def test_a_flag_that_is_set_is_still_respected():
    """When Odoo does report it, a cohort marked unsellable stays out."""
    groups = [dict(GROUPS[0], is_available_for_sale=True),
              dict(GROUPS[1], is_available_for_sale=False)]
    data = dict(DATA, groups=groups)
    tools.PACKAGE_SINK.set([])
    tools.CURRENCY.set("EGP")
    _card, brief = tools._build_package(PKG, tools._package_index(data))
    ids = {o.get("group_id") for o in brief["price_options"] if o.get("group_id")}
    assert ids == {41}, ids


def test_a_finished_cohort_is_never_offered():
    """The fallback must not resurrect a cohort that already ended."""
    past = dict(GROUPS[0], is_available_for_sale=False,
                first_event_date="2019-01-01",
                online_max_date_end="2019-03-01",
                onsite_max_date_end="2019-03-01")
    data = dict(DATA, groups=[past])
    tools.PACKAGE_SINK.set([])
    tools.CURRENCY.set("EGP")
    _card, brief = tools._build_package(PKG, tools._package_index(data))
    assert not [o for o in brief["price_options"] if o.get("group_id")]
