"""Odoo 17 data layer for the real Engosoft schema.

Every quirk below was found by probing the live database, not assumed:

* Courses are `product.template` rows with the custom `detailed_type = 'course'`
  (115 rows; 75 published + sellable). Filtering on this is mandatory — the
  other 353 products are events, booking fees and consumables.
* `list_price` is **0** on effectively every course. Real prices live in
  `product.pricelist.item`, per currency, and come in TWO shapes: newer rows use
  `applied_on='1_product'` + `product_tmpl_id`, older rows use
  `applied_on='0_product_variant'` + `product_id`. Reading only one shape leaves
  older courses priced at zero.
* `event.event.event_registrations_open` is a computed, non-stored field. Odoo
  silently ignores it in a domain (searching it returns every row), so it has to
  be filtered in Python after fetching.
* `slide.channel.website_url` is absolute, `product.template.website_url` is
  relative. Concatenating a base onto both produces `engosoft.comhttps://…`.
* Images are binary columns, never URLs — the URL is built from the record id.
* The `training.package*` models need eLearning/Manager + Operation Group. Until
  the bot's Odoo user has them, package reads raise AccessError; every package
  method degrades to empty instead of breaking the chat.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Iterable, Optional

import httpx

from .config import get_settings

log = logging.getLogger("nabras.odoo")

COURSE_FIELDS = [
    "id", "name", "default_code", "website_url", "is_published", "sale_ok",
    "detailed_type", "course_type", "course_subtitle", "description_sale",
    "course_duration_text", "course_language_text", "course_certificate_text",
    "course_category_label", "attendance_course_category_label",
    "public_categ_ids", "list_price", "currency_id", "compare_list_price",
    "recorded_instructor_ids", "attendance_instructor_ids",
    "instructor_tagline", "attendance_instructor_tagline",
    "course_review_ids", "course_video_promo", "is_new_course_homepage",
    "write_date",
]

EVENT_FIELDS = [
    "id", "name", "date_begin", "date_end", "date_tz", "address_id",
    "seats_available", "seats_max", "seats_limited", "seats_taken",
    "event_registrations_open", "event_registrations_sold_out",
    "is_published", "website_url", "course_id", "product_name",
    "is_package_event", "related_group_id", "total_lectures_number",
    "certificate_name", "certificate_duration_hours", "instructor_id",
    "write_date",
]

EMPLOYEE_FIELDS = ["id", "name", "job_title", "work_email", "department_id", "active"]

# Delivery format, as modelled on product.template.course_type
COURSE_TYPE_LABELS = {
    "recorded": "مسجّل",
    "attendance": "حضوري",
    "attendance_recorded": "حضوري + تسجيل",
    "exam_simulator": "محاكي امتحان",
}


class OdooAccessDenied(RuntimeError):
    """The bot's Odoo user lacks the group needed for this model."""


class Odoo:
    """Async JSON-RPC client. Read-only except for `create_lead`."""

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    # ------------------------------------------------------------------ core
    async def execute(self, model: str, method: str, args: list,
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
        url = f"{s.odoo_url}/jsonrpc"
        if self._client is not None:
            data = self._unwrap(await self._client.post(url, json=payload))
        else:
            async with httpx.AsyncClient(timeout=s.odoo_timeout) as c:
                data = self._unwrap(await c.post(url, json=payload))
        return data["result"]

    @staticmethod
    def _unwrap(r: httpx.Response) -> dict:
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            err = data["error"]
            msg = err.get("data", {}).get("message") or str(err)
            if "not allowed to access" in msg or "AccessError" in str(err):
                raise OdooAccessDenied(msg.strip().splitlines()[0])
            raise RuntimeError(f"Odoo error: {msg}")
        return data

    async def search_read(self, model: str, domain: list, fields: list,
                          limit: int = 0, order: str = "") -> list[dict]:
        kw: dict[str, Any] = {"fields": fields}
        if limit:
            kw["limit"] = limit
        if order:
            kw["order"] = order
        return await self.execute(model, "search_read", [domain], kw)

    async def read(self, model: str, ids: list[int], fields: list) -> list[dict]:
        if not ids:
            return []
        return await self.execute(model, "read", [list(ids)], {"fields": fields})

    # -------------------------------------------------------------- catalogue
    async def fetch_courses(self, since: Optional[str] = None) -> list[dict]:
        """Published, sellable courses. `since` enables delta polling."""
        s = get_settings()
        domain: list = [
            ["detailed_type", "=", s.course_product_type],
            ["is_published", "=", True],
            ["sale_ok", "=", True],
        ]
        if since:
            domain.append(["write_date", ">", since])
        return await self.search_read("product.template", domain,
                                      COURSE_FIELDS, order="id desc")

    async def fetch_channel_links(self) -> dict[int, dict]:
        """slide.channel -> the product it is sold as.

        The link is `slide.channel.product_id` and it points at product.product
        (the variant), not the template, so the variant is resolved back to its
        template here. There is no reverse field on the product side.
        """
        chans = await self.search_read(
            "slide.channel", [["is_published", "=", True]],
            ["id", "name", "website_url", "product_id", "total_slides",
             "total_time", "members_count", "rating_avg", "enroll", "visibility",
             "certificate_name", "certificate_duration_hours"])
        variant_ids = [c["product_id"][0] for c in chans
                       if isinstance(c.get("product_id"), list)]
        variants = await self.read("product.product", variant_ids,
                                   ["id", "product_tmpl_id"])
        v2t = {v["id"]: v["product_tmpl_id"][0] for v in variants
               if isinstance(v.get("product_tmpl_id"), list)}
        out: dict[int, dict] = {}
        for c in chans:
            pid = c["product_id"][0] if isinstance(c.get("product_id"), list) else None
            tmpl = v2t.get(pid) if pid else None
            c["template_id"] = tmpl
            out[c["id"]] = c
        return out

    # ------------------------------------------------------------------ price
    async def fetch_prices(self, template_ids: Iterable[int],
                           currency: str) -> dict[int, dict]:
        """Real price per template for one currency.

        Handles both pricelist-item shapes and prefers the more specific
        variant-level rule, matching Odoo's own precedence.
        """
        s = get_settings()
        ids = [int(i) for i in template_ids]
        if not ids:
            return {}
        pricelist = s.pricelist_for(currency)
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

        variants = await self.search_read(
            "product.product", [["product_tmpl_id", "in", ids]],
            ["id", "product_tmpl_id"])
        v2t = {v["id"]: v["product_tmpl_id"][0] for v in variants
               if isinstance(v.get("product_tmpl_id"), list)}

        items = await self.search_read(
            "product.pricelist.item",
            ["&", ["pricelist_id", "=", pricelist],
             "|", ["product_tmpl_id", "in", ids],
             ["product_id", "in", list(v2t.keys())]],
            ["product_tmpl_id", "product_id", "applied_on", "compute_price",
             "fixed_price", "currency_id", "date_start", "date_end",
             "min_quantity"])

        best: dict[int, dict] = {}
        for it in items:
            if it.get("date_start") and str(it["date_start"]) > now:
                continue
            if it.get("date_end") and str(it["date_end"]) < now:
                continue
            if (it.get("min_quantity") or 0) > 1:
                continue
            if it.get("compute_price") != "fixed":
                # percentage / formula rules would need Odoo's own resolver;
                # skip rather than quote a wrong number.
                continue
            applied = it.get("applied_on")
            if applied == "0_product_variant" and isinstance(it.get("product_id"), list):
                tmpl = v2t.get(it["product_id"][0])
                specificity = 2
            elif isinstance(it.get("product_tmpl_id"), list):
                tmpl = it["product_tmpl_id"][0]
                specificity = 1
            else:
                continue
            if tmpl is None:
                continue
            cur = it["currency_id"][1] if isinstance(it.get("currency_id"), list) else currency
            cand = {"price": it.get("fixed_price"), "currency": cur,
                    "_specificity": specificity}
            if tmpl not in best or specificity > best[tmpl]["_specificity"]:
                best[tmpl] = cand
        for v in best.values():
            v.pop("_specificity", None)
        return best

    # ----------------------------------------------------------------- events
    async def fetch_upcoming_events(self, horizon_days: Optional[int] = None
                                    ) -> list[dict]:
        """Future batches. Registration state is filtered in Python because
        `event_registrations_open` is computed and unsearchable."""
        s = get_settings()
        now = datetime.utcnow()
        until = now + timedelta(days=horizon_days or s.events_horizon_days)
        rows = await self.search_read(
            "event.event",
            [["date_begin", ">=", now.strftime("%Y-%m-%d %H:%M:%S")],
             ["date_begin", "<=", until.strftime("%Y-%m-%d %H:%M:%S")],
             ["is_published", "=", True]],
            EVENT_FIELDS, order="date_begin asc")
        for r in rows:
            r["registration_open"] = bool(r.get("event_registrations_open"))
            r["url"] = abs_url(r.get("website_url"))
        return rows

    # ------------------------------------------------------------ instructors
    async def fetch_instructors(self, ids: Iterable[int]) -> dict[int, dict]:
        rows = await self.read("hr.employee", list({int(i) for i in ids}),
                               EMPLOYEE_FIELDS)
        return {r["id"]: r for r in rows}

    async def fetch_all_instructors(self) -> list[dict]:
        """Everyone whose job title mentions instructor, plus anyone sitting in
        the two instructor departments."""
        return await self.search_read(
            "hr.employee",
            ["|", ["job_title", "ilike", "instructor"],
             ["department_id.name", "ilike", "INSTRUCTORS"]],
            EMPLOYEE_FIELDS, order="name asc")

    # -------------------------------------------------------------- packages
    async def fetch_packages(self) -> dict[str, Any]:
        """Training packages. Returns `{"available": False, ...}` when the bot's
        Odoo user has not been granted eLearning/Manager + Operation Group."""
        try:
            packages = await self.search_read(
                "training.package", [["website_published", "=", True]],
                ["id", "name", "website_url", "package_type", "attendee_type",
                 "total_price", "final_price", "discount", "discount_end_time",
                 "currency_id", "attendee_online_discount",
                 "attendee_onsite_discount", "num_courses_display",
                 "training_hours_attendee", "training_hours_recorded",
                 "review_rating_avg", "review_rating_count", "public_categ_ids",
                 "badge_text", "levels_ids", "product_ids", "groups_ids",
                 "similar_packages_ids", "write_date"],
                order="sequence asc")
            line_fields = ["id", "name", "package_id", "level_id", "product_id",
                           "sequence", "sale_ok"]
            lines = await self.search_read(
                "training.package.product.line", [["website_published", "=", True]],
                line_fields)
            # The attendance courses of a track live in their own model. Without
            # them the path shows only what is sold as recorded.
            attendee_lines = await self.search_read(
                "training.package.attendee.product.line",
                [["website_published", "=", True]], line_fields)
            levels = await self.search_read(
                "training.package.level", [],
                ["id", "name", "package_id", "sequence",
                 "attendee_course_count", "recorded_course_count"])
            groups = await self.search_read(
                "training.package.group", [],
                ["id", "name", "technical_name", "full_display_name",
                 "package_id", "sale_status", "is_available_for_sale",
                 "first_event_date", "online_event_ids", "onsite_event_ids",
                 "online_min_date_begin", "online_max_date_end",
                 "onsite_min_date_begin", "onsite_max_date_end",
                 "online_total_price", "onsite_total_price"])
            outcomes = await self.search_read(
                "learning.outcome", [], ["id", "name", "sequence"])
        except OdooAccessDenied as e:
            log.warning("packages unavailable — grant eLearning/Manager + "
                        "Operation Group to the bot user (%s)", e)
            return {"available": False, "reason": "access_denied",
                    "packages": [], "lines": [], "attendee_lines": [],
                    "levels": [], "groups": [], "outcomes": []}
        for p in packages:
            p["url"] = abs_url(p.get("website_url"))
        return {"available": True, "packages": packages, "lines": lines,
                "attendee_lines": attendee_lines, "levels": levels,
                "groups": groups, "outcomes": outcomes}

    # ------------------------------------------------------------------ sell
    async def product_variant_id(self, template_id: int) -> int | None:
        recs = await self.search_read(
            "product.product", [["product_tmpl_id", "=", template_id]],
            ["id"], limit=1)
        return recs[0]["id"] if recs else None

    async def create_lead(self, payload: dict) -> int:
        return await self.execute("crm.lead", "create", [payload])

    # ------------------------------------------------------------- freshness
    async def latest_write_date(self, model: str, domain: list) -> Optional[str]:
        rows = await self.search_read(model, domain, ["write_date"],
                                      limit=1, order="write_date desc")
        return rows[0]["write_date"] if rows else None


def abs_url(path: Optional[str]) -> str:
    """slide.channel returns absolute URLs, product.template relative ones."""
    if not path:
        return ""
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return f"{get_settings().shop_base}{path}"


def image_url(model: str, rec_id: int, field: str = "image_1920") -> str:
    """Images are binary columns; the browsable URL is derived from the id."""
    return f"{get_settings().shop_base}/web/image/{model}/{rec_id}/{field}"


odoo = Odoo()
