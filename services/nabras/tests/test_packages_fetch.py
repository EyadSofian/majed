"""`fetch_packages` against the shapes Odoo actually returns.

Production log, every refresh since the attendance-lines feature shipped:

    RuntimeError: Odoo error: Invalid field
    training.package.attendee.product.line.website_published
    in leaf ('website_published', '=', True)

That model has no such field, so the query was rejected — and because the read
sits in the same `try` as everything else, one bad leaf took packages, levels,
groups and outcomes down with it. `packages_source: odoo` could never be true;
the service quietly lived off the n8n snapshot instead.
"""
import pytest

from app.odoo import Odoo, OdooAccessDenied

ATTENDEE = "training.package.attendee.product.line"


class FakeWire:
    """Records the domains and can reject a model the way Odoo really does."""

    def __init__(self, invalid_field_on=(), denied_on=()):
        self.domains = {}
        self._invalid = set(invalid_field_on)
        self._denied = set(denied_on)

    async def execute(self, model, method, args, kwargs=None):
        domain = args[0] if args else []
        self.domains[model] = domain
        if model in self._denied:
            raise OdooAccessDenied(f"not allowed to access {model}")
        if model in self._invalid:
            for leaf in domain:
                if isinstance(leaf, list) and leaf[0] == "website_published":
                    raise RuntimeError(
                        f"Odoo error: Invalid field {model}.website_published "
                        f"in leaf ('website_published', '=', True)")
        if model == "training.package":
            return [{"id": 5, "name": "Interior Design", "website_url": "/p/5"}]
        return [{"id": 1, "name": "row", "package_id": [5, "Interior Design"]}]


def _client(**kw):
    od, wire = Odoo(), FakeWire(**kw)
    od.execute = wire.execute          # type: ignore[method-assign]
    return od, wire


async def test_attendance_lines_are_not_filtered_by_a_field_that_does_not_exist():
    """The exact production failure, reproduced and fixed."""
    od, wire = _client(invalid_field_on=[ATTENDEE])
    out = await od.fetch_packages()

    assert out["available"] is True
    assert out["packages"], "the whole refresh used to die here"
    assert out["attendee_lines"]
    assert wire.domains[ATTENDEE] == [], wire.domains[ATTENDEE]


async def test_published_filter_is_still_applied_where_the_field_exists():
    """Dropping it on the attendance model must not drop it everywhere."""
    od, wire = _client()
    await od.fetch_packages()
    assert wire.domains["training.package"] == [["website_published", "=", True]]
    assert wire.domains["training.package.product.line"] == [
        ["website_published", "=", True]]


async def test_a_broken_attendance_model_no_longer_costs_the_packages():
    """Half a track beats no track: the rest of the refresh must survive."""
    class Boom(FakeWire):
        async def execute(self, model, method, args, kwargs=None):
            if model == ATTENDEE:
                raise RuntimeError("Odoo error: some future schema change")
            return await super().execute(model, method, args, kwargs)

    od = Odoo()
    od.execute = Boom().execute        # type: ignore[method-assign]
    out = await od.fetch_packages()
    assert out["available"] is True
    assert out["packages"]
    assert out["attendee_lines"] == []


async def test_access_denial_is_still_reported_rather_than_swallowed():
    """A missing ACL is a fixable configuration problem, not a shrug."""
    od, _wire = _client(denied_on=[ATTENDEE])
    out = await od.fetch_packages()
    assert out["available"] is False
    assert out["reason"] == "access_denied"
