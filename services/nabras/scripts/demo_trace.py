"""Drives a 4-turn sales conversation against the running demo server and
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

TURNS = [
    ("عايز اتعلم تحليل بيانات، من فين أبدأ؟", {}),
    ("طب أنهي واحد فيهم أرخص؟", {}),
    ("تمام، عايز أشتري Power BI",
     {"page_type": "courseDetail", "slug": "power-bi-data-analysis"}),
    ("بصراحة السعر شويه عليا، ممكن حد يكلمني؟", {}),
]


def sep(t):
    print(f"\n\033[1m{'─' * 74}\n{t}\n{'─' * 74}\033[0m")


def main() -> int:
    with httpx.Client(timeout=60) as c:
        t0 = time.perf_counter()
        r = c.post(f"{BASE}/api/v1/user/guest-session/create/")
        tok = r.json()["data"]["guest_token"]
        print(f"guest token minted in {(time.perf_counter()-t0)*1000:6.1f} ms  "
              f"({tok[:28]}…)")

        for i, (msg, extra) in enumerate(TURNS, 1):
            sep(f"TURN {i}  ▸  {msg}")
            body = {"message": msg, "fahem_session_id": SESSION,
                    "language": "auto", **extra}
            if extra:
                print(f"  [page context] {extra}")
            start = time.perf_counter()
            ttft = None
            text, cards = [], None
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
                    if ev["type"] == "token":
                        if ttft is None:
                            ttft = el
                            print(f"  \033[32m[{el:6.1f} ms] first token\033[0m")
                        text.append(ev["content"])
                    elif ev["type"] == "cards":
                        cards = ev["course_cards"]
                        print(f"  \033[36m[{el:6.1f} ms] cards x{len(cards)}\033[0m")
                    elif ev["type"] == "done":
                        print(f"  \033[90m[{el:6.1f} ms] done\033[0m")
                    elif ev["type"] == "error":
                        print(f"  \033[31m[{el:6.1f} ms] error {ev}\033[0m")
            total = (time.perf_counter() - start) * 1000
            print(f"\n  reply: {''.join(text)}")
            print(f"\n  \033[1mTTFT {ttft or 0:.0f} ms   total {total:.0f} ms   "
                  f"perceived-wait saved {total - (ttft or total):.0f} ms\033[0m")
            if cards:
                print("  cards:")
                for cd in cards:
                    buy = cd.get("checkout_url")
                    print(f"    • {cd['title']:<28} {str(cd['price_display']):>6} "
                          f"★{cd['rating']}  {'🛒 ' + buy if buy else ''}")

        sep("MEMORY  ▸  GET /api/v1/ai-chat/history/")
        h = c.get(f"{BASE}/api/v1/ai-chat/history/{SESSION}/",
                  headers={"X-Guest-Token": tok})
        rows = h.json()["data"]
        print(f"  {len(rows)} persisted messages")
        for m in rows:
            print(f"    {m['role']:<6} {str(m['content'])[:88]}")

        sep("GUARDRAILS")
        bad = c.post(f"{BASE}/api/v1/ai-chat/chat/",
                     json={"message": "hi", "fahem_session_id": "x"})
        print(f"  no token           -> HTTP {bad.status_code}")
        bad2 = c.post(f"{BASE}/api/v1/ai-chat/chat/",
                      json={"message": "hi", "fahem_session_id": "x"},
                      headers={"X-Guest-Token": "not.a.jwt"})
        print(f"  forged token       -> HTTP {bad2.status_code}")
        bad3 = c.post(f"{BASE}/api/v1/ai-chat/chat/",
                      json={"fahem_session_id": "x"},
                      headers={"X-Guest-Token": tok})
        print(f"  malformed payload  -> HTTP {bad3.status_code}")
        codes = [c.post(f"{BASE}/api/v1/user/guest-session/create/").status_code
                 for _ in range(35)]
        print(f"  35x mint guest     -> {codes.count(200)}x200, {codes.count(429)}x429")
    return 0


if __name__ == "__main__":
    sys.exit(main())
