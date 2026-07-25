"""In-memory catalogue with delta refresh.

At 75 sellable courses a vector database is dead weight: the entire catalogue
fits in a few thousand tokens, so it is held in memory, searched directly, and
summarised into the system prompt (where prompt caching makes it nearly free).

Freshness, which is what actually matters commercially:

* **price** — never cached. Read live from Odoo at the moment a number is
  quoted or a checkout link is built, so a price change is visible instantly.
* **catalogue / batches / instructors** — refreshed by polling `write_date`
  every `CATALOG_REFRESH_SECONDS` (default 5 min). The poll returns nothing
  99% of the time and costs almost nothing; the moment someone edits a course
  in Odoo it comes back and the snapshot updates.
"""
import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .config import get_settings
from .odoo import COURSE_TYPE_LABELS, abs_url, image_url, odoo

log = logging.getLogger("nabras.catalog")

_WORD = re.compile(r"[\w؀-ۿ]+", re.UNICODE)
# Arabic orthographic variants that would otherwise split identical words.
_AR_NORM = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه",
                          "ؤ": "و", "ئ": "ي"})


def tokens(text: str) -> set[str]:
    return {w.translate(_AR_NORM).lower()
            for w in _WORD.findall(text or "") if len(w) > 1}


@dataclass
class Course:
    id: int
    name: str
    url: str
    image_url: str
    code: str = ""
    course_type: str = ""
    subtitle: str = ""
    description: str = ""
    duration_text: str = ""
    certificate_text: str = ""
    category_ids: list[int] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    instructor_ids: list[int] = field(default_factory=list)
    instructor_tagline: str = ""
    channel_id: Optional[int] = None
    total_slides: int = 0
    rating: float = 0.0
    members: int = 0
    _search_blob: set[str] = field(default_factory=set, repr=False)

    @property
    def delivery(self) -> str:
        return COURSE_TYPE_LABELS.get(self.course_type, self.course_type or "")


@dataclass
class Snapshot:
    courses: dict[int, Course] = field(default_factory=dict)
    categories: dict[int, str] = field(default_factory=dict)
    instructors: dict[int, dict] = field(default_factory=dict)
    events_by_course: dict[int, list[dict]] = field(default_factory=dict)
    events_by_channel: dict[int, list[dict]] = field(default_factory=dict)
    packages: dict[str, Any] = field(default_factory=dict)
    loaded_at: float = 0.0
    last_write_date: Optional[str] = None

    @property
    def ready(self) -> bool:
        return bool(self.courses)


_snap = Snapshot()


def snapshot() -> Snapshot:
    return _snap


# --------------------------------------------------------------------------
async def refresh(full: bool = False) -> Snapshot:
    """Rebuild the snapshot. `full=False` still refetches events (they move on
    their own as seats sell) but skips untouched course rows."""
    global _snap
    s = get_settings()
    t0 = time.perf_counter()
    since = None if full or not _snap.ready else _snap.last_write_date

    changed = await odoo.fetch_courses(since=since)
    if since and not changed:
        # Nothing edited — only refresh the volatile parts.
        await _refresh_events(_snap)
        _snap.loaded_at = time.time()
        return _snap

    snap = Snapshot() if (full or not _snap.ready) else _snap
    if since and _snap.ready:
        rows = changed                      # merge deltas into the live snapshot
    else:
        rows = await odoo.fetch_courses()

    cat_ids: set[int] = set()
    instr_ids: set[int] = set()
    for r in rows:
        c = _to_course(r)
        snap.courses[c.id] = c
        cat_ids.update(c.category_ids)
        instr_ids.update(c.instructor_ids)

    # Courses that were unpublished since the last poll must disappear.
    if not since:
        live = {r["id"] for r in rows}
        for gone in set(snap.courses) - live:
            snap.courses.pop(gone, None)

    if cat_ids:
        cats = await odoo.read("product.public.category", sorted(cat_ids), ["id", "name"])
        snap.categories.update({c["id"]: c["name"] for c in cats})
    for c in snap.courses.values():
        c.categories = [snap.categories.get(i, "") for i in c.category_ids]
        c.categories = [x for x in c.categories if x]
        c._search_blob = tokens(" ".join(
            [c.name, c.subtitle, c.description[:600], c.duration_text,
             c.delivery, c.instructor_tagline, *c.categories]))

    if instr_ids:
        snap.instructors.update(await odoo.fetch_instructors(instr_ids))

    await _attach_channels(snap)
    await _refresh_events(snap)
    snap.packages = await odoo.fetch_packages()

    snap.last_write_date = max(
        [r.get("write_date") for r in rows if r.get("write_date")] +
        ([snap.last_write_date] if snap.last_write_date else []) or [None])
    snap.loaded_at = time.time()
    _snap = snap
    log.info("catalogue: %d courses, %d batches, packages=%s (%.0f ms)",
             len(snap.courses), sum(len(v) for v in snap.events_by_course.values()),
             snap.packages.get("available"), (time.perf_counter() - t0) * 1000)
    return snap


def _to_course(r: dict) -> Course:
    return Course(
        id=r["id"],
        name=(r.get("name") or "").strip(),
        url=abs_url(r.get("website_url")),
        image_url=image_url("product.template", r["id"]),
        code=str(r.get("default_code") or ""),
        course_type=r.get("course_type") or "",
        subtitle=(r.get("course_subtitle") or "").strip(),
        description=(r.get("description_sale") or "").strip(),
        duration_text=(r.get("course_duration_text") or "").strip(),
        certificate_text=(r.get("course_certificate_text") or "").strip(),
        category_ids=list(r.get("public_categ_ids") or []),
        instructor_ids=list((r.get("recorded_instructor_ids") or []) +
                            (r.get("attendance_instructor_ids") or [])),
        instructor_tagline=(r.get("instructor_tagline") or
                            r.get("attendance_instructor_tagline") or "").strip(),
    )


async def _attach_channels(snap: Snapshot) -> None:
    """slide.channel carries the learning-side facts (lessons, rating, members)
    and is the key events join on."""
    try:
        links = await odoo.fetch_channel_links()
    except Exception:  # noqa: BLE001
        log.exception("channel link fetch failed")
        return
    by_template = {v["template_id"]: v for v in links.values() if v.get("template_id")}
    for c in snap.courses.values():
        ch = by_template.get(c.id)
        if not ch:
            continue
        c.channel_id = ch["id"]
        c.total_slides = ch.get("total_slides") or 0
        c.rating = float(ch.get("rating_avg") or 0)
        c.members = ch.get("members_count") or 0


async def _refresh_events(snap: Snapshot) -> None:
    try:
        events = await odoo.fetch_upcoming_events()
    except Exception:  # noqa: BLE001
        log.exception("event fetch failed")
        return
    by_channel: dict[int, list[dict]] = {}
    for e in events:
        ch = e.get("course_id")
        if isinstance(ch, list):
            by_channel.setdefault(ch[0], []).append(e)
    snap.events_by_channel = by_channel
    snap.events_by_course = {
        c.id: by_channel.get(c.channel_id, [])
        for c in snap.courses.values() if c.channel_id
    }


# --------------------------------------------------------------------------
def search(query: str, top_k: int = 5,
           category: Optional[str] = None,
           delivery: Optional[str] = None) -> list[Course]:
    """Token-overlap ranking over the whole catalogue.

    Exact enough at 75 rows, deterministic, and with no embedding call in the
    latency path — the reason this service has no vector store.
    """
    q = tokens(query)
    snap = snapshot()
    scored: list[tuple[float, Course]] = []
    for c in snap.courses.values():
        if delivery and c.course_type != delivery:
            continue
        if category and not any(category.lower() in cat.lower() for cat in c.categories):
            continue
        if not q:
            scored.append((0.0, c))
            continue
        overlap = q & c._search_blob
        if not overlap:
            continue
        score = len(overlap) / len(q)
        name_hits = q & tokens(c.name)
        score += 1.5 * len(name_hits)                 # title matches dominate
        if snap.events_by_course.get(c.id):
            score += 0.25                             # prefer bookable courses
        scored.append((score, c))
    scored.sort(key=lambda x: (-x[0], x[1].name))
    return [c for _, c in scored[:top_k]]


def catalog_digest(limit: int = 200) -> str:
    """Compact catalogue for the system prompt: one line per course. ~3k tokens
    for the whole thing, and identical between turns so it stays cacheable."""
    snap = snapshot()
    lines = []
    for c in sorted(snap.courses.values(), key=lambda x: x.name)[:limit]:
        bits = [f"#{c.id}", c.name]
        if c.categories:
            bits.append("/".join(c.categories))
        if c.delivery:
            bits.append(c.delivery)
        if c.duration_text:
            bits.append(c.duration_text)
        n = len(snap.events_by_course.get(c.id, []))
        if n:
            bits.append(f"{n} دفعة قادمة")
        lines.append(" | ".join(bits))
    return "\n".join(lines)


async def refresher_loop() -> None:
    s = get_settings()
    while True:
        try:
            await asyncio.sleep(s.catalog_refresh_seconds)
            await refresh(full=False)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("catalogue refresh failed; will retry")
