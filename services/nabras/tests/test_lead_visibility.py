"""A captured lead has to be findable afterwards.

Production, 14:58:28:

    turn session=cw_140340 lang=ar tools=[create_lead] cards=0 packages=0

That line proves the funnel's capture step ran. It says nothing about what it
produced — no lead id, no name, no contact, no whether the advisor will ever
see it. `create_lead` logs its FAILURES and its trial-mode skip, and says
nothing at all when it succeeds, so the single most valuable event in the
whole funnel is the one event that leaves no trace.

The lead id does not leave the tool either: it is returned into the model's
context and nowhere else. There is no `lead` event on the SSE stream, so the
bridge never learns the number and never writes it to Chatwoot — even though
the bridge already has a `lead` notification and a `notifyOnLead` toggle
waiting for it.
"""
import json

import pytest

from app import tools


class FakeOdoo:
    def __init__(self, lead_id=4821, activity_id=99):
        self.lead_id, self.activity_id = lead_id, activity_id
        self.payload = None

    async def create_lead(self, payload):
        self.payload = payload
        return self.lead_id

    async def schedule_activity(self, lead_id, **kw):
        return self.activity_id

    async def utm_source_id(self, name):
        return 7


@pytest.fixture
def odoo(monkeypatch):
    fake = FakeOdoo()
    monkeypatch.setattr(tools, "odoo", fake)
    tools.LEAD_SINK.set({})
    return fake


ARGS = {"name": "إياد سفيان", "phone": "01000000000",
        "field": "Mechanical", "specialization": "ميكانيكا",
        "experience": "3", "course_interest": "المسار الشامل للميكانيكا"}


async def test_a_created_lead_is_written_to_the_log(odoo, caplog):
    """"مش ظاهر حاجة خالص" — because nothing was ever written."""
    import logging
    caplog.set_level(logging.INFO, logger="nabras.tools")
    await tools.create_lead.ainvoke(dict(ARGS))
    line = "\n".join(r.getMessage() for r in caplog.records)
    assert "4821" in line, f"the lead id is not in the log: {line!r}"
    assert "إياد سفيان" in line


async def test_the_lead_reaches_the_stream_so_chatwoot_can_show_it(odoo):
    """The bridge already has a lead notification; nothing ever fed it."""
    await tools.create_lead.ainvoke(dict(ARGS))
    lead = tools.LEAD_SINK.get()
    assert lead, "no lead event was emitted for the bridge"
    assert lead["lead_id"] == 4821
    assert lead["name"] == "إياد سفيان"
    assert lead["phone"] == "01000000000"
    assert lead["specialization"] == "ميكانيكا"
    assert lead["in_followup_cycle"] is True


async def test_the_model_still_gets_what_it_got_before(odoo):
    out = json.loads(await tools.create_lead.ainvoke(dict(ARGS)))
    assert out["lead_id"] == 4821
    assert out["in_followup_cycle"] is True


async def test_a_lead_with_no_follow_up_activity_says_so(odoo, monkeypatch):
    """Without an activity it is in neither SLA queue — that must be visible."""
    async def boom(*a, **kw):
        raise RuntimeError("no activity type")
    monkeypatch.setattr(odoo, "schedule_activity", boom)
    await tools.create_lead.ainvoke(dict(ARGS))
    assert tools.LEAD_SINK.get()["in_followup_cycle"] is False


async def test_nothing_is_emitted_when_the_lead_was_not_written(odoo, monkeypatch):
    """Trial mode must not tell Chatwoot a lead exists."""
    from app.config import get_settings
    s = get_settings()
    monkeypatch.setattr(s, "allow_crm_writes", False)
    await tools.create_lead.ainvoke(dict(ARGS))
    assert not tools.LEAD_SINK.get().get("lead_id")


async def test_a_failed_lead_is_not_reported_as_captured(odoo, monkeypatch):
    async def boom(payload):
        raise RuntimeError("odoo down")
    monkeypatch.setattr(odoo, "create_lead", boom)
    out = json.loads(await tools.create_lead.ainvoke(dict(ARGS)))
    assert out["error"] == "odoo_unavailable"
    assert not tools.LEAD_SINK.get().get("lead_id")
