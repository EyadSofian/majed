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

from app.odoo import Odoo, OdooAccessDenied

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

# The profile the site renders in its own popup — biography plus the lists the
# customer scrolls through. Stored in custom fields, hence discovered not guessed.
EMPLOYEE_META = {
    "description": {"string": "Description", "type": "text"},
    "specialists": {"string": "Specialists", "type": "text"},
    "experience": {"string": "Experience", "type": "text"},
    "university_or_company": {"string": "University/Company", "type": "char"},
    # both of these match an innocent hint ("bio" in Biometric, "summary" in
    # Next Activity Summary) and must never reach a customer-facing card
    "device_ids": {"string": "Biometric IDs", "type": "one2many",
                   "relation": "hr.employee.devices_ids"},
    "activity_summary": {"string": "Next Activity Summary", "type": "char"},
    "message_ids": {"string": "Messages", "type": "one2many",
                    "relation": "mail.message"},
    "recorded_courses": {"string": "Recorded Courses", "type": "many2many",
                         "relation": "product.template"},
}

PROFILES = {
    4129: {
        "description": "الدكتور أيمن عاطف من أبرز الخبراء في إدارة المشاريع "
                       "بخبرة تتجاوز 20 عاماً، درّب أكثر من 1000 متخصص.",
        "specialists": "✔ Facility Management\n✔ Project Management\n"
                       "✔ Building Management Systems (BMS)",
        "experience": "✔ خبرة 25 عاماً بالمجال\n✔ درّب أكثر من 1000 شخص\n"
                      "✔ معتمد من PMI - SMRP - IFMA",
        "university_or_company": "Engosoft",
        "activity_summary": "HR Orientation",
        "device_ids": [],
    },
}

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

# Real shapes from the live database: three price candidates that differ ~6x,
# an unpublished package, and groups pointing at a package that is not published.
PACKAGES = {
    "available": True,
    "packages": [
        {"id": 5, "name": "Interior Design Professional Track",
         "website_url": "/training_package/interior-design-professional-track-5",
         "url": "https://engosoft.com/training_package/interior-design-professional-track-5",
         "website_published": True, "package_type": "both",
         "attendee_type": "both_attendees",
         "total_price": 23750, "final_price": 12000.875000000002,
         "discount": 49.47, "currency_id": [73, "EGP"],
         "attendee_online_discount": 52.29, "attendee_onsite_discount": 41.81,
         "num_courses_display": 6, "training_hours_attendee": 123,
         "training_hours_recorded": 38, "review_rating_avg": 0,
         "public_categ_ids": [], "badge_text": False,
         "levels_ids": [1, 2, 3], "product_ids": [52, 53],
         "groups_ids": [41, 45], "learning_outcomes_ids": [4, 7],
         "write_date": "2026-07-11 16:28:36"},
        # recorded-only track: no groups, so final_price IS the price
        {"id": 15, "name": "Infrastructure Professional Track",
         "website_url": "/training_package/infrastructure-professional-track-15",
         "url": "https://engosoft.com/training_package/infrastructure-professional-track-15",
         "website_published": True, "package_type": "recorded",
         "attendee_type": "both_attendees",
         "total_price": 15000, "final_price": 15000, "discount": 0,
         "currency_id": [73, "EGP"], "num_courses_display": 4,
         "training_hours_attendee": 0, "training_hours_recorded": 27,
         "review_rating_avg": 0, "levels_ids": [], "product_ids": [60],
         "groups_ids": [], "learning_outcomes_ids": [],
         "write_date": "2026-07-11 16:28:36"},
    ],
    "lines": [
        {"id": 52, "name": "Interior Design Basics Using SketchUp",
         "package_id": [5, "Interior Design Professional Track"],
         "level_id": [1, "Level 1"], "product_id": [1815, "[537] SketchUp"],
         "sequence": 10, "sale_ok": True, "website_published": True},
        {"id": 53, "name": "3ds Max for Interior Design",
         "package_id": [5, "Interior Design Professional Track"],
         "level_id": [2, "Level 2"], "product_id": [1093, "[36] 3ds Max"],
         "sequence": 11, "sale_ok": True, "website_published": True},
        # A line whose product IS in the published catalogue. In the live
        # database most lines resolve like this; the two above resolve to
        # nothing here, which is exactly the "part of the path but not sold
        # separately" case the track tool has to report instead of hiding.
        {"id": 54, "name": "Navisworks MEP",
         "package_id": [5, "Interior Design Professional Track"],
         "level_id": [2, "Level 2"], "product_id": [2107, "[873] Navisworks MEP"],
         "sequence": 12, "sale_ok": True, "website_published": True},
        {"id": 60, "name": "SewerGEMS Program",
         "package_id": [15, "Infrastructure Professional Track"],
         "level_id": False, "product_id": [1241, "[88] SewerGEMS"],
         "sequence": 10, "sale_ok": True, "website_published": True},
    ],
    # attendance side of the SAME track: a separate Odoo model. Course 2116 is
    # only sold as attendance, so reading the recorded lines alone would drop it
    # from the path the trainee is meant to follow.
    "attendee_lines": [
        {"id": 71, "name": "Revit Electrical Design",
         "package_id": [5, "Interior Design Professional Track"],
         "level_id": [2, "Level 2"], "product_id": [2116, "[891] Revit Electrical"],
         "sequence": 13, "sale_ok": True, "website_published": True},
        # already in the recorded lines — must not be listed twice
        {"id": 72, "name": "Navisworks MEP",
         "package_id": [5, "Interior Design Professional Track"],
         "level_id": [2, "Level 2"], "product_id": [2107, "[873] Navisworks MEP"],
         "sequence": 14, "sale_ok": True, "website_published": True},
    ],
    "levels": [
        {"id": 1, "name": "Level 1", "package_id": [5, "IDPT"], "sequence": 10,
         "attendee_course_count": 1, "recorded_course_count": 1},
        {"id": 2, "name": "Level 2", "package_id": [5, "IDPT"], "sequence": 11,
         "attendee_course_count": 2, "recorded_course_count": 3},
    ],
    "groups": [
        # started -> NOT sellable, must be ignored even though it is soonest
        {"id": 34, "name": "Group June 2026",
         "full_display_name": "Group June 2026 (Amal Oraby - 5507)",
         "package_id": [5, "IDPT"], "sale_status": "started",
         "is_available_for_sale": False,
         "first_event_date": "2026-06-15 17:00:00",
         "online_total_price": 31441, "onsite_total_price": 0},
        {"id": 41, "name": "Group July 2026",
         "full_display_name": "Group July 2026 (Zyad Mohamed - 5600)",
         "package_id": [5, "IDPT"], "sale_status": "active",
         "is_available_for_sale": True,
         "first_event_date": "2026-07-26 17:00:00",
         "online_total_price": 31440, "onsite_total_price": 0},
        {"id": 45, "name": "Evening Group July 2026",
         "full_display_name": "Evening Group July 2026 (M. Ibrahim 5620)",
         "package_id": [5, "IDPT"], "sale_status": "active",
         "is_available_for_sale": True,
         "first_event_date": "2026-08-20 15:30:00",
         "online_total_price": 0, "onsite_total_price": 58000},
        # group whose package is unpublished — must not crash anything
        {"id": 1, "name": "group A", "full_display_name": "group A",
         "package_id": [1, "Mechanical training courses"],
         "sale_status": "started", "is_available_for_sale": False,
         "first_event_date": "2024-12-31 17:30:00",
         "online_total_price": 5000, "onsite_total_price": 0},
    ],
    "outcomes": [
        {"id": 4, "name": "The fundamentals of interior space design.", "sequence": 10},
        {"id": 7, "name": "Producing interior plans using AutoCAD.", "sequence": 11},
    ],
}


# The same records in each language the shop serves. Odoo returns translatable
# fields in the *reader's* language, which is the whole reason titles are read
# per visitor rather than once.
NAMES_BY_LANG = {
    "ar_001": {
        2092: "دورة إدارة المشاريع الاحترافية (PMP)",
        2107: "تنسيق أنظمة الميكانيكا (Navisworks MEP)",
        2116: "تصميم الأنظمة الكهربائية باستخدام ريفيت (Revit Electrical)",
    },
    "fr_FR": {2107: "Coordination MEP (Navisworks)"},
}


class FakeOdoo(Odoo):
    """Fakes the WIRE, not the logic.

    Every method the code calls is overridden with canned Odoo responses, so
    field discovery, the ✔-list parsing and the profile assembly all run for
    real against real-shaped data. Anything not faked hits `execute` and raises,
    which is how an unnoticed new query gets caught.
    """

    def __init__(self, *, packages_denied: bool = False, fail: bool = False,
                 no_translations: bool = False):
        self.packages_denied = packages_denied
        self.no_translations = no_translations
        self.payments_denied = False
        self.no_profiles = False
        self.lang_calls: list[str] = []
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

    async def execute(self, model, method, args, kwargs=None):
        self._boom()
        if model == "hr.employee" and method == "fields_get":
            return {} if self.no_profiles else dict(EMPLOYEE_META)
        raise NotImplementedError(f"{model}.{method}")

    async def read(self, model: str, ids, fields) -> list[dict]:
        self._boom()
        if model == "hr.employee":
            return [{"id": i, **{f: PROFILES.get(i, {}).get(f, False)
                                 for f in fields if f != "id"}}
                    for i in ids if i in PROFILES]
        if model == "product.public.category":
            return [{"id": i, "name": CATEGORIES[i]} for i in ids if i in CATEGORIES]
        if model == "hr.employee":
            return [EMPLOYEES[i] for i in ids if i in EMPLOYEES]
        return []


    async def read_in_language(self, model: str, ids, fields, lang: str) -> dict:
        self._boom()
        self.lang_calls.append(lang)
        if not lang or self.no_translations:
            return {}
        names = NAMES_BY_LANG.get(lang, {})
        return {i: {"id": i, "name": names[i]} for i in ids if i in names}

    async def fetch_payment_options(self) -> dict:
        self._boom()
        if self.payments_denied:
            return {"available": False, "reason": "access_denied", "providers": []}
        return {"available": True, "providers": [
            {"name": "Bank Transfer", "code": "custom", "test_mode": False},
            {"name": "Paymob Card", "code": "paymob", "test_mode": False},
            # a provider left in test mode is not something a customer can use
            {"name": "Tamara", "code": "tamara", "test_mode": True},
        ]}

    async def fetch_variant_ids(self, template_ids) -> dict:
        self._boom()
        out = {}
        for v, t in sorted(VARIANTS.items()):
            if t in [int(i) for i in template_ids]:
                out.setdefault(t, v)
        return out

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
