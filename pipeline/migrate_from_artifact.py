#!/usr/bin/env python3
"""One-off: build data/words.json and data/seed-progress.json from the export of
the earlier claude.ai artifact database (one JSON file per word document).

    python3 pipeline/migrate_from_artifact.py /path/to/export/words
"""
import glob
import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPES = ["jpen", "enjp", "audio"]


def day_key(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def main(src):
    words, cards, days = [], {}, {}
    for f in sorted(glob.glob(os.path.join(src, "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        wid = d["id"]
        w = {
            "id": wid, "kana": d.get("kana", ""), "kanji": d.get("kanji", ""), "romaji": d.get("romaji", ""),
            "kanaAlts": d.get("kanaAlts") or [], "meanings": d.get("meanings") or [], "hint": d.get("hint", ""),
            "note": d.get("note", ""), "source": str(d.get("source", "")), "addedAt": d.get("addedAt", 0),
            "example": d.get("example") or None,
            "audio": ("voices/" + os.path.basename(d["audio"])) if d.get("audio") else None,
            "exampleAudio": ("voices/" + os.path.basename(d["exampleAudio"])) if d.get("exampleAudio") else None,
        }
        words.append(w)
        for t in TYPES:
            c = (d.get("cards") or {}).get(t)
            if not c or c.get("state", "new") == "new":
                continue
            cards[f"{wid}/{t}"] = c
            # Approximate the daily log: one entry per card on the day it was first seen.
            ms = c.get("firstReview")
            if ms:
                e = days.setdefault(day_key(ms), {"reviews": 0, "correct": 0})
                e["reviews"] += 1
                if not c.get("lapses") and c.get("state") == "review":
                    e["correct"] += 1
    words.sort(key=lambda w: w["addedAt"])
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "words.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "words": words}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    now = datetime.utcnow().isoformat() + "Z"
    seed = {"version": 1, "createdAt": now, "updatedAt": now, "cards": cards, "days": days, "words": {}, "localWords": {},
            "settings": {"newPerDay": 0, "autoplay": True, "theme": "system"}}
    with open(os.path.join(ROOT, "data", "seed-progress.json"), "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{len(words)} words, {len(cards)} started cards, {len(days)} review days")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
