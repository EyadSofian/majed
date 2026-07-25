"""Odoo 17 JSON-RPC client — used ONLY for money-moment lookups + lead writes.

Bulk catalog reads go through Pinecone, not here: that keeps chat latency
independent of Odoo load/uptime, while price and availability stay exact at
the only moment that matters (checkout).
"""
from typing import Any

import httpx

from .config import get_settings


class Odoo:
    """Thin async wrapper over Odoo's /jsonrpc `execute_kw`."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def _execute(self, model: str, method: str, args: list,
                       kwargs: dict | None = None) -> Any:
        s = get_settings()
        payload = {
            "jsonrpc": "2.0", "method": "call", "id": 1,
            "params": {
                "service": "object", "method": "execute_kw",
                "args": [s.odoo_db, s.odoo_uid, s.odoo_api_key,
                         model, method, args, kwargs or {}],
            },
        }
        if self._client is not None:
            r = await self._client.post(f"{s.odoo_url}/jsonrpc", json=payload)
            data = self._raise_for_odoo(r)
        else:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.post(f"{s.odoo_url}/jsonrpc", json=payload)
                data = self._raise_for_odoo(r)
        return data["result"]

    @staticmethod
    def _raise_for_odoo(r: httpx.Response) -> dict:
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            err = data["error"]
            msg = err.get("data", {}).get("message") or str(err)
            raise RuntimeError(f"Odoo error: {msg}")
        return data

    async def read_courses(self, ids: list[int], fields: list[str]) -> list[dict]:
        s = get_settings()
        return await self._execute(s.odoo_course_model, "read", [ids], {"fields": fields})

    async def product_variant_id(self, template_id: int) -> int | None:
        """Cart/checkout needs product.product (variant), not product.template."""
        recs = await self._execute(
            "product.product", "search_read",
            [[["product_tmpl_id", "=", template_id]]],
            {"fields": ["id"], "limit": 1},
        )
        return recs[0]["id"] if recs else None

    async def create_lead(self, payload: dict) -> int:
        return await self._execute("crm.lead", "create", [payload])


odoo = Odoo()
