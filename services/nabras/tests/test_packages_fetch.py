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

    def __init__(self, invalid_field_on=(), denied_on=(), unknown_fields=None):
        self.domains = {}
        self.fields = {}
        self._invalid = set(invalid_field_on)
        self._denied = set(denied_on)
        # model -> the columns that model does NOT have. Odoo rejects those in
        # the *fields list* too, not only in a domain leaf.
        self._unknown = unknown_fields or {}

    async def execute(self, model, method, args, kwargs=None):
        domain = args[0] if args else []
        self.domains[model] = domain
        self.fields[model] = list((kwargs or {}).get("fields") or [])
        if model in self._denied:
            raise OdooAccessDenied(f"not allowed to access {model}")
        if model in self._invalid:
            for leaf in domain:
                if isinstance(leaf, list) and leaf[0] == "website_published":
                    raise RuntimeError(
                        f"Odoo error: Invalid field {model}.website_published "
                        f"in leaf ('website_published', '=', True)")
        for bad in self._unknown.get(model, ()):
            if bad in self.fields[model]:
                raise RuntimeError(
                    f"Odoo error: Invalid field '{bad}' on model '{model}'")
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


# --------------------------------------------------------------------------
# The SAME class of bug, one field further in: after the domain leaf was fixed,
# production logged this on every single refresh, ~288 times a day —
#
#   attendance lines unavailable (Odoo error: Invalid field 'sale_ok' on model
#   'training.package.attendee.product.line') — tracks will show their recorded
#   courses only
#
# `line_fields` was shared between the recorded model (which HAS sale_ok) and
# the attendance model (which does not), so every attendance read was rejected
# and every track silently lost its attendance courses.


async def test_attendance_lines_do_not_ask_for_a_column_that_model_lacks():
    """The production failure of 2026-08, reproduced and fixed."""
    od, wire = _client(unknown_fields={ATTENDEE: ("sale_ok", "website_published")})
    out = await od.fetch_packages()

    assert out["attendee_lines"], "attendance courses were dropped again"
    assert "sale_ok" not in wire.fields[ATTENDEE], wire.fields[ATTENDEE]


async def test_recorded_lines_keep_the_columns_that_model_does_have():
    """Narrowing the attendance read must not narrow the recorded one."""
    od, wire = _client()
    await od.fetch_packages()
    recorded = wire.fields["training.package.product.line"]
    assert "sale_ok" in recorded
    assert "website_published" not in wire.fields[ATTENDEE]


async def test_both_line_models_return_what_the_track_is_assembled_from():
    """package_id / product_id / level_id / sequence are what builds a track."""
    od, wire = _client(unknown_fields={ATTENDEE: ("sale_ok", "website_published")})
    await od.fetch_packages()
    for model in ("training.package.product.line", ATTENDEE):
        for needed in ("id", "name", "package_id", "product_id", "level_id",
                       "sequence"):
            assert needed in wire.fields[model], (model, needed)


# --------------------------------------------------------------------------
# Connection reuse. `odoo = Odoo()` is a process-wide singleton built with
# `client=None`, and `execute` used to open a NEW httpx.AsyncClient per call and
# throw it away — a fresh TCP connect and TLS handshake to engosoft.com for
# every read. `fetch_packages` is six of them; a set of course cards is two more
# on the reply path, while the customer waits.


async def test_one_pooled_connection_is_reused_across_calls():
    od = Odoo()
    first = od._session()
    assert od._session() is first, "a new client per call is a TLS handshake per call"
    await od.aclose()


async def test_the_pool_is_released_on_shutdown():
    od = Odoo()
    client = od._session()
    await od.aclose()
    assert client.is_closed
    assert od._owned is None


async def test_a_closed_pool_is_rebuilt_rather_than_reused():
    """Shutdown must not leave the next call holding a dead client."""
    od = Odoo()
    first = od._session()
    await od.aclose()
    assert od._session() is not first
    await od.aclose()


async def test_an_injected_client_is_still_honoured():
    """Tests and callers that pass their own client must keep control of it."""
    import httpx
    mine = httpx.AsyncClient()
    od = Odoo(client=mine)
    assert od._client is mine
    await od.aclose()
    assert not mine.is_closed, "we must not close a client we did not open"
    await mine.aclose()
