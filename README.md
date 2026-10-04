# Kotoba

Spaced-repetition flash cards for Japanese vocabulary, built around one habit:
photograph the textbook pages after each lesson and every word on them becomes
cards, with a Japanese voice, the same day.

Each word gets three cards: read the kana and type the English, read the
English and type the kana (romaji is accepted), and listen and type the
English. Scheduling is FSRS. Every word has an example sentence with its own
recording. Nothing is drip-fed: a page's vocabulary is available to learn as
soon as it is added.

Sister project of [Kanjr](https://github.com/williamtoner/Kanjr), and built the
same way: a static app with no build step, progress in the browser with
optional sync through a private GitHub Gist, voice clips committed to the repo,
installable to a phone home screen.

## Use it

https://williamtoner.github.io/Kotoba/app/

On iPhone: open in Safari, Share, "Add to Home Screen". On Android: Chrome
menu, "Add to Home screen".

## Adding pages

Two ways, both producing identical records:

1. **In the app** (Add tab): take a photo, check the list, save. Needs a Claude
   API key from https://console.anthropic.com pasted once into Settings. A
   page costs a few cents. With a GitHub token in Settings the words are also
   committed to this repo, and the voices workflow records them within minutes.
2. **With Claude Code** on this repository: upload the photos and say "add
   these pages". `CLAUDE.md` tells it what to do. Needs no API key.

## Development

```bash
python3 -m http.server 8000     # then open http://localhost:8000/app/
node tests/run.mjs              # tests for the scheduler, grading, merge and parsing
pip install edge-tts pillow
python3 pipeline/voices.py      # record clips for words that lack them
python3 pipeline/make_icons.py  # regenerate the icons
```

## Layout

```
app/        static web app (no build step)
data/       words.json (the deck) and seed-progress.json (one-time import)
pipeline/   Python helpers: voices, add_words, icons, migration
tests/      node tests
```
