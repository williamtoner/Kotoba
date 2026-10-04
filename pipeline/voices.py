#!/usr/bin/env python3
"""Record a Japanese voice clip for every word and example sentence that lacks one.

Reads data/words.json, writes app/voices/<id>.mp3 and app/voices/<id>-ex.mp3
with Microsoft's neural voice through the edge-tts package, and fills in the
`audio` / `exampleAudio` fields. Safe to run repeatedly: existing clips are kept.

    pip install edge-tts
    python3 pipeline/voices.py            # record what is missing
    python3 pipeline/voices.py --check    # exit 1 if anything is missing, record nothing
"""
import asyncio
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS = os.path.join(ROOT, "data", "words.json")
VOICES = os.path.join(ROOT, "app", "voices")
VOICE = "ja-JP-NanamiNeural"
RATE = "-10%"


def load():
    with open(WORDS, encoding="utf-8") as f:
        return json.load(f)


def save(doc):
    with open(WORDS, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")


def missing(doc):
    """Yield (word, kind, text, filename) for every clip that should exist but does not."""
    for w in doc["words"]:
        wid = w["id"]
        text = (w.get("kanji") or w.get("kana") or "").strip()
        if text:
            fn = f"{wid}.mp3"
            if not w.get("audio") or not os.path.exists(os.path.join(VOICES, fn)):
                yield w, "audio", text, fn
        ex = w.get("example") or {}
        extext = (ex.get("jaKanji") or ex.get("ja") or "").strip()
        if extext:
            fn = f"{wid}-ex.mp3"
            if not w.get("exampleAudio") or not os.path.exists(os.path.join(VOICES, fn)):
                yield w, "exampleAudio", extext, fn


async def record(items):
    import edge_tts
    sem = asyncio.Semaphore(4)

    async def one(w, kind, text, fn):
        out = os.path.join(VOICES, fn)
        async with sem:
            await edge_tts.Communicate(text, VOICE, rate=RATE).save(out)
        if os.path.getsize(out) < 500:
            os.remove(out)
            raise RuntimeError(f"empty clip for {w['id']} ({kind})")
        w[kind] = f"voices/{fn}"

    results = await asyncio.gather(*(one(*it) for it in items), return_exceptions=True)
    failed = [r for r in results if isinstance(r, Exception)]
    for r in failed:
        print("failed:", r, file=sys.stderr)
    return len(items) - len(failed)


def main():
    os.makedirs(VOICES, exist_ok=True)
    doc = load()
    items = list(missing(doc))
    if "--check" in sys.argv:
        print(f"{len(items)} clip(s) missing")
        return 1 if items else 0
    if not items:
        print("All words have recordings.")
        return 0
    done = asyncio.run(record(items))
    save(doc)
    print(f"Recorded {done} of {len(items)} clip(s).")
    return 0 if done == len(items) else 2


if __name__ == "__main__":
    sys.exit(main())
