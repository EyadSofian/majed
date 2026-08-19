"""Which discipline a track question is about, and what gets offered for it.

All three cases below come from one production turn on 2026-08-19:

    resolved contextual track 'المسار الشامل للمهندس الميكانيكي'
    with active field Interior Design and Decoration
    as 'التصميم الداخلي و الديكور شاملة'

    turn tools=[recommend_track] cards=4 packages=0
    turn tools=[recommend_track] cards=5 packages=0

A mechanical engineer asked for the comprehensive mechanical track. He was
resolved to interior design, and every reply carried the courses inside a
track but never the track itself — `packages=0` on every single turn.
"""
import json

import pytest

from app import catalog, curriculum, tools


# ------------------------------------------------------- which discipline
def test_a_named_discipline_beats_the_filler_words_around_it():
    """`مسار`/`للمهندس`/`شامل` are noise; `ميكانيكي` is the question.

    Asserted on `resolve_field` because that is what decides — it returned
    "Civil" in production, outvoted by the scaffolding of its own sentence.
    """
    assert tools.resolve_field("المسار الشامل للمهندس الميكانيكي") == "Mechanical"


def test_structural_words_alone_name_no_discipline():
    """These belong to nearly every field, so they cannot pick one."""
    for noise in ("مسار شامل", "باقه تدريب", "دوره كورس", "مهندس محترف",
                  "professional training package"):
        assert curriculum.field_of_query(noise) is None, noise


def test_the_words_that_do_carry_a_discipline_still_work():
    """Dropping the noise must not cost a real answer."""
    for query, field in (("ميكانيكا", "Mechanical"), ("تكييف", "Mechanical"),
                         ("كهرباء", "Electrical"), ("مدني", "Civil")):
        assert tools.resolve_field(query) == field, query


def test_the_kb_still_knows_the_vocabulary_no_alias_table_could_hold():
    """«تكييف» reaches Mechanical only because a course lists it."""
    assert curriculum.field_of_query("تكييف") == "Mechanical"


def test_a_question_that_names_its_field_is_not_a_contextual_follow_up():
    """"المسار الشامل" alone leans on context; naming a field does not."""
    assert tools._is_contextual_comprehensive_track("المسار الشامل") is True
    assert tools._is_contextual_comprehensive_track(
        "المسار الشامل للمهندس الميكانيكي") is False
    assert tools._is_contextual_comprehensive_track("عايز مسار كهرباء شامل") is False


def test_the_conversation_never_overrides_a_discipline_the_question_names():
    """The exact production line: mechanical question, interior-design context."""
    tok = tools.ACTIVE_FIELD.set("Interior Design and Decoration")
    try:
        q = "المسار الشامل للمهندس الميكانيكي"
        assert tools.resolve_specialization(q) == "Mechanical"
        assert not tools._is_contextual_comprehensive_track(q)
    finally:
        tools.ACTIVE_FIELD.reset(tok)


# ------------------------------------------------------- what gets offered
MECH_COURSES = [(1223, "HVAC System Design"),
                (1224, "Firefighting Design System"),
                (1226, "Plumbing Systems Design")]

PACKAGE = {"id": 6, "name": "Mechanical Engineering Professional Track",
           "public_categ_ids": [], "currency_id": [73, "EGP"],
           "num_courses_display": 3,
           "url": "https://engosoft.com/training_package/"
                  "mechanical-engineering-professional-track-6"}


def _packages_payload() -> dict:
    rows = [{"id": 100 + i, "name": name, "package_id": [6, "MEPT"],
             "level_id": [1, "Level 1"], "product_id": [pid, name],
             "sequence": 10 + i}
            for i, (pid, name) in enumerate(MECH_COURSES)]
    return {"available": True, "packages": [PACKAGE], "lines": rows,
            "attendee_lines": [], "levels": [], "groups": [], "outcomes": []}


@pytest.fixture(autouse=True)
def _sinks():
    tools.PACKAGE_SINK.set([])
    tools.CARD_SINK.set([])
    tools.CHIP_SINK.set([])
    tools.CURRENCY.set("EGP")
    yield


@pytest.fixture
def mechanical_catalogue(monkeypatch):
    """A snapshot that actually contains the mechanical courses.

    This matters: with an empty snapshot the KB grouping-rule branch finds no
    courses and quietly falls through to the package matcher, which DOES send a
    card — so the bug hides. Production has the courses, takes the grouping
    branch, and sends none.
    """
    snap = catalog.Snapshot()
    for oid in curriculum.group_members(curriculum.groups_for_field("Mechanical")[0]):
        snap.courses[oid] = catalog.Course(
            id=oid, name=f"Mechanical course {oid}",
            url=f"https://engosoft.com/shop/{oid}", image_url="", field_name="Mechanical")
    monkeypatch.setattr(catalog, "_snap", snap)

    async def _cat(*a, **kw):
        return snap

    monkeypatch.setattr(tools, "_ensure_catalog", _cat)
    return snap


@pytest.fixture
def mechanical_packages(monkeypatch):
    data = _packages_payload()

    async def _pkgs(*a, **kw):
        return data

    monkeypatch.setattr(catalog, "ensure_packages", _pkgs)
    return data


async def test_the_grouping_rule_branch_is_the_one_production_takes(
        mechanical_catalogue, mechanical_packages):
    """Guard the test above: prove we exercise the branch that was broken."""
    out = json.loads(await tools.recommend_track.ainvoke(
        {"track": "المسار الشامل للمهندس الميكانيكي"}))
    assert out.get("note") == "engosoft_grouping_rule", out.get("note")
    assert out["courses"], "the branch should still list the member courses"


async def test_the_track_itself_is_offered_not_only_its_courses(
        mechanical_catalogue, mechanical_packages):
    """`packages=0` on every production turn — the buyable thing never shipped."""
    out = json.loads(await tools.recommend_track.ainvoke(
        {"track": "المسار الشامل للمهندس الميكانيكي"}))

    cards = tools._packages()
    assert cards, f"still no package card; tool returned {out.get('note')!r}"
    assert cards[0]["package_id"] == 6
    assert "mechanical-engineering-professional-track-6" in cards[0]["url"]
    assert out.get("track"), "the model was told the courses but not the offer"


async def test_the_courses_inside_the_track_still_come_with_it(
        mechanical_catalogue, mechanical_packages):
    """The fix adds the package; it must not cost the path."""
    out = json.loads(await tools.recommend_track.ainvoke(
        {"track": "المسار الشامل للمهندس الميكانيكي"}))
    assert out["courses"]
    assert tools._cards(), "course cards disappeared"
