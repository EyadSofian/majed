"""Customer-facing localisation for structured Odoo profile data.

Odoo is always the source of truth. This module only translates the exact
profile strings Odoo returned; it cannot add a credential, employer, duration
or number. Arabic translations already stored in Odoo pass through untouched.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from .config import get_settings

log = logging.getLogger("nabras.localization")

_ARABIC_RE = re.compile(r"[\u0600-\u06ff]")
_LATIN_RE = re.compile(r"[A-Za-z]")
_LOWERCASE_RE = re.compile(r"[a-z]")
_FACT_RE = re.compile(r"\d+(?:[.,]\d+)?|(?<![A-Za-z])[A-Z][A-Z0-9+./-]{1,5}(?![A-Za-z])")

_TRANSLATION_CACHE: dict[str, dict[str, Any]] = {}
_INFLIGHT: dict[str, asyncio.Task] = {}

_SYSTEM_PROMPT = """\
أنت مترجم محترف لبطاقات مدربي Engosoft.
ترجم القيم الوصفية في JSON إلى العربية الفصحى الواضحة، ثم أعد JSON فقط
بالبنية نفسها وبالعدد نفسه من الأقسام والعناصر.

قواعد صارمة:
- لا تضف ولا تحذف ولا تستنتج أي خبرة أو شهادة أو جهة أو رقم.
- حافظ حرفياً على الأرقام، والاختصارات والشهادات التقنية مثل PMP وPMI وBMS وHVAC.
- لا تترجم أسماء الأشخاص أو الشركات أو المنتجات؛ عرّب فقط النص الوصفي المحيط بها.
- اترك النص العربي الموجود كما هو.
- لا تستخدم Markdown ولا تكتب أي شرح خارج JSON.
"""


def _contains_arabic(value: str) -> bool:
    return bool(_ARABIC_RE.search(value or ""))


def _needs_translation(value: str) -> bool:
    """True for English prose, false for Arabic and standalone acronyms."""
    value = (value or "").strip()
    if not value or _contains_arabic(value) or not _LATIN_RE.search(value):
        return False
    return bool(_LOWERCASE_RE.search(value) or len(value.split()) > 1)


def _profile_payload(card: dict[str, Any]) -> dict[str, Any]:
    sections = []
    for section in card.get("sections") or []:
        sections.append({
            "label": str(section.get("label") or ""),
            "items": [str(item) for item in (section.get("items") or [])],
        })
    return {
        "title": str(card.get("title") or ""),
        "department": str(card.get("department") or ""),
        "bio": str(card.get("bio") or ""),
        "sections": sections,
    }


def _iter_entries(payload: dict[str, Any]):
    for field in ("title", "department", "bio"):
        yield field, payload.get(field) or ""
    for section in payload.get("sections") or []:
        yield "section_label", section.get("label") or ""
        for item in section.get("items") or []:
            yield "section_item", item


def _iter_strings(payload: dict[str, Any]):
    for _, value in _iter_entries(payload):
        yield value


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content
        )
    return str(content or "")


def _parse_json(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw)
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        value = json.loads(raw[start:end + 1])
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _valid_translation(source: dict[str, Any], translated: Any) -> bool:
    """Reject shape changes, untranslated prose and altered hard facts."""
    if not isinstance(translated, dict):
        return False
    if any(not isinstance(translated.get(k), str)
           for k in ("title", "department", "bio")):
        return False

    source_sections = source.get("sections") or []
    target_sections = translated.get("sections")
    if not isinstance(target_sections, list) or len(target_sections) != len(source_sections):
        return False
    for src, dst in zip(source_sections, target_sections):
        if not isinstance(dst, dict) or not isinstance(dst.get("label"), str):
            return False
        items = dst.get("items")
        if not isinstance(items, list) or len(items) != len(src.get("items") or []):
            return False
        if any(not isinstance(item, str) for item in items):
            return False

    source_entries = list(_iter_entries(source))
    target_entries = list(_iter_entries(translated))
    if len(source_entries) != len(target_entries):
        return False
    for (kind, src), (_, dst) in zip(source_entries, target_entries):
        # Empty source fields may not grow invented content, and existing Odoo
        # Arabic translations are authoritative rather than rewritten material.
        if not src.strip() and dst.strip():
            return False
        if src and not dst.strip():
            return False
        if _contains_arabic(src) and dst != src:
            return False
        if _needs_translation(src) and not _contains_arabic(dst):
            # A single company/product proper noun may correctly remain Latin
            # inside a section (for example Engosoft). Labels and prose may not.
            proper_noun = (
                kind == "section_item"
                and dst == src
                and bool(re.fullmatch(r"[A-Z][A-Za-z0-9&.+/-]*", src))
            )
            if not proper_noun:
                return False

    # Numbers and upper-case credentials are customer facts, not prose. A
    # translation that loses or mutates any one of them is unsafe to display.
    source_values = [value for _, value in source_entries]
    target_values = [value for _, value in target_entries]
    source_facts = _FACT_RE.findall("\n".join(source_values))
    translated_text = "\n".join(target_values)
    return all(fact in translated_text for fact in source_facts)


async def _request_translation(payload: dict[str, Any]) -> dict[str, Any] | None:
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    model = ChatOpenAI(
        model=settings.router_model,
        api_key=settings.openai_api_key,
        streaming=False,
        timeout=settings.profile_translation_timeout,
        max_retries=1,
    )
    response = await asyncio.wait_for(
        model.ainvoke([
            SystemMessage(content=_SYSTEM_PROMPT),
            HumanMessage(content=json.dumps(payload, ensure_ascii=False)),
        ]),
        timeout=settings.profile_translation_timeout + 1,
    )
    return _parse_json(_message_text(response.content))


def _cache_key(lang: str, payload: dict[str, Any]) -> str:
    raw = json.dumps(
        {"lang": lang, "profile": payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _cache_put(key: str, value: dict[str, Any]) -> None:
    limit = max(1, get_settings().profile_translation_cache_size)
    if len(_TRANSLATION_CACHE) >= limit:
        _TRANSLATION_CACHE.pop(next(iter(_TRANSLATION_CACHE)))
    _TRANSLATION_CACHE[key] = copy.deepcopy(value)


async def _translated_payload(
        payload: dict[str, Any], lang: str) -> dict[str, Any] | None:
    key = _cache_key(lang, payload)
    cached = _TRANSLATION_CACHE.get(key)
    if cached is not None:
        return copy.deepcopy(cached)

    task = _INFLIGHT.get(key)
    if task is None:
        task = asyncio.create_task(_request_translation(payload))
        _INFLIGHT[key] = task
    try:
        candidate = await task
    except Exception:  # noqa: BLE001 - translation must never break a reply
        log.exception("instructor profile translation failed")
        return None
    finally:
        if _INFLIGHT.get(key) is task:
            _INFLIGHT.pop(key, None)

    if not _valid_translation(payload, candidate):
        log.warning("discarded unsafe or incomplete instructor profile translation")
        return None
    _cache_put(key, candidate)
    return copy.deepcopy(candidate)


async def localize_instructor_profile(
        card: dict[str, Any], lang: str) -> dict[str, Any]:
    """Return a card whose professional profile is Arabic when requested."""
    settings = get_settings()
    if (not settings.profile_translation_enabled
            or not (lang or "").lower().startswith("ar")):
        return card

    payload = _profile_payload(card)
    if not any(_needs_translation(value) for value in _iter_strings(payload)):
        return card

    translated = await _translated_payload(payload, lang)
    if translated is None:
        return card

    result = dict(card)
    for field in ("title", "department", "bio"):
        result[field] = translated[field] or None
    result["sections"] = translated["sections"]
    return result


def _reset_translation_cache_for_tests() -> None:
    _TRANSLATION_CACHE.clear()
    _INFLIGHT.clear()
