"""Agent tools.

Cards are captured out-of-band through a ContextVar sink so the model can
stream natural language while the structured `course_cards` ride along in the
response metadata. That decouples card data from token generation — faster to
render and impossible for the model to garble.
"""
import asyncio
import contextvars
import json
import logging
from typing import Any, Optional

import httpx
from langchain_core.tools import tool

from .config import get_settings
from .odoo import odoo
from .schemas import CourseCard

log = logging.getLogger("nabras.tools")

# Per-request card sink. `None` default means "no active request" — tools then
# simply skip publishing cards instead of mutating a shared module-level list.
CARD_SINK: contextvars.ContextVar[Optional[list]] = contextvars.ContextVar(
    "nabras_cards", default=None)


def _sink() -> list:
    cur = CARD_SINK.get()
    return cur if cur is not None else []


# --------------------------------------------------------------------------
# Lazy clients — importing this module must not require credentials (tests,
# `--help`, image build). Everything is created on first real use.
# --------------------------------------------------------------------------
_oai = None
_index = None


def _openai():
    global _oai
    if _oai is None:
        from openai import AsyncOpenAI
        _oai = AsyncOpenAI(api_key=get_settings().openai_api_key)
    return _oai


def _pinecone_index():
    global _index
    if _index is None:
        from pinecone import Pinecone
        s = get_settings()
        _index = Pinecone(api_key=s.pinecone_api_key).Index(s.pinecone_index)
    return _index


def _course_url(slug: str) -> str:
    return f"{get_settings().shop_base}/courses/{slug}"


async def _embed(text: str) -> list[float]:
    r = await _openai().embeddings.create(model=get_settings().embed_model, input=text)
    return r.data[0].embedding


def _matches(res: Any) -> list[dict]:
    """Pinecone returns an OpenAPI model in some versions and a plain dict in
    others. Normalise both to a list of dicts."""
    raw = res.get("matches") if isinstance(res, dict) else getattr(res, "matches", None)
    out = []
    for m in raw or []:
        if isinstance(m, dict):
            out.append(m)
        else:
            out.append({"id": getattr(m, "id", None),
                        "score": getattr(m, "score", None),
                        "metadata": getattr(m, "metadata", None) or {}})
    return out


def _as_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _as_int(v: Any) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------
@tool
async def search_courses(query: str, top_k: int = 5) -> str:
    """Semantic search over the Engosoft course catalog.

    Use for any 'recommend / find / do you have' request. Returns matching
    courses with title, price, rating and slug. Never invent courses that this
    tool did not return.
    """
    s = get_settings()
    try:
        vec = await _embed(query)
        # Pinecone's sync client would block the event loop; push it to a thread.
        res = await asyncio.to_thread(
            _pinecone_index().query,
            vector=vec, top_k=max(1, min(top_k, 10)),
            namespace=s.pinecone_namespace, include_metadata=True,
        )
    except Exception as e:  # noqa: BLE001 - surfaced to the model, not the user
        log.exception("search_courses failed")
        return json.dumps({"error": "search_unavailable", "detail": str(e)[:200]})

    cards, brief = [], []
    for m in _matches(res):
        md = m.get("metadata") or {}
        slug = md.get("slug", "")
        card = CourseCard(
            course_id=_as_int(md.get("course_id")),
            title=md.get("title", ""),
            slug=slug,
            url=md.get("url") or _course_url(slug),
            thumbnail_url=md.get("thumbnail_url"),
            rating=_as_float(md.get("rating")),
            price_display=md.get("price_display"),
        )
        cards.append(card.model_dump())
        brief.append({"course_id": card.course_id, "title": card.title,
                      "slug": card.slug, "price": card.price_display,
                      "rating": card.rating,
                      "why": (md.get("summary") or "")[:160]})

    _sink().extend(cards)   # surfaces as metadata.course_cards
    if not brief:
        return json.dumps({"results": [], "note": "no_match"}, ensure_ascii=False)
    return json.dumps(brief, ensure_ascii=False)


@tool
async def get_course_live(course_id: int) -> str:
    """Fetch REAL-TIME price and availability for one course from Odoo 17.

    Call this at the money-moment (right before offering checkout). Do not
    trust the cached price on the card.
    """
    try:
        recs = await odoo.read_courses(
            [course_id], ["name", "list_price", "currency_id", "sale_ok"])
    except Exception as e:  # noqa: BLE001
        log.exception("get_course_live failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    if not recs:
        return json.dumps({"error": "not_found"})
    r = recs[0]
    cur = r["currency_id"][1] if isinstance(r.get("currency_id"), list) else "USD"
    return json.dumps({"course_id": course_id, "title": r.get("name"),
                       "price": r.get("list_price"), "currency": cur,
                       "available": bool(r.get("sale_ok"))}, ensure_ascii=False)


@tool
async def build_checkout_link(course_id: int) -> str:
    """Build an express add-to-cart -> checkout deep link for a course.

    Also attaches `checkout_url` onto that course's card so the CTA can sell.
    """
    s = get_settings()
    try:
        variant = await odoo.product_variant_id(course_id)
    except Exception as e:  # noqa: BLE001
        log.exception("build_checkout_link failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    if not variant:
        return json.dumps({"error": "variant_not_found"})

    url = (f"{s.shop_base}/shop/cart/update"
           f"?product_id={variant}&add_qty=1&express=1")
    sink = _sink()
    attached = False
    for c in sink:
        if c.get("course_id") == course_id:
            c["checkout_url"] = url
            attached = True

    # Closing turns usually skip search_courses (the course is already known
    # from earlier context), so there would be no card to hang the CTA on and
    # the widget would render a "buy" line with no button. Materialise one.
    if not attached:
        card = await _card_from_odoo(course_id, url)
        if card:
            sink.append(card)
            attached = True

    return json.dumps({"checkout_url": url, "attached_to_card": attached},
                      ensure_ascii=False)


async def _card_from_odoo(course_id: int, checkout_url: str) -> Optional[dict]:
    """Minimal card built straight from Odoo, for close-only turns."""
    s = get_settings()
    try:
        recs = await odoo.read_courses(
            [course_id], ["name", "list_price", "currency_id", "website_url"])
    except Exception:  # noqa: BLE001
        log.exception("_card_from_odoo failed")
        return None
    if not recs:
        return None
    r = recs[0]
    cur = r["currency_id"][1] if isinstance(r.get("currency_id"), list) else "USD"
    path = r.get("website_url") or ""
    url = path if path.startswith("http") else f"{s.shop_base}{path}"
    price = r.get("list_price")
    return CourseCard(
        course_id=course_id,
        title=r.get("name") or "",
        slug=path.rsplit("/", 1)[-1] if path else "",
        url=url,
        price_display=f"{price:g} {cur}" if price is not None else None,
        checkout_url=checkout_url,
    ).model_dump()


@tool
async def create_lead(name: str, phone: Optional[str] = None,
                      email: Optional[str] = None,
                      course_interest: Optional[str] = None,
                      notes: Optional[str] = None) -> str:
    """Create a CRM lead in Odoo assigned to the sales advisor.

    Call once per session, when the user hesitates or asks for a human.
    """
    if not (phone or email):
        return json.dumps({"error": "need_contact",
                           "detail": "ask for a phone or an email first"})
    s = get_settings()
    payload = {
        "name": f"[Nabras] {course_interest or 'Course inquiry'} — {name}",
        "contact_name": name, "type": "lead",
        "user_id": s.sales_advisor_id,
        "description": notes or "", "phone": phone or "", "email_from": email or "",
    }
    try:
        lead_id = await odoo.create_lead(payload)
    except Exception as e:  # noqa: BLE001
        log.exception("create_lead failed")
        return json.dumps({"error": "odoo_unavailable", "detail": str(e)[:200]})
    return json.dumps({"lead_id": lead_id, "assigned_to": s.sales_advisor_id})


@tool
async def escalate_to_chatwoot(session_id: str, summary: str,
                               contact: Optional[str] = None) -> str:
    """Hand a hot or hesitant conversation to a human agent via Chatwoot."""
    s = get_settings()
    if not s.chatwoot_api_token:
        return json.dumps({"status": "chatwoot_not_configured"})
    base = f"{s.chatwoot_url}/api/v1/accounts/{s.chatwoot_account_id}"
    hdr = {"api_access_token": s.chatwoot_api_token}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            src = await c.post(f"{base}/inboxes/{s.chatwoot_inbox_id}/contacts",
                               headers=hdr, json={"name": contact or session_id})
            src.raise_for_status()
            cid = (src.json().get("payload", {}).get("contact", {}) or {}).get("id")
            conv = await c.post(f"{base}/conversations", headers=hdr, json={
                "source_id": session_id, "inbox_id": s.chatwoot_inbox_id,
                "contact_id": cid,
                "additional_attributes": {"nabras_summary": summary}})
            conv.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log.exception("escalate_to_chatwoot failed")
        return json.dumps({"status": "escalation_failed", "detail": str(e)[:200]})
    return json.dumps({"status": "escalated",
                       "conversation": conv.json().get("id")})


TOOLS = [search_courses, get_course_live, build_checkout_link,
         create_lead, escalate_to_chatwoot]
