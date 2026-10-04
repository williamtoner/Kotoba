#!/usr/bin/env python3
"""Merge new vocabulary into data/words.json.

Input: a JSON file holding an array of entries in the extraction format
(kana, kanji, romaji, kanaAlts, meanings, hint, note, source, example).
Entries get an id and addedAt, are checked for the required fields, and are
skipped when a word with the same kana (katakana folded to hiragana,
punctuation ignored) is already in the deck.

    python3 pipeline/add_words.py new_words.json
    python3 pipeline/add_words.py new_words.json --dry-run
"""
import json
import os
import re
import sys
import time
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS = os.path.join(ROOT, "data", "words.json")


def norm_kana(s):
    s = unicodedata.normalize("NFKC", s or "").lower()
    out = []
    for ch in s:
        c = ord(ch)
        if 0x30A1 <= c <= 0x30F6:
            out.append(chr(c - 0x60))
        elif ch == "ー":
            out.append(ch)
        elif ch.isspace() or unicodedata.category(ch)[0] in ("P", "S"):
            continue
        else:
            out.append(ch)
    return "".join(out)


def base36(n):
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = chars[r] + s
    return s or "0"


def clean(e):
    if not isinstance(e, dict):
        return None
    s = lambda k: str(e.get(k) or "").strip()
    meanings = e.get("meanings")
    if isinstance(meanings, str):
        meanings = [meanings]
    meanings = [str(m).strip() for m in (meanings or []) if str(m).strip()]
    ex = e.get("example") if isinstance(e.get("example"), dict) else None
    row = {
        "kana": s("kana"), "kanji": s("kanji"), "romaji": s("romaji"),
        "kanaAlts": [str(a).strip() for a in (e.get("kanaAlts") or []) if str(a).strip()],
        "meanings": meanings, "hint": s("hint"), "note": s("note"), "source": s("source"),
        "example": None,
    }
    if ex and str(ex.get("ja") or "").strip():
        row["example"] = {k: str(ex.get(k) or "").strip() for k in ("ja", "jaKanji", "romaji", "en")}
    if not row["kana"] or not row["meanings"]:
        return None
    return row


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if len(args) != 1:
        print(__doc__)
        return 2
    with open(args[0], encoding="utf-8") as f:
        incoming = json.load(f)
    with open(WORDS, encoding="utf-8") as f:
        doc = json.load(f)
    have = {norm_kana(w["kana"]) for w in doc["words"]}
    for w in doc["words"]:
        for a in w.get("kanaAlts") or []:
            have.add(norm_kana(a))
    now = int(time.time() * 1000)
    added, skipped, bad = [], [], 0
    for i, e in enumerate(incoming):
        row = clean(e)
        if not row:
            bad += 1
            continue
        k = norm_kana(row["kana"])
        if k in have:
            skipped.append(row["kana"])
            continue
        have.add(k)
        row["id"] = "w-" + base36(now + i)
        row["addedAt"] = now + i
        row["audio"] = None
        row["exampleAudio"] = None
        doc["words"].append(row)
        added.append(row)
    if not dry:
        with open(WORDS, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.write("\n")
    print(f"added {len(added)}, skipped {len(skipped)} already in deck, {bad} invalid" + (" (dry run)" if dry else ""))
    for r in added:
        print("  +", r["kana"], "-", " / ".join(r["meanings"]))
    for k in skipped:
        print("  =", k)
    return 0


if __name__ == "__main__":
    sys.exit(main())
