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


# ─────────────────────────────────────────────────────────────────────────
# The Digital-Sales mapping: state -> specialization -> job title -> GOAL.
# The goal is the branching variable, so a maintenance engineer asking for a
# certificate and one asking to learn HVAC stop sharing a path.
# ─────────────────────────────────────────────────────────────────────────
def mapping() -> dict:
    return _data().get("mapping", {})


# Arabic proclitics. A goal arrives as free prose — «اتأهل لسوق العمل»,
# «عايز الشهادة» — so the trigger word is rarely bare. Both sides of the
# comparison get the same treatment, which makes this a normalisation rather
# than a lookup: over-stemming a word cannot cause a mismatch, only a shared
# shorter form. The length floor keeps «بيم» and «فني» whole.
_PROCLITICS = ("وال", "بال", "كال", "فال", "لل", "ال", "و", "ب", "ك", "ف", "ل")


def _stem(word: str) -> str:
    for p in _PROCLITICS:
        if word.startswith(p) and len(word) - len(p) >= 3:
            return word[len(p):]
    return word


def _words(text: str) -> set[str]:
    return {_stem(w) for w in _norm(text).split()}


def _match_triggers(query: str, rows: Iterable[dict]) -> Optional[dict]:
    """The row whose trigger words all appear in *query*; longest trigger wins.

    Word sets, not substrings: people write «عايز شهاده اداريه» and «اتأهل
    لسوق العمل», never the spelling in this file.
    """
    q = _words(query)
    if not q:
        return None
    best, best_len = None, 0
    for row in rows:
        for trigger in row.get("triggers", []):
            words = _words(trigger)
            if words and len(words) > best_len and words <= q:
                best, best_len = row, len(words)
    return best


def resolve_goal(query: str) -> Optional[dict]:
    """Which of the four goals is this? None when the visitor has not said."""
    return _match_triggers(query, mapping().get("goals", []))


def resolve_work_field(query: str) -> Optional[dict]:
    """Facility management / maintenance / project management — the second
    question of the certification branch."""
    return _match_triggers(query, mapping().get("work_fields", []))


def resolve_state(query: str) -> Optional[dict]:
    """Map «حديث التخرج» / «خبرة من سنتين إلى 5 سنوات» to a state row.

    Matched on the label because these arrive as taps on the chips this file
    defines, so the text is ours, not free prose.
    """
    q = _words(query)
    for row in mapping().get("states", []):
        words = _words(row.get("label", ""))
        if words and words <= q:
            return row
    return None


def certification_for(work_field: str, years: Optional[float]) -> Optional[dict]:
    """The one programme this person qualifies for.

    Rows without a year bound (CMRP) match on the work field alone. A row with
    bounds is skipped when the years are unknown, so the caller asks instead of
    quietly recommending the entry-level certificate to a 10-year manager.
    """
    rows = [c for c in mapping().get("certifications", [])
            if c.get("work_field") == work_field]
    if not rows:
        return None
    unbounded = [c for c in rows
                 if c.get("min_years") is None and c.get("max_years") is None]
    if years is None:
        return unbounded[0] if len(rows) == 1 or unbounded else None
    for c in rows:
        lo, hi = c.get("min_years"), c.get("max_years")
        if (lo is None or years >= lo) and (hi is None or years <= hi):
            return c
    # Below every bound (e.g. 6 months in facility management): the lowest rung
    # is still the honest recommendation, and the prompt says to flag the gap.
    return min(rows, key=lambda c: c.get("min_years") or 0)


def comprehensive_groups(specialization: str) -> list[dict]:
    """The comprehensive track(s) of a specialization, as grouping rules.

    Civil deliberately returns three — Engosoft sells concrete, infrastructure
    and steel as separate tracks, and pretending there is one «مدني شاملة»
    would put a bridge engineer in a concrete-design path they did not pick.
    """
    wanted = mapping().get("comprehensive", {}).get(specialization) or []
    by_rule = {g.get("rule"): g for g in _data().get("groups", [])}
    return [by_rule[r] for r in wanted if r in by_rule]


def bim_track(specialization: str) -> Optional[dict]:
    return mapping().get("bim_tracks", {}).get(specialization)


def chips_for(kind: str) -> list[dict]:
    """The tappable options of one qualification step, widget-shaped."""
    rows = mapping().get(kind) or []
    return [{"title": r["label"], "value": r["label"]}
            for r in rows if isinstance(r, dict) and r.get("label")]


def ready() -> bool:
    return bool(fields())


def stats() -> dict:
    return {"courses": sum(len(v) for v in fields().values()),
            "fields": len(fields()),
            "groups": len(_data().get("groups", []))}
