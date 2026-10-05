# Kotoba — notes for Claude Code

Kotoba is a static spaced-repetition web app for Japanese vocabulary, served
from this repository by GitHub Pages at https://williamtoner.github.io/Kotoba/app/.
No build step, no framework, no dependencies. Progress lives in the learner's
browser (and optionally a private Gist); the vocabulary lives in
`data/words.json`; voice clips live in `app/voices/`.

## The weekly job: "add these pages"

The learner photographs textbook pages after each lesson and uploads the
photos here. When asked to add pages (any wording: "add these", "here are
this week's pages", "new vocab"):

1. Read every photo carefully and extract the vocabulary following the exact
   rules in `PROMPT` inside `app/extract.js` (same fields, same conventions:
   hiragana kana with katakana for loanwords, kanji only where a beginner
   would see it, meanings split into separate glosses, a hint that
   disambiguates words sharing a meaning, every handwritten margin note
   included with its romaji corrected, one short example sentence per word
   with `ja` as spaced kana, `jaKanji`, `romaji`, `en`).
2. Write the entries as a JSON array to a scratch file and run
   `python3 pipeline/add_words.py <file>`. It assigns ids, skips words already
   in the deck, and appends to `data/words.json`. Show the learner the list it
   prints.
3. Record the voices: `pip install edge-tts` if needed, then
   `python3 pipeline/voices.py`. It writes `app/voices/<id>.mp3` and
   `<id>-ex.mp3` and fills the `audio` / `exampleAudio` fields. If the network
   blocks it, skip this step: the `Record voices` GitHub Action records
   missing clips after the push.
4. Run `node tests/run.mjs` (must pass) and `python3 pipeline/voices.py --check`.
5. Commit (`Add N words from pages X–Y`) and push to `main`. GitHub Pages
   serves the new words within a minute or two; the app picks them up on its
   next load. Never rewrite or delete existing entries in `data/words.json`
   unless asked; the learner's review progress is keyed by word id.

## Layout

```
app/            the web app (index.html, app.js UI, srs.js FSRS scheduler, grading.js answer
                checking, store.js localStorage/IndexedDB, sync.js Gist sync + repo publish,
                extract.js Claude photo reading, sw.js, manifest, icons/, voices/)
data/words.json the deck: {version, words:[{id, kana, kanji, romaji, kanaAlts, meanings, hint,
                note, source, addedAt, example{ja,jaKanji,romaji,en}, audio, exampleAudio}]}
data/seed-progress.json  review state migrated from the earlier claude.ai version; imported once
pipeline/       voices.py (edge-tts), add_words.py, make_icons.py, migrate_from_artifact.py
tests/run.mjs   node tests for the pure modules
.github/workflows/voices.yml  records missing clips on push / nightly
```

## Conventions

- Plain ES modules, no `??` or `?.` in the pure modules so `node tests/run.mjs`
  also runs on old Node versions.
- Word ids are stable forever (`seedNNN` for the migrated deck, `w-<base36>`
  after). Progress is keyed `"<id>/<type>"` with types `jpen`, `enjp`, `audio`.
- Bump `CACHE_VERSION` in `app/sw.js` when shell files change in a way that
  must invalidate old caches.
- Audio paths in `words.json` are relative to `app/` (`voices/<id>.mp3`).
- Reviews are self-marked: each card reveals the answer, then **Wrong** / **Correct** (grades 1 and 3;
  `S.WRONG` / `S.CORRECT`). No typing — the three types test recognition and recall out loud:
  `jpen` read the Japanese, `audio` hear it, `enjp` see the English and say it aloud, then press
  "Play the Japanese" to check yourself. Typing can be switched back on per learner
  (Settings → "Type the answer instead of marking myself", `settings.typeAnswers`), which restores the
  old `grading.js` path; keep `grading.js` and its tests working.
- To keep repetition down: cards of one word stay at least `RECENT_WORDS` apart, new cards come in
  rounds by type, and a word's later types are locked until the type before it reaches `review`
  (`unlocked()` in srs.js) — so a new word is not drilled three ways on the day you meet it.
- The learner can type kana or romaji; grading rules are in `app/grading.js`
  and have tests. Add a test when you change them.
