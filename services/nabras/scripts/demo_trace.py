"""Drives a 5-turn sales conversation against the running demo server and
prints a timed trace of the SSE wire protocol.

    python scripts/demo_server.py &      # :8099
    python scripts/demo_trace.py
"""
import json
import sys
import time

import httpx

BASE = "http://127.0.0.1:8099"
SESSION = "demo_session_1"
CURRENCY = "EGP"

TURNS = [
    ("عايز أدخل مجال BIM، من فين أبدأ؟", {}),
    ("طب Navisworks بكام؟", {}),
    ("تمام، امتى الدفعة الجاية وفيه أماكن؟",
     {"page_type": "courseDetail", "slug": "navisworks-mep-2107"}),
    ("خلاص عايز أشترك", {}),
    ("بصراحة السعر شويه عليا، ممكن حد يكلمني؟", {}),
]


def sep(t):
    print(f"\n\033[1m{'─' * 78}\n{t}\n{'─' * 78}\033[0m")


def main() -> int:
    with httpx.Client(timeout=60) as c:
        h = c.get(f"{BASE}/health").json()
        print(f"catalogue: {h['courses']} courses · {h['batches']} batches · "
              f"packages={h['packages_available']}")
        tok = c.post(f"{BASE}/api/v1/user/guest-session/create/"
                     ).json()["data"]["guest_token"]

        for i, (msg, extra) in enumerate(TURNS, 1):
            sep(f"TURN {i}  ▸  {msg}")
            if extra:
                print(f"  [page] {extra}")
            body = {"message": msg, "fahem_session_id": SESSION,
                    "language": "auto", "currency": CURRENCY, **extra}
            start = time.perf_counter()
            ttft = None
            text, cards, pkgs, handoff = [], None, None, None
            with c.stream("POST", f"{BASE}/api/v1/ai-chat/chat/", json=body,
                          headers={"X-Guest-Token": tok}) as resp:
                if resp.status_code != 200:
                    resp.read()
                    print("  HTTP", resp.status_code, resp.text)
                    return 1
                for line in resp.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    ev = json.loads(line[6:])
                    el = (time.perf_counter() - start) * 1000
                    k = ev["type"]
                    if k == "token":
                        if ttft is None:
                            ttft = el
                            print(f"  \033[32m[{el:6.1f} ms] first token\033[0m")
                        text.append(ev["content"])
                    elif k == "cards":
                        cards = ev["course_cards"]
                        print(f"  \033[36m[{el:6.1f} ms] course cards x{len(cards)}\033[0m")
                    elif k == "packages":
                        pkgs = ev["package_cards"]
                        print(f"  \033[35m[{el:6.1f} ms] package cards x{len(pkgs)}\033[0m")
                    elif k == "handoff":
                        handoff = ev
                        print(f"  \033[33m[{el:6.1f} ms] HANDOFF -> bridge "
                              f"({ev.get('reason')})\033[0m")
                    elif k == "done":
                        print(f"  \033[90m[{el:6.1f} ms] done\033[0m")
                    elif k == "error":
                        print(f"  \033[31m[{el:6.1f} ms] error {ev}\033[0m")
            total = (time.perf_counter() - start) * 1000
            print(f"\n  reply: {''.join(text).strip()}")
            print(f"\n  \033[1mTTFT {ttft or 0:.0f} ms   total {total:.0f} ms   "
                  f"perceived-wait saved {total - (ttft or total):.0f} ms\033[0m")
            if pkgs:
                print("  packages:")
                for p in pkgs:
                    print(f"    ★ {p['title']:<38} {str(p['price_display']):>12}"
                          f"  خصم {p.get('discount')}%  {p.get('courses_count')} كورس")
            if cards:
                print("  courses:")
                for cd in cards:
                    nb = cd.get("next_batch") or {}
                    seats = (f"  مقاعد {nb.get('seats_available')}/{nb.get('seats_max')}"
                             if nb else "")
                    buy = "  🛒 " + cd["checkout_url"] if cd.get("checkout_url") else ""
                    print(f"    • {cd['title']:<34} {str(cd['price_display']):>12}"
                          f"  [{cd.get('delivery') or '—'}]{seats}{buy}")
                    for ins in cd.get("instructors", [])[:2]:
                        print(f"        👤 {ins['name']} — {ins.get('title')}")

        sep("MEMORY  ▸  GET /api/v1/ai-chat/history/")
        rows = c.get(f"{BASE}/api/v1/ai-chat/history/{SESSION}/",
                     headers={"X-Guest-Token": tok}).json()["data"]
        print(f"  {len(rows)} persisted messages")
        for m in rows:
            print(f"    {m['role']:<6} {str(m['content'])[:86]}")

        sep("GUARDRAILS")
        print("  no token          -> HTTP %s" % c.post(
            f"{BASE}/api/v1/ai-chat/chat/",
            json={"message": "hi", "fahem_session_id": "x"}).status_code)
        print("  forged token      -> HTTP %s" % c.post(
            f"{BASE}/api/v1/ai-chat/chat/",
            json={"message": "hi", "fahem_session_id": "x"},
            headers={"X-Guest-Token": "not.a.jwt"}).status_code)
        print("  malformed payload -> HTTP %s" % c.post(
            f"{BASE}/api/v1/ai-chat/chat/", json={"fahem_session_id": "x"},
            headers={"X-Guest-Token": tok}).status_code)
        codes = [c.post(f"{BASE}/api/v1/user/guest-session/create/").status_code
                 for _ in range(35)]
        print(f"  35x mint guest    -> {codes.count(200)}x200, {codes.count(429)}x429")
    return 0


if __name__ == "__main__":
    sys.exit(main())
