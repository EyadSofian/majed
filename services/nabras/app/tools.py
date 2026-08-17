"""Agent tools, bound to the real Engosoft Odoo schema.

Cards and handoff requests are captured out-of-band through ContextVars so the
model can stream natural language while structured payloads ride along in the
SSE metadata. That keeps card data out of the token path — faster to render and
impossible for the model to garble.

Prices are never cached: every quote goes to Odoo's pricelist for the visitor's
currency, because `list_price` is 0 on the whole catalogue and a wrong number
loses a sale.
"""
import asyncio
import contextvars
import json
import logging
from typing import Any, Optional

from langchain_core.tools import tool

from . import catalog, curriculum
from .config import get_settings
from .localization import localize_instructor_profile
from .odoo import OdooAccessDenied, image_url, odoo
from .schemas import (Batch, CourseCard, Instructor, PackageCard,
                      PriceOption)

log = logging.getLogger("nabras.tools")

CARD_SINK: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar(
    "nabras_cards", default=None)
PACKAGE_SINK: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar(
    "nabras_packages", default=None)
# NOTE: every sink must be a *mutable container that we mutate in place*.
# LangGraph runs tools in child tasks, which get a COPY of the context: a
# `ContextVar.set()` there is invisible to the SSE generator that reads it back.
# Appending to a shared list / updating a shared dict is visible; rebinding is
# not. Handing off silently stopped working the one time this was a plain set().
HANDOFF_SINK: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "nabras_handoff", default=None)
# Specializations the visitor can tap instead of typing. Same mutate-in-place
# rule as every sink above.
CHIP_SINK: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar(
    "nabras_chips", default=None)
CURRENCY: contextvars.ContextVar[str] = contextvars.ContextVar(
    "nabras_currency", default="EGP")
LANG: contextvars.ContextVar[str] = contextvars.ContextVar(
    "nabras_lang", default="")
# The latest discipline the visitor explicitly chose. A follow-up such as
# «هات المسار الشامل» has no discipline in its own words, so the tool must not
# ask the model to infer one again (or drift to a course from the CRM profile).
ACTIVE_FIELD: contextvars.ContextVar[str] = contextvars.ContextVar(
    "nabras_active_field", default="")
# "not mine" — the bridge drops this turn and lets the site's other bot answer
# the same message. Mutated in place like every sink above.
DEFER_SINK: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar(
    "nabras_defer", default=None)
# Instructor cards — a trainer is a face and a track record, and reading that
# as a paragraph of text is not the same as seeing it.
INSTRUCTOR_SINK: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar(
    "nabras_instructors", default=None)


def _cards() -> list:
    cur = CARD_SINK.get()
    return cur if cur is not None else []


def _packages() -> list:
    cur = PACKAGE_SINK.get()
    return cur if cur is not None else []


def _chips() -> list:
    cur = CHIP_SINK.get()
    return cur if cur is not None else []


def _instructor_cards() -> list:
    cur = INSTRUCTOR_SINK.get()
    return cur if cur is not None else []


async def _ensure_catalog() -> "catalog.Snapshot":
    """Tools can fire before any search in a cold process; load on demand."""
    snap = catalog.snapshot()
    if not snap.ready:
        snap = await catalog.refresh(full=True)
    return snap


def _fmt_price(value: Any, currency: str) -> Optional[str]:
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n <= 1:            # 0 and the 1-unit placeholders are not real prices
        return None
    return f"{n:,.0f} {currency}"


def _batch(e: dict) -> Batch:
    loc = e.get("address_id")
    return Batch(
        event_id=e["id"],
        starts_at=str(e.get("date_begin") or ""),
        ends_at=str(e.get("date_end") or "") or None,
        timezone=e.get("date_tz") or None,
        location=loc[1] if isinstance(loc, list) else None,
        seats_available=e.get("seats_available"),
        seats_max=e.get("seats_max"),
        registration_open=bool(e.get("registration_open")),
        url=e.get("url") or None,
    )


def _open_batches(course_id: int) -> list[dict]:
    """Only future runs that are actually bookable. `event_registrations_open`
    is computed, so this filter has to happen here, not in the Odoo domain."""
    rows = catalog.snapshot().events_by_course.get(course_id, [])
    return [e for e in rows if e.get("registration_open")]


async def _card_for(course: "catalog.Course", price: Optional[dict]) -> dict:
    snap = catalog.snapshot()
    batches = _open_batches(course.id)
    cur = price.get("currency") if price else CURRENCY.get()
    return CourseCard(
        course_id=course.id,
        title=catalog.title_for(course, LANG.get()),
        url=course.url,
        image_url=course.image_url,
        price_display=_fmt_price(price.get("price") if price else None, cur or ""),
        currency=cur,
        rating=round(course.rating, 1) if course.rating else None,
        delivery=course.delivery or None,
        duration_text=course.duration_text or None,
        categories=course.categories,
        instructors=[
            Instructor(id=i, name=snap.instructors[i].get("name", ""),
                       title=snap.instructors[i].get("job_title") or None)
            for i in course.instructor_ids if i in snap.instructors
        ],
        next_batch=_batch(batches[0]) if batches else None,
        batches_count=len(batches),
    ).model_dump()


def _brief(course: "catalog.Course", card: dict) -> dict:
    """The compact row the model reads. The card carries the display data; this
    carries only what a recommendation decision needs."""
    batches = _open_batches(course.id)
    return {
        "course_id": course.id, "title": catalog.title_for(course, LANG.get()),
        "price": card["price_display"], "currency": card["currency"],
        "delivery": course.delivery, "duration": course.duration_text,
        "categories": course.categories, "rating": card["rating"],
        "open_batches": len(batches),
        "next_start": batches[0]["date_begin"] if batches else None,
        "why": (course.subtitle or course.description)[:180],
        # who Engosoft says this course is for — the KB's own answer, so the
        # recommendation can be matched to the person instead of the keyword
        **{k: v for k, v in curriculum.audience_for(course.id).items() if v},
        "field": course.field_name or None,
    }


def _checkout_url(variant_id: int) -> str:
    return (f"{get_settings().shop_base}/shop/cart/update"
            f"?product_id={variant_id}&add_qty=1&express=1")


async def _emit_courses(courses: list["catalog.Course"]) -> list[dict]:
    """Price a set of courses in ONE Odoo round-trip, push their cards, and
    return the briefs. A track is 6-10 courses; pricing them one by one would
    put ten sequential calls in the reply path."""
    if not courses:
        return []
    currency = CURRENCY.get()
    ids = [c.id for c in courses]
    try:
        prices = await odoo.fetch_prices(ids, currency)
    except Exception:  # noqa: BLE001
        log.exception("price lookup failed")
        prices = {}
    # A card without a buy button is a recommendation the customer has to go and
    # act on somewhere else. One query gives every card one.
    try:
        variants = await odoo.fetch_variant_ids(ids)
    except Exception:  # noqa: BLE001
        log.exception("variant lookup failed — cards will show details only")
        variants = {}
    out = []
    for c in courses:
        card = await _card_for(c, prices.get(c.id))
        if variants.get(c.id) and card.get("price_display"):
            card["checkout_url"] = _checkout_url(variants[c.id])
        _cards().append(card)
        out.append(_brief(c, card))
    return out


# ==========================================================================
@tool
async def search_courses(query: str, top_k: int = 4,
                         category: Optional[str] = None,
                         delivery: Optional[str] = None) -> str:
    """Search the Engosoft course catalogue.

    Use for any 'recommend / find / do you have' request. `category` may be one
    of: BIM, Electrical, Mechanical, Civil and Structural, Interior Design and
    Decoration, Management and Safety, Best Seller. `delivery` may be
    'recorded', 'attendance', 'attendance_recorded' or 'exam_simulator'.
    Returns real courses with live prices. Never invent a course this did not
    return; the matching cards are shown to the user automatically.
    """
    snap = catalog.snapshot()
    if not snap.ready:
        try:
            await catalog.refresh(full=True)
        except Exception as e:  # noqa: BLE001
            log.exception("catalogue unavailable")
            return json.dumps({"error": "catalog_unavailable", "detail": str(e)[:200]})

    found = catalog.search(query, top_k=max(1, min(top_k, 8)),
                           category=category, delivery=delivery,
                           field_name=curriculum.field_of_query(query)
                           if not category else None)
    if not found:                       # discipline too narrow -> plain search
        found = catalog.search(query, top_k=max(1, min(top_k, 8)),
                               category=category, delivery=delivery)
    if not found:
        return json.dumps({"results": [], "note": "no_match"}, ensure_ascii=False)

    # one path for pricing, carding and the buy button — search must not drift
    # from what a track recommendation shows
    return json.dumps(await _emit_courses(found), ensure_ascii=False)


@tool
async def get_course_details(course_id: int) -> str:
    """Full detail for one course: live price, delivery format, duration,
    certificate, instructors, and every upcoming bookable batch with its dates.
    Call before recommending a specific course strongly."""
    snap = await _ensure_catalog()
    c = snap.courses.get(course_id)
    if not c:
        return json.dumps({"error": "not_found", "course_id": course_id})

    currency = CURRENCY.get()
    try:
        price = (await odoo.fetch_prices([course_id], currency)).get(course_id)
    except Exception:  # noqa: BLE001
        log.exception("price lookup failed")
        price = None

    card = await _card_for(c, price)
    _cards().append(card)
    batches = _open_batches(course_id)
    return json.dumps({
        "course_id": c.id, "title": c.name, "url": c.url,
        "price": card["price_display"], "currency": card["currency"],
        "delivery": c.delivery, "duration": c.duration_text,
        "certificate": c.certificate_text, "categories": c.categories,
        "lessons": c.total_slides, "rating": card["rating"],
        "enrolled": c.members,
        "instructors": card["instructors"],
        "instructor_tagline": c.instructor_tagline,
        "summary": (c.subtitle or c.description)[:700],
        "batches": [{
            "event_id": b["id"], "starts": b["date_begin"], "ends": b.get("date_end"),
            "timezone": b.get("date_tz"),
            "location": b["address_id"][1] if isinstance(b.get("address_id"), list) else None,
        } for b in batches[:6]],
    }, ensure_ascii=False)


@tool
async def get_upcoming_batches(course_id: Optional[int] = None,
                               limit: int = 8) -> str:
    """Upcoming bookable batches — dates, location and timezone.
    Omit `course_id` for the soonest batches across the whole catalogue."""
    snap = await _ensure_catalog()
    if course_id:
        rows = _open_batches(course_id)
    else:
        rows = [e for lst in snap.events_by_course.values() for e in lst
                if e.get("registration_open")]
        rows.sort(key=lambda e: str(e.get("date_begin")))
    if not rows:
        return json.dumps({"batches": [], "note": "no_open_batches"}, ensure_ascii=False)

    by_channel = {c.channel_id: c for c in snap.courses.values() if c.channel_id}
    out = []
    for b in rows[:max(1, min(limit, 20))]:
        ch = b.get("course_id")
        course = by_channel.get(ch[0]) if isinstance(ch, list) else None
        out.append({
            "event_id": b["id"], "title": b.get("name"),
            "course_id": course.id if course else None,
            "course_title": course.name if course else None,
            "starts": b.get("date_begin"), "ends": b.get("date_end"),
            "timezone": b.get("date_tz"),
            "location": b["address_id"][1] if isinstance(b.get("address_id"), list) else None,
            "sessions": b.get("total_lectures_number"),
            "url": b.get("url"),
        })
    return json.dumps(out, ensure_ascii=False)


@tool
async def get_price(course_id: int, currency: Optional[str] = None) -> str:
    """Live price for a course, in the visitor's currency (EGP, USD, AED, SAR).

    Always call this before stating any number. Engosoft prices are per-region
    and are NOT on the product record — quoting anything else will be wrong.
    """
    s = get_settings()
    cur = (currency or CURRENCY.get() or s.default_currency).upper()
    if cur not in s.supported_currencies:
        return json.dumps({"error": "unsupported_currency",
                           "supported": s.supported_currencies})
    try:
        price = (await odoo.fetch_prices([course_id], cur)).get(course_id)
    except Exception as e:  # noqa: BLE001
        log.exception("price lookup failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    if not price:
        return json.dumps({"error": "no_price_rule", "course_id": course_id,
                           "currency": cur,
                           "hint": "send the course URL instead of a number"})
    display = _fmt_price(price.get("price"), price.get("currency") or cur)
    updated = False
    for card in _cards():
        if card.get("course_id") == course_id:
            card["price_display"] = display
            card["currency"] = price.get("currency") or cur
            updated = True
    if not updated:
        snap = await _ensure_catalog()
        course = snap.courses.get(course_id)
        if course:
            _cards().append(await _card_for(course, price))
    return json.dumps({"course_id": course_id, "price": price.get("price"),
                       "currency": price.get("currency") or cur,
                       "display": display}, ensure_ascii=False)


@tool
async def get_instructor(instructor_id: Optional[int] = None,
                         name: Optional[str] = None,
                         course_id: Optional[int] = None) -> str:
    """Look up an instructor by name, or list the instructors of a course.

    Prefer `instructor_id` — the id from the instructor list in your
    instructions. You are the one who matches «عمرو كمال» to "Amr Kamal";
    that list is the only set of people that exist.

    `name` is the fallback when the person is not on that list (it is capped):
    it matches on the spelling-independent form of the name and searches every
    employee, not just the listed ones. If `matched` comes back false these are
    only *similar* names — ask which course they mean. Never state that an
    instructor does not exist: a spelling you cannot match is not proof.

    Returns only what Engosoft records — job title, department, and the courses
    they actually teach. Never invent a biography or a credential.
    """
    snap = await _ensure_catalog()
    if instructor_id:
        # The id you read off the instructor list in your instructions: an
        # exact record, no guessing about spelling on either side.
        e = snap.instructors.get(int(instructor_id))
        if e:
            return json.dumps(
                {"matched": True,
                 "instructors": await _with_profile([_instructor_brief(e, snap)])},
                ensure_ascii=False)
        try:
            rows = await odoo.fetch_instructors([int(instructor_id)])
        except Exception:  # noqa: BLE001
            rows = {}
        if rows:
            return json.dumps(
                {"matched": True, "instructors": await _with_profile(
                    [_instructor_brief(list(rows.values())[0], snap)])},
                ensure_ascii=False)
        return json.dumps({"matched": False, "instructors": [],
                           "note": "unknown_id_use_the_name_or_the_course"},
                          ensure_ascii=False)
    if course_id:
        c = snap.courses.get(course_id)
        if not c:
            return json.dumps({"error": "not_found"})
        rows = [snap.instructors[i] for i in c.instructor_ids if i in snap.instructors]
        if not rows:
            return json.dumps({"instructors": [], "note": "not_recorded"})
        return json.dumps(
            {"matched": True, "instructors": await _with_profile(
                [_instructor_brief(e, snap) for e in rows])},
            ensure_ascii=False)

    try:
        everyone = await odoo.fetch_all_instructors()
    except Exception as e:  # noqa: BLE001
        log.exception("instructor lookup failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    # Anyone attached to a live course is a teacher of ours whatever their job
    # title says, so they are searchable even if the directory filter missed them.
    seen = {e["id"] for e in everyone}
    everyone = everyone + [e for i, e in snap.instructors.items() if i not in seen]

    needle = (name or "").strip()
    if not needle:
        return json.dumps({"matched": True, "instructors": [
            _instructor_brief(e, snap) for e in everyone[:12]]}, ensure_ascii=False)

    wanted = catalog.name_keys(needle)
    scored = []
    for e in everyone:
        keys = catalog.name_keys(e.get("name") or "")
        hits = len(wanted & keys)
        if needle.lower() in (e.get("name") or "").lower():
            hits += len(wanted) + 1          # a literal match outranks everything
        if hits:
            scored.append((hits, e))
    scored.sort(key=lambda x: -x[0])
    best = scored[0][0] if scored else 0
    # every part of the typed name accounted for = we found the person
    confident = bool(wanted) and best >= len(wanted)
    rows = [e for h, e in scored if h == best][:6] if confident else \
           [e for _, e in scored[:4]]
    if not rows:
        return json.dumps({"matched": False, "instructors": [],
                           "note": "no_similar_name_ask_which_course"},
                          ensure_ascii=False)
    return json.dumps({
        "matched": confident,
        "note": None if confident else "similar_names_only_confirm_the_course",
        "instructors": await _with_profile(
            [_instructor_brief(e, snap) for e in rows]),
    }, ensure_ascii=False)


async def _with_profile(cards: list[dict]) -> list[dict]:
    """Attach the biography, specialisations and experience the site shows.

    Only for a short list: this is one extra Odoo read, worth it when the answer
    IS the trainer, wasteful when we are listing ten of them.
    """
    if not cards or len(cards) > 3:
        return cards
    details = {}
    try:
        details = await odoo.fetch_instructor_details(
            [c["id"] for c in cards], LANG.get())
    except Exception:  # noqa: BLE001
        log.exception("instructor profile fetch failed")
    for c in cards:
        # A repeated tool call reuses the sink object. Rebuild its profile from
        # the current Odoo read instead of appending every section a second time.
        c["bio"] = None
        c["sections"] = []
        data = details.get(c["id"]) or {}
        identity = data.get("__identity__") or {}
        for source, target in (
            ("name", "name"), ("title", "title"),
            ("department", "department"),
        ):
            if identity.get(source):
                c[target] = identity[source]
        for key, val in data.items():
            if key == "__identity__":
                continue
            if "items" in val:
                c["sections"].append({"label": val["label"], "items": val["items"]})
            elif not c.get("bio") and len(val.get("text", "")) > 60:
                c["bio"] = val["text"]          # the longest free text is the bio
            elif val.get("text"):
                c["sections"].append({"label": val["label"],
                                      "items": [val["text"]]})
    # A result can contain up to three people. Translate those profiles in
    # parallel so a comparison does not pay three sequential model round-trips.
    localized_cards = await asyncio.gather(*(
        localize_instructor_profile(c, LANG.get()) for c in cards
    ))
    for c, localized in zip(cards, localized_cards):
        if localized is not c:
            c.clear()
            c.update(localized)
    return cards


def _instructor_brief(e: dict, snap: "catalog.Snapshot") -> dict:
    """What Odoo holds about this person, plus what they actually teach.

    The courses are the honest version of "what is he specialised in" — the
    alternative is the model inferring a speciality, which is how a trainer
    acquires a credential nobody gave them.
    """
    teaches = [catalog.title_for(c, LANG.get()) for c in snap.courses.values()
               if e["id"] in c.instructor_ids]
    dept = e.get("department_id")
    card = Instructor(
        id=e["id"], name=(e.get("name") or "").strip(),
        title=e.get("job_title") or None,
        # hr.employee images are binary columns; the URL is derived from the id
        # exactly like a product's. If the site does not serve it publicly the
        # widget falls back to initials rather than a broken frame.
        image_url=image_url("hr.employee", e["id"], "image_512"),
        department=dept[1] if isinstance(dept, list) else None,
        teaches=teaches[:8], courses_count=len(teaches),
    ).model_dump()
    # A model can call get_instructor twice while refining one answer.  Both
    # calls refer to the same person, so the UI must receive one up-to-date card
    # rather than two identical cards in the same assistant turn.
    sink = _instructor_cards()
    existing = next((x for x in sink if x.get("id") == card["id"]), None)
    if existing is not None:
        existing.clear()
        existing.update(card)
        return existing
    sink.append(card)
    return card


ATTENDANCE_LABELS = {
    "both_attendees": "أونلاين أو حضوري",
    "online_only": "أونلاين",
    "onsite_only": "حضوري بالمقر",
}
MODE_LABELS = {
    "recorded": "مسجّل",
    "attendance_online": "حضوري أونلاين",
    "attendance_onsite": "حضوري بالمقر",
}


def _price_options(pkg: dict, groups: list[dict], cur: str) -> list[dict]:
    """Every way this package can actually be bought.

    Verified against the live data: `final_price == total_price * (1 - discount/100)`
    holds exactly for all six discounted packages. The attendance modes follow
    the same shape, priced per cohort — the group carries the list price and the
    package carries the per-mode discount, so each cohort ends up with its own
    figure (Interior Design: 15,000 online, 32,004 / 33,750 / 45,475 onsite).
    Returning one number for all of that is what misquotes by multiples.
    """
    opts: list[dict] = []

    def add(mode, label, gross, discount, group=None):
        if not gross or gross <= 1:
            return
        net = gross * (1 - (discount or 0) / 100.0)
        disp = _fmt_price(net, cur)
        if not disp:
            return
        opts.append(PriceOption(
            mode=mode, label=label, price=round(net, 2), price_display=disp,
            was_display=_fmt_price(gross, cur) if (discount or 0) > 0 else None,
            discount=round(discount, 1) if discount else None,
            group_id=group.get("id") if group else None,
            group_name=group.get("full_display_name") if group else None,
            starts_at=str(group.get("first_event_date")) if group else None,
        ).model_dump())

    # 1) the self-paced recorded track
    if (pkg.get("package_type") or "") in ("recorded", "both"):
        add("recorded", MODE_LABELS["recorded"],
            pkg.get("total_price"), pkg.get("discount"))

    # 2+3) one option per sellable cohort, per attendance mode
    for g in groups:
        starts = str(g.get("first_event_date") or "")[:10]
        name = g.get("full_display_name") or g.get("name") or ""
        add("attendance_online",
            f"{MODE_LABELS['attendance_online']} — {name}".strip(" —"),
            g.get("online_total_price"), pkg.get("attendee_online_discount"), g)
        add("attendance_onsite",
            f"{MODE_LABELS['attendance_onsite']} — {name}".strip(" —"),
            g.get("onsite_total_price"), pkg.get("attendee_onsite_discount"), g)
    return opts


def _by_package(rows: list[dict]) -> dict[int, list]:
    out: dict[int, list] = {}
    for r in rows:
        pid = r.get("package_id")
        if isinstance(pid, list):
            out.setdefault(pid[0], []).append(r)
    return out


def _merged_lines(data: dict) -> list[dict]:
    """A track has TWO line models in Odoo: the recorded list and the attendance
    list. A course can sit in either or both, so the path the trainee follows is
    the union — reading one model alone hides half the track."""
    rows = list(data.get("lines") or [])

    def key(r: dict):
        pid, prod = r.get("package_id"), r.get("product_id")
        if isinstance(pid, list) and isinstance(prod, list):
            return (pid[0], prod[0])
        return None

    seen = {k for k in (key(r) for r in rows) if k}
    for r in data.get("attendee_lines") or []:
        k = key(r)
        if k and k in seen:
            continue
        if k:
            seen.add(k)
        rows.append(r)
    return rows


def _package_index(data: dict) -> dict:
    """Group every child model by package once, so both package tools read the
    same structure instead of re-deriving it."""
    return {
        "lines": _by_package(_merged_lines(data)),
        "levels": _by_package(data.get("levels", [])),
        "groups": _by_package(data.get("groups", [])),
        "outcomes": {o["id"]: o.get("name", "") for o in data.get("outcomes", [])},
    }


def _package_lines(pkg_id: int, idx: dict) -> list[dict]:
    """The track in teaching order: by level first, then the line sequence —
    which is the order a trainee is meant to take the courses in."""
    levels = {l["id"]: l for l in idx["levels"].get(pkg_id, [])}

    def key(line: dict):
        lv = line.get("level_id")
        seq = levels.get(lv[0], {}).get("sequence", 9999) if isinstance(lv, list) else 9999
        return (seq, line.get("sequence") or 0)

    return sorted(idx["lines"].get(pkg_id, []), key=key)


def _build_package(p: dict, idx: dict) -> tuple[PackageCard, dict]:
    """One package -> (card pushed to the widget, brief the model reads)."""
    lines = _package_lines(p["id"], idx)
    groups = [g for g in idx["groups"].get(p["id"], []) if g.get("is_available_for_sale")]
    groups.sort(key=lambda g: str(g.get("first_event_date") or "9999"))
    cur = p["currency_id"][1] if isinstance(p.get("currency_id"), list) else CURRENCY.get()
    options = _price_options(p, groups, cur)
    cheapest = min(options, key=lambda o: o["price"]) if options else None
    hours = (p.get("training_hours_attendee") or 0) + (p.get("training_hours_recorded") or 0)
    levels = [l.get("name", "") for l in
              sorted(idx["levels"].get(p["id"], []), key=lambda x: x.get("sequence") or 0)]
    includes = [str(l.get("name") or "") for l in lines][:12]

    card = PackageCard(
        package_id=p["id"], title=(p.get("name") or "").strip(),
        url=p.get("url") or "",
        price_options=options,
        price_from_display=cheapest["price_display"] if cheapest else None,
        currency=cur,
        courses_count=p.get("num_courses_display") or len(lines) or None,
        training_hours=hours or None,
        attendance=ATTENDANCE_LABELS.get(p.get("attendee_type")),
        rating=round(p.get("review_rating_avg") or 0, 1) or None,
        badge=p.get("badge_text") or None,
        next_group=groups[0].get("full_display_name") if groups else None,
        starts_at=str(groups[0].get("first_event_date")) if groups else None,
        levels=[x for x in levels if x],
        includes=includes,
    )
    brief = {
        "package_id": p["id"], "title": card.title,
        "price_from": card.price_from_display, "currency": cur,
        "price_options": [
            {k: o[k] for k in ("mode", "label", "price_display",
                               "was_display", "discount", "starts_at")}
            for o in options],
        "courses": card.courses_count, "hours": card.training_hours,
        "attendance": card.attendance, "levels": card.levels,
        "sellable_cohorts": len(groups),
        "includes": includes,
        "outcomes": [idx["outcomes"][i] for i in (p.get("learning_outcomes_ids") or [])
                     if i in idx["outcomes"]][:6],
    }
    return card, brief


@tool
async def search_packages(query: Optional[str] = None) -> str:
    """Training packages (المسارات) — multi-course tracks sold as one bundle.

    The highest-value offer, so check for a relevant package before selling a
    single course. Each package returns `price_options`: the self-paced recorded
    track, plus an online and an onsite figure for EVERY upcoming cohort, each
    with its own date and discount. Present the options and let the trainee
    choose the mode and the cohort — never merge them into one price.
    """
    snap = await _ensure_catalog()
    data = await catalog.ensure_packages()
    if not data.get("available"):
        return json.dumps({"packages": [], "available": False,
                           "note": "package_data_unavailable"}, ensure_ascii=False)

    idx = _package_index(data)
    q = catalog.tokens(query or "")
    field = curriculum.field_of_query(query or "")
    out = []
    for p in data.get("packages", []):
        plines = idx["lines"].get(p["id"], [])
        blob = catalog.tokens(
            " ".join([p.get("name") or ""] +
                     [str(l.get("name") or "") for l in plines]))
        token_match = bool(q & blob)
        pkg_field = _package_field(plines)
        # Discipline over spelling: on a field-scoped query keep only that
        # discipline's tracks (a mechanical question never returns a BIM track),
        # unless the name/lines matched the words directly.
        if field and pkg_field and pkg_field != field and not token_match:
            continue
        if q and not token_match and not (field and pkg_field == field):
            continue
        card, brief = _build_package(p, idx)
        _packages().append(card.model_dump())
        out.append(brief)
    if not out:
        return json.dumps({"packages": [], "note": "no_match"}, ensure_ascii=False)
    return json.dumps(out, ensure_ascii=False)


# --------------------------------------------------------------- the track
# What a trainee actually types, mapped to the Odoo product.public.category it
# belongs to. Odoo's category names are English only, so "أنا في تخصص ميكانيكا"
# matches nothing without this table — and the tool would answer a mechanical
# engineer with interior design courses.
TRACK_ALIASES: dict[str, tuple[str, ...]] = {
    "BIM": ("bim", "بيم", "نمذجة", "نمذجة المعلومات", "revit", "ريفيت",
            "navisworks", "نافيسوركس", "تنسيق"),
    "Mechanical": ("mechanical", "ميكانيكا", "ميكانيكال", "ميكانيكي", "ميكانيكية",
                   "hvac", "تكييف", "تبريد", "plumbing", "صحية", "سباكة",
                   "firefighting", "حريق", "mep"),
    "Electrical": ("electrical", "كهرباء", "كهربا", "كهربائي", "كهربائية",
                   "الكتريكال", "dialux", "etap", "جهد", "اضاءة"),
    "Civil and Structural": ("civil", "structural", "مدني", "مدنية", "انشائي",
                             "انشائية", "انشاءات", "خرسانة", "خرسانية", "staad",
                             "etabs", "sap", "safe", "تنفيذ"),
    "Interior Design and Decoration": ("interior", "decoration", "ديكور",
                                       "تشطيبات", "داخلي", "داخلية", "sketchup",
                                       "3ds", "max"),
    "Management and Safety": ("management", "safety", "ادارة", "اداري", "سلامة",
                              "امن", "pmp", "primavera", "بريمافيرا", "مشاريع",
                              "مشروعات", "تخطيط"),
}
_ALIAS_TOKENS = {cat: catalog.tokens(" ".join(words))
                 for cat, words in TRACK_ALIASES.items()}

# Odoo stores category names in English. A visitor picking their field should
# read it in their own language, so the chip carries the Arabic label and the
# English name stays the key everything else matches on.
# Worded exactly as the shop's own category sidebar, so a visitor who just
# scrolled past "المدني والانشائي" is offered that, not a synonym of it.
SPEC_LABELS = {
    "BIM": "دورات الـ BIM",
    "Electrical": "كهرباء",
    "Mechanical": "ميكانيكا",
    "Civil and Structural": "المدني والانشائي",
    "Interior Design and Decoration": "التصميم الداخلي و الديكور",
    "Management and Safety": "الادارة والسلامة",
}
# A merchandising tag, not a field of engineering — offering it as a
# "specialization" tells a mechanical engineer nothing about where they belong.
NOT_SPECIALIZATIONS = {"Best Seller", "Best Sellers", "All Courses"}

# Shop specialization (the chip / TRACK_ALIASES key) -> the KB discipline field.
# Lets a package's course-derived field be compared against what the visitor
# picked. BIM has no single KB field (its courses aren't field-mapped), so it is
# deliberately absent and falls back to name/category matching.
SPEC_TO_FIELD = {
    "Mechanical": "Mechanical",
    "Electrical": "Electrical",
    "Civil and Structural": "Civil",
    "Interior Design and Decoration": "Interior Design",
    "Management and Safety": "Management",
}


def _package_field(lines: list[dict]) -> Optional[str]:
    """A package's discipline is its COURSES', not the words in its name.

    "BIM MEP Professional Track" carries the mechanical word "MEP" in its name,
    but its courses are BIM (Revit, Navisworks) — so a mechanical question must
    never land on it. Reading the field from the member courses (via the KB) is
    what tells the two apart; the majority discipline wins.
    """
    counts: dict[str, int] = {}
    for line in lines:
        pid = line.get("product_id")
        if isinstance(pid, list):
            f = curriculum.field_for(pid[0])
            if f:
                counts[f] = counts.get(f, 0) + 1
    return max(counts, key=counts.get) if counts else None


def _spec_packages(data: dict, spec: str) -> list[dict]:
    """Tracks that belong to a specialization.

    Primary signal is the discipline of the track's own courses (the KB field);
    Odoo category and name words are only fallbacks. A track whose courses are a
    DIFFERENT discipline is excluded even if its name shares a word — that is the
    "BIM MEP under Mechanical" bug.
    """
    if not spec or not data.get("available"):
        return []
    categories = catalog.snapshot().categories
    words = _ALIAS_TOKENS.get(spec, set()) | catalog.tokens(spec)
    lines_by = _by_package(_merged_lines(data))
    want_field = SPEC_TO_FIELD.get(spec)
    out = []
    for p in data.get("packages", []):
        pkg_field = _package_field(lines_by.get(p["id"], []))
        if want_field and pkg_field and pkg_field != want_field:
            continue                      # a different discipline — never here
        by_field = bool(want_field) and pkg_field == want_field
        by_categ = spec in [categories.get(i) for i in (p.get("public_categ_ids") or [])]
        by_name = bool(words & catalog.tokens(p.get("name") or ""))
        if by_field or by_categ or by_name:
            out.append(p)
    return out


@tool
async def list_specializations() -> str:
    """Every specialization (تخصص) Engosoft trains in, and what is inside each.

    Use when the trainee asks what fields you cover, or has not said where they
    belong yet — "أنا مهندس، عندكم إيه؟". Returns each specialization with how
    many courses it has, sample course names, and the tracks (باقات) inside it.
    The visitor also gets them as tappable chips, so don't list them twice:
    say one line and let them pick.
    """
    snap = await _ensure_catalog()
    data = await catalog.ensure_packages()
    # Engosoft's own disciplines first — those are the six the business trains
    # in. Shop categories are only a fallback for a catalogue the map misses.
    by_cat: dict[str, list] = {}
    for f in curriculum.fields():
        rows = catalog.courses_in_field(f)
        if rows:
            by_cat[f] = rows
    if not by_cat:
        for c in snap.courses.values():
            for name in c.categories:
                by_cat.setdefault(name, []).append(c)

    out = []
    for name, courses in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
        if name in NOT_SPECIALIZATIONS:
            continue
        packages = _spec_packages(data, name)
        out.append({
            "specialization": name,
            "label": curriculum.FIELD_LABELS.get(name, SPEC_LABELS.get(name, name)),
            "courses": len(courses),
            "examples": [catalog.title_for(c, LANG.get()) for c in courses[:3]],
            "tracks": [p.get("name") for p in packages][:4],
        })
        _chips().append({"title": curriculum.FIELD_LABELS.get(
                             name, SPEC_LABELS.get(name, name)),
                         "value": f"أنا في تخصص {name}"})
    return json.dumps({"specializations": out,
                       "packages_loaded": bool(data.get("available"))},
                      ensure_ascii=False)


def resolve_specialization(query: str) -> Optional[str]:
    """Map free text to a shop category (merchandising), for card filtering."""
    q = catalog.tokens(query)
    if not q:
        return None
    best, score = None, 0
    for cat, words in _ALIAS_TOKENS.items():
        hit = len(q & words)
        if hit > score:
            best, score = cat, hit
    for name in catalog.snapshot().categories.values():
        hit = len(q & catalog.tokens(name))
        if hit > score:
            best, score = name, hit
    return best


def resolve_field(query: str) -> Optional[str]:
    """The DISCIPLINE the question is about, from Engosoft's own course map.

    This is the one that decides what gets recommended. It knows «تكييف» is
    Mechanical because the KB lists that word under an HVAC course — no
    hand-written synonym table can keep up with that.
    """
    return curriculum.field_of_query(query)


def active_field_from_messages(messages: list[str]) -> str:
    """Return the most recently named Engosoft discipline/specialisation.

    The shop aliases remain useful when the shipped curriculum has been pruned
    (for example during a partial catalogue refresh), while the curriculum map
    gives us the more precise discipline when it is available.
    """
    field_to_spec = {field: spec for spec, field in SPEC_TO_FIELD.items()}
    for message in reversed(messages):
        spec = resolve_specialization(message)
        if spec and spec not in NOT_SPECIALIZATIONS:
            return spec
        field = resolve_field(message)
        if field:
            return field_to_spec.get(field, field)
    return ""


def _is_contextual_comprehensive_track(query: str) -> bool:
    """Whether *query* refers to a comprehensive track without naming a field."""
    words = catalog.tokens(query)
    comprehensive = {"شامل", "شامله", "كامل", "متكامل", "comprehensive"}
    track_words = {"مسار", "المسار", "باقه", "الباقه", "track", "package"}
    return bool(words & comprehensive) and bool(words & track_words)


def _match_package(data: dict, query: str, spec: Optional[str] = None) -> Optional[dict]:
    """The package a trainee means by "أنا في باقة كذا".

    Title words weigh most: "باقة الميكانيكا" is the track named that, not every
    track that happens to contain one mechanical course. The specialization is
    scored too, because package names in Odoo are English while the question is
    usually Arabic — "باقة الكهربا" has zero words in common with "Electrical
    Design Professional Track" and would otherwise match nothing.
    """
    q = catalog.tokens(query)
    if not q or not data.get("available"):
        return None
    lines_by = _by_package(_merged_lines(data))
    spec_tokens = _ALIAS_TOKENS.get(spec or "", set()) | catalog.tokens(spec or "")
    categories = catalog.snapshot().categories
    # The discipline the question is about, and (below) each package's own
    # discipline read from its courses. A mechanical question must land on the
    # mechanical track, not on a BIM track that merely has "MEP" in its name.
    field = resolve_field(query) or SPEC_TO_FIELD.get(spec or "")
    best, best_score = None, 0.0
    for p in data.get("packages", []):
        name_tok = catalog.tokens(p.get("name") or "")
        plines = lines_by.get(p["id"], [])
        line_hits = len(q & catalog.tokens(" ".join(
            str(l.get("name") or "") for l in plines)))
        in_spec = spec and spec in [categories.get(i) for i in
                                    (p.get("public_categ_ids") or [])]
        score = (2.0 * len(q & name_tok) + 0.5 * line_hits
                 + 1.5 * len(spec_tokens & name_tok) + (2.0 if in_spec else 0))
        pkg_field = _package_field(plines)
        if field and pkg_field:
            score += 4.0 if field == pkg_field else -3.0
        if score > best_score:
            best, best_score = p, score
    return best


def _level_name(line: dict) -> Optional[str]:
    lv = line.get("level_id")
    return lv[1] if isinstance(lv, list) and len(lv) > 1 else None


def _level_matches(line: dict, wanted: str) -> bool:
    name = (_level_name(line) or "").lower()
    want = wanted.strip().lower()
    digits = "".join(ch for ch in want if ch.isdigit())
    if digits:                       # "ليفل ٢" / "level 2" / "المستوى 2"
        return digits in name
    return bool(want) and want in name


@tool
async def recommend_track(track: str, level: Optional[str] = None,
                          top_k: int = 6) -> str:
    """Courses recommended inside one track or specialization.

    Call this the moment the trainee places themselves — "أنا في باقة كذا",
    "أنا في تخصص ميكانيكا", "I'm on the BIM track". `track` is their own words;
    `level` optionally narrows to one level of the package ("Level 2").

    Returns the package's courses in teaching order grouped by level, each with
    a live price and its next bookable batch, plus related courses in the same
    specialization. If no package matches, it still recommends the right
    courses from that specialization. Cards render automatically.
    """
    snap = await _ensure_catalog()
    # A track question is exactly the moment the package data has to be right,
    # so it is pulled now rather than waiting for the next scheduled push.
    packages = await catalog.ensure_packages()
    limit = max(1, min(top_k, 12))
    active_spec = ACTIVE_FIELD.get()
    spec = resolve_specialization(track) or active_spec or None
    field_name = resolve_field(track) or SPEC_TO_FIELD.get(active_spec, "") or None

    # Elliptical follow-ups are resolved deterministically from the transcript,
    # not left to the LLM. «المسار الشامل» after «ميكانيكا» therefore becomes
    # the official «ميكانيكا شاملة» grouping rule, never CFM/PMP from a profile.
    effective_track = track
    group = curriculum.match_group(track)
    if not group and active_spec and _is_contextual_comprehensive_track(track):
        label = SPEC_LABELS.get(active_spec,
                                curriculum.FIELD_LABELS.get(field_name or "",
                                                            active_spec))
        effective_track = f"{label} شاملة"
        group = curriculum.match_group(effective_track)
        log.info("resolved contextual track %r with active field %s as %r",
                 track, active_spec, effective_track)

    # 1. Engosoft's own grouping rule, when the question names one. This is the
    #    authoritative contents of "الميكانيكا الشاملة" and the rest — it beats
    #    any search, because it is a list somebody wrote on purpose.
    if group:
        picked: list[catalog.Course] = []
        for oid in curriculum.group_members(group):
            course = snap.courses.get(oid)
            if course is not None and course not in picked:
                picked.append(course)
        if picked:
            return json.dumps({
                "track": None, "specialization": field_name or spec,
                "label": curriculum.FIELD_LABELS.get(field_name or "", field_name),
                "note": "engosoft_grouping_rule",
                "rule": group.get("rule"),
                "courses": await _emit_courses(picked[:limit]),
            }, ensure_ascii=False)

    # 1-b. A bare discipline. `match_group` only answers to a package's own
    #      name, so «مدني» — and even «ميكانيكا», which has exactly one package
    #      waiting for it — used to fall straight through to a generic search.
    if not group and field_name:
        siblings = curriculum.groups_for_field(field_name)
        if len(siblings) == 1:
            group = siblings[0]
            picked = []
            for oid in curriculum.group_members(group):
                course = snap.courses.get(oid)
                if course is not None and course not in picked:
                    picked.append(course)
            if picked:
                return json.dumps({
                    "track": None, "specialization": field_name,
                    "label": curriculum.FIELD_LABELS.get(field_name, field_name),
                    "note": "engosoft_grouping_rule",
                    "rule": group.get("rule"),
                    "courses": await _emit_courses(picked[:limit]),
                }, ensure_ascii=False)
        elif len(siblings) > 1:
            # Several real products, and no combined one to offer: civil is sold
            # as three separate tracks. Synthesising a "comprehensive civil"
            # would have the bot quote a package nobody can buy, so the customer
            # picks instead. Chips render as buttons, so the model must not
            # repeat the list in prose.
            options = [{"label": curriculum.group_label(g),
                        "rule": g.get("rule"),
                        "courses_count": len(curriculum.group_members(g))}
                       for g in siblings]
            for opt in options:
                _chips().append({"title": opt["label"],
                                 "value": f"أريد مسار {opt['label']}"})
            return json.dumps({
                "specialization": field_name,
                "label": curriculum.FIELD_LABELS.get(field_name, field_name),
                "note": "field_has_several_tracks",
                "ask": "اسأل العميل أي مسار يناسبه — الخيارات ظاهرة كأزرار، "
                       "فلا تكررها في النص، ولا تجمعها في باقة واحدة.",
                "tracks": options,
            }, ensure_ascii=False)

    pkg = _match_package(packages, effective_track, spec)

    if not pkg:
        # No single track owns the question ("أنا في تخصص ميكانيكا"), so answer
        # with the specialization itself: its courses AND the tracks inside it,
        # which is what the trainee is really choosing between.
        # 2. the discipline: its own courses, in the order the KB teaches them
        found = catalog.search(effective_track, top_k=limit, field_name=field_name)
        if not found and field_name:
            found = catalog.courses_in_field(field_name)[:limit]
        if not found:
            found = catalog.search(effective_track, top_k=limit, category=spec)
        if not found:
            found = catalog.search(effective_track, top_k=limit)
        idx = _package_index(packages)
        tracks = []
        for p in _spec_packages(packages, spec or "")[:3]:
            card, brief = _build_package(p, idx)
            _packages().append(card.model_dump())
            tracks.append(brief)
        return json.dumps({
            "track": None, "specialization": field_name or spec,
            "label": curriculum.FIELD_LABELS.get(field_name or "",
                                                 SPEC_LABELS.get(spec or "", spec)),
            "note": "no_package_matched" if packages.get("available")
                    else "package_data_unavailable",
            "courses": await _emit_courses(found),
            "tracks_in_specialization": tracks,
        }, ensure_ascii=False)

    idx = _package_index(packages)
    card, brief = _build_package(pkg, idx)
    _packages().append(card.model_dump())

    lines = _package_lines(pkg["id"], idx)
    if level:
        picked = [l for l in lines if _level_matches(l, level)]
        lines = picked or lines
    spec = spec or resolve_specialization(pkg.get("name") or "")

    ordered: list[catalog.Course] = []
    level_of: dict[int, Optional[str]] = {}
    missing: list[str] = []
    for line in lines:
        pid = line.get("product_id")
        course = snap.courses.get(pid[0]) if isinstance(pid, list) else None
        if course is None:
            # A track line whose product is not in the published catalogue: it
            # is part of the path but cannot be bought on its own. Say so
            # instead of dropping it, or the path looks shorter than it is.
            missing.append(str(line.get("name") or ""))
            continue
        if course.id not in level_of:
            level_of[course.id] = _level_name(line)
            ordered.append(course)

    briefs = await _emit_courses(ordered[:limit])
    path: list[dict] = []
    for b in briefs:
        name = level_of.get(b["course_id"])
        if not path or path[-1]["level"] != name:
            path.append({"level": name, "courses": []})
        path[-1]["courses"].append(b)

    # Same specialization, not in the track: the natural next sale once the
    # path is done, and the honest answer to "وبعد الباقة أعمل إيه؟".
    extra: list[catalog.Course] = []
    if spec and len(briefs) < limit:
        in_track = {c.id for c in ordered}
        extra = [c for c in catalog.search(spec, top_k=len(in_track) + 3,
                                           category=spec)
                 if c.id not in in_track][:2]

    return json.dumps({
        "track": brief, "specialization": spec,
        "level_filter": level or None,
        "path": path,
        "not_sold_separately": missing[:8],
        "also_recommended": await _emit_courses(extra),
    }, ensure_ascii=False)


@tool
async def build_checkout_link(course_id: int) -> str:
    """Attach a direct-purchase action to a course card.

    The internal Odoo endpoint is POST-only and must NEVER be written in the
    answer as a link. The widget submits it correctly from the card's purchase
    button. Confirm the live price with get_price first.
    """
    snap = await _ensure_catalog()
    course = snap.courses.get(course_id)
    try:
        variant = await odoo.product_variant_id(course_id)
    except Exception as e:  # noqa: BLE001
        log.exception("checkout link failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    if not variant:
        return json.dumps({"error": "variant_not_found", "course_id": course_id})

    url = _checkout_url(variant)
    attached = False
    for card in _cards():
        if card.get("course_id") == course_id:
            card["checkout_url"] = url
            attached = True
    # A closing turn usually skips search_courses, so there would be no card to
    # hang the CTA on and the widget would render a "buy" line with no button.
    if not attached and course:
        cur = CURRENCY.get()
        try:
            price = (await odoo.fetch_prices([course_id], cur)).get(course_id)
        except Exception:  # noqa: BLE001
            price = None
        card = await _card_for(course, price)
        card["checkout_url"] = url
        _cards().append(card)
        attached = True
    # Deliberately do not return the raw `/shop/cart/update` URL to the model:
    # opening it as a normal link sends GET and Odoo responds Method Not Allowed.
    return json.dumps({
        "purchase_action": "attached_to_course_card" if attached else "unavailable",
        "attached_to_card": attached,
        "instruction": (
            "اختم الرد بدعوة العميل إلى استخدام زر «اشترِ الدورة الآن» في البطاقة. "
            "لا تكتب رابطًا داخل النص."
        ),
    }, ensure_ascii=False)


@tool
async def create_lead(name: str, phone: Optional[str] = None,
                      email: Optional[str] = None,
                      course_interest: Optional[str] = None,
                      field: Optional[str] = None,
                      specialization: Optional[str] = None,
                      experience: Optional[str] = None,
                      job_title: Optional[str] = None,
                      goal: Optional[str] = None,
                      notes: Optional[str] = None) -> str:
    """Create a CRM lead in Odoo for the sales advisor.

    This is the funnel's capture step, not just an escape hatch: call it once the
    visitor has given a contact method, folding in what you already qualified —
    their `field` (المجال), `specialization` (التخصص), `experience` (سنوات
    الخبرة), `job_title` (المسمى الوظيفي: مهندس · فني · مشرف · مدير) and `goal`
    (الهدف: سوق العمل · تصميم · BIM · شهادة) — so the advisor opens the lead
    already knowing who this is. A name plus one contact method (phone or email)
    is enough; never ask for anything more sensitive.
    """
    if not (phone or email):
        return json.dumps({"error": "need_contact",
                           "detail": "ask for a phone number or an email first"})
    s = get_settings()
    # A qualification line the advisor reads at a glance, above any free notes.
    qual = []
    if field:
        qual.append(f"المجال: {field}")
    if specialization:
        qual.append(f"التخصص: {specialization}")
    if job_title:
        qual.append(f"المسمى الوظيفي: {job_title}")
    if experience:
        qual.append(f"سنوات الخبرة: {experience}")
    if goal:
        qual.append(f"الهدف: {goal}")
    description = "\n".join([p for p in (" · ".join(qual), notes) if p])
    if not s.allow_crm_writes:
        # Trial mode: exercise the whole funnel without polluting the live CRM
        # with test leads. The agent still gets a success-shaped result.
        log.info("lead suppressed (ALLOW_CRM_WRITES=false): %s / %s / %s",
                 name, phone or email, " · ".join(qual) or "-")
        return json.dumps({"lead_id": None, "simulated": True,
                           "note": "trial mode — not written to Odoo"})
    payload = {
        "name": f"[ماجد] {course_interest or specialization or field or 'استفسار عن كورس'} — {name}",
        "contact_name": name, "type": "lead",
        "user_id": s.sales_advisor_id,
        "description": description, "phone": phone or "", "email_from": email or "",
    }
    # Attribution, so Majed's leads are a countable bucket beside the SLA's own
    # three website sources instead of arriving anonymous. Best-effort: a
    # missing source must never cost us the lead itself.
    try:
        source_id = await odoo.utm_source_id(s.lead_source_name)
        if source_id:
            payload["source_id"] = source_id
    except Exception as e:  # noqa: BLE001
        log.warning("lead source unavailable (%s) — creating without it", e)

    try:
        lead_id = await odoo.create_lead(payload)
    except OdooAccessDenied as e:
        return json.dumps({"error": "access_denied", "detail": str(e)[:200]})
    except Exception as e:  # noqa: BLE001
        log.exception("create_lead failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})

    # The SLA runs off activities: the advisor works "Activity Today", then
    # "Overdue Activities". A lead with none is in neither list — assigned to a
    # human and then quietly waiting. This is what puts it in the queue.
    #
    # Deliberately after the lead exists and deliberately swallowing: a failure
    # here costs the follow-up prompt, not the customer's details.
    activity_id = None
    if s.lead_activity_enabled:
        try:
            activity_id = await odoo.schedule_activity(
                lead_id, user_id=s.sales_advisor_id,
                summary=s.lead_activity_summary,
                note=description or "",
                delay_days=s.lead_activity_delay_days)
        except Exception as e:  # noqa: BLE001
            log.warning("lead %s created but no activity scheduled (%s) — "
                        "it will not appear in Activity Today", lead_id, e)

    return json.dumps({"lead_id": lead_id, "assigned_to": s.sales_advisor_id,
                       "activity_id": activity_id,
                       "in_followup_cycle": bool(activity_id)})


@tool
async def request_handoff(summary: str, reason: str = "customer_request") -> str:
    """Ask for a human agent to take over.

    This only raises a signal on the response stream — the bridge owns Chatwoot
    (conversation status, team assignment, auto-return), so Nabras must not
    write there itself or the two would fight over the same state.
    """
    sink = HANDOFF_SINK.get()
    if sink is None:
        # No active request context (direct tool call); nothing to signal to.
        return json.dumps({"status": "handoff_unavailable"})
    # Mutate in place — a rebind here would not reach the streaming generator.
    sink.update({"requested": True, "reason": reason, "summary": summary[:1000]})
    return json.dumps({"status": "handoff_requested", "reason": reason})


@tool
async def get_payment_options() -> str:
    """How the customer can actually pay, and whether instalments exist.

    Call this before answering ANY payment question — "تقسيط", "أقساط",
    "فيزا", "تحويل بنكي", "بتقبلوا إيه". Returns only the providers switched on
    for this shop. If it returns `available: false`, the shop has not told us:
    do not describe payment options from general knowledge — call
    `defer_to_bot` or `request_handoff` instead. A wrong "yes we do instalments"
    is a customer who reaches checkout and finds nothing.
    """
    data = await odoo.fetch_payment_options()
    if not data.get("available"):
        return json.dumps({"available": False, "note": "ask_a_human_or_defer"},
                          ensure_ascii=False)
    live = [p for p in data["providers"] if not p["test_mode"]]
    return json.dumps({
        "available": True,
        "methods": [p["name"] for p in live],
        "codes": [p["code"] for p in live],
        "note": "only these are live on the shop; anything else does not exist",
    }, ensure_ascii=False)


@tool
async def defer_to_bot(reason: str) -> str:
    """Hand THIS message to the site's other assistant instead of answering.

    Use when the question is outside what these tools can prove: payment or
    instalment terms this shop has not published, refunds, invoices, corporate
    or group deals, an existing order or complaint, certificate equivalence,
    careers. The customer sees one assistant either way — they are not told a
    transfer happened — so deferring costs nothing, while guessing about money
    or policy costs a customer.

    Say nothing else in the same turn: whatever you write is discarded.
    """
    sink = DEFER_SINK.get()
    if sink is None:
        return json.dumps({"status": "defer_unavailable"})
    sink.update({"deferred": True, "reason": (reason or "")[:300]})
    return json.dumps({"status": "deferred"})


TOOLS = [search_courses, get_course_details, get_upcoming_batches, get_price,
         get_instructor, search_packages, list_specializations, recommend_track,
         get_payment_options, build_checkout_link, create_lead,
         defer_to_bot, request_handoff]
