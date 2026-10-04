/**
 * extract.js — read vocabulary off photographed textbook pages with Claude.
 *
 * This is a static site with no build step and no server, so the request goes
 * straight from the browser to the Claude API with the learner's own key
 * (stored only in this browser, see store.js). The key is as exposed as any
 * value in a browser, which is acceptable for a personal tool; keep it on a
 * low spending limit. The same prompt is used by the Claude Code flow in
 * CLAUDE.md, so both paths produce identical records.
 */

export const MODEL = 'claude-opus-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export const PROMPT = `You are reading photographed pages from a beginner Japanese textbook written in romaji, with the student's handwritten margin notes. Extract every vocabulary item and reusable phrase a learner should memorise, from ALL the photos.

Rules:
- Include printed vocabulary entries, every word in vocabulary boxes (countries, jobs and similar), and every handwritten note that pairs Japanese with an English meaning. Correct misspelled handwritten romaji to standard Hepburn (for example "dooitashimashite" is "dōitashimashite").
- From dialogues include only reusable set phrases and single words (greetings, "sōdesuka", "o-shigoto wa?", "hajimemashite", "dōzo yoroshiku"). Skip personal names, sentence patterns with blanks, page headers, exercise instructions and grammar drills.
- kana: hiragana, or katakana for loanwords such as アメリカ. kanji: the common written form if a beginner would normally see it (今日は is not common for konnichiwa, so leave that empty), otherwise "".
- When a polite prefix or suffix is optional, like "(o)genki desu ka" or "gambatte (kudasai)", put the full form in kana and the shorter form in kanaAlts.
- meanings: an array of short English glosses, each one a separate acceptable answer. Split alternatives like "Sorry / Excuse me / Thank you" into separate entries. No parentheses inside meanings.
- hint: a short disambiguator shown when the learner must produce the Japanese, such as "polite", "casual", "said by the person leaving", "on meeting someone for the first time". "" if none is needed.
- note: any printed or handwritten usage note, in a few words. "" if none.
- source: the page number if printed, else "".
- example: one short, natural, beginner-level sentence using the word. "ja" is the sentence in kana with a space between words, "jaKanji" is the normal written form with kanji, "romaji" is Hepburn, "en" is the English.
Reply with only a JSON array, nothing else, like:
[{"romaji":"ohayō gozaimasu","kana":"おはようございます","kanji":"","kanaAlts":["おはよう"],"meanings":["good morning"],"hint":"polite","note":"","source":"4","example":{"ja":"せんせい、おはようございます。","jaKanji":"先生、おはようございます。","romaji":"Sensei, ohayō gozaimasu.","en":"Good morning, teacher."}}]`;

/** Shrink a photo to at most `maxSide` pixels on its long edge and return {data, media_type}. */
export async function prepareImage(file, maxSide = 1800) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) { bitmap = await createImageBitmap(file); }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), media_type: 'image/jpeg' };
}

export class ExtractError extends Error { constructor(message, kind) { super(message); this.kind = kind; } }

/** Ask Claude to read the pages. Resolves with the parsed array of raw entries. */
export async function extractFromPhotos(apiKey, files, { signal, onStatus } = {}) {
  if (!apiKey) throw new ExtractError('No Claude API key is set. Add one in Settings.', 'nokey');
  if (onStatus) onStatus('Preparing photos');
  const images = [];
  for (const f of files) images.push(await prepareImage(f));
  const content = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } }));
  content.push({ type: 'text', text: PROMPT });
  if (onStatus) onStatus('Reading the page' + (files.length > 1 ? 's' : ''));
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ExtractError('Stopped.', 'cancelled');
    throw new ExtractError('Could not reach the Claude API. Check the connection.', 'network');
  }
  if (res.status === 401) throw new ExtractError('The Claude API key was rejected. Check it in Settings.', 'auth');
  if (res.status === 429) throw new ExtractError('The Claude API is rate limiting this key. Try again in a minute.', 'rate');
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j && j.error && j.error.message ? ' ' + j.error.message : ''; } catch (_) { /* ignore */ }
    throw new ExtractError('The Claude API returned ' + res.status + '.' + detail, 'http');
  }
  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new ExtractError('Claude declined to read these photos.', 'refused');
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = parseJsonArray(text);
  if (!parsed) throw new ExtractError('Claude answered in a form that could not be read. Try again.', 'parse');
  return parsed;
}

/** Tolerant parse: the whole text, else a fenced block, else first [ to last ]. */
export function parseJsonArray(text) {
  const tries = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { const v = JSON.parse(t); if (Array.isArray(v)) return v; } catch (_) { /* next */ } }
  return null;
}

/** Turn one raw entry from Claude into a clean word record (without id). */
export function cleanEntry(r) {
  if (!r || typeof r !== 'object') return null;
  const str = (x) => (x == null ? '' : String(x)).trim();
  const e = r.example && typeof r.example === 'object' ? r.example : null;
  const row = {
    kana: str(r.kana), kanji: str(r.kanji), romaji: str(r.romaji),
    kanaAlts: Array.isArray(r.kanaAlts) ? r.kanaAlts.map(str).filter(Boolean) : [],
    meanings: Array.isArray(r.meanings) ? r.meanings.map(str).filter(Boolean) : [str(r.meanings)].filter(Boolean),
    hint: str(r.hint), note: str(r.note), source: str(r.source),
    example: e && str(e.ja) ? { ja: str(e.ja), jaKanji: str(e.jaKanji), romaji: str(e.romaji), en: str(e.en) } : null,
  };
  if (!row.kana || !row.meanings.length) return null;
  return row;
}
