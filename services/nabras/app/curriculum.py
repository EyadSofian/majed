"""Engosoft's course relations, shipped with the service.

Odoo is the only source of anything a customer reads — the name, the price, the
dates, the instructor. This module answers three questions Odoo cannot:

1. **Which courses make up a named package?** "الميكانيكا الشاملة" is a list
   somebody wrote, not a search result.
2. **Which discipline is a course in?** The visitor's "تخصص". Shop categories
   are merchandising and share words across disciplines, which is why
   «مسار ميكانيكا» used to come back with BIM courses.
3. **Who is a course for?** Target audience and experience level.

Plus one invisible thing: the KB's keyword tree feeds the *search index* so
«تكييف» finds HVAC. Those words are never shown to anyone; they only help find
a course that already exists in Odoo.

`prune()` runs after every catalogue load and drops every id the live catalogue
does not publish — so a course that exists here but not in Odoo cannot be
recommended, named, or counted.
"""
import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger("nabras.curriculum")

DATA = Path(__file__).resolve().parent.parent / "data" / "curriculum.json"

_pruned_to: Optional[set[int]] = None


@lru_cache(maxsize=1)
def _data() -> dict:
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        log.warning("curriculum.json missing or unreadable — running on Odoo alone")
        return {"fields": {}, "courses": {}, "groups": []}


def _live(odoo_id) -> bool:
    """Is this id something the live catalogue actually publishes?"""
    return _pruned_to is None or int(odoo_id) in _pruned_to


def prune(known_ids: Iterable[int]) -> dict:
    """Restrict the map to what Odoo publishes right now.

    Called after each catalogue refresh. Anything else in the KB — an
    unpublished course, a retired one, a typo in a URL — stops existing here
    too, which is the only way the map can never contradict the shop.
    """
    global _pruned_to
    _pruned_to = {int(i) for i in known_ids}
    _field_words.cache_clear()
    dropped = [i for i in _all_ids() if int(i) not in _pruned_to]
    if dropped:
        log.info("curriculum: %d of %d courses are not published in Odoo — ignored",
                 len(dropped), len(_all_ids()))
    return {"known": len(_pruned_to), "ignored": len(dropped)}


def _all_ids() -> list[int]:
    return [int(i) for i in _data().get("courses", {})]


FIELD_LABELS = {f: row.get("label") or f
                for f, row in _data().get("fields", {}).items()}


def entry(odoo_id: int) -> Optional[dict]:
    if not _live(odoo_id):
        return None
    return _data().get("courses", {}).get(str(int(odoo_id)))


def keywords_for(odoo_id: int) -> list[str]:
    """Search words only — never rendered, never quoted back to a customer."""
    return list((entry(odoo_id) or {}).get("keywords") or [])


def field_for(odoo_id: int) -> str:
    return (entry(odoo_id) or {}).get("field") or ""


def audience_for(odoo_id: int) -> dict:
    e = entry(odoo_id) or {}
    return {"audience": e.get("audience") or "", "level": e.get("level") or ""}


def fields() -> dict[str, list[int]]:
    """Discipline -> the Odoo ids in it that the shop actually publishes."""
    out: dict[str, list[int]] = {}
    for f, row in _data().get("fields", {}).items():
        ids = [i for i in row.get("course_ids", []) if _live(i)]
        if ids:
            out[f] = ids
    return out


def _norm(text: str) -> str:
    text = (text or "").lower()
    text = text.translate(str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي",
                                         "ة": "ه", "ؤ": "و", "ئ": "ي"}))
    return " " + " ".join(re.findall(r"[\w؀-ۿ]+", text)) + " "


@lru_cache(maxsize=1)
def _group_index() -> list[tuple[list[str], dict]]:
    """Triggers with the most words first, so "باقة الميكانيكا الشاملة" wins
    over a shorter trigger it contains."""
    idx = []
    for g in _data().get("groups", []):
        for t in g.get("triggers", []):
            words = _norm(t).split()
            if words:
                idx.append((words, g))
    idx.sort(key=lambda x: -len(x[0]))
    return idx


def match_group(query: str) -> Optional[dict]:
    """The package rule a question is asking for, if any.

    Matched on the trigger's *words*, not the exact phrase: people write
    «عايز الميكانيكا الشاملة» and «باقه ميكانيكا شامله», never the KB's spelling.
    """
    q = _norm(query)
    if not q.strip():
        return None
    for words, group in _group_index():
        if all(f" {w} " in q for w in words):
            return group
    return None


def group_members(group: dict) -> list[int]:
    """The package's courses, in order — only the ones Odoo publishes."""
    return [int(i) for i in group.get("course_ids", []) if _live(i)]


@lru_cache(maxsize=1)
def _field_words() -> dict[str, set[str]]:
    """The words that name each discipline — its own name and every keyword of
    every course in it. That is how «تكييف» reaches Mechanical without anyone
    maintaining a synonym table."""
    out: dict[str, set[str]] = {}
    live = set(fields())
    for f, row in _data().get("fields", {}).items():
        if f not in live:
            continue
        words = set(_norm(f).split()) | set(_norm(row.get("label", "")).split())
        for kw in row.get("keywords", []):
            words |= set(_norm(kw).split())
        out[f] = {w for w in words if len(w) > 2}
    return out


def field_of_query(query: str) -> Optional[str]:
    """Which discipline is this question about? Highest word overlap wins."""
    q = set(_norm(query).split())
    if not q:
        return None
    best, score = None, 0
    for f, words in _field_words().items():
        hits = len(q & words)
        if hits > score:
            best, score = f, hits
    return best


def ready() -> bool:
    return bool(fields())


def stats() -> dict:
    return {"courses": sum(len(v) for v in fields().values()),
            "fields": len(fields()),
            "groups": len(_data().get("groups", []))}
