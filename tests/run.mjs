// Node tests for the pure modules: node tests/run.mjs
import * as S from '../app/srs.js';
import * as G from '../app/grading.js';
import { mergeProgress } from '../app/sync.js';
import { parseJsonArray, cleanEntry } from '../app/extract.js';

let failed = 0, passed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('FAIL', msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' — got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b)); }

// ---- scheduler
const now = Date.UTC(2026, 9, 4, 9, 0, 0), R = 0.9;
let c = S.gradeCard({ state: 'new' }, 3, now, R);
ok(c.state === 'review' && Math.round((c.due - now) / S.DAY) === 3, 'new Good is due in about 3 days');
c = S.gradeCard({ state: 'new' }, 1, now, R);
ok(c.state === 'learning' && c.due - now === S.LEARN_MS, 'new Again comes back in 10 min');
let c2 = S.gradeCard(c, 3, now + S.LEARN_MS, R);
ok(c2.state === 'review' && c2.due - (now + S.LEARN_MS) === S.DAY, 'learning Good graduates to 1 day');
let c3 = S.gradeCard(c2, 1, c2.due, R);
ok(c3.state === 'relearning' && c3.lapses === 1, 'review Again counts a lapse');
ok(S.gradeCard({ state: 'new' }, 4, now, R).due - now > 10 * S.DAY, 'new Easy goes out past 10 days');
eq(S.fmtDelta(90 * 1000), '2 min', 'fmtDelta minutes');
eq(S.fmtDelta(3 * S.DAY), '3 d', 'fmtDelta days');

const words = { a: { id: 'a', addedAt: 1 }, b: { id: 'b', addedAt: 2 } };
const cards = { 'a/jpen': { state: 'review', due: now - 1000 }, 'a/enjp': { state: 'review', due: now + S.DAY } };
eq(S.pickNext(words, cards, now, Infinity, []), { wid: 'a', type: 'jpen', due: now - 1000 }, 'due card first');
eq(S.pickNext(words, {}, now, Infinity, []), { wid: 'a', type: 'jpen', added: 1, o: 0 }, 'new cards start with the first word reading card');
eq(S.pickNext(words, {}, now, Infinity, ['a']).wid, 'b', 'a word just shown waits; the next word comes first');
eq(S.pickNext(words, {}, now, Infinity, ['a', 'b']), { wid: 'a', type: 'jpen', added: 1, o: 0 }, 'when every word is recent, spacing gives way');
eq(S.pickNext(words, { 'a/jpen': { state: 'review', due: now + S.DAY }, 'b/jpen': { state: 'review', due: now + S.DAY } }, now, Infinity, []).type, 'enjp', 'rounds: production cards come after every reading card');
const dueSibs = { 'a/jpen': { state: 'review', due: now - 3000 }, 'a/enjp': { state: 'review', due: now - 2000 }, 'b/jpen': { state: 'review', due: now - 1000 } };
eq(S.pickNext(words, dueSibs, now, Infinity, ['a']).wid, 'b', 'due siblings are spread out');
ok(S.pickNext(words, {}, now, 0, []) === null, 'no new cards when the budget is zero');
eq(S.counts(words, cards, now), { due: 1, fresh: 4, total: 2 }, 'counts');
const dk = (t) => new Date(t).toISOString().slice(0, 10);
const today = Date.UTC(2026, 9, 4);
eq(S.streak({ [dk(today)]: { reviews: 2 }, [dk(today - S.DAY)]: { reviews: 1 } }, today, dk), 2, 'streak counts today and yesterday');
eq(S.streak({ [dk(today - S.DAY)]: { reviews: 1 } }, today, dk), 1, 'streak survives an unreviewed today');
eq(S.streak({}, today, dk), 0, 'empty streak');
ok(S.isLeech({ 'x/jpen': { lapses: 4 } }, 'x') && !S.isLeech({ 'x/jpen': { lapses: 3 } }, 'x'), 'leech threshold');

// ---- grading
const w = { id: 'w', kana: 'おはようございます', kanaAlts: ['おはよう'], meanings: ['good morning'] };
for (const t of ['おはようございます', 'おはよう', 'オハヨウ', 'ohayou gozaimasu', 'ohayo gozaimas', 'ohayō']) ok(G.kanaMatches(t, w), 'kana/romaji accepts ' + t);
ok(!G.kanaMatches('こんにちは', w) && !G.kanaMatches('konnichiwa', w), 'kana rejects a different word');
ok(G.kanaMatches('konbanwa', { kana: 'こんばんは' }) && G.kanaMatches('kombanwa', { kana: 'こんばんは' }), 'particle は and n/m');
ok(G.kanaMatches('chuugoku', { kana: 'ちゅうごく' }) && G.kanaMatches('tyuugoku', { kana: 'ちゅうごく' }), 'chu variants');
ok(G.kanaMatches('amerika', { kana: 'アメリカ' }), 'katakana via romaji');
eq(G.kanaToRomaji('いってらっしゃい'), 'itterasshai', 'sokuon doubling');
ok(G.enMatches('Good morning!', ['good morning']), 'english exact');
ok(G.enMatches('the good bye', ['good-bye']) && G.enMatches('goodbye', ['good-bye']), 'english articles and hyphens');
ok(G.enMatches("I'm fine", ['fine']), 'english leading I\'m');
ok(!G.enMatches('good evening', ['good morning']), 'english rejects');
ok(G.enMatches('excuse me', ['sorry', 'excuse me', 'thank you']), 'english any meaning');
const deck = { w, v: { id: 'v', kana: 'おはよう', meanings: ['good morning'] } };
ok(G.synonymHit('おはよう', { id: 'w', kana: 'おはようございます', meanings: ['good morning'] }, deck) !== null, 'synonym hit');

// ---- merge
const a = { version: 1, updatedAt: '2026-10-04T10:00:00Z', cards: { 'a/jpen': { reps: 3, last: 5 }, 'b/jpen': { reps: 1, last: 1 } }, days: { d1: { reviews: 2, correct: 1 } }, words: { a: { updatedAt: 1, suspended: true } }, localWords: {}, settings: { newPerDay: 0 } };
const b = { version: 1, updatedAt: '2026-10-04T09:00:00Z', cards: { 'a/jpen': { reps: 2, last: 9 }, 'c/jpen': { reps: 1, last: 1 } }, days: { d1: { reviews: 1, correct: 3 } }, words: { a: { updatedAt: 2, suspended: false } }, localWords: { x: { kana: 'x', updatedAt: 1 } }, settings: { newPerDay: 5, autoplay: false } };
const m = mergeProgress(a, b);
eq(m.cards['a/jpen'].reps, 3, 'merge keeps the card with more reps');
ok(m.cards['b/jpen'] && m.cards['c/jpen'], 'merge unions cards');
eq(m.days.d1, { reviews: 2, correct: 3 }, 'merge takes max per day field');
eq(m.words.a.suspended, false, 'merge takes the later word state');
ok(m.localWords.x, 'merge keeps local words');
eq(m.settings, { newPerDay: 0, autoplay: false }, 'merge layers newer settings over older');

// ---- extraction parsing
eq(parseJsonArray('Here you go:\n```json\n[{"kana":"a"}]\n```'), [{ kana: 'a' }], 'parse fenced');
eq(parseJsonArray('noise [1,2] tail'), [1, 2], 'parse bracketed');
ok(parseJsonArray('nothing') === null, 'parse none');
const ce = cleanEntry({ kana: ' こんにちは ', meanings: 'hello', example: { ja: 'こんにちは。' } });
eq(ce.meanings, ['hello'], 'cleanEntry wraps a string meaning');
ok(ce.example && ce.example.ja === 'こんにちは。', 'cleanEntry keeps example');
ok(cleanEntry({ kana: '', meanings: ['x'] }) === null, 'cleanEntry rejects missing kana');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
