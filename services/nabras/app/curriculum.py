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


def field_of_group(group: dict) -> Optional[str]:
    """The discipline a package belongs to, from its own courses.

    Every grouping rule in the KB is single-discipline, so this is a read of
    the data rather than a judgement. A rule that ever spans two returns None
    instead of picking one.
    """
    found = {entry(i).get("field") for i in group.get("course_ids", [])
             if entry(i)}
    found.discard(None)
    return found.pop() if len(found) == 1 else None


def groups_for_field(field: str) -> list[dict]:
    """The packages Engosoft actually sells inside one discipline.

    This exists because a trainee says «مدني», not «باقة التصميم الخرساني», and
    `match_group` only answers to a package's own name. Without it a bare
    discipline found nothing at all — not even «ميكانيكا», which has exactly
    one package waiting for it.

    It deliberately does NOT synthesise a "comprehensive civil" package.
    Civil is sold as three separate tracks (خرساني · بنية تحتية · منشآت معدنية);
    inventing a fourth that unions them would have the bot offer something
    nobody can buy. Where a discipline has several, the caller asks which.
    """
    if not field:
        return []
    live = {i for ids in fields().values() for i in ids}
    out = []
    for g in _data().get("groups", []):
        if field_of_group(g) != field:
            continue
        if any(i in live for i in g.get("course_ids", [])):
            out.append(g)
    return out


def group_label(group: dict) -> str:
    """What to call a package to a customer: its first Arabic trigger.

    The `rule` key is an internal English name ("STEEL DESIGN GROUPING RULE")
    and must never reach a reply.
    """
    for t in group.get("triggers", []):
        if any("\u0600" <= ch <= "\u06ff" for ch in t):
            return t.strip()
    return (group.get("triggers") or [group.get("rule", "")])[0]


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


def _generic_words() -> set[str]:
    """Words that name no discipline, computed rather than hand-listed.

    Every field's keyword list contains the scaffolding of a course title —
    «مسار», «باقه», «دوره», «مهندس», "professional", "training", "track". A word
    carried by more than half the disciplines cannot tell them apart, but it
    still cast a vote, and a sentence has more scaffolding in it than subject:

        "المسار الشامل للمهندس الميكانيكي"
          مسار      -> Civil, Mechanical, Electrical, Interior, Architecture
          للمهندس   -> Civil
          شامل      -> Interior Design
          ميكانيكي  -> Mechanical          <- the only word that meant anything

    Civil tied Mechanical on noise alone and won on dict order, so a mechanical
    engineer was answered with an interior-design track. Deriving the list from
    the KB keeps it correct as courses are added, which a hand-written stoplist
    would not.
    """
    fields = _field_words()
    if not fields:
        return set()
    seen: dict[str, int] = {}
    for words in fields.values():
        for w in words:
            seen[w] = seen.get(w, 0) + 1
    half = len(fields) // 2
    return {w for w, n in seen.items() if n > half} | _PACKAGING_WORDS


# How a course is PACKAGED, never what it teaches. The computed rule above
# only catches a word once most disciplines happen to list it, and these are
# too central to leave to that: «شامل» sits in exactly one field's keywords,
# so on its own it made "مسار شامل" an interior-design question.
_PACKAGING_WORDS = {
    "شامل", "شامله", "الشامل", "الشامله", "كامل", "متكامل", "comprehensive",
    "مسار", "المسار", "مسارات", "باقه", "الباقه", "باقات", "track", "package",
    "مهندس", "المهندس", "للمهندس", "مهندسين", "engineer", "engineering",
    "دوره", "دورات", "كورس", "كورسات", "course", "training", "professional",
}


def _field_name_words() -> dict[str, set[str]]:
    """Only the words that NAME a discipline — its key and its label.

    Deliberately not cached: six rows is nothing to rebuild, and a second
    cache would be one more thing to invalidate whenever the map is pruned to
    what Odoo publishes.
    """
    out: dict[str, set[str]] = {}
    live = set(fields())
    for f, row in _data().get("fields", {}).items():
        if f not in live:
            continue
        words = set(_norm(f).split()) | set(_norm(row.get("label", "")).split())
        out[f] = {w for w in words if len(w) > 2}
    return out


def field_of_query(query: str) -> Optional[str]:
    """Which discipline is this question about?

    A word that NAMES a discipline outweighs one that merely turns up in a
    course's keywords: «ميكانيكا» is Mechanical's own label, and also a keyword
    under one electrical course, so counting both the same made it a coin toss
    decided by dict order.

    Returns None when nothing distinguishes the disciplines, which lets the
    caller fall back to the one the visitor actually picked instead of being
    handed a guess dressed up as an answer.
    """
    q = set(_norm(query).split()) - _generic_words()
    if not q:
        return None
    named = _field_name_words()
    ranked: list[tuple[int, str]] = []
    for f, words in _field_words().items():
        score = len(q & words) + 2 * len(q & named.get(f, set()))
        if score:
            ranked.append((score, f))
    if not ranked:
        return None
    ranked.sort(key=lambda r: -r[0])
    if len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
        return None
    return ranked[0][1]


def ready() -> bool:
    return bool(fields())


def stats() -> dict:
    return {"courses": sum(len(v) for v in fields().values()),
            "fields": len(fields()),
            "groups": len(_data().get("groups", []))}
