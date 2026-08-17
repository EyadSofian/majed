"""A lead has to enter the advisor's follow-up cycle, not just exist.

The Digital Sales SLA is driven by Odoo activities: the advisor works
«Activity Today», then «Overdue Activities». A lead carrying no activity shows
up in neither — it is assigned to a human and then quietly waits for somebody
to notice it. Majed's leads were exactly that: created, assigned, invisible.
"""
import json

import pytest

from app import tools as tools_mod
from app.config import get_settings


class RecordingOdoo:
    """Records writes instead of performing them, and can be told to fail."""

    def __init__(self, *, activity_fails=False, source_fails=False,
                 no_activity_type=False):
        self.leads, self.activities, self.created_sources = [], [], []
        self._activity_fails = activity_fails
        self._source_fails = source_fails
        self._no_activity_type = no_activity_type

    async def create_lead(self, payload):
        self.leads.append(payload)
        return 5001

    async def utm_source_id(self, name):
        if self._source_fails:
            raise RuntimeError("utm.source not readable")
        self.created_sources.append(name)
        return 77

    async def schedule_activity(self, lead_id, *, user_id, summary,
                                note="", delay_days=0):
        if self._activity_fails:
            raise RuntimeError("mail.activity denied")
        if self._no_activity_type:
            return None                      # the client's own soft failure
        rec = {"lead_id": lead_id, "user_id": user_id, "summary": summary,
               "note": note, "delay_days": delay_days}
        self.activities.append(rec)
        return 9001


@pytest.fixture
def crm(monkeypatch):
    """CRM writes on, with a recording Odoo underneath."""
    s = get_settings()
    monkeypatch.setattr(s, "allow_crm_writes", True)
    def _install(**kw):
        od = RecordingOdoo(**kw)
        monkeypatch.setattr(tools_mod, "odoo", od)
        return od
    return _install


async def _lead(**kw):
    payload = {"name": "إياد سفيان", "phone": "01000000000",
               "field": "Mechanical", "specialization": "HVAC",
               "experience": "4", "job_title": "مهندس", "goal": "شهادة"}
    payload.update(kw)
    return json.loads(await tools_mod.create_lead.ainvoke(payload))


async def test_lead_enters_the_followup_cycle(crm):
    """The whole point: an activity is scheduled, dated, and owned."""
    od = crm()
    out = await _lead()
    s = get_settings()

    assert out["lead_id"] == 5001
    assert out["in_followup_cycle"] is True
    assert out["activity_id"] == 9001

    assert len(od.activities) == 1
    act = od.activities[0]
    assert act["lead_id"] == 5001
    # the advisor who owns the lead owns the follow-up too
    assert act["user_id"] == s.sales_advisor_id == od.leads[0]["user_id"]
    # due today by default — an SLA website lead is called the same day
    assert act["delay_days"] == 0
    assert act["summary"]
    # the qualification travels onto the activity, so the advisor opens it
    # already knowing who this is
    assert "المسمى الوظيفي: مهندس" in act["note"]
    assert "الهدف: شهادة" in act["note"]


async def test_lead_is_attributed_to_a_source(crm):
    """Otherwise Majed's leads cannot be counted apart from the SLA's own."""
    od = crm()
    await _lead()
    assert od.created_sources == [get_settings().lead_source_name]
    assert od.leads[0]["source_id"] == 77


async def test_activity_failure_never_costs_the_lead(crm):
    """A follow-up prompt is worth less than the customer's phone number."""
    od = crm(activity_fails=True)
    out = await _lead()
    assert out["lead_id"] == 5001            # the lead survived
    assert out["activity_id"] is None
    assert out["in_followup_cycle"] is False  # and says so honestly
    assert od.activities == []


async def test_source_failure_never_costs_the_lead(crm):
    od = crm(source_fails=True)
    out = await _lead()
    assert out["lead_id"] == 5001
    assert "source_id" not in od.leads[0]
    assert out["in_followup_cycle"] is True   # the activity still happened


async def test_missing_activity_type_is_reported_not_hidden(crm):
    """The client returns None when the database has no activity type."""
    od = crm(no_activity_type=True)
    out = await _lead()
    assert out["lead_id"] == 5001
    assert out["in_followup_cycle"] is False


async def test_activity_can_be_switched_off(crm, monkeypatch):
    monkeypatch.setattr(get_settings(), "lead_activity_enabled", False)
    od = crm()
    out = await _lead()
    assert out["lead_id"] == 5001
    assert od.activities == []
    assert out["in_followup_cycle"] is False


async def test_delay_is_configurable(crm, monkeypatch):
    """Some teams want the first call tomorrow, not today."""
    monkeypatch.setattr(get_settings(), "lead_activity_delay_days", 2)
    od = crm()
    await _lead()
    assert od.activities[0]["delay_days"] == 2


async def test_trial_mode_writes_nothing_at_all(monkeypatch):
    """ALLOW_CRM_WRITES=false must not create a lead OR an activity."""
    monkeypatch.setattr(get_settings(), "allow_crm_writes", False)
    od = RecordingOdoo()
    monkeypatch.setattr(tools_mod, "odoo", od)
    out = await _lead()
    assert out["simulated"] is True
    assert od.leads == [] and od.activities == [] and od.created_sources == []


# ---------------------------------------------------------------------------
# The client's own wire shape. This is the part that talks to the real Odoo and
# could not be exercised against it from here, so it is pinned explicitly:
# `mail.activity` is keyed by ir.model id (not the model name), and a wrong
# date format is rejected outright.
class WireOdoo:
    """A real Odoo client with only `execute` faked, recording every call."""

    def __init__(self, *, model_rows=None, xmlid_rows=None, type_rows=None,
                 source_rows=None):
        self.calls = []
        self._rows = {
            ("ir.model", "search_read"): model_rows
            if model_rows is not None else [{"id": 421}],
            ("ir.model.data", "search_read"): xmlid_rows
            if xmlid_rows is not None else [{"res_id": 33}],
            ("mail.activity.type", "search_read"): type_rows
            if type_rows is not None else [{"id": 99}],
            ("utm.source", "search_read"): source_rows
            if source_rows is not None else [],
        }

    async def execute(self, model, method, args, kwargs=None):
        self.calls.append((model, method, args, kwargs))
        if (model, method) in self._rows:
            return self._rows[(model, method)]
        if method == "create":
            return 7777
        return []


def _wire(**kw):
    from app.odoo import Odoo
    od = Odoo()
    rec = WireOdoo(**kw)
    od.execute = rec.execute          # type: ignore[method-assign]
    return od, rec


async def test_activity_payload_is_shaped_the_way_odoo_wants_it():
    od, rec = _wire()
    act_id = await od.schedule_activity(5001, user_id=2, summary="مكالمة أولى",
                                        note="المجال: Mechanical", delay_days=0)
    assert act_id == 7777
    create = [c for c in rec.calls if c[0] == "mail.activity" and c[1] == "create"]
    assert len(create) == 1
    vals = create[0][2][0]
    # keyed by ir.model id, not by the model name — the usual way this fails
    assert vals["res_model_id"] == 421
    assert vals["res_id"] == 5001
    assert vals["activity_type_id"] == 33      # resolved from the xml id
    assert vals["user_id"] == 2
    assert vals["summary"] == "مكالمة أولى"
    assert vals["note"] == "المجال: Mechanical"
    # Odoo rejects anything but YYYY-MM-DD here
    import datetime as _dt
    _dt.datetime.strptime(vals["date_deadline"], "%Y-%m-%d")


async def test_activity_type_falls_back_when_the_xmlid_is_absent():
    """A renamed standard type must not leave the lead outside the cycle."""
    od, rec = _wire(xmlid_rows=[])
    await od.schedule_activity(5001, user_id=2, summary="x")
    vals = [c for c in rec.calls
            if c[0] == "mail.activity" and c[1] == "create"][0][2][0]
    assert vals["activity_type_id"] == 99      # the first available type


async def test_no_activity_type_at_all_returns_none_instead_of_writing():
    od, _rec = _wire(xmlid_rows=[], type_rows=[])
    assert await od.schedule_activity(5001, user_id=2, summary="x") is None


async def test_lookups_are_cached_across_leads():
    """Four extra round-trips per lead would be paid on every conversation."""
    od, rec = _wire()
    for _ in range(3):
        await od.schedule_activity(5001, user_id=2, summary="x")
    reads = [c for c in rec.calls if c[1] == "search_read"]
    assert len(reads) == 2, [c[0] for c in reads]   # ir.model + ir.model.data


async def test_utm_source_is_created_once_then_reused():
    od, rec = _wire(source_rows=[])
    first = await od.utm_source_id("ماجد — شات الموقع")
    second = await od.utm_source_id("ماجد — شات الموقع")
    assert first == second == 7777
    creates = [c for c in rec.calls if c[0] == "utm.source" and c[1] == "create"]
    assert len(creates) == 1, "source must not be re-created per lead"


async def test_existing_utm_source_is_reused_not_duplicated():
    od, rec = _wire(source_rows=[{"id": 12}])
    assert await od.utm_source_id("ماجد — شات الموقع") == 12
    assert not [c for c in rec.calls if c[0] == "utm.source" and c[1] == "create"]
