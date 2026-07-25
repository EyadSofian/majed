"""Agent tools, bound to the real Engosoft Odoo schema.

Cards and handoff requests are captured out-of-band through ContextVars so the
model can stream natural language while structured payloads ride along in the
SSE metadata. That keeps card data out of the token path — faster to render and
impossible for the model to garble.

Prices are never cached: every quote goes to Odoo's pricelist for the visitor's
currency, because `list_price` is 0 on the whole catalogue and a wrong number
loses a sale.
"""
import contextvars
import json
import logging
from typing import Any, Optional

from langchain_core.tools import tool

from . import catalog
from .config import get_settings
from .odoo import OdooAccessDenied, abs_url, odoo
from .schemas import Batch, CourseCard, Instructor, PackageCard

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
CURRENCY: contextvars.ContextVar[str] = contextvars.ContextVar(
    "nabras_currency", default="EGP")


def _cards() -> list:
    cur = CARD_SINK.get()
    return cur if cur is not None else []


def _packages() -> list:
    cur = PACKAGE_SINK.get()
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
        title=course.name,
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
                           category=category, delivery=delivery)
    if not found:
        return json.dumps({"results": [], "note": "no_match"}, ensure_ascii=False)

    currency = CURRENCY.get()
    try:
        prices = await odoo.fetch_prices([c.id for c in found], currency)
    except Exception:  # noqa: BLE001
        log.exception("price lookup failed")
        prices = {}

    brief = []
    for c in found:
        card = await _card_for(c, prices.get(c.id))
        _cards().append(card)
        batches = _open_batches(c.id)
        brief.append({
            "course_id": c.id, "title": c.name,
            "price": card["price_display"], "currency": card["currency"],
            "delivery": c.delivery, "duration": c.duration_text,
            "categories": c.categories, "rating": card["rating"],
            "open_batches": len(batches),
            "next_start": batches[0]["date_begin"] if batches else None,
            "seats_left": batches[0].get("seats_available") if batches else None,
            "why": (c.subtitle or c.description)[:180],
        })
    return json.dumps(brief, ensure_ascii=False)


@tool
async def get_course_details(course_id: int) -> str:
    """Full detail for one course: live price, delivery format, duration,
    certificate, instructors, and every upcoming bookable batch with its dates
    and remaining seats. Call before recommending a specific course strongly."""
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
            "seats_left": b.get("seats_available"), "seats_max": b.get("seats_max"),
        } for b in batches[:6]],
    }, ensure_ascii=False)


@tool
async def get_upcoming_batches(course_id: Optional[int] = None,
                               limit: int = 8) -> str:
    """Upcoming bookable batches — dates, location, timezone and remaining
    seats. Omit `course_id` for the soonest batches across the whole catalogue.
    Use the remaining-seats number honestly; never inflate scarcity."""
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
            "seats_left": b.get("seats_available"), "seats_max": b.get("seats_max"),
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
async def get_instructor(name: Optional[str] = None,
                         course_id: Optional[int] = None) -> str:
    """Look up an instructor by name, or list the instructors of a course.
    Returns only what Engosoft records — never invent a biography."""
    snap = await _ensure_catalog()
    if course_id:
        c = snap.courses.get(course_id)
        if not c:
            return json.dumps({"error": "not_found"})
        rows = [snap.instructors[i] for i in c.instructor_ids if i in snap.instructors]
        if not rows:
            return json.dumps({"instructors": [], "note": "not_recorded"})
    else:
        try:
            everyone = await odoo.fetch_all_instructors()
        except Exception as e:  # noqa: BLE001
            log.exception("instructor lookup failed")
            return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
        needle = (name or "").strip().lower()
        rows = [e for e in everyone
                if not needle or needle in (e.get("name") or "").lower()]
        if not rows:
            return json.dumps({"instructors": [], "note": "not_found"})
    return json.dumps([{
        "id": e["id"], "name": e.get("name"),
        "title": e.get("job_title"),
        "department": e["department_id"][1] if isinstance(e.get("department_id"), list) else None,
    } for e in rows[:12]], ensure_ascii=False)


ATTENDANCE_LABELS = {
    "both_attendees": "أونلاين أو حضوري",
    "online_only": "أونلاين",
    "onsite_only": "حضوري",
}


def _package_price(pkg: dict, groups: list[dict]) -> tuple:
    """Pick the number the customer would actually pay, and say which it is.

    A package carries three candidates and they are NOT interchangeable — for
    the Interior Design track they run 12,001 / 31,440 / 78,150. `final_price`
    prices the recorded track; a live cohort is priced by its own group. Quoting
    `final_price` to someone booking an onsite group understates it ~6x.
    """
    cur = pkg["currency_id"][1] if isinstance(pkg.get("currency_id"), list) else CURRENCY.get()
    for g in groups:                       # soonest sellable group wins
        online = g.get("online_total_price") or 0
        onsite = g.get("onsite_total_price") or 0
        if online > 1:
            return _fmt_price(online, cur), "group_online", cur, g
        if onsite > 1:
            return _fmt_price(onsite, cur), "group_onsite", cur, g
    return _fmt_price(pkg.get("final_price"), cur), "recorded", cur, None


@tool
async def search_packages(query: Optional[str] = None) -> str:
    """Training packages (المسارات) — multi-course tracks sold as one bundle.

    These are the highest-value offer, so check for a relevant package before
    selling a single course. The returned `price_basis` says what the price
    covers: 'recorded' (self-paced track) or 'group_online' / 'group_onsite'
    (a specific live cohort). Quote the number WITH its basis — the recorded
    price and the live-cohort price differ by several times.
    """
    snap = await _ensure_catalog()
    data = snap.packages or {}
    if not data.get("available"):
        return json.dumps({"packages": [], "available": False,
                           "note": "package_data_unavailable"}, ensure_ascii=False)

    def by_pkg(rows):
        out: dict[int, list] = {}
        for r in rows:
            pid = r.get("package_id")
            if isinstance(pid, list):
                out.setdefault(pid[0], []).append(r)
        return out

    lines_by = by_pkg(data.get("lines", []))
    levels_by = by_pkg(data.get("levels", []))
    groups_by = by_pkg(data.get("groups", []))
    outcomes = {o["id"]: o.get("name", "") for o in data.get("outcomes", [])}

    q = catalog.tokens(query or "")
    out = []
    for p in data.get("packages", []):
        lines = sorted(lines_by.get(p["id"], []), key=lambda x: x.get("sequence") or 0)
        blob = catalog.tokens(" ".join(
            [p.get("name") or ""] + [str(l.get("name") or "") for l in lines]))
        if q and not (q & blob):
            continue

        groups = [g for g in groups_by.get(p["id"], []) if g.get("is_available_for_sale")]
        groups.sort(key=lambda g: str(g.get("first_event_date") or "9999"))
        price_display, basis, cur, group = _package_price(p, groups)
        hours = (p.get("training_hours_attendee") or 0) + (p.get("training_hours_recorded") or 0)
        levels = [l.get("name", "") for l in
                  sorted(levels_by.get(p["id"], []), key=lambda x: x.get("sequence") or 0)]
        includes = [str(l.get("name") or "") for l in lines][:12]

        card = PackageCard(
            package_id=p["id"], title=(p.get("name") or "").strip(),
            url=p.get("url") or "",
            price_display=price_display, price_basis=basis, currency=cur,
            # Only show a struck-through "before" price when the discount is on
            # the same basis as the price we are quoting.
            list_price_display=(_fmt_price(p.get("total_price"), cur)
                                if basis == "recorded" and (p.get("discount") or 0) > 0
                                else None),
            discount=round(p["discount"], 1) if basis == "recorded" and p.get("discount") else None,
            courses_count=p.get("num_courses_display") or len(lines) or None,
            training_hours=hours or None,
            attendance=ATTENDANCE_LABELS.get(p.get("attendee_type")),
            rating=round(p.get("review_rating_avg") or 0, 1) or None,
            badge=p.get("badge_text") or None,
            next_group=group.get("full_display_name") if group else None,
            starts_at=str(group.get("first_event_date")) if group else None,
            levels=[x for x in levels if x],
            includes=includes,
        )
        _packages().append(card.model_dump())
        out.append({
            "package_id": p["id"], "title": card.title,
            "price": card.price_display, "price_basis": basis,
            "currency": cur, "was": card.list_price_display,
            "discount_percent": card.discount,
            "courses": card.courses_count, "hours": card.training_hours,
            "attendance": card.attendance, "levels": card.levels,
            "next_group": card.next_group, "starts": card.starts_at,
            "sellable_groups": len(groups),
            "includes": includes,
            "outcomes": [outcomes[i] for i in (p.get("learning_outcomes_ids") or [])
                         if i in outcomes][:6],
        })
    if not out:
        return json.dumps({"packages": [], "note": "no_match"}, ensure_ascii=False)
    return json.dumps(out, ensure_ascii=False)


@tool
async def build_checkout_link(course_id: int) -> str:
    """Build an express add-to-cart -> checkout link for a course, and attach it
    to that course's card so the buy button appears. Confirm the live price with
    get_price first."""
    s = get_settings()
    snap = await _ensure_catalog()
    course = snap.courses.get(course_id)
    try:
        variant = await odoo.product_variant_id(course_id)
    except Exception as e:  # noqa: BLE001
        log.exception("checkout link failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    if not variant:
        return json.dumps({"error": "variant_not_found", "course_id": course_id})

    url = (f"{s.shop_base}/shop/cart/update"
           f"?product_id={variant}&add_qty=1&express=1")
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
    return json.dumps({"checkout_url": url, "attached_to_card": attached,
                       "course_url": course.url if course else abs_url("")},
                      ensure_ascii=False)


@tool
async def create_lead(name: str, phone: Optional[str] = None,
                      email: Optional[str] = None,
                      course_interest: Optional[str] = None,
                      notes: Optional[str] = None) -> str:
    """Create a CRM lead in Odoo for the sales advisor. Call once per session,
    when the visitor hesitates or asks to speak to someone. A name plus one
    contact method is enough — never ask for anything more sensitive."""
    if not (phone or email):
        return json.dumps({"error": "need_contact",
                           "detail": "ask for a phone number or an email first"})
    s = get_settings()
    payload = {
        "name": f"[نبراس] {course_interest or 'استفسار عن كورس'} — {name}",
        "contact_name": name, "type": "lead",
        "user_id": s.sales_advisor_id,
        "description": notes or "", "phone": phone or "", "email_from": email or "",
    }
    try:
        lead_id = await odoo.create_lead(payload)
    except OdooAccessDenied as e:
        return json.dumps({"error": "access_denied", "detail": str(e)[:200]})
    except Exception as e:  # noqa: BLE001
        log.exception("create_lead failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    return json.dumps({"lead_id": lead_id, "assigned_to": s.sales_advisor_id})


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


TOOLS = [search_courses, get_course_details, get_upcoming_batches, get_price,
         get_instructor, search_packages, build_checkout_link, create_lead,
         request_handoff]
