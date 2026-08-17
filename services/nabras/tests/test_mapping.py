"""The SLA's mapping, asserted against the data it actually runs on.

The mapping in `Website.md` turns on four things: المجال · التخصص · سنوات الخبرة
· المسمّى الوظيفي. Two of those live in `curriculum.json` per course
(`field`/`audience`/`level`) and reach the model through the catalogue digest.
A course missing either is one the model has to guess about, and a guess here
recommends the wrong course to a paying trainee — so the whole catalogue is
checked, not a sample.
"""
import re

import pytest

from app import catalog, curriculum

# The four professional certifications the doc routes by years of experience,
# with the floor the *business rule* states (not Odoo's looser field).
DOC_CERTS = {
    "FMP": 1,    # إدارة المرافق ١–٣ سنوات
    "CFM": 5,    # إدارة المرافق ٥ فأكثر
    "CMRP": None,  # الصيانة والاعتمادية — the doc states no floor
    "PMP": 3,    # إدارة المشاريع ٣ فأكثر
}

# الباقة الشاملة حسب التخصص — the doc names four disciplines.
DOC_DISCIPLINES = ("Mechanical", "Electrical", "Civil", "Architecture")


def _courses():
    return curriculum._data()["courses"]


def _find(cert):
    """Courses whose keywords name this certification as a whole word."""
    pat = re.compile(rf"\b{cert}\b", re.I)
    return {cid: c for cid, c in _courses().items()
            if any(pat.search(k) for k in c.get("keywords", []))}


def test_every_course_carries_the_mapping_fields():
    """audience + level + field are what the mapping matches on."""
    missing = {
        key: sorted(cid for cid, c in _courses().items() if not c.get(key))
        for key in ("field", "audience", "level")
    }
    assert missing == {"field": [], "audience": [], "level": []}, missing


@pytest.mark.parametrize("cert", sorted(DOC_CERTS))
def test_each_documented_certification_exists(cert):
    """FMP was absent entirely, so «إدارة المرافق ١–٣ → FMP» could not be met."""
    found = _find(cert)
    assert found, f"{cert} is in the mapping doc but not in curriculum.json"


@pytest.mark.parametrize("cert,floor", sorted(
    (c, f) for c, f in DOC_CERTS.items() if f is not None))
def test_certification_experience_floor_is_reachable(cert, floor):
    """The catalogue floor must not exclude someone the doc says qualifies.

    PMP is the live example: the doc requires 3 years, Odoo's field says 1. A
    looser catalogue value is fine — the prompt states the real rule and is
    declared authoritative. A *stricter* one is not: it would turn away a
    trainee the business wants to enrol.
    """
    for cid, course in _find(cert).items():
        m = re.search(r"from\s+(\d+)", course.get("level", ""), re.I)
        if not m:
            continue
        assert int(m.group(1)) <= floor, (
            f"{cert} (#{cid}) demands {m.group(1)}+ years but the mapping "
            f"admits people at {floor}+")


def test_group_rules_only_reference_real_courses():
    """A discipline package pointing at an unknown id renders an empty track."""
    data = curriculum._data()
    known = set(data["courses"])
    for group in data["groups"]:
        unknown = [i for i in group.get("course_ids", []) if str(i) not in known]
        assert not unknown, f"{group['rule']}: unknown course ids {unknown}"


@pytest.mark.parametrize("field", DOC_DISCIPLINES)
def test_each_documented_discipline_has_courses(field):
    """«ميكانيكا → الباقة الشاملة ميكانيكا» needs courses in that field."""
    have = [cid for cid, c in _courses().items() if c.get("field") == field]
    assert have, f"the doc routes «{field}» to a track, but no course is in it"


async def test_digest_exposes_audience_and_level_to_the_model(loaded_catalog, monkeypatch):
    """The mapping fields are useless if they never reach the prompt.

    They used to arrive only when the model happened to call search_courses;
    on the package path it never did, so it matched a trainee half-blind.
    Every catalogue line must therefore carry both columns.
    """
    # The fixture catalogue and the curriculum map hold different course ids,
    # so the columns are asserted through the lookup the digest actually calls.
    monkeypatch.setattr(catalog.curriculum, "audience_for",
                        lambda _id: {"audience": "Mechanical Engineer",
                                     "level": "From 5 and Above"})
    digest = catalog.catalog_digest()
    assert digest, "digest is empty — nothing to assert"
    for line in digest.splitlines():
        assert "Mechanical Engineer" in line, f"audience missing from: {line}"
        assert "5+" in line, f"experience floor missing from: {line}"


async def test_digest_omits_the_columns_when_the_course_is_unmapped(loaded_catalog):
    """A course outside the curriculum map must not grow empty columns."""
    monkeypatch_free = catalog.catalog_digest()
    # the fixture ids are genuinely absent from curriculum.json
    assert monkeypatch_free
    for line in monkeypatch_free.splitlines():
        assert not line.rstrip().endswith("|"), f"trailing empty column: {line}"


def test_level_short_squeezes_the_odoo_phrasing():
    assert catalog._level_short("From 5 and Above") == "5+"
    assert catalog._level_short("From 1 and Above") == "1+"
    assert catalog._level_short("") == ""
    # anything unrecognised is passed through rather than dropped
    assert catalog._level_short("Any level") == "Any level"
