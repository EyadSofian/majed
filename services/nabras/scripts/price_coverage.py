#!/usr/bin/env python3
"""Which courses have no price in which currency — before a customer finds out.

    python scripts/price_coverage.py                # all four currencies
    python scripts/price_coverage.py SAR EGP        # only these
    python scripts/price_coverage.py --csv out.csv  # also write a sheet

Why this exists: Engosoft prices are NOT on the product record (`list_price` is
0 on effectively every course). They live in `product.pricelist.item`, in a
SEPARATE pricelist per currency — EGP 28 · USD 27 · AED 29 · SAR 9. Nothing is
converted; each list is priced by hand. So a course can be fully priced in
Egyptian pounds and have no row at all in riyals, and the bot will answer a
Saudi visitor with "the team will confirm the price" instead of a number.

That is invisible until a customer hits it, because it is not an error —
`get_price` returns `no_price_rule` and the prompt correctly refuses to guess.
This script asks the question up front, for every course, in every currency.

It calls `odoo.fetch_prices` — the exact function the bot calls — so the report
cannot disagree with what a visitor is told. It then re-reads the raw pricelist
rows to explain *why* a course came back empty, which is the part that decides
who fixes it:

    missing   → no row exists. Someone has to price this course in this list.
    unusable  → a row exists but `fetch_prices` skips it. Not a data-entry gap;
                see the reason column. `compute_price` other than `fixed`
                (a percentage or formula rule) needs Odoo's own resolver, so
                the bot refuses it rather than quoting a wrong number.

Exit code is 1 if any gap is found, so this can run on a schedule and complain.
"""
import argparse
import asyncio
import csv
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings          # noqa: E402
from app.odoo import Odoo, OdooAccessDenied  # noqa: E402

BOLD, DIM, RED, YEL, GRN, OFF = (
    "\033[1m", "\033[90m", "\033[31m", "\033[33m", "\033[32m", "\033[0m")


def _skip_reason(item: dict, now: str) -> str:
    """Why `fetch_prices` ignored this row. Mirrors its filters, in its order."""
    if item.get("date_start") and str(item["date_start"]) > now:
        return f"لسه ما بدأش (يبدأ {str(item['date_start'])[:10]})"
    if item.get("date_end") and str(item["date_end"]) < now:
        return f"منتهي (انتهى {str(item['date_end'])[:10]})"
    if (item.get("min_quantity") or 0) > 1:
        return f"أقل كمية {item['min_quantity']} (مش قطعة واحدة)"
    if item.get("compute_price") != "fixed":
        return f"قاعدة {item.get('compute_price')} مش سعر ثابت"
    return "غير معروف — راجع الصف يدويًا"


async def _raw_items(od: Odoo, pricelist: int, tmpl_ids: list[int],
                     v2t: dict[int, int]) -> dict[int, list[dict]]:
    """Every row targeting these courses in this list, filters NOT applied."""
    items = await od.search_read(
        "product.pricelist.item",
        ["&", ["pricelist_id", "=", pricelist],
         "|", ["product_tmpl_id", "in", tmpl_ids],
         ["product_id", "in", list(v2t.keys())]],
        ["product_tmpl_id", "product_id", "applied_on", "compute_price",
         "fixed_price", "date_start", "date_end", "min_quantity"])
    by_tmpl: dict[int, list[dict]] = defaultdict(list)
    for it in items:
        if it.get("applied_on") == "0_product_variant" and isinstance(it.get("product_id"), list):
            tmpl = v2t.get(it["product_id"][0])
        elif isinstance(it.get("product_tmpl_id"), list):
            tmpl = it["product_tmpl_id"][0]
        else:
            continue
        if tmpl is not None:
            by_tmpl[tmpl].append(it)
    return by_tmpl


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("currencies", nargs="*", help="default: all supported")
    ap.add_argument("--csv", metavar="FILE", help="write the gaps to a CSV too")
    ap.add_argument("--quiet", action="store_true", help="summary table only")
    args = ap.parse_args()

    s = get_settings()
    if not s.odoo_api_key:
        print(f"{RED}ODOO_API_KEY مش متظبط — حطّه في .env{OFF}", file=sys.stderr)
        return 2

    currencies = [c.upper() for c in (args.currencies or s.supported_currencies)]
    bad = [c for c in currencies if c not in s.supported_currencies]
    if bad:
        print(f"{RED}عملات مش مدعومة: {bad} — المتاح {s.supported_currencies}{OFF}",
              file=sys.stderr)
        return 2

    od = Odoo()
    print(f"{DIM}أودو: {s.odoo_url} · db={s.odoo_db}{OFF}")
    try:
        courses = await od.fetch_courses()
    except OdooAccessDenied as e:
        print(f"{RED}أودو رفض القراءة: {e}{OFF}", file=sys.stderr)
        return 2
    if not courses:
        print(f"{RED}مفيش كورسات راجعة — اتأكد من detailed_type والنشر{OFF}",
              file=sys.stderr)
        return 2

    names = {c["id"]: (c.get("name") or f"#{c['id']}") for c in courses}
    ids = sorted(names)
    print(f"كورسات منشورة وقابلة للبيع: {BOLD}{len(ids)}{OFF}\n")

    # product→template map, needed to attribute variant-level rows to a course
    variants = await od.search_read("product.product",
                                    [["product_tmpl_id", "in", ids]],
                                    ["id", "product_tmpl_id"])
    v2t = {v["id"]: v["product_tmpl_id"][0] for v in variants
           if isinstance(v.get("product_tmpl_id"), list)}
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    rows, summary = [], {}
    for cur in currencies:
        pricelist = s.pricelist_for(cur)
        priced = await od.fetch_prices(ids, cur)      # the bot's own path
        raw = await _raw_items(od, pricelist, ids, v2t)

        missing, unusable = [], []
        for cid in ids:
            if priced.get(cid):
                continue
            if raw.get(cid):
                reason = _skip_reason(raw[cid][0], now)
                unusable.append((cid, reason))
                rows.append({"currency": cur, "pricelist_id": pricelist,
                             "course_id": cid, "course": names[cid],
                             "status": "unusable", "reason": reason})
            else:
                missing.append(cid)
                rows.append({"currency": cur, "pricelist_id": pricelist,
                             "course_id": cid, "course": names[cid],
                             "status": "missing", "reason": "مفيش صف سعر أصلًا"})
        summary[cur] = (pricelist, len(ids) - len(missing) - len(unusable),
                        missing, unusable)

    # ---- summary -----------------------------------------------------------
    print(f"{BOLD}{'العملة':<8}{'القائمة':>9}{'مسعّر':>9}{'ناقص':>9}{'معطّل':>9}   التغطية{OFF}")
    print("─" * 62)
    worst = 0
    for cur in currencies:
        pl, ok, missing, unusable = summary[cur]
        pct = ok * 100 // len(ids)
        worst = max(worst, len(missing) + len(unusable))
        col = GRN if pct == 100 else (YEL if pct >= 90 else RED)
        bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
        print(f"{cur:<8}{pl:>9}{ok:>9}{len(missing):>9}{len(unusable):>9}   "
              f"{col}{bar} {pct}%{OFF}")

    # ---- detail ------------------------------------------------------------
    if not args.quiet:
        for cur in currencies:
            pl, ok, missing, unusable = summary[cur]
            if not missing and not unusable:
                continue
            print(f"\n{BOLD}── {cur} (قائمة {pl}) ──{OFF}")
            if missing:
                print(f"  {RED}مفيش صف سعر ({len(missing)}){OFF} "
                      f"{DIM}— العميل هيسمع «الفريق هيأكدلك السعر»{OFF}")
                for cid in missing:
                    print(f"    #{cid:<7} {names[cid][:58]}")
            if unusable:
                print(f"  {YEL}صف موجود بس متجاهَل ({len(unusable)}){OFF} "
                      f"{DIM}— مش نقص إدخال، شوف السبب{OFF}")
                for cid, reason in unusable:
                    print(f"    #{cid:<7} {names[cid][:40]:<42} {DIM}{reason}{OFF}")

    if args.csv and rows:
        with open(args.csv, "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print(f"\n{DIM}اتكتب: {args.csv} ({len(rows)} صف){OFF}")

    if worst:
        print(f"\n{RED}في {len(rows)} فجوة سعر. كل واحدة فيهم عميل هيتقاله "
              f"«الفريق هيأكدلك» بدل رقم.{OFF}")
        return 1
    print(f"\n{GRN}كل الكورسات مسعّرة في كل العملات المطلوبة.{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
