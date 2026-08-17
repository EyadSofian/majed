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

from . import curriculum
from .config import get_settings
from .odoo import COURSE_TYPE_LABELS, abs_url, image_url, odoo

log = logging.getLogger("nabras.catalog")

_WORD = re.compile(r"[\w؀-ۿ]+", re.UNICODE)
# Arabic orthographic variants that would otherwise split identical words.
_AR_NORM = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه",
                          "ؤ": "و", "ئ": "ي"})


def tokens(text: str) -> set[str]:
    return {_ar_stem(w.translate(_AR_NORM).lower())
            for w in _WORD.findall(text or "") if len(w) > 1}


# Arabic letter -> its usual Latin spelling in an Engosoft instructor name.
_TRANSLIT = {
    "ا": "a", "أ": "a", "إ": "a", "آ": "a", "ء": "a", "ى": "a", "ع": "a",
    "ب": "b", "ت": "t", "ة": "h", "ث": "th", "ج": "g", "ح": "h", "خ": "kh",
    "د": "d", "ذ": "z", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s",
    "ض": "d", "ط": "t", "ظ": "z", "غ": "gh", "ف": "f", "ق": "q", "ك": "k",
    "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w", "ي": "y", "ئ": "y",
    "ؤ": "w",
}
_WEAK = set("aeiouwy")


def name_key(word: str) -> str:
    """The consonant skeleton of a name, in either script.

    People type «عمرو كمال»; Odoo stores "Amr Kamal". Matching the two as
    strings finds nothing, and the bot then tells a customer that a real
    instructor does not exist. Vowels and the weak letters (و / ي) are exactly
    what differs between spellings, so both sides collapse to what is stable:
        عمرو → amrw → mr   ·   Amr → mr
        كمال → kmal → kml  ·   Kamal → kml
    """
    latin = "".join(_TRANSLIT.get(ch, ch) for ch in (word or "").lower())
    out: list[str] = []
    for ch in latin:
        if not ch.isalnum() or ch in _WEAK:
            continue
        if not out or out[-1] != ch:      # "abbas" and "abas" are one name
            out.append(ch)
    return "".join(out)


def name_keys(text: str) -> set[str]:
    """Skeletons of every meaningful word, minus the honorifics that are not
    part of anyone's name."""
    drop = {"", "d", "dr", "ng", "eng", "mr", "ms", "prof", "m"}
    keys = {name_key(w) for w in _WORD.findall(text or "")}
    return {k for k in keys if k and k not in drop and len(k) > 1}


def _ar_stem(word: str) -> str:
    """Drop the Arabic definite article. Customers type "الكهربا" and
    "التصميم"; without this they match neither the alias table nor a package
    named "التصميم الداخلي". The length guard keeps short real words
    ("الف", "الي") intact."""
    return word[2:] if len(word) > 4 and word.startswith("ال") else word


@dataclass
class Course:
    id: int
    name: str                     # as the API user reads it (English)
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
    # The discipline as Engosoft's own course map assigns it — what a visitor
    # means by "تخصص". The shop's categories are merchandising, not disciplines.
    field_name: str = ""
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

    @property
    def display_name(self) -> str:
        """The title in the site's default language. Per-visitor titles go
        through `title_for(course, lang)` — see it for why."""
        return title_for(self)


@dataclass
class Snapshot:
    courses: dict[int, Course] = field(default_factory=dict)
    categories: dict[int, str] = field(default_factory=dict)
    instructors: dict[int, dict] = field(default_factory=dict)
    events_by_course: dict[int, list[dict]] = field(default_factory=dict)
    events_by_channel: dict[int, list[dict]] = field(default_factory=dict)
    packages: dict[str, Any] = field(default_factory=dict)
    # Odoo lang code -> {course id: title in that language}. One entry per
    # language a visitor has actually shown up in; an empty dict for a language
    # means Odoo had nothing for it, and is cached so we stop asking.
    names_by_lang: dict[str, dict[int, str]] = field(default_factory=dict)
    packages_source: str = "odoo"        # odoo | ingest
    packages_at: float = 0.0
    loaded_at: float = 0.0
    last_write_date: Optional[str] = None

    @property
    def ready(self) -> bool:
        return bool(self.courses)


_snap = Snapshot()


def snapshot() -> Snapshot:
    return _snap


async def _refresh_packages_from_odoo(
        snap: Snapshot, *, force: bool = False) -> bool:
    """Refresh packages directly from their canonical Odoo models.

    A previous access denial may have been fixed without a deploy, so stale
    package data must retry Odoo rather than remaining on n8n forever. A
    transient failure never erases the last known-good snapshot.
    """
    s = get_settings()
    if (not force and (snap.packages or {}).get("available")
            and time.time() - snap.packages_at < s.packages_max_age_seconds):
        return True
    try:
        fetched = await odoo.fetch_packages()
    except Exception:  # noqa: BLE001
        log.exception("direct Odoo package refresh failed")
        return False
    if fetched.get("available"):
        snap.packages = fetched
        snap.packages_source = "odoo"
        snap.packages_at = time.time()
        log.info("packages refreshed directly from Odoo: %d",
                 len(fetched.get("packages") or []))
        return True
    if not (snap.packages or {}).get("available"):
        snap.packages = fetched
        snap.packages_source = "odoo"
        snap.packages_at = time.time()
    return False


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
        # Nothing edited — refresh the volatile parts. Package permissions or
        # contents can change independently of product.template.write_date.
        await _refresh_events(_snap)
        await _refresh_packages_from_odoo(_snap)
        _snap.loaded_at = time.time()
        return _snap

    if full or not _snap.ready:
        snap = Snapshot()
        # A full rebuild must not discard the last known-good package snapshot
        # before the direct Odoo refresh (or its n8n fallback) succeeds.
        snap.packages = _snap.packages
        snap.packages_source = _snap.packages_source
        snap.packages_at = _snap.packages_at
        # keep the languages already in play; _refresh_titles refills them
        snap.names_by_lang = {k: {} for k in _snap.names_by_lang}
    else:
        snap = _snap
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
    # The course map may only ever speak about courses this shop publishes.
    curriculum.prune(snap.courses)
    await _refresh_titles(snap, [r["id"] for r in rows])
    for c in snap.courses.values():
        c.categories = [snap.categories.get(i, "") for i in c.category_ids]
        c.categories = [x for x in c.categories if x]
        # BOTH names go in the blob: the customer may type either, and an
        # Arabic-only blob would stop matching "navisworks".
        # The KB's keyword tree is the difference between «تكييف» finding HVAC
        # and finding nothing: Odoo holds none of the words customers type.
        c.field_name = curriculum.field_for(c.id)
        kb_words = curriculum.keywords_for(c.id)
        c._search_blob = tokens(" ".join(
            [c.name, c.subtitle, c.description[:600], c.duration_text,
             c.delivery, c.instructor_tagline, *c.categories, *kb_words]))
        for names in snap.names_by_lang.values():
            if names.get(c.id):
                c._search_blob |= tokens(names[c.id])

    if instr_ids:
        snap.instructors.update(await odoo.fetch_instructors(instr_ids))
    # The whole teaching staff, not only whoever is attached to a course today.
    # It goes into the system prompt: the model can then map «عمرو كمال» onto
    # "Amr Kamal" itself — language is its job — while still being unable to
    # name anyone who is not on this list.
    if not since:
        try:
            for e in await odoo.fetch_all_instructors():
                snap.instructors.setdefault(e["id"], e)
        except Exception:  # noqa: BLE001
            log.warning("instructor directory unavailable — "
                        "only course-linked instructors will be known")

    await _attach_channels(snap)
    await _refresh_events(snap)
    await _refresh_packages_from_odoo(snap, force=True)

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


_LANG = re.compile(r"^[a-z]{2}([_-][A-Za-z0-9]{2,4})?$")
MAX_LANGS = 6          # bound on how many languages we will hold titles for


def normalize_lang(lang: str) -> str:
    """`ar-001` (what a browser reports) -> `ar_001` (what Odoo stores)."""
    lang = (lang or "").strip()
    return lang.replace("-", "_") if _LANG.match(lang) else ""


def title_for(course: "Course", lang: str = "") -> str:
    """The course title as THIS visitor's site is rendering it.

    Odoo serves translatable fields in the API user's language, and the bot's
    user is English. A visitor reading «تصميم أنظمة التيار الخفيف» must not be
    answered about "Light Current Systems Design" — that reads like a different
    product. Falls back to the site default, then to whatever Odoo gave us, so
    a missing translation never blanks a title.
    """
    snap = _snap
    for key in (normalize_lang(lang), get_settings().odoo_lang):
        if key:
            name = snap.names_by_lang.get(key, {}).get(course.id)
            if name:
                return name
    return course.name


async def ensure_language(lang: str) -> None:
    """Make sure titles for `lang` are loaded. No-op after the first visitor."""
    lang = normalize_lang(lang)
    if not lang:
        return
    snap = _snap
    if not snap.ready:                 # first request of a cold process
        snap = await refresh(full=True)
    if lang in snap.names_by_lang or len(snap.names_by_lang) >= MAX_LANGS:
        return
    await _load_titles(snap, lang, list(snap.courses))


async def _load_titles(snap: Snapshot, lang: str, ids: list[int]) -> None:
    if not lang or not ids:
        return
    try:
        rows = await odoo.read_in_language(
            "product.template", ids, ["id", "name"], lang)
    except Exception:  # noqa: BLE001
        log.warning("titles unavailable for lang=%s — keeping the default", lang)
        snap.names_by_lang.setdefault(lang, {})   # remember, stop retrying
        return
    names = snap.names_by_lang.setdefault(lang, {})
    for cid, r in rows.items():
        name = (r.get("name") or "").strip()
        if not name:
            continue
        names[cid] = name
        c = snap.courses.get(cid)
        if c is not None:
            # a customer may type either spelling, so both stay searchable
            c._search_blob |= tokens(name)
    log.info("titles: %d rows for lang=%s", len(rows), lang)


async def _refresh_titles(snap: Snapshot, ids: list[int]) -> None:
    """Re-read titles for every language already in play, for the rows that
    just changed — otherwise a renamed course keeps its old title per language."""
    langs = {get_settings().odoo_lang} | set(snap.names_by_lang)
    for lang in sorted(x for x in langs if x):
        await _load_titles(snap, lang, ids)


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
           delivery: Optional[str] = None,
           field_name: Optional[str] = None) -> list[Course]:
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
        # The discipline filter is the KB's, not the shop's: a question about
        # «ميكانيكا» must never be answered with a BIM course because the shop
        # happens to file it under a category that shares a word.
        if field_name and c.field_name != field_name:
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


def instructor_digest(limit: int = 300) -> str:
    """The teaching staff, one line each, for the system prompt.

    Names live in Odoo in English and customers type them in Arabic. Handing the
    model the real list lets it do the matching — that is language work, which
    it is better at than any transliteration table — and at the same time makes
    inventing an instructor impossible: if the name is not on this list, it does
    not exist to say.
    """
    snap = snapshot()
    if not snap.instructors:
        return ""
    teaching: dict[int, int] = {}
    for c in snap.courses.values():
        for i in c.instructor_ids:
            teaching[i] = teaching.get(i, 0) + 1
    rows = sorted(snap.instructors.values(),
                  key=lambda e: (-teaching.get(e["id"], 0), e.get("name") or ""))
    lines = []
    for e in rows[:limit]:
        bits = [f"#{e['id']}", (e.get("name") or "").strip()]
        if e.get("job_title"):
            bits.append(str(e["job_title"]).strip())
        n = teaching.get(e["id"], 0)
        if n:
            bits.append(f"{n} كورس")
        lines.append(" | ".join(bits))
    return "\n".join(lines)


def courses_in_field(field_name: str) -> list[Course]:
    """Every catalogue course the KB assigns to this discipline, KB order."""
    snap = snapshot()
    return [snap.courses[i] for i in curriculum.fields().get(field_name, [])
            if i in snap.courses]


def catalog_digest(limit: int = 200) -> str:
    """Compact catalogue for the system prompt: one line per course. ~3k tokens
    for the whole thing, and identical between turns so it stays cacheable."""
    snap = snapshot()
    lines = []
    for c in sorted(snap.courses.values(), key=lambda x: x.name)[:limit]:
        bits = [f"#{c.id}", c.display_name]
        if c.display_name != c.name:
            bits.append(c.name)   # both names, so a reply can use either language
        if c.categories:
            bits.append("/".join(c.categories))
        if c.delivery:
            bits.append(c.delivery)
        if c.duration_text:
            bits.append(c.duration_text)
        n = len(snap.events_by_course.get(c.id, []))
        if n:
            bits.append(f"{n} دفعة قادمة")
        # Who the course is for. These are the two fields the SLA's mapping
        # turns on — audience is the job title (مهندس / مشرف / فني), level the
        # experience floor — and they used to reach the model only if it
        # happened to call search_courses. On the package path it never did, so
        # it was matching a trainee to a course half-blind. `level` is squeezed
        # to "0+"/"5+" because "From 5 and Above" says the same thing 4x longer.
        aud = curriculum.audience_for(c.id)
        if aud.get("audience"):
            bits.append(aud["audience"])
        lvl = _level_short(aud.get("level"))
        if lvl:
            bits.append(lvl)
        lines.append(" | ".join(bits))
    return "\n".join(lines)


_LEVEL_RE = re.compile(r"from\s+(\d+)", re.I)


def _level_short(level: Optional[str]) -> str:
    """"From 3 and Above" -> "3+". Anything unrecognised is passed through."""
    if not level:
        return ""
    m = _LEVEL_RE.search(level)
    return f"{m.group(1)}+" if m else level.strip()


_pkg_lock: Optional["asyncio.Lock"] = None


async def ensure_packages(max_age: Optional[float] = None) -> dict:
    """Make sure package data is present and fresh enough to answer with.

    Odoo is the canonical and first source. n8n remains a fallback only for an
    Odoo access denial/outage. A trainee asking about a track is the
    highest-value question we get, so stale data is refreshed on that turn.
    """
    global _pkg_lock
    s = get_settings()
    snap = _snap
    limit = s.packages_max_age_seconds if max_age is None else max_age
    fresh = bool((snap.packages or {}).get("available")) and \
        (time.time() - snap.packages_at) < limit
    if fresh:
        return snap.packages or {}

    if _pkg_lock is None:
        _pkg_lock = asyncio.Lock()
    async with _pkg_lock:                 # ten concurrent chats, one fetch
        snap = _snap
        if bool((snap.packages or {}).get("available")) and \
                (time.time() - snap.packages_at) < limit:
            return snap.packages
        if await _refresh_packages_from_odoo(snap, force=True):
            return snap.packages
        if not s.packages_webhook_url:
            return snap.packages or {}
        try:
            import httpx
            headers = {"X-Ingest-Token": s.ingest_token} if s.ingest_token else {}
            async with httpx.AsyncClient(timeout=s.packages_fetch_timeout) as c:
                r = await c.post(s.packages_webhook_url, json={"reason": "on_demand"},
                                 headers=headers)
                r.raise_for_status()
                payload = r.json()
            if isinstance(payload, list) and payload:
                payload = payload[0]      # n8n returns a list of items
            install_packages(payload)
            log.info("packages pulled on demand: %d",
                     len(_snap.packages.get("packages") or []))
        except Exception as e:  # noqa: BLE001
            # Never fail the customer's question over this: a stale or empty
            # snapshot still answers, the tool just says less.
            log.warning("on-demand package pull failed: %s", str(e)[:200])
        return _snap.packages or {}


def install_packages(payload: dict) -> dict:
    """Install a package snapshot pushed by n8n.

    Returns a small summary so the pusher can verify what landed.
    """
    snap = snapshot()
    keys = ("packages", "lines", "levels", "groups", "outcomes",
            "attendee_lines")
    data = {k: list(payload.get(k) or []) for k in keys}
    if not data["packages"]:
        raise ValueError("payload contains no packages")
    data["available"] = True
    snap.packages = data
    snap.packages_source = "ingest"
    snap.packages_at = time.time()
    log.info("packages ingested: %s", {k: len(v) for k, v in data.items()
                                       if isinstance(v, list)})
    return {k: len(v) for k, v in data.items() if isinstance(v, list)}


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
