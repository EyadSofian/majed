#!/usr/bin/env python3
"""Turn Engosoft's course KB (markdown) into `data/curriculum.json`.

    python scripts/build_curriculum.py EngoSoft_Courses_KB.md

Re-run this whenever the KB changes — a new course, a renamed track, an edited
grouping rule. Nothing else reads the markdown; the service only ever loads the
JSON this produces.

What it takes out of the KB, and why each one matters:
  * keyword tree -> the Arabic phrases customers type, which Odoo does not hold
  * category     -> the discipline, so «ميكانيكا» stops returning BIM courses
  * grouping rules -> the exact contents of "الميكانيكا الشاملة" and friends
  * course page  -> the Odoo product id, the join key back to the live catalogue
"""
import json
import pathlib
import re
import sys

# Words that name the family rather than the course. "Mechanical - Shop Drawing"
# and "Electrical - Shop Drawing" differ ONLY by one of these, so they decide
# nothing on their own and everything as a tiebreak.
FAMILY = {"mechanical", "electrical", "civil", "infrastructure", "structure",
          "structural", "interior", "architecture", "automotive", "steel",
          "course", "courses", "design", "the", "of", "and", "engosoft",
          "systems", "system"}


def toks(s):
    s = re.sub(r"\(.*?\)", " ", s or "").lower().replace("&", " ")
    return [w for w in re.findall(r"[a-z0-9]+", s) if len(w) > 1]


def content(s):
    return [w for w in toks(s) if w not in FAMILY] or toks(s)


def pair(a, b):
    """Exact beats prefix: "lighting" is the Lighting course, not Light Current."""
    if a == b:
        return 2
    if len(a) >= 4 and len(b) >= 4 and (a.startswith(b) or b.startswith(a)):
        return 1
    return 0


def score(words, title):
    t = toks(title)
    return sum(max((pair(w, y) for y in t), default=0) for w in words)


def sections(text):
    out, cur, buf = {}, "head", []
    for line in text.splitlines():
        if line.startswith("# ") and not line.startswith("## "):
            out[cur] = "\n".join(buf)
            cur, buf = line[2:].strip(), []
        else:
            buf.append(line)
    out[cur] = "\n".join(buf)
    return out


def field(block, label):
    m = re.search(rf"^\*\*{re.escape(label)}:\*\*\s*(.+?)\s*$", block, re.M)
    return m.group(1).strip() if m else ""


def bullet(block, label):
    m = re.search(rf"^-\s*\*\*{re.escape(label)}:\*\*\s*(.+?)\s*$", block, re.M)
    return m.group(1).strip() if m else ""


def keywords(block):
    m = re.search(r"^\*\*Keyword Tree:\*\*\s*(.*?)(?=^\*|^\Z|^---)", block, re.M | re.S)
    if not m:
        return []
    out, seen = [], set()
    for k in re.split(r"[,،]", re.sub(r"\s+", " ", m.group(1))):
        k = k.strip(" .·")
        if k and k.lower() not in seen:
            seen.add(k.lower())
            out.append(k)
    return out


def link(block, label):
    m = re.search(rf"\*\s*\*\*{re.escape(label)}:\*\*\s*\[[^\]]+\]\((https?://[^)\s]+)\)",
                  block)
    return m.group(1) if m else ""


# Disciplines Engosoft trains in. A KB category outside this map is not a field
# the business sells against and is dropped entirely.
FIELD_LABELS = {
    "Mechanical": "ميكانيكا",
    "Electrical": "كهرباء",
    "Civil": "مدني وإنشائي",
    "Architecture": "معماري",
    "Interior Design": "تصميم داخلي وديكور",
    "Management": "إدارة ومشاريع وسلامة",
}


def parse(section):
    """Only what we are allowed to use: the id, its discipline, who it is for,
    and the search words. The title is kept for group matching and then thrown
    away — it never reaches the JSON."""
    items = []
    for chunk in re.split(r"\n(?=## )", section or ""):
        if not chunk.strip().startswith("## "):
            continue
        page = field(chunk, "Course Page")
        m = re.search(r"-(\d+)$", page)
        items.append({
            "title": chunk.splitlines()[0][3:].strip(),   # matching only
            "category": field(chunk, "Category"),
            "audience": bullet(chunk, "Target Audience"),
            "level": bullet(chunk, "Experience Level"),
            "keywords": keywords(chunk),
            # a /training_package/ url ends with a PACKAGE id, not a product id
            "odoo_id": (int(m.group(1))
                        if m and "/training_package/" not in page else None),
        })
    return items


def main(src: pathlib.Path, dst: pathlib.Path) -> None:
    parts = sections(src.read_text())
    courses = parse(parts.get("EngoSoft Training Courses Database"))
    tracks = parse(parts.get("Tracks"))

    groups = []
    for chunk in re.split(r"\n(?=## )", parts.get("Packages and courses", "")):
        if "RULE" not in chunk:
            continue
        triggers = re.findall(r'"([^"]+)"', chunk)
        members = [re.sub(r"\s*\(.*?\)\s*$", "", m).strip()
                   for m in re.findall(r"^-\s+(.+?)\s*$", chunk, re.M)]
        if not (triggers and members):
            continue
        ids = []
        for mem in members:
            ranked = sorted(((score(content(mem), c["title"]),
                              score(toks(mem), c["title"]), c) for c in courses),
                            key=lambda x: (x[0], x[1]), reverse=True)
            best, runner = ranked[0], ranked[1]
            confident = best[0] > 0 and (best[0], best[1]) > (runner[0], runner[1])
            ids.append(best[2]["odoo_id"] if confident else None)
        groups.append({"rule": chunk.splitlines()[0][3:].strip(),
                       "triggers": triggers, "courses": members,
                       "course_ids": ids})

    # ---- emit only the three things, keyed by Odoo id
    out_courses: dict[str, dict] = {}
    for c in courses + tracks:
        if not c["odoo_id"] or c["category"] not in FIELD_LABELS:
            continue                       # no product id, or not a field we sell
        out_courses[str(c["odoo_id"])] = {
            "field": c["category"],
            "audience": c["audience"],
            "level": c["level"],
            "keywords": c["keywords"],
        }

    # A track has no product id of its own, but its words are how people name
    # the discipline — the only thing they are used for.
    out_fields: dict[str, dict] = {}
    for c in courses + tracks:
        f = c["category"]
        if f not in FIELD_LABELS:
            continue
        row = out_fields.setdefault(f, {"label": FIELD_LABELS[f], "keywords": [],
                                        "course_ids": []})
        row["keywords"] += c["keywords"] + [c["title"]]
        if c["odoo_id"]:
            row["course_ids"].append(c["odoo_id"])
    for row in out_fields.values():
        seen, uniq = set(), []
        for k in row["keywords"]:
            if k and k.lower() not in seen:
                seen.add(k.lower())
                uniq.append(k)
        row["keywords"] = uniq

    out_groups = [{"rule": g["rule"], "triggers": g["triggers"],
                   "course_ids": [i for i in g["course_ids"] if i]}
                  for g in groups]

    dst.write_text(json.dumps(
        {"source": src.name, "fields": out_fields, "courses": out_courses,
         "groups": out_groups}, ensure_ascii=False, indent=1) + "\n")
    dropped = len(courses) + len(tracks) - len(out_courses)
    print(f"{dst}: {len(out_courses)} courses across {len(out_fields)} fields, "
          f"{len(out_groups)} package rules "
          f"({sum(len(g['course_ids']) for g in out_groups)} members) — "
          f"dropped {dropped} KB entries with no Odoo product id or no field")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    root = pathlib.Path(__file__).resolve().parent.parent
    main(pathlib.Path(sys.argv[1]), root / "data" / "curriculum.json")
