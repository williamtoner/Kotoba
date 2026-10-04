/**
 * app.js — the UI. Four tabs: Review, Add, Words, Settings.
 *
 * Words come from three places and are merged into one map on every change:
 *   data/words.json          the deck committed to the repository
 *   progress.localWords      words added on this device, not yet in the repo
 *   progress.words[id]       per-word user state: suspended, deleted, edits
 * Review state is progress.cards keyed "<id>/<type>" (see srs.js).
 */
import * as S from './srs.js';
import * as G from './grading.js';
import * as store from './store.js';
import * as sync from './sync.js';
import * as X from './extract.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPES = S.TYPES, TYPE_LABEL = S.TYPE_LABEL;

// ---------------------------------------------------------------- state
let progress = store.load();
let keys = store.loadKeys();
let syncCfg = sync.loadSyncConfig();
let repoWords = [];          // from data/words.json
let words = {};              // merged id -> word (suspended ones included, flagged)
let wordsNote = '';
let tab = 'review';
let current = null, phase = 'ask', verdict = null;
let recent = [];
let session = { answered: 0, correct: 0, missed: {} };
let practice = [];
let extracted = null, pickedFiles = [], extractBusy = null, extractStatus = '';
let wordsFilter = '', openWord = null, group = { kind: 'all' };
let voice = null, voiceChecked = false, audioEl = null, lastUtter = null;
let syncState = { busy: false, last: null, error: null };
let syncTimer = null;
let publishState = { busy: false, msg: '' };

function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); }
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function weekStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getTime(); }
function fmtWeek(ts) { return 'w/c ' + new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
function newId() { return 'w-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function saveProgress() { store.save(progress); scheduleSync(); }

// ---------------------------------------------------------------- words
function rebuildWords() {
  const map = {};
  for (const w of repoWords) map[w.id] = Object.assign({}, w, { suspended: false, local: false });
  for (const id in progress.localWords) if (!map[id]) map[id] = Object.assign({}, progress.localWords[id], { id, suspended: false, local: true });
  for (const id in progress.words) {
    const u = progress.words[id]; if (!map[id]) continue;
    if (u.deleted) { delete map[id]; continue; }
    if (u.override) Object.assign(map[id], u.override);
    map[id].suspended = !!u.suspended;
  }
  words = map;
}
function activeWords() { const out = {}; for (const id in words) if (!words[id].suspended) out[id] = words[id]; return out; }
function userState(id) { if (!progress.words[id]) progress.words[id] = { updatedAt: 0 }; progress.words[id].updatedAt = Date.now(); return progress.words[id]; }
function cardOf(id, type) { return progress.cards[S.cardKey(id, type)] || { state: 'new' }; }

async function loadRepoWords() {
  try {
    const res = await fetch('../data/words.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = await res.json();
    repoWords = Array.isArray(doc.words) ? doc.words : [];
    try { localStorage.setItem('kotoba.words.cache', JSON.stringify(repoWords)); } catch (_) { /* ignore */ }
    // Local words that have reached the repository are no longer local.
    let dropped = false;
    for (const w of repoWords) if (progress.localWords[w.id]) { delete progress.localWords[w.id]; dropped = true; }
    if (dropped) saveProgress();
    wordsNote = '';
  } catch (e) {
    try { repoWords = JSON.parse(localStorage.getItem('kotoba.words.cache') || '[]'); } catch (_) { repoWords = []; }
    wordsNote = repoWords.length ? 'Offline: using the last downloaded word list.' : 'Could not load the word list. Check the connection and reload.';
  }
  rebuildWords();
}

async function importSeedIfNeeded() {
  if (progress.seedImported) return;
  if (Object.keys(progress.cards).length) { progress.seedImported = true; saveProgress(); return; }
  try {
    const res = await fetch('../data/seed-progress.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const v = store.validateProgress(await res.json());
    if (!v.ok) return;
    progress = sync.mergeProgress(progress, v.progress);
    progress.seedImported = true;
    store.writeNow(progress);
    toast('Imported your earlier review progress');
  } catch (_) { /* nothing to import */ }
}

// ---------------------------------------------------------------- tabs & theme
function applyTheme() {
  const t = progress.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
}
function setTab(t) {
  tab = t;
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false');
  for (const name of ['review', 'add', 'words', 'settings']) $('#view-' + name).hidden = name !== t;
  try { history.replaceState(null, '', '#' + t); } catch (_) { /* ignore */ }
  if (t === 'settings' && syncCfg) runSync();
  render();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });

// ---------------------------------------------------------------- speech & audio
function pickVoice() {
  try {
    const vs = speechSynthesis.getVoices(); if (!vs.length) return;
    voiceChecked = true;
    const ja = vs.filter((v) => /^ja/i.test(v.lang));
    voice = ja.find((v) => /kyoko|o-?ren|hattori|nanami|google/i.test(v.name)) || ja[0] || null;
  } catch (_) { voiceChecked = true; }
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.addEventListener('voiceschanged', () => { pickVoice(); if (tab === 'review') render(); }); }
function speak(text) {
  if (!('speechSynthesis' in window)) { toast('This browser cannot speak, and there is no recording for this yet.'); return false; }
  try {
    const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; if (voice) u.voice = voice; u.rate = 0.85; lastUtter = u;
    u.onerror = (e) => { const c = e && e.error; if (c && c !== 'interrupted' && c !== 'canceled') toast('Device voice failed: ' + c); };
    if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(() => speechSynthesis.speak(u), 150); } else speechSynthesis.speak(u);
    return true;
  } catch (_) { return false; }
}
function playClip(url, fallbackText) {
  if (url) {
    try {
      if (!audioEl) { audioEl = new Audio(); audioEl.preload = 'auto'; }
      audioEl.onerror = () => speak(fallbackText);
      audioEl.pause(); audioEl.src = url; audioEl.currentTime = 0;
      const p = audioEl.play();
      if (p && p.catch) p.catch((e) => { if (e && e.name === 'NotAllowedError') return; speak(fallbackText); });
      return true;
    } catch (_) { /* fall through */ }
  }
  return speak(fallbackText);
}
const speakWord = (w) => playClip(w.audio, w.kanji || w.kana);
const speakExample = (w) => w.example && playClip(w.exampleAudio, w.example.jaKanji || w.example.ja);
function voiceStatus() {
  if (!('speechSynthesis' in window)) return 'This browser has no built-in speech.';
  if (!voiceChecked) return 'Device voices have not loaded yet.';
  return voice ? 'Device voice: ' + voice.name : 'No Japanese voice on this device.';
}

// ---------------------------------------------------------------- review
function render() {
  if (tab === 'review') renderReview(); else if (tab === 'add') renderAdd(); else if (tab === 'words') renderWords(); else renderSettings();
}
function jpDisplay(w) { return w.kanji ? '<ruby class="jp">' + esc(w.kanji) + '<rt>' + esc(w.kana) + '</rt></ruby>' : '<span class="jp">' + esc(w.kana) + '</span>'; }

function nextCard() {
  if (practice.length) return Object.assign({ practice: true }, practice.shift());
  const cap = progress.settings.newPerDay | 0;
  const budget = cap > 0 ? Math.max(0, cap - S.newToday(progress.cards, startOfToday())) : Infinity;
  return S.pickNext(activeWords(), progress.cards, Date.now(), budget, recent);
}

function renderReview() {
  const v = $('#view-review'); const now = Date.now();
  const k = S.counts(activeWords(), progress.cards, now); const cap = progress.settings.newPerDay | 0;
  const st = S.streak(progress.days, startOfToday(), dayKey);
  let html = '<div class="stats"><span><b>' + k.due + '</b>due</span><span><b>' + (cap > 0 ? Math.max(0, cap - S.newToday(progress.cards, startOfToday())) : k.fresh) + '</b>' + (cap > 0 ? 'new left today' : 'new') + '</span><span><b>' + k.total + '</b>words</span><span><b>' + st + '</b>day streak</span></div>';
  if (wordsNote) html += '<div class="notice">' + esc(wordsNote) + '</div>';
  if (!store.status().localStorage) html += '<div class="notice">This browser is not saving progress (storage blocked). Reviews will be lost when you close the tab.</div>';
  if (!current) { current = nextCard(); phase = 'ask'; verdict = null; }
  if (!current) {
    if (session.answered) {
      const missed = Object.keys(session.missed).filter((id) => words[id]);
      html += '<div class="card summary"><div class="kind"><span class="tag">Session done</span><span>' + (st > 1 ? st + ' days in a row' : '') + '</span></div><div class="nums"><div><b>' + session.answered + '</b><span>answered</span></div><div><b>' + Math.round(100 * session.correct / session.answered) + '%</b><span>correct</span></div><div><b>' + missed.length + '</b><span>words to revisit</span></div></div>';
      if (missed.length) html += '<ul class="missed">' + missed.map((id) => '<li><span class="jp">' + esc(words[id].kana) + '</span><span class="m">' + esc((words[id].meanings || []).join(' / ')) + '</span></li>').join('') + '</ul><div class="row"><button class="btn primary" id="drill">Drill these again</button><span class="help" style="margin:0;font-size:13px">Extra practice. It does not change the schedule.</span></div>';
      html += '</div>';
    }
    html += k.total ? '<div class="card empty"><div class="jp">お疲れさま</div>Nothing due right now.<br>' + (k.fresh ? k.fresh + ' new cards are waiting for tomorrow\'s allowance (change the cap in Settings).' : 'Add a page to learn more.') + '</div>'
      : '<div class="card empty"><div class="jp">ようこそ</div>No words yet. Open <b>Add</b> and photograph a page.</div>';
    v.innerHTML = html;
    const d = $('#drill'); if (d) d.onclick = () => { const missed = Object.keys(session.missed).filter((id) => words[id]); practice = []; for (const id of missed) for (const t of TYPES) practice.push({ wid: id, type: t }); session = { answered: 0, correct: 0, missed: {} }; current = null; render(); };
    return;
  }
  const w = words[current.wid]; const type = current.type; const card = cardOf(w.id, type);
  html += '<div class="card"><div class="kind"><span class="tag">' + TYPE_LABEL[type] + '</span><span>' + (current.practice ? '<span class="practice">practice</span>' : card.state === 'new' ? 'new' : card.state === 'review' ? 'review' : 'learning') + '</span></div><div class="prompt">';
  if (type === 'jpen') html += '<div class="big">' + jpDisplay(w) + '</div>';
  else if (type === 'enjp') html += '<div class="big en">' + esc((w.meanings || []).join(' / ')) + '</div>' + (w.hint ? '<div class="sub">' + esc(w.hint) + '</div>' : '');
  else {
    html += '<button class="playbtn" id="play" aria-label="Play audio">&#9654;</button>';
    if (!w.audio && voiceChecked && !voice) html += '<div class="novoice">No recording yet and no Japanese voice on this device, so here is the kana.</div><div class="big jp">' + esc(w.kana) + '</div>';
    else html += '<div class="sub">tap to hear it' + (w.audio ? '' : ' (device voice)') + '</div>';
  }
  html += '</div>';
  if (phase === 'ask') {
    const jp = type === 'enjp';
    html += '<form class="answer" id="ansform"><input id="ans" ' + (jp ? 'class="jp" lang="ja"' : 'lang="en"') + ' placeholder="' + (jp ? 'かな or romaji' : 'type the English') + '" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"><button class="btn primary" type="submit">Check</button></form>';
  } else {
    html += '<div class="verdict ' + (verdict.ok ? 'ok' : 'no') + '"><span class="lead">' + (verdict.ok ? 'Correct' : 'Not quite') + '</span>' + (verdict.note ? '<span>' + esc(verdict.note) + '</span>' : '') + '<span class="typed">you typed: ' + (esc(verdict.typed) || '(nothing)') + '</span></div>';
    html += '<dl class="reveal"><dt>Japanese</dt><dd class="jpbig">' + jpDisplay(w) + '</dd><dt>Romaji</dt><dd>' + esc(w.romaji) + '</dd><dt>English</dt><dd>' + esc((w.meanings || []).join(' / ')) + (w.hint ? ' <span style="color:var(--muted)">(' + esc(w.hint) + ')</span>' : '') + '</dd>' + (w.note ? '<dt>Note</dt><dd>' + esc(w.note) + '</dd>' : '') + '</dl>';
    if (w.example && w.example.ja) html += '<div class="example"><div class="ja jp">' + esc(w.example.ja) + '</div><div class="ro">' + esc(w.example.romaji || '') + '</div><div class="en">' + esc(w.example.en || '') + '</div><button class="btn small exbtn" id="explay">&#9654; sentence</button></div>';
    const R = 0.9; const pv = (g) => current.practice ? '' : S.previewInterval(card, g, now, R);
    html += '<div class="grades">';
    if (current.practice) html += '<button class="btn primary" data-g="3" id="defgrade">Next</button>';
    else if (verdict.ok) html += '<button class="btn" data-g="2">Hard<small>' + pv(2) + '</small></button><button class="btn primary" data-g="3" id="defgrade">Good<small>' + pv(3) + '</small></button><button class="btn" data-g="4">Easy<small>' + pv(4) + '</small></button>';
    else html += '<button class="btn primary" data-g="1" id="defgrade">Again<small>' + pv(1) + '</small></button><button class="btn" data-g="3">I was right<small>' + pv(3) + '</small></button>';
    html += '</div><div class="row"><button class="btn quiet" id="speakagain">&#9654; hear it</button><span style="flex:1"></span><kbd>Enter = ' + (current.practice ? 'Next' : verdict.ok ? 'Good' : 'Again') + '</kbd></div>';
  }
  html += '</div>';
  v.innerHTML = html;
  const play = $('#play'); if (play) { play.onclick = () => speakWord(w); if (progress.settings.autoplay && phase === 'ask') speakWord(w); }
  const sa = $('#speakagain'); if (sa) sa.onclick = () => speakWord(w);
  const ep = $('#explay'); if (ep) ep.onclick = () => speakExample(w);
  const f = $('#ansform'); if (f) { f.onsubmit = (e) => { e.preventDefault(); checkAnswer($('#ans').value); }; setTimeout(() => { try { $('#ans').focus(); } catch (_) { /* ignore */ } }, 30); }
  for (const b of v.querySelectorAll('[data-g]')) b.onclick = () => applyGrade(+b.dataset.g);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && tab === 'review' && phase === 'reveal') { const b = $('#defgrade'); if (b) { e.preventDefault(); b.click(); } } });

function checkAnswer(typed) {
  const w = words[current.wid]; const type = current.type; let ok = false, note = '';
  if (type === 'enjp') {
    ok = G.kanaMatches(typed, w);
    if (!ok) { const syn = G.synonymHit(typed, w, activeWords()); if (syn) { ok = true; note = syn.kana + ' also means this. The card wanted ' + w.kana + '.'; } }
  } else ok = G.enMatches(typed, w.meanings);
  verdict = { ok, typed, note }; phase = 'reveal';
  if (type !== 'audio' && progress.settings.autoplay) speakWord(w);
  render();
}
function applyGrade(g) {
  const w = words[current.wid]; const type = current.type; const now = Date.now();
  recent.push(S.cardKey(w.id, type)); if (recent.length > 4) recent.shift();
  if (current.practice) { current = null; phase = 'ask'; verdict = null; render(); return; }
  progress.cards[S.cardKey(w.id, type)] = S.gradeCard(cardOf(w.id, type), g, now, 0.9);
  session.answered++; if (g > 1) session.correct++; else session.missed[w.id] = true;
  const dk = dayKey(now); const d = progress.days[dk] || { reviews: 0, correct: 0 }; d.reviews++; if (g > 1) d.correct++; progress.days[dk] = d;
  saveProgress();
  current = null; phase = 'ask'; verdict = null; render();
}

// ---------------------------------------------------------------- add
const BLANK = { kana: '', kanji: '', romaji: '', kanaAlts: [], meanings: [], hint: '', note: '', source: '', example: { ja: '', jaKanji: '', romaji: '', en: '' } };
function pendingLocal() { return Object.keys(progress.localWords).map((id) => Object.assign({ id }, progress.localWords[id])); }

function renderAdd() {
  const v = $('#view-add'); let html = '<h2>Add from a photo</h2>';
  const pend = pendingLocal();
  if (!keys.anthropic) {
    html += '<div class="section"><p class="help" style="margin-bottom:6px">Two ways to turn a page into cards:</p><ol class="steps"><li><b>With Claude Code</b> (no API key): open <a href="https://claude.ai/code" target="_blank" rel="noopener">claude.ai/code</a> on the Kotoba repository, upload the page photos and say <i>add these pages</i>. The words and their recordings appear here after it pushes.</li><li><b>In this app</b>: paste a Claude API key from console.anthropic.com into Settings. Then the camera button appears here and a page costs a few cents to read.</li></ol></div>';
  } else {
    html += '<p class="help">Good light, page flat, straight on. Reading takes 20 to 90 seconds. Every word is available to learn as soon as you save.</p>';
    html += '<div class="pickrow"><button class="btn primary" id="snap">&#128247; Take a photo</button><button class="btn" id="pick">Choose from library</button></div><input id="cam" type="file" accept="image/*" capture="environment" hidden><input id="file" type="file" accept="image/*" multiple hidden>';
    if (pickedFiles.length) {
      html += '<div class="thumbs" id="thumbs"></div>';
      if (extractBusy) html += '<div class="progress"><div class="spin"></div><span>' + esc(extractStatus || 'Working') + '&hellip;</span><button class="btn quiet" id="stopx">Stop</button></div>';
      else html += '<div class="row"><button class="btn primary" id="extract">Read the vocabulary (' + pickedFiles.length + ' photo' + (pickedFiles.length > 1 ? 's' : '') + ')</button><button class="btn quiet" id="clearx">Clear</button></div>';
    }
  }
  if (extracted) {
    const n = extracted.filter((r) => r.pick).length;
    html += '<h2>Check what was found</h2><p class="help">Fix anything Claude misread, untick what you do not want, then save. Words already in your deck are unticked. Tap a word to edit it.</p><ul class="wl" id="exlist">';
    extracted.forEach((r, i) => {
      html += '<li><div class="head" data-i="' + i + '"><input type="checkbox" data-pick="' + i + '" ' + (r.pick ? 'checked' : '') + ' aria-label="include"><div class="grow"><span class="kana">' + esc(r.kana) + (r.kanji ? ' <span class="meta">' + esc(r.kanji) + '</span>' : '') + '</span><span class="meta">' + esc(r.romaji) + '</span><span class="meaning">' + esc((r.meanings || []).join(' / ')) + (r.hint ? ' <span class="meta">(' + esc(r.hint) + ')</span>' : '') + '</span></div>' + (r.dup ? '<span class="dup">in deck</span>' : '') + '</div>';
      if (r.open) html += editForm(r, 'x' + i);
      html += '</li>';
    });
    html += '</ul><div class="row"><button class="btn primary" id="saveall" ' + (n ? '' : 'disabled') + '>Save ' + n + ' word' + (n === 1 ? '' : 's') + '</button><button class="btn quiet" id="discard">Discard</button></div>';
  }
  if (pend.length) {
    html += '<div class="notice info" style="margin-top:16px">' + pend.length + ' word' + (pend.length === 1 ? '' : 's') + ' added here ' + (pend.length === 1 ? 'is' : 'are') + ' not in the repository yet, so ' + (pend.length === 1 ? 'it has' : 'they have') + ' no recording. ' + (syncCfg && syncCfg.token ? '<button class="btn small" id="publish" ' + (publishState.busy ? 'disabled' : '') + '>' + (publishState.busy ? 'Publishing' : 'Publish to GitHub') + '</button>' : 'Add a GitHub token in Settings to publish them.') + (publishState.msg ? ' ' + esc(publishState.msg) : '') + '</div>';
  }
  html += '<h2>Add by hand</h2>' + editForm(BLANK, 'manual') + '<div class="acts"><button class="btn primary" id="manualsave">Add word</button></div>';
  v.innerHTML = html;

  const addFiles = (list) => { pickedFiles = pickedFiles.concat(Array.from(list || [])).slice(0, 6); renderAdd(); };
  const cam = $('#cam'), fi = $('#file');
  if (cam) { $('#snap').onclick = () => cam.click(); cam.onchange = () => addFiles(cam.files); }
  if (fi) { $('#pick').onclick = () => fi.click(); fi.onchange = () => addFiles(fi.files); }
  const th = $('#thumbs'); if (th) for (const f of pickedFiles) { const img = document.createElement('img'); img.alt = ''; const u = URL.createObjectURL(f); img.src = u; img.onload = () => URL.revokeObjectURL(u); th.appendChild(img); }
  const ex = $('#extract'); if (ex) ex.onclick = runExtract;
  const cl = $('#clearx'); if (cl) cl.onclick = () => { pickedFiles = []; renderAdd(); };
  const st = $('#stopx'); if (st) st.onclick = () => { if (extractBusy) extractBusy.abort(); };
  const list = $('#exlist');
  if (list) {
    list.addEventListener('change', (e) => { const p = e.target.dataset.pick; if (p !== undefined) { extracted[+p].pick = e.target.checked; const n = extracted.filter((r) => r.pick).length; const b = $('#saveall'); b.disabled = !n; b.textContent = 'Save ' + n + ' word' + (n === 1 ? '' : 's'); } });
    list.addEventListener('click', (e) => { if (e.target.type === 'checkbox') return; const h = e.target.closest('.head'); if (h) { const i = +h.dataset.i; extracted[i].open = !extracted[i].open; renderAdd(); } });
    for (const b of list.querySelectorAll('[data-apply]')) b.onclick = () => { const i = +b.dataset.apply.slice(1); Object.assign(extracted[i], readForm(b.dataset.apply)); extracted[i].open = false; extracted[i].dup = isDup(extracted[i]); renderAdd(); };
  }
  const sa = $('#saveall'); if (sa) sa.onclick = () => { const rows = extracted.filter((r) => r.pick); if (!rows.length) return; saveWords(rows); extracted = null; pickedFiles = []; renderAdd(); };
  const di = $('#discard'); if (di) di.onclick = () => { extracted = null; renderAdd(); };
  const ms = $('#manualsave'); if (ms) ms.onclick = () => { const r = readForm('manual'); if (!r.kana || !r.meanings.length) { toast('Kana and at least one meaning are needed.'); return; } saveWords([r]); renderAdd(); };
  const pb = $('#publish'); if (pb) pb.onclick = publishPending;
}
function editForm(r, id) {
  const ex = r.example || {};
  return '<div class="edit" id="form-' + id + '">'
    + '<label>Kana<input class="jp" lang="ja" data-f="kana" value="' + esc(r.kana) + '"></label>'
    + '<label>Kanji (optional)<input class="jp" lang="ja" data-f="kanji" value="' + esc(r.kanji) + '"></label>'
    + '<label>Romaji<input data-f="romaji" value="' + esc(r.romaji) + '"></label>'
    + '<label>Other accepted kana (comma separated)<input class="jp" lang="ja" data-f="kanaAlts" value="' + esc((r.kanaAlts || []).join(', ')) + '"></label>'
    + '<label class="full">English meanings (separate with ;)<input data-f="meanings" value="' + esc((r.meanings || []).join('; ')) + '"></label>'
    + '<label>Hint<input data-f="hint" value="' + esc(r.hint) + '"></label>'
    + '<label>Page<input data-f="source" value="' + esc(r.source) + '"></label>'
    + '<label class="full">Note<textarea data-f="note" rows="1">' + esc(r.note) + '</textarea></label>'
    + '<div class="sect">Example sentence</div>'
    + '<label class="full">Japanese (kana, spaces between words)<input class="jp" lang="ja" data-f="exja" value="' + esc(ex.ja) + '"></label>'
    + '<label class="full">Japanese with kanji (used for the recording)<input class="jp" lang="ja" data-f="exjk" value="' + esc(ex.jaKanji) + '"></label>'
    + '<label>Romaji<input data-f="exro" value="' + esc(ex.romaji) + '"></label>'
    + '<label>English<input data-f="exen" value="' + esc(ex.en) + '"></label>'
    + (id.startsWith('x') ? '<div class="acts" style="grid-column:1/-1"><button class="btn" data-apply="' + id + '">Apply</button></div>' : '')
    + '</div>';
}
function readForm(id) {
  const f = document.getElementById('form-' + id); const g = (k) => (f.querySelector('[data-f="' + k + '"]').value || '').trim();
  const ex = { ja: g('exja'), jaKanji: g('exjk'), romaji: g('exro'), en: g('exen') };
  return { kana: g('kana'), kanji: g('kanji'), romaji: g('romaji'), kanaAlts: g('kanaAlts').split(/[,、]/).map((s) => s.trim()).filter(Boolean), meanings: g('meanings').split(/[;；]/).map((s) => s.trim()).filter(Boolean), hint: g('hint'), note: g('note'), source: g('source'), example: ex.ja ? ex : null };
}
function isDup(r) { const k = G.normKana(r.kana); return !!k && Object.keys(words).some((id) => G.kanaForms(words[id]).includes(k)); }

async function runExtract() {
  if (!keys.anthropic || !pickedFiles.length) return;
  extractBusy = new AbortController(); extractStatus = 'Preparing photos'; renderAdd();
  try {
    const rows = await X.extractFromPhotos(keys.anthropic, pickedFiles, { signal: extractBusy.signal, onStatus: (s) => { extractStatus = s; const el = document.querySelector('.progress span'); if (el) el.innerHTML = esc(s) + '&hellip;'; } });
    const seen = new Set(); const out = [];
    for (const r of rows) {
      const row = X.cleanEntry(r); if (!row) continue;
      const k = G.normKana(row.kana); if (seen.has(k)) continue; seen.add(k);
      row.dup = isDup(row); row.pick = !row.dup; row.open = false; out.push(row);
    }
    extracted = out; if (!out.length) toast('Nothing usable was found on those photos.');
  } catch (e) {
    if (!(e && e.kind === 'cancelled')) toast(e && e.message ? e.message : 'Reading failed.');
  }
  extractBusy = null; renderAdd();
}
function saveWords(rows) {
  const now = Date.now(); let n = 0;
  for (const r of rows) {
    const id = newId();
    const doc = { id, kana: r.kana, kanji: r.kanji || '', romaji: r.romaji || '', kanaAlts: r.kanaAlts || [], meanings: r.meanings || [], hint: r.hint || '', note: r.note || '', source: r.source || '', addedAt: now + n, example: r.example && r.example.ja ? r.example : null, audio: null, exampleAudio: null, updatedAt: now + n };
    progress.localWords[id] = doc; n++;
  }
  rebuildWords(); saveProgress();
  toast('Saved ' + n + ' word' + (n === 1 ? '' : 's') + '.');
  if (syncCfg && syncCfg.token) publishPending();
}
async function publishPending() {
  const pend = pendingLocal(); if (!pend.length || !syncCfg || !syncCfg.token || publishState.busy) return;
  publishState = { busy: true, msg: '' }; if (tab === 'add') renderAdd();
  try {
    const added = await sync.publishWords(syncCfg.token, pend);
    publishState = { busy: false, msg: added.length ? 'Published. Recordings arrive within about ten minutes.' : 'Already published.' };
  } catch (e) { publishState = { busy: false, msg: 'Publishing failed: ' + (e && e.message ? e.message : 'unknown error') }; }
  if (tab === 'add') renderAdd();
}

// ---------------------------------------------------------------- words
function renderWords() {
  const v = $('#view-words'); const now = Date.now();
  const all = Object.keys(words).map((id) => words[id]);
  const pages = [...new Set(all.map((w) => w.source).filter(Boolean))].sort((a, b) => (+a || 0) - (+b || 0) || String(a).localeCompare(String(b)));
  const weeks = [...new Set(all.map((w) => weekStart(w.addedAt || 0)))].sort((a, b) => b - a);
  const leeches = all.filter((w) => S.isLeech(progress.cards, w.id)).length;
  let html = '<h2>Words</h2><input class="search" id="q" placeholder="search kana, romaji or English" value="' + esc(wordsFilter) + '">';
  html += '<div class="filters" id="filters"><button data-k="all" aria-pressed="' + (group.kind === 'all') + '">All</button>';
  if (leeches) html += '<button class="leech" data-k="leech" aria-pressed="' + (group.kind === 'leech') + '">Tricky (' + leeches + ')</button>';
  for (const p of pages) html += '<button data-k="page" data-v="' + esc(p) + '" aria-pressed="' + (group.kind === 'page' && group.value === p) + '">p.' + esc(p) + '</button>';
  for (const wk of weeks) html += '<button data-k="week" data-v="' + wk + '" aria-pressed="' + (group.kind === 'week' && group.value === wk) + '">' + fmtWeek(wk) + '</button>';
  html += '</div>';
  const q = wordsFilter.trim().toLowerCase(); const nq = G.normKana(q);
  const list = all.filter((w) => {
    if (group.kind === 'leech' && !S.isLeech(progress.cards, w.id)) return false;
    if (group.kind === 'page' && w.source !== group.value) return false;
    if (group.kind === 'week' && weekStart(w.addedAt || 0) !== group.value) return false;
    return !q || w.kana.includes(q) || G.normKana(w.kana).includes(nq) || (w.romaji || '').toLowerCase().includes(q) || (w.meanings || []).some((m) => m.toLowerCase().includes(q)) || (w.kanji || '').includes(q);
  }).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  html += '<p class="help" style="margin-top:8px">' + list.length + ' of ' + all.length + '. Squares show the three cards: grey new, amber learning, green review, outlined when due.' + (group.kind === 'leech' ? ' Tricky words have been forgotten four or more times. Rewrite the hint or note, or pause the word.' : '') + '</p><ul class="wl" id="wlist">';
  for (const w of list) {
    html += '<li class="' + (w.suspended ? 'suspended' : '') + '"><div class="head" data-id="' + esc(w.id) + '"><div class="grow"><span class="kana">' + esc(w.kana) + (w.kanji ? ' <span class="meta">' + esc(w.kanji) + '</span>' : '') + '</span><span class="meta">' + esc(w.romaji) + (w.audio ? ' ♪' : '') + '</span><span class="meaning">' + esc((w.meanings || []).join(' / ')) + (w.hint ? ' <span class="meta">(' + esc(w.hint) + ')</span>' : '') + '</span></div>' + (w.suspended ? '<span class="dup">paused</span>' : w.local ? '<span class="local">not published</span>' : S.isLeech(progress.cards, w.id) ? '<span class="flag">tricky</span>' : '') + '<div class="chips">' + TYPES.map((t) => { const c = cardOf(w.id, t); return '<span class="chip ' + c.state + ' ' + (c.state !== 'new' && c.due <= now ? 'due' : '') + '" title="' + TYPE_LABEL[t] + '"></span>'; }).join('') + '</div></div>';
    if (openWord === w.id) {
      html += editForm(w, 'w') + '<div class="cardstates">' + TYPES.map((t) => { const c = cardOf(w.id, t); return '<span><b>' + TYPE_LABEL[t] + '</b>: ' + (c.state === 'new' ? 'new' : c.state + ', due ' + S.fmtDelta(c.due - now) + (c.lapses ? ', forgotten ' + c.lapses + '×' : '')) + '</span>'; }).join('') + '</div>';
      html += '<div class="acts"><button class="btn primary" id="wsave">Save</button><button class="btn quiet" id="wspeak">&#9654; hear</button>' + (w.example && w.example.ja ? '<button class="btn quiet" id="wspeakex">&#9654; sentence</button>' : '') + '<button class="btn quiet" id="wsusp">' + (w.suspended ? 'Resume' : 'Pause word') + '</button><button class="btn quiet" id="wreset">Reset progress</button><span class="sp"></span><button class="btn danger" id="wdel">Delete</button></div>';
    }
    html += '</li>';
  }
  html += '</ul>';
  v.innerHTML = html;
  const qi = $('#q'); qi.oninput = () => { wordsFilter = qi.value; const pos = qi.selectionStart; renderWords(); const q2 = $('#q'); q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (_) { /* ignore */ } };
  $('#filters').addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; const k = b.dataset.k; group = k === 'all' ? { kind: 'all' } : k === 'leech' ? { kind: 'leech' } : k === 'page' ? { kind: 'page', value: b.dataset.v } : { kind: 'week', value: +b.dataset.v }; renderWords(); });
  $('#wlist').addEventListener('click', (e) => { const h = e.target.closest('.head'); if (h) { openWord = openWord === h.dataset.id ? null : h.dataset.id; renderWords(); } });
  const ws = $('#wsave'); if (ws) ws.onclick = () => {
    const r = readForm('w'); if (!r.kana || !r.meanings.length) { toast('Kana and at least one meaning are needed.'); return; }
    const w = words[openWord]; const patch = { kana: r.kana, kanji: r.kanji, romaji: r.romaji, kanaAlts: r.kanaAlts, meanings: r.meanings, hint: r.hint, note: r.note, source: r.source };
    if (r.example) patch.example = Object.assign({}, w.example || {}, r.example);
    if (w.local) Object.assign(progress.localWords[w.id], patch, { updatedAt: Date.now() });
    else { const u = userState(w.id); u.override = Object.assign({}, u.override || {}, patch); }
    rebuildWords(); saveProgress(); toast('Saved'); renderWords();
  };
  const wp = $('#wspeak'); if (wp) wp.onclick = () => speakWord(words[openWord]);
  const wpe = $('#wspeakex'); if (wpe) wpe.onclick = () => speakExample(words[openWord]);
  const wsu = $('#wsusp'); if (wsu) wsu.onclick = () => { const u = userState(openWord); u.suspended = !u.suspended; rebuildWords(); saveProgress(); current = null; renderWords(); };
  const wr = $('#wreset'); if (wr) wr.onclick = () => { if (wr.dataset.arm !== '1') { wr.dataset.arm = '1'; wr.textContent = 'Tap again to reset'; return; } for (const t of TYPES) delete progress.cards[S.cardKey(openWord, t)]; saveProgress(); current = null; toast('Progress reset'); renderWords(); };
  const wd = $('#wdel'); if (wd) wd.onclick = () => { if (wd.dataset.arm !== '1') { wd.dataset.arm = '1'; wd.textContent = 'Tap again to delete'; return; } const id = openWord; if (words[id].local) delete progress.localWords[id]; else userState(id).deleted = true; for (const t of TYPES) delete progress.cards[S.cardKey(id, t)]; openWord = null; if (current && current.wid === id) current = null; rebuildWords(); saveProgress(); renderWords(); };
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const v = $('#view-settings'); const s = progress.settings;
  let html = '<div class="section"><h2>Review</h2><div class="settings"><label>New cards per day <input type="number" id="npd" min="0" max="500" value="' + s.newPerDay + '"></label><span class="help" style="font-size:13px;color:var(--muted)">0 means no cap: every word on a page is learned the day you add it.</span></div><div class="settings"><label><input type="checkbox" id="autoplay" ' + (s.autoplay ? 'checked' : '') + '> Play audio automatically</label><label>Theme <select id="theme"><option value="system"' + (s.theme === 'system' ? ' selected' : '') + '>System</option><option value="light"' + (s.theme === 'light' ? ' selected' : '') + '>Light</option><option value="dark"' + (s.theme === 'dark' ? ' selected' : '') + '>Dark</option></select></label></div></div>';

  html += '<div class="section"><h2>Sync between devices</h2><p class="help">Keeps your progress in a private Gist on your GitHub account, so the phone and the laptop share one file. The same token lets the app publish words you add, so they get recordings.</p>';
  if (syncCfg && syncCfg.token) {
    html += '<div class="status">Connected' + (syncCfg.gistId ? '' : ' (no gist yet)') + (syncState.busy ? '. Syncing…' : syncState.error ? '. Last sync failed: ' + esc(syncState.error) : syncState.last ? '. Last synced ' + new Date(syncState.last).toLocaleTimeString() : '') + '</div><div class="row"><button class="btn" id="syncnow" ' + (syncState.busy ? 'disabled' : '') + '>Sync now</button><button class="btn quiet" id="syncoff">Disconnect</button></div>';
  } else {
    html += '<ol class="steps"><li>On GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate.</li><li>Account permissions: <b>Gists: read and write</b>. Repository access: only <b>Kotoba</b>, with <b>Contents: read and write</b> (for publishing words).</li><li>Paste the token here. It stays in this browser only.</li></ol><div class="field"><input id="ghtoken" type="password" placeholder="github_pat_…" autocomplete="off"><button class="btn primary" id="syncon">Connect</button></div>';
  }
  html += '</div>';

  html += '<div class="section"><h2>Claude API key</h2><p class="help">Lets the Add tab read pages itself. Create a key at console.anthropic.com, set a small monthly limit, and paste it here. It stays in this browser only and is never synced. Without a key, use Claude Code to add pages instead.</p>';
  html += keys.anthropic ? '<div class="status">Key saved (ends …' + esc(keys.anthropic.slice(-4)) + ').</div><div class="row"><button class="btn quiet" id="keyoff">Remove key</button></div>' : '<div class="field"><input id="akey" type="password" placeholder="sk-ant-…" autocomplete="off"><button class="btn primary" id="keyon">Save</button></div>';
  html += '</div>';

  const withAudio = Object.keys(words).filter((id) => words[id].audio).length;
  html += '<div class="section"><h2>Audio</h2><p class="help">' + withAudio + ' of ' + Object.keys(words).length + ' words have a recorded voice (♪). New words are recorded by the repository workflow shortly after they are published; until then the device voice reads them.</p><div class="settings"><span id="voiceinfo">' + esc(voiceStatus()) + '</span><button class="btn" id="testvoice">Test device voice</button></div></div>';

  html += '<div class="section"><h2>Your data</h2><p class="help">Progress is stored in this browser and backed up inside it daily for two weeks. Export a copy now and then.</p><div class="row"><button class="btn" id="export">Export progress</button><button class="btn quiet" id="importbtn">Import a file</button><input id="importfile" type="file" accept="application/json" hidden></div><div class="status">' + Object.keys(progress.cards).length + ' started cards, ' + Object.keys(progress.days).length + ' review days.</div></div>';

  html += '<div class="section"><h2>Install on your phone</h2><div class="iconrow"><img src="icons/icon-192.png" alt=""><ol class="steps" style="margin:0"><li>iPhone: open this page in Safari, tap Share, then "Add to Home Screen".</li><li>Android: Chrome menu, "Add to Home screen" or "Install app".</li></ol></div><p class="help" style="margin-top:10px">Source and docs: <a href="https://github.com/' + sync.REPO + '" target="_blank" rel="noopener">github.com/' + sync.REPO + '</a></p></div>';
  v.innerHTML = html;

  $('#npd').onchange = () => { progress.settings.newPerDay = Math.max(0, Math.min(500, +$('#npd').value || 0)); saveProgress(); current = null; };
  $('#autoplay').onchange = () => { progress.settings.autoplay = $('#autoplay').checked; saveProgress(); };
  $('#theme').onchange = () => { progress.settings.theme = $('#theme').value; applyTheme(); saveProgress(); };
  const on = $('#syncon'); if (on) on.onclick = async () => {
    const token = ($('#ghtoken').value || '').trim(); if (!token) return; on.disabled = true;
    try { store.flush(); const r = await sync.connect(token, progress); syncCfg = { token, gistId: r.gistId }; sync.saveSyncConfig(syncCfg); toast(r.created ? 'Connected. Created a new sync file.' : 'Connected to your existing sync file.'); await runSync(); }
    catch (e) { toast(e && e.message ? e.message : 'Could not connect.'); on.disabled = false; }
    renderSettings();
  };
  const off = $('#syncoff'); if (off) off.onclick = () => { sync.clearSyncConfig(); syncCfg = null; syncState = { busy: false, last: null, error: null }; renderSettings(); };
  const sn = $('#syncnow'); if (sn) sn.onclick = () => runSync();
  const kon = $('#keyon'); if (kon) kon.onclick = () => { const k = ($('#akey').value || '').trim(); if (!k) return; keys.anthropic = k; store.saveKeys(keys); toast('Key saved'); renderSettings(); };
  const koff = $('#keyoff'); if (koff) koff.onclick = () => { delete keys.anthropic; store.saveKeys(keys); renderSettings(); };
  $('#testvoice').onclick = () => { pickVoice(); $('#voiceinfo').textContent = voiceStatus(); speak('こんにちは'); };
  $('#export').onclick = () => { store.flush(); store.downloadExport(progress); };
  $('#importbtn').onclick = () => $('#importfile').click();
  $('#importfile').onchange = async () => {
    const f = $('#importfile').files[0]; if (!f) return;
    const v2 = store.parseImport(await f.text());
    if (!v2.ok) { toast('That file is not a Kotoba export (' + v2.error + ').'); return; }
    progress = sync.mergeProgress(progress, v2.progress); progress.seedImported = true; store.writeNow(progress); rebuildWords(); current = null; toast('Imported and merged'); renderSettings();
  };
}

// ---------------------------------------------------------------- sync driver
function scheduleSync() {
  if (!syncCfg || !syncCfg.token || !syncCfg.gistId) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; runSync(); }, 20000);
}
async function runSync() {
  if (!syncCfg || !syncCfg.token || syncState.busy) return;
  if (!syncCfg.gistId) { try { const r = await sync.connect(syncCfg.token, progress); syncCfg.gistId = r.gistId; sync.saveSyncConfig(syncCfg); } catch (e) { syncState.error = e.message; return; } }
  syncState.busy = true; syncState.error = null; if (tab === 'settings') renderSettings();
  try {
    store.flush();
    const r = await sync.syncOnce(syncCfg, progress, store.validateProgress);
    if (r.pulledChanges) { progress = r.progress; store.writeNow(progress); rebuildWords(); if (!(tab === 'review' && phase === 'ask' && current)) { current = null; } }
    syncState.last = Date.now();
  } catch (e) { syncState.error = e && e.message ? e.message : 'sync failed'; }
  syncState.busy = false;
  if (tab === 'settings') renderSettings(); else if (tab === 'review' && !current) render();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { store.flush(); if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; runSync(); } } });
window.addEventListener('pagehide', () => store.flush());

// ---------------------------------------------------------------- boot
function initialTab() { const h = (location.hash || '').replace('#', ''); return ['review', 'add', 'words', 'settings'].includes(h) ? h : 'review'; }
async function boot() {
  applyTheme();
  rebuildWords();
  setTab(initialTab());
  await loadRepoWords();
  await importSeedIfNeeded();
  rebuildWords(); current = null; render();
  if (syncCfg && syncCfg.token) runSync();
  if (pendingLocal().length && syncCfg && syncCfg.token) publishPending();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => { const nw = reg.installing; if (!nw) return; nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Kotoba was updated. Reload to get the new version.'); }); });
    }).catch(() => { /* offline support is optional */ });
  }
}
boot();
