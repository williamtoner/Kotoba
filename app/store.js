/**
 * store.js — where progress lives.
 *
 *   localStorage   the live progress object, key `kotoba.progress.v1`
 *   localStorage   secrets that never sync: `kotoba.keys.v1` (Anthropic key)
 *                  and `kotoba.sync.v1` (GitHub token + gist id, see sync.js)
 *   IndexedDB      one snapshot of progress per day, last 14 days, as a safety net
 *
 * Progress shape (version 1):
 *   cards       { "<wordId>/<type>": {state, s, d, due, last, reps, lapses, firstReview} }
 *   days        { "YYYY-MM-DD": {reviews, correct} }
 *   words       { "<wordId>": {updatedAt, suspended?, deleted?, override?: {...fields}} }
 *   localWords  { "<wordId>": {...a full word, updatedAt} }   words added on this device, not yet in the repo
 *   settings    { newPerDay, autoplay, theme }
 *
 * Everything that reads or writes storage is wrapped so a blocked or full
 * store degrades to memory-only instead of breaking the app.
 */

export const STORAGE_KEY = 'kotoba.progress.v1';
export const KEYS_KEY = 'kotoba.keys.v1';
const BACKUP_DB = 'kotoba-backups';
const BACKUP_STORE = 'snapshots';
const BACKUP_DAYS = 14;

const state = { localStorageOk: true, lastError: null, saveTimer: null, pending: null };

export function defaultSettings() { return { newPerDay: 0, autoplay: true, theme: 'system' }; }

export function defaultProgress(now = new Date()) {
  const iso = now.toISOString();
  return { version: 1, createdAt: iso, updatedAt: iso, cards: {}, days: {}, words: {}, localWords: {}, settings: defaultSettings() };
}

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/** Turn untrusted JSON into a progress object, or report why it cannot be one. */
export function validateProgress(raw) {
  if (!isObj(raw)) return { ok: false, error: 'not an object' };
  if (raw.version !== 1) return { ok: false, error: 'unknown version ' + raw.version };
  const p = defaultProgress();
  p.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : p.createdAt;
  p.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : p.updatedAt;
  if (isObj(raw.cards)) for (const k in raw.cards) { const c = raw.cards[k]; if (isObj(c) && typeof c.state === 'string') p.cards[k] = Object.assign({}, c); }
  if (isObj(raw.days)) for (const k in raw.days) { const d = raw.days[k]; if (isObj(d)) p.days[k] = { reviews: Number(d.reviews) || 0, correct: Number(d.correct) || 0 }; }
  if (isObj(raw.words)) for (const k in raw.words) { const w = raw.words[k]; if (isObj(w)) p.words[k] = Object.assign({}, w); }
  if (isObj(raw.localWords)) for (const k in raw.localWords) { const w = raw.localWords[k]; if (isObj(w) && typeof w.kana === 'string') p.localWords[k] = Object.assign({}, w); }
  p.settings = normaliseSettings(raw.settings);
  if (raw.seedImported) p.seedImported = true;
  return { ok: true, progress: p };
}

export function normaliseSettings(raw) {
  const s = defaultSettings();
  if (!isObj(raw)) return s;
  if (typeof raw.newPerDay === 'number' && raw.newPerDay >= 0) s.newPerDay = Math.min(500, Math.floor(raw.newPerDay));
  if (typeof raw.autoplay === 'boolean') s.autoplay = raw.autoplay;
  if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') s.theme = raw.theme;
  return s;
}

// ---------------------------------------------------------------- localStorage

export function load() {
  let text = null;
  try { text = localStorage.getItem(STORAGE_KEY); } catch (e) { state.localStorageOk = false; state.lastError = e; }
  if (!text) return defaultProgress();
  try {
    const v = validateProgress(JSON.parse(text));
    if (v.ok) return v.progress;
  } catch (_) { /* fall through */ }
  try { localStorage.setItem(STORAGE_KEY + '.corrupt', text); } catch (_) { /* ignore */ }
  return defaultProgress();
}

export function writeNow(progress) {
  progress.updatedAt = new Date().toISOString();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); state.localStorageOk = true; }
  catch (e) { state.localStorageOk = false; state.lastError = e; }
  backupMaybe(progress);
}

/** Coalesce a burst of writes into one, shortly after the last. */
export function save(progress) {
  state.pending = progress;
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { state.saveTimer = null; if (state.pending) { writeNow(state.pending); state.pending = null; } }, 250);
}

export function flush() {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  if (state.pending) { writeNow(state.pending); state.pending = null; }
}

export function status() { return { localStorage: state.localStorageOk, lastError: state.lastError }; }

export function clearAll() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- secrets (never synced)

export function loadKeys() {
  try { const raw = localStorage.getItem(KEYS_KEY); const k = raw ? JSON.parse(raw) : null; return isObj(k) ? k : {}; } catch (_) { return {}; }
}
export function saveKeys(keys) {
  try { localStorage.setItem(KEYS_KEY, JSON.stringify(keys || {})); } catch (_) { /* memory only */ }
}

// ---------------------------------------------------------------- export / import

export function exportJSON(progress) { return JSON.stringify(progress, null, 2); }
export function exportFileName(now = new Date()) { return 'kotoba-progress-' + now.toISOString().slice(0, 10) + '.json'; }
export function downloadExport(progress, now = new Date()) {
  const blob = new Blob([exportJSON(progress)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = exportFileName(now); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function parseImport(text) {
  try { return validateProgress(JSON.parse(text)); } catch (e) { return { ok: false, error: 'not valid JSON' }; }
}

// ---------------------------------------------------------------- IndexedDB daily backups

function openBackupDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    let req;
    try { req = indexedDB.open(BACKUP_DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(BACKUP_STORE)) db.createObjectStore(BACKUP_STORE, { keyPath: 'day' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

let lastBackupDay = null;
function backupMaybe(progress) {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastBackupDay) return;
  lastBackupDay = day;
  openBackupDB().then((db) => {
    const tx = db.transaction(BACKUP_STORE, 'readwrite');
    const st = tx.objectStore(BACKUP_STORE);
    st.put({ day, savedAt: new Date().toISOString(), progress: JSON.parse(JSON.stringify(progress)) });
    const cutoff = new Date(Date.now() - BACKUP_DAYS * 86400000).toISOString().slice(0, 10);
    const cur = st.openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c) return; if (c.key < cutoff) c.delete(); c.continue(); };
    tx.oncomplete = () => db.close();
  }).catch(() => { lastBackupDay = null; });
}

export function listBackups() {
  return openBackupDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(BACKUP_STORE, 'readonly');
    const req = tx.objectStore(BACKUP_STORE).getAll();
    req.onsuccess = () => { db.close(); resolve((req.result || []).sort((a, b) => (a.day < b.day ? 1 : -1))); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}
