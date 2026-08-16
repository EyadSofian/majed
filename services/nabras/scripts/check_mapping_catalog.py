"""Does the shop actually sell every programme the sales mapping recommends?

The mapping in `data/curriculum.json` names programmes — FMP, CFM, CMRP, PMP
and the four BIM tracks — but whether one is *sellable* is the live catalogue's
answer, never the map's. `recommend_by_goal` resolves each against Odoo at
answer time and reports `not_in_catalog` when it finds nothing, so a programme
the shop does not publish is never quoted to a customer.

That is safe, but it is silent: nobody learns the mapping has a dead branch
until a customer walks into it. This script asks the same question up front,
with the production matcher, so the answer here is exactly the answer a
customer would get.

    cd services/nabras
    ODOO_API_KEY=... python scripts/check_mapping_catalog.py

Exit code is 1 when any branch is dead, so CI or a cron can watch it.
"""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import catalog, curriculum  # noqa: E402
from app.tools import _find_named  # the production matcher, not a copy  # noqa: E402

OK, DEAD = "✓", "✗"


def _near_misses(terms: list[str], limit: int = 4) -> list[str]:
    """Titles that share *any* word with the search terms.

    A dead branch is usually a naming difference, not a missing course: the
    shop calls it "Certified Facility Manager (CFM) Preparation" and the map
    looks for "CFM". Printing the near misses turns "not found" into a fix.
    """
    words: set[str] = set()
    for term in terms:
        words |= catalog.tokens(term)
    scored = []
    for course in catalog.snapshot().courses.values():
        hits = len(words & catalog.tokens(course.name))
        if hits:
            scored.append((hits, course.name))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [name for _, name in scored[:limit]]


def _report(kind: str, code: str, terms: list[str]) -> bool:
    found = _find_named(terms)
    if found:
        titles = ", ".join(c.name.strip() for c in found)
        print(f"  {OK} {kind:6} {code:18} -> {titles}")
        return True
    print(f"  {DEAD} {kind:6} {code:18} -> NOT PUBLISHED")
    near = _near_misses(terms)
    if near:
        print(f"      closest titles in the shop: {'; '.join(near)}")
        print(f"      -> if one of these IS the programme, add its wording to "
              f"`match` in data/curriculum.json")
    else:
        print("      nothing in the catalogue shares a word — the shop most "
              "likely does not sell it at all")
    return False


async def main() -> int:
    if not os.getenv("ODOO_API_KEY"):
        print("ODOO_API_KEY is not set — this script reads the live catalogue.")
        return 2

    snap = await catalog.refresh(full=True)
    print(f"catalogue: {len(snap.courses)} published courses\n")

    dead: list[str] = []

    print("certifications (goal = شهادة احترافية أو إدارية)")
    for cert in curriculum.mapping().get("certifications", []):
        if not _report("cert", cert["code"], cert.get("match", [])):
            dead.append(cert["code"])

    print("\nBIM tracks (goal = نمذجة وتقنيات BIM)")
    for spec, row in curriculum.mapping().get("bim_tracks", {}).items():
        if not _report("bim", row.get("code", spec), row.get("match", [])):
            dead.append(row.get("code", spec))

    print("\ncomprehensive tracks (goal = سوق العمل / التصميم)")
    for spec in curriculum.mapping().get("comprehensive", {}):
        groups = curriculum.comprehensive_groups(spec)
        live = [i for g in groups for i in curriculum.group_members(g)
                if i in snap.courses]
        total = sum(len(g.get("course_ids", [])) for g in groups)
        mark = OK if live else DEAD
        print(f"  {mark} track  {spec:18} -> {len(live)}/{total} courses published")
        if not live:
            dead.append(spec)

    if dead:
        print(f"\n{len(dead)} dead branch(es): {', '.join(dead)}")
        print("Majed will say «غير متاح حاليًّا» for these — correct behaviour, "
              "but a customer asking for them gets no recommendation.")
        return 1

    print("\nEvery branch of the mapping resolves to a published course.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
