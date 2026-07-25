from typing import Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    # Accepts either `session_id` or the Fahym-compatible `fahem_session_id`.
    session_id: str = Field(validation_alias="fahem_session_id", max_length=128)
    language: str = "auto"
    page_type: Optional[str] = None      # courseDetail | courses | package | shop
    slug: Optional[str] = None
    # Drives which pricelist quotes the price. Sent by the widget from the
    # website's active currency; EGP if absent.
    currency: Optional[str] = None
    # The visitor's Odoo language code (`ar_001`, `en_US`, …) — course titles
    # are shown in it, so the chat names a course the way the page does.
    lang: Optional[str] = None

    model_config = {"populate_by_name": True}


class Batch(BaseModel):
    """One upcoming run of a course (Odoo event.event)."""
    event_id: int
    starts_at: str
    ends_at: Optional[str] = None
    timezone: Optional[str] = None
    location: Optional[str] = None
    seats_available: Optional[int] = None
    seats_max: Optional[int] = None
    registration_open: bool = False
    url: Optional[str] = None


class Instructor(BaseModel):
    id: int
    name: str
    title: Optional[str] = None
    image_url: Optional[str] = None
    department: Optional[str] = None
    courses_count: int = 0
    teaches: list[str] = Field(default_factory=list)


class CourseCard(BaseModel):
    course_id: int
    title: str
    url: str
    image_url: Optional[str] = None
    price_display: Optional[str] = None
    currency: Optional[str] = None
    rating: Optional[float] = None
    delivery: Optional[str] = None          # حضوري / مسجّل / حضوري + تسجيل
    duration_text: Optional[str] = None
    categories: list[str] = Field(default_factory=list)
    instructors: list[Instructor] = Field(default_factory=list)
    next_batch: Optional[Batch] = None
    batches_count: int = 0
    checkout_url: Optional[str] = None      # the sell edge over Fahym


class PriceOption(BaseModel):
    """One buyable variant of a package.

    A package is not one price. It is a recorded track plus, for every live
    cohort, an online figure and an onsite figure — each with its own list price
    and its own discount. Collapsing them to a single number misquotes by
    multiples.
    """
    mode: str                              # recorded | attendance_online | attendance_onsite
    label: str                             # مسجّل / حضوري أونلاين — دفعة أغسطس
    price: float
    price_display: str
    was_display: Optional[str] = None      # struck-through list price
    discount: Optional[float] = None
    group_id: Optional[int] = None
    group_name: Optional[str] = None
    starts_at: Optional[str] = None


class PackageCard(BaseModel):
    package_id: int
    title: str
    url: str
    # Never one price: the recorded track plus an online and an onsite figure
    # for every sellable cohort. `price_from_display` is only the headline.
    price_options: list[PriceOption] = Field(default_factory=list)
    price_from_display: Optional[str] = None   # cheapest option, for the headline
    currency: Optional[str] = None
    courses_count: Optional[int] = None
    training_hours: Optional[int] = None
    attendance: Optional[str] = None       # أونلاين / حضوري / الاتنين
    rating: Optional[float] = None
    badge: Optional[str] = None
    next_group: Optional[str] = None
    starts_at: Optional[str] = None
    levels: list[str] = Field(default_factory=list)
    includes: list[str] = Field(default_factory=list)


class LeadPayload(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    course_interest: Optional[str] = None
    notes: Optional[str] = None
