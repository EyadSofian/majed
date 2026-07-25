"""Test doubles mirroring the REAL Engosoft Odoo shapes.

Deliberately reproduces the traps found in the live database, so the tests fail
if the code ever regresses to the naive reading:
  * `list_price` is 0 on every course — the price lives in the pricelist.
  * pricelist items come in both the template and the variant shape.
  * one published event is in the past and one has registration closed.
  * `slide.channel.website_url` is absolute, `product.template.website_url` is
    relative.
"""
from typing import Any, Iterator, Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from app.odoo import OdooAccessDenied

# --------------------------------------------------------------------- model
class ScriptedModel(BaseChatModel):
    """Replays a script of turns: {"tool": name, "args": {...}} or {"text": ...}."""

    script: list = []
    cursor: int = 0
    calls: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kw: Any) -> "ScriptedModel":
        return self

    def _next(self) -> dict:
        if self.cursor >= len(self.script):
            return {"text": "تمام."}
        step = self.script[self.cursor]
        self.cursor += 1
        return step

    def _generate(self, messages, stop=None, run_manager=None, **kw) -> ChatResult:
        self.calls.append(list(messages))
        step = self._next()
        if "tool" in step:
            msg = AIMessage(content="", tool_calls=[{
                "name": step["tool"], "args": step.get("args", {}),
                "id": f"call_{self.cursor}"}])
        else:
            msg = AIMessage(content=step["text"])
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _stream(self, messages, stop=None, run_manager=None,
                **kw) -> Iterator[ChatGenerationChunk]:
        self.calls.append(list(messages))
        step = self._next()
        if "tool" in step:
            yield ChatGenerationChunk(message=AIMessageChunk(
                content="", tool_calls=[{
                    "name": step["tool"], "args": step.get("args", {}),
                    "id": f"call_{self.cursor}"}]))
            return
        words = step["text"].split(" ")
        for i, w in enumerate(words):
            yield ChatGenerationChunk(
                message=AIMessageChunk(content=w if i == len(words) - 1 else w + " "))


# ------------------------------------------------------------------ the data
CATEGORIES = {4: "Management and Safety", 7: "BIM", 9: "Best Seller"}

COURSES = [
    {"id": 2092, "name": "PMP Preparation Course - 8th Edition ",
     "default_code": "847", "website_url": "/shop/pmp-preparation-course-8th-edition-2092",
     "is_published": True, "sale_ok": True, "detailed_type": "course",
     "course_type": "attendance_recorded", "course_subtitle": "PMI PMP exam prep",
     "description_sale": "Project management professional preparation.",
     "course_duration_text": "36 Accredited Training Hours",
     "course_certificate_text": "Accredited Certificate",
     "public_categ_ids": [4], "list_price": 0.0, "currency_id": [73, "EGP"],
     "recorded_instructor_ids": [4129], "attendance_instructor_ids": [4111],
     "instructor_tagline": "PMP certified trainers",
     "write_date": "2026-07-20 10:00:00"},
    {"id": 2107, "name": "Navisworks MEP", "default_code": "873",
     "website_url": "/shop/navisworks-mep-2107", "is_published": True,
     "sale_ok": True, "detailed_type": "course", "course_type": "recorded",
     "course_subtitle": "BIM coordination and clash detection",
     "description_sale": "Autodesk Navisworks for MEP coordination.",
     "course_duration_text": "15 Accredited Training Hours",
     "public_categ_ids": [9, 7], "list_price": 0.0, "currency_id": [73, "EGP"],
     "recorded_instructor_ids": [4156], "attendance_instructor_ids": [],
     "write_date": "2026-07-18 10:00:00"},
    {"id": 2116, "name": "Revit Electrical Design", "default_code": "891",
     "website_url": "/shop/revit-electrical-design-2116", "is_published": True,
     "sale_ok": True, "detailed_type": "course", "course_type": "attendance",
     "course_subtitle": "Electrical systems in Revit",
     "description_sale": "Lighting, power, low current in Revit.",
     "course_duration_text": "15 Accredited Training Hours",
     "public_categ_ids": [9, 7], "list_price": 0.0, "currency_id": [73, "EGP"],
     "recorded_instructor_ids": [], "attendance_instructor_ids": [4149],
     "write_date": "2026-07-19 10:00:00"},
]

# slide.channel side — note website_url is ABSOLUTE here, unlike products
CHANNELS = [
    {"id": 209, "name": "PMP Preparation Course - 8th Edition",
     "website_url": "https://engosoft.com/slides/pmp-209",
     "product_id": [2046, "[847] PMP"], "total_slides": 8, "total_time": 0,
     "members_count": 132, "rating_avg": 5.0, "enroll": "payment",
     "visibility": "connected"},
    {"id": 191, "name": "NavisWorks (MEP)",
     "website_url": "https://engosoft.com/slides/navisworks-mep-191",
     "product_id": [2059, "[873] Navisworks MEP"], "total_slides": 4,
     "total_time": 4.65, "members_count": 31, "rating_avg": 0.0,
     "enroll": "payment", "visibility": "public"},
]
VARIANTS = {2046: 2092, 2059: 2107, 9092: 2092, 9107: 2107, 9116: 2116}

PRICES = {  # template -> currency -> amount
    2092: {"EGP": 6900, "USD": 180, "SAR": 690, "AED": 690},
    2107: {"EGP": 4815, "USD": 130, "SAR": 480, "AED": 480},
    2116: {"EGP": 9375, "USD": 250, "SAR": 940, "AED": 940},
}

EVENTS = [
    {"id": 1400, "name": "PMP Course Online - 5675",
     "date_begin": "2026-08-16 17:00:00", "date_end": "2026-09-23 20:00:00",
     "date_tz": "Asia/Riyadh", "address_id": [3569, "Engosoft - KSA"],
     "seats_available": 70, "seats_max": 100, "seats_limited": True,
     "seats_taken": 30, "event_registrations_open": True,
     "event_registrations_sold_out": False, "is_published": True,
     "website_url": "/event/e05675-pmp-course-online-5675-1400",
     "course_id": [209, "PMP Preparation Course - 8th Edition"],
     "is_package_event": False, "total_lectures_number": 12},
    # registration CLOSED — must be filtered out of anything we offer
    {"id": 1401, "name": "PMP Course Online - closed",
     "date_begin": "2026-09-01 17:00:00", "date_end": "2026-10-01 20:00:00",
     "date_tz": "Asia/Riyadh", "address_id": [3569, "Engosoft - KSA"],
     "seats_available": 5, "seats_max": 40, "seats_limited": True,
     "seats_taken": 35, "event_registrations_open": False,
     "event_registrations_sold_out": False, "is_published": True,
     "website_url": "/event/e05676-pmp-closed-1401",
     "course_id": [209, "PMP Preparation Course - 8th Edition"],
     "is_package_event": False, "total_lectures_number": 12},
    {"id": 1310, "name": "Navisworks - MEP - 5591",
     "date_begin": "2026-08-20 16:00:00", "date_end": "2026-08-25 20:00:00",
     "date_tz": "Asia/Riyadh", "address_id": [3569, "Engosoft - KSA"],
     "seats_available": 3, "seats_max": 50, "seats_limited": True,
     "seats_taken": 47, "event_registrations_open": True,
     "event_registrations_sold_out": False, "is_published": True,
     "website_url": "/event/e05591-navisworks-mep-5591-1310",
     "course_id": [191, "NavisWorks (MEP)"],
     "is_package_event": True, "total_lectures_number": 3},
]

EMPLOYEES = {
    4129: {"id": 4129, "name": "Dr.Ayman Atef Ali Fawzi",
           "job_title": "PRIMAVERA & PMP Instructor", "work_email": False,
           "department_id": [2226, "NONTECHNICAL INSTRUCTORS SECTION"], "active": True},
    4111: {"id": 4111, "name": "Eng.Mohamed Hamdy", "job_title": "PMP Instructor",
           "work_email": False, "department_id": [2226, "NONTECHNICAL INSTRUCTORS SECTION"],
           "active": True},
    4156: {"id": 4156, "name": "MOHAMED MOSTAFA ABD EL-WAHAB ABOAUF",
           "job_title": "BIM Architecture Instructor", "work_email": "x@y.com",
           "department_id": [2225, "TECHNICAL INSTRUCTORS SECTION"], "active": True},
    4149: {"id": 4149, "name": "Abdelrhman Nasr Eldeen",
           "job_title": "BIM Architecture Instructor", "work_email": False,
           "department_id": [2225, "TECHNICAL INSTRUCTORS SECTION"], "active": True},
}

PACKAGES = {
    "available": True,
    "packages": [{
        "id": 5, "name": "Interior Design Professional Track",
        "website_url": "/training_package/interior-design-professional-track-5",
        "url": "https://engosoft.com/training_package/interior-design-professional-track-5",
        "package_type": "both", "attendee_type": "both_attendees",
        "total_price": 30000, "final_price": 24000, "discount": 20.0,
        "currency_id": [73, "EGP"], "num_courses_display": 4,
        "training_hours_attendee": 60, "training_hours_recorded": 20,
        "review_rating_avg": 4.8, "review_rating_count": 12,
        "public_categ_ids": [2], "badge_text": "الأكثر طلباً",
        "levels_ids": [1], "product_ids": [11, 12], "groups_ids": [33],
        "write_date": "2026-07-01 09:00:00"}],
    "lines": [
        {"id": 11, "name": "AutoCAD for Interior Design", "package_id": [5, "IDPT"],
         "level_id": [1, "Level 1"], "product_id": [2116, "Revit Electrical Design"],
         "sequence": 1, "sale_ok": True},
        {"id": 12, "name": "Navisworks MEP", "package_id": [5, "IDPT"],
         "level_id": [1, "Level 1"], "product_id": [2107, "Navisworks MEP"],
         "sequence": 2, "sale_ok": True},
    ],
    "levels": [{"id": 1, "name": "Level 1", "package_id": [5, "IDPT"],
                "sequence": 1, "attendee_course_count": 2, "recorded_course_count": 2}],
    "groups": [{"id": 33, "name": "July Group 2026",
                "full_display_name": "July Group 2026 (Alaa Saleh - 5452)",
                "package_id": [5, "IDPT"], "sale_status": "active",
                "is_available_for_sale": True,
                "first_event_date": "2026-08-10 17:00:00",
                "online_event_ids": [1400], "onsite_event_ids": [],
                "online_total_price": 24000, "onsite_total_price": 0}],
}


class FakeOdoo:
    """Implements only what catalog.py and tools.py actually call."""

    def __init__(self, *, packages_denied: bool = False, fail: bool = False):
        self.packages_denied = packages_denied
        self.fail = fail
        self.leads: list = []
        self.price_calls: list = []

    def _boom(self):
        if self.fail:
            raise RuntimeError("odoo timeout")

    async def fetch_courses(self, since: Optional[str] = None) -> list[dict]:
        self._boom()
        if since:
            return [c for c in COURSES if c["write_date"] > since]
        return [dict(c) for c in COURSES]

    async def fetch_channel_links(self) -> dict[int, dict]:
        self._boom()
        out = {}
        for ch in CHANNELS:
            c = dict(ch)
            c["template_id"] = VARIANTS.get(ch["product_id"][0])
            out[ch["id"]] = c
        return out

    async def fetch_prices(self, template_ids, currency: str) -> dict[int, dict]:
        self._boom()
        self.price_calls.append((list(template_ids), currency))
        cur = (currency or "EGP").upper()
        return {int(t): {"price": PRICES[int(t)][cur], "currency": cur}
                for t in template_ids if int(t) in PRICES and cur in PRICES[int(t)]}

    async def fetch_upcoming_events(self, horizon_days=None) -> list[dict]:
        self._boom()
        out = []
        for e in EVENTS:
            r = dict(e)
            r["registration_open"] = bool(e["event_registrations_open"])
            r["url"] = "https://engosoft.com" + e["website_url"]
            out.append(r)
        return out

    async def fetch_instructors(self, ids) -> dict[int, dict]:
        self._boom()
        return {i: EMPLOYEES[i] for i in ids if i in EMPLOYEES}

    async def fetch_all_instructors(self) -> list[dict]:
        self._boom()
        return list(EMPLOYEES.values())

    async def fetch_packages(self) -> dict:
        if self.packages_denied:
            return {"available": False, "reason": "access_denied",
                    "packages": [], "lines": [], "levels": [], "groups": []}
        self._boom()
        return PACKAGES

    async def read(self, model: str, ids, fields) -> list[dict]:
        self._boom()
        if model == "product.public.category":
            return [{"id": i, "name": CATEGORIES[i]} for i in ids if i in CATEGORIES]
        if model == "hr.employee":
            return [EMPLOYEES[i] for i in ids if i in EMPLOYEES]
        return []

    async def product_variant_id(self, template_id: int):
        self._boom()
        for v, t in VARIANTS.items():
            if t == int(template_id):
                return v
        return None

    async def create_lead(self, payload: dict) -> int:
        self._boom()
        self.leads.append(payload)
        return 5000 + len(self.leads)
