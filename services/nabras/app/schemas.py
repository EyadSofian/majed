from typing import Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    # Accepts either `session_id` or the Fahym-compatible `fahem_session_id`.
    session_id: str = Field(validation_alias="fahem_session_id", max_length=128)
    language: str = "auto"
    page_type: Optional[str] = None      # courseDetail | courses | trackDetail | tracks
    slug: Optional[str] = None

    model_config = {"populate_by_name": True}


class CourseCard(BaseModel):
    course_id: Optional[int] = None
    title: str
    slug: str
    url: str
    thumbnail_url: Optional[str] = None
    rating: Optional[float] = None
    price_display: Optional[str] = None
    checkout_url: Optional[str] = None    # <- the sell edge over Fahym


class LeadPayload(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    course_interest: Optional[str] = None
    notes: Optional[str] = None
