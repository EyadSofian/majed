"""What the dropped attendance lines actually cost the customer.

The `sale_ok` rejection in `fetch_packages` was logged as a warning and read
like a cosmetic degradation — "tracks will show their recorded courses only".
It was not cosmetic. A package's discipline is derived from its member
COURSES (`_package_field`), so a track sold only as attendance arrives with no
lines at all, no discipline, and is then dropped by the field filter in
`search_packages`.

The customer-visible result is the one in the transcript: a mechanical
engineer says "مهندس ميكانيكا", and the mechanical track is never offered —
the model describes a path in prose instead of sending the package card,
because the tool handed it nothing to send.
"""
import json

import pytest

from app import catalog, tools

# Real Engosoft product ids: the KB maps these three to Mechanical.
MECH_COURSES = [(1223, "HVAC System Design"),
                (1224, "Firefighting Design System"),
                (1226, "Plumbing Systems Design")]

PACKAGE = {"id": 6, "name": "Mechanical Engineering Professional Track ",
           "public_categ_ids": [], "currency_id": [73, "EGP"],
           "num_courses_display": 3, "url": "/shop/mech-track"}


def _data(*, attendance_only: bool) -> dict:
    """The mechanical track, sold either as attendance or as recorded."""
    rows = [{"id": 100 + i, "name": name, "package_id": [6, "MEPT"],
             "level_id": [1, "Level 1"], "product_id": [pid, name],
             "sequence": 10 + i}
            for i, (pid, name) in enumerate(MECH_COURSES)]
    return {"available": True, "packages": [PACKAGE],
            "lines": [] if attendance_only else rows,
            "attendee_lines": rows if attendance_only else [],
            "levels": [], "groups": [], "outcomes": []}


def _dropped(data: dict) -> dict:
    """The same payload as it arrived while Odoo was rejecting the read."""
    out = dict(data)
    out["attendee_lines"] = []
    return out


@pytest.fixture(autouse=True)
def _sinks():
    tools.PACKAGE_SINK.set([])
    tools.CARD_SINK.set([])
    tools.CURRENCY.set("EGP")
    yield


def test_an_attendance_only_track_has_a_discipline():
    """Nothing else works if the field cannot be read from the courses."""
    lines_by = tools._by_package(tools._merged_lines(_data(attendance_only=True)))
    assert tools._package_field(lines_by[6]) == "Mechanical"


def test_dropping_the_attendance_lines_erases_that_discipline():
    """The precise mechanism: no lines -> no field -> nothing to match on."""
    data = _dropped(_data(attendance_only=True))
    lines_by = tools._by_package(tools._merged_lines(data))
    assert tools._package_field(lines_by.get(6, [])) is None


async def test_a_mechanical_engineer_is_offered_the_mechanical_track(monkeypatch):
    """The end the customer sees: the card is sent."""
    data = _data(attendance_only=True)
    monkeypatch.setattr(catalog, "ensure_packages", _returns(data))
    monkeypatch.setattr(tools, "_ensure_catalog", _returns(catalog.snapshot()))

    out = json.loads(await tools.search_packages.ainvoke({"query": "ميكانيكا"}))

    assert isinstance(out, list) and out, out
    assert out[0]["package_id"] == 6
    assert tools._packages(), "no package card was pushed to the widget"


async def test_and_was_not_while_the_attendance_read_was_being_rejected(monkeypatch):
    """The same question, against the data production actually had."""
    monkeypatch.setattr(catalog, "ensure_packages",
                        _returns(_dropped(_data(attendance_only=True))))
    monkeypatch.setattr(tools, "_ensure_catalog", _returns(catalog.snapshot()))

    out = json.loads(await tools.search_packages.ainvoke({"query": "ميكانيكا"}))

    assert out == {"packages": [], "note": "no_match"}
    assert not tools._packages(), "expected the reproduction to send nothing"


def _returns(value):
    async def _f(*a, **kw):
        return value
    return _f
