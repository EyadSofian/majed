"""Engosoft's own course map, shipped with the service.

Odoo says what exists and what it costs. It does **not** say which discipline a
course belongs to in the way a customer thinks about it, what a "track" contains,
or the dozens of Arabic phrases people actually type. That knowledge lives in
Engosoft's course KB, and without it the bot answered «مسار ميكانيكا» with BIM
courses — the Odoo category never matched the Arabic question, so the search fell
through to a plain keyword match.

`data/curriculum.json` is generated from that KB (`scripts/build_curriculum.py`)
and carries three things:

* **keywords** — every phrase the KB lists for a course, in both languages. These
  are merged into the search index, so «تكييف» finds HVAC.
* **field** — the discipline the KB assigns, which is what the visitor means by
  "تخصص", independent of how the shop's categories happen to be arranged.
* **groups** — the KB's own grouping rules: the exact courses that make up
  "الميكانيكا الشاملة", "التصميم الخرساني", and the rest. Members were resolved
  to Odoo ids where the KB was unambiguous; the rest fall back to a catalogue
  search at runtime.

This is an overlay, never a replacement: a course that exists here but not in
Odoo is not sellable and is never offered.
"""
import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Optional

log = logging.getLogger("nabras.curriculum")

DATA = Path(__file__).resolve().parent.parent / "data" / "curriculum.json"

# The KB's discipline names, as a customer would say them. Marketing is in the
# KB but is not part of the six fields the business sells against, so it is not
# offered as a specialization.
FIELD_LABELS = {
    "Mechanical": "ميكانيكا",
    "Electrical": "كهرباء",
    "Civil": "مدني وإنشائي",
    "Architecture": "معماري",
    "Interior Design": "تصميم داخلي وديكور",
    "Management": "إدارة ومشاريع وسلامة",
}
NOT_A_FIELD = {"Marketing"}


@lru_cache(maxsize=1)
def _data() -> dict:
    try:
        return json.loads(DATA.read_text())
    except Exception:  # noqa: BLE001
        log.warning("curriculum.json missing or unreadable — running on Odoo alone")
        return {"courses": [], "tracks": [], "groups": []}


@lru_cache(maxsize=1)
def _by_odoo_id() -> dict[int, dict]:
    out: dict[int, dict] = {}
    for c in _data().get("courses", []) + _data().get("tracks", []):
        # a /training_package/ url ends with the PACKAGE id, not a product id
        if c.get("odoo_id") and not c.get("is_package_url"):
            out[c["odoo_id"]] = c
    return out


def entry(odoo_id: int) -> Optional[dict]:
    return _by_odoo_id().get(int(odoo_id))


def keywords_for(odoo_id: int) -> list[str]:
    e = entry(odoo_id)
    return list(e.get("keywords") or []) if e else []


def field_for(odoo_id: int) -> str:
    e = entry(odoo_id)
    field = (e or {}).get("category") or ""
    return "" if field in NOT_A_FIELD else field


def audience_for(odoo_id: int) -> dict:
    e = entry(odoo_id) or {}
    return {"audience": e.get("audience") or "", "level": e.get("level") or ""}


@lru_cache(maxsize=1)
def fields() -> dict[str, list[int]]:
    """Discipline -> the Odoo ids of its courses, in KB order."""
    out: dict[str, list[int]] = {}
    for oid, e in _by_odoo_id().items():
        f = e.get("category") or ""
        if f and f not in NOT_A_FIELD:
            out.setdefault(f, []).append(oid)
    return out


def _norm(text: str) -> str:
    text = (text or "").lower()
    text = text.translate(str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي",
                                         "ة": "ه", "ؤ": "و", "ئ": "ي"}))
    return " " + " ".join(re.findall(r"[\w؀-ۿ]+", text)) + " "


@lru_cache(maxsize=1)
def _group_index() -> list[tuple[str, list[str], dict]]:
    """(normalised trigger, its words, the group) — longest trigger first, so
    "باقة الميكانيكا الشاملة" wins over the bare word it contains."""
    idx = []
    for g in _data().get("groups", []):
        for t in g.get("triggers", []):
            n = _norm(t).strip()
            if n:
                idx.append((n, n.split(), g))
    idx.sort(key=lambda x: -len(x[1]))
    return idx


def match_group(query: str) -> Optional[dict]:
    """The KB grouping rule a question is asking for, if any.

    Matching is on the trigger's *words* rather than the exact phrase: people
    write «عايز الميكانيكا الشاملة» and «باقه ميكانيكا شامله», never the phrase
    as the KB spells it.
    """
    q = _norm(query)
    if not q.strip():
        return None
    for _, words, group in _group_index():
        if all(f" {w} " in q for w in words):
            return group
    return None


def group_members(group: dict) -> list[tuple[Optional[int], str]]:
    """(odoo id or None, name) for each course in the rule, in teaching order."""
    ids = group.get("course_ids") or [None] * len(group.get("courses", []))
    return list(zip(ids, group.get("courses", [])))


@lru_cache(maxsize=1)
def _field_words() -> dict[str, set[str]]:
    """Words that name a discipline: its own name, plus every keyword of every
    course AND track in it. That is how «تكييف» reaches Mechanical without a
    hand-written synonym table.

    Tracks count here even though they are packages rather than products: their
    keywords ("بيم ميكانيكا وكهرباء") are how people name the discipline, and
    naming it is all this function does.
    """
    out: dict[str, set[str]] = {}
    for e in _data().get("courses", []) + _data().get("tracks", []):
        f = e.get("category") or ""
        if not f or f in NOT_A_FIELD:
            continue
        words = out.setdefault(f, set(_norm(f).split()) |
                               set(_norm(FIELD_LABELS.get(f, "")).split()))
        words |= {w for kw in (e.get("keywords") or []) for w in _norm(kw).split()}
        words |= set(_norm(e.get("title") or "").split())
    return {f: {w for w in words if len(w) > 2} for f, words in out.items()}


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
    return bool(_by_odoo_id())


def stats() -> dict:
    return {"courses": len(_by_odoo_id()), "fields": len(fields()),
            "groups": len(_data().get("groups", []))}
