/**
 * sync.js — share one progress file across devices through a private GitHub
 * Gist, and publish new words into the repository so the voices workflow can
 * record them.
 *
 * The learner pastes one GitHub token. For sync it needs the gist permission;
 * to publish words it also needs write access to this repository's contents.
 * The first connect finds an existing Kotoba gist on the account or creates
 * one. Every later sync pulls the remote file, merges it with local progress
 * (pure, see mergeProgress) and pushes the result when anything changed.
 *
 * Only mergeProgress and the config helpers are pure; the network calls live
 * at the bottom and never run at import time, so the module tests in Node.
 */

export const SYNC_KEY = 'kotoba.sync.v1';
export const GIST_FILE = 'kotoba-progress.json';
export const GIST_DESCRIPTION = 'Kotoba progress — Japanese vocabulary SRS (do not edit by hand)';
export const REPO = 'williamtoner/Kotoba';
export const WORDS_PATH = 'data/words.json';
const API = 'https://api.github.com';

// ---------------------------------------------------------------- config

export function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    const cfg = raw ? JSON.parse(raw) : null;
    return cfg && typeof cfg.token === 'string' ? cfg : null;
  } catch (_) { return null; }
}
export function saveSyncConfig(cfg) { try { localStorage.setItem(SYNC_KEY, JSON.stringify(cfg)); } catch (_) { /* memory only */ } }
export function clearSyncConfig() { try { localStorage.removeItem(SYNC_KEY); } catch (_) { /* ignore */ } }

// ---------------------------------------------------------------- merge

function num(x) { return Number(x) || 0; }

/**
 * Merge two progress files. Neither input is mutated.
 *  - cards: per card, the entry with more reps wins; ties go to the later review.
 *  - days: per day, the larger count of each field.
 *  - words / localWords: per id, the entry with the later updatedAt.
 *  - settings: from the side updated more recently.
 */
export function mergeProgress(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (a.updatedAt || '') >= (b.updatedAt || '') ? a : b;
  const older = newer === a ? b : a;

  const cards = {};
  const keys = new Set(Object.keys(a.cards || {}).concat(Object.keys(b.cards || {})));
  for (const k of keys) {
    const x = a.cards && a.cards[k], y = b.cards && b.cards[k];
    let pick;
    if (!x) pick = y; else if (!y) pick = x;
    else if (num(x.reps) !== num(y.reps)) pick = num(x.reps) > num(y.reps) ? x : y;
    else pick = num(x.last) >= num(y.last) ? x : y;
    cards[k] = Object.assign({}, pick);
  }

  const days = {};
  const dk = new Set(Object.keys(a.days || {}).concat(Object.keys(b.days || {})));
  for (const k of dk) {
    const x = (a.days && a.days[k]) || {}, y = (b.days && b.days[k]) || {};
    days[k] = { reviews: Math.max(num(x.reviews), num(y.reviews)), correct: Math.max(num(x.correct), num(y.correct)) };
  }

  const latest = (m1, m2) => {
    const out = {};
    const ids = new Set(Object.keys(m1 || {}).concat(Object.keys(m2 || {})));
    for (const id of ids) {
      const x = m1 && m1[id], y = m2 && m2[id];
      if (!x) out[id] = Object.assign({}, y); else if (!y) out[id] = Object.assign({}, x);
      else out[id] = Object.assign({}, num(x.updatedAt) >= num(y.updatedAt) ? x : y);
    }
    return out;
  };

  return {
    version: 1,
    createdAt: [a.createdAt, b.createdAt].filter(Boolean).sort()[0] || newer.createdAt,
    updatedAt: newer.updatedAt,
    cards, days,
    words: latest(a.words, b.words),
    localWords: latest(a.localWords, b.localWords),
    settings: Object.assign({}, older.settings || {}, newer.settings || {}),
    seedImported: !!(a.seedImported || b.seedImported),
  };
}

/** A cheap fingerprint so we only push when something changed. */
export function fingerprint(p) {
  let n = 0, sum = 0;
  for (const k in p.cards || {}) { n++; sum += num(p.cards[k].reps) * 7 + num(p.cards[k].lapses) * 3 + Math.floor(num(p.cards[k].due) / 60000) % 100000; }
  return n + ':' + sum + ':' + Object.keys(p.days || {}).length + ':' + Object.keys(p.words || {}).length + ':' + Object.keys(p.localWords || {}).length + ':' + JSON.stringify(p.settings || {});
}

// ---------------------------------------------------------------- GitHub API

export class SyncError extends Error { constructor(message, kind) { super(message); this.kind = kind; } }

async function api(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new SyncError('GitHub rejected the token. Check it was copied completely.', 'auth');
  if (res.status === 403) throw new SyncError('GitHub refused the request. The token may lack a permission, or the rate limit was hit.', 'auth');
  if (res.status === 404) throw new SyncError('Not found on GitHub. For publishing, the token needs write access to the Kotoba repository.', 'notfound');
  if (res.status === 409 || res.status === 422) throw new SyncError('GitHub reported a conflict. Try again.', 'conflict');
  if (!res.ok) throw new SyncError('GitHub returned ' + res.status + '.', 'http');
  return res.status === 204 ? null : res.json();
}

export async function findGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await api(token, '/gists?per_page=100&page=' + page);
    for (const g of list) if (g.files && g.files[GIST_FILE]) return g.id;
    if (list.length < 100) break;
  }
  return null;
}

export async function connect(token, progress) {
  let gistId = await findGist(token);
  let created = false;
  if (!gistId) {
    const g = await api(token, '/gists', { method: 'POST', body: { description: GIST_DESCRIPTION, public: false, files: { [GIST_FILE]: { content: JSON.stringify(progress) } } } });
    gistId = g.id; created = true;
  }
  return { gistId, created };
}

export async function pull(cfg) {
  const g = await api(cfg.token, '/gists/' + cfg.gistId);
  const f = g.files && g.files[GIST_FILE];
  if (!f) return { progress: null };
  let text = f.content;
  if (f.truncated) { const res = await fetch(f.raw_url); if (!res.ok) throw new SyncError('Could not download the sync file.', 'http'); text = await res.text(); }
  try { return { progress: JSON.parse(text) }; } catch (_) { throw new SyncError('The sync file on GitHub is not valid JSON.', 'data'); }
}

export async function push(cfg, progress) {
  await api(cfg.token, '/gists/' + cfg.gistId, { method: 'PATCH', body: { files: { [GIST_FILE]: { content: JSON.stringify(progress) } } } });
}

/** One full sync. Returns { progress, pushed, pulledChanges }. */
export async function syncOnce(cfg, local, validate) {
  const remote = await pull(cfg);
  let merged = local, pulledChanges = false, remoteFp = null;
  if (remote.progress) {
    const v = validate(remote.progress);
    if (v.ok) { merged = mergeProgress(local, v.progress); pulledChanges = fingerprint(merged) !== fingerprint(local); remoteFp = fingerprint(v.progress); }
  }
  let pushed = false;
  if (fingerprint(merged) !== remoteFp) { await push(cfg, merged); pushed = true; }
  return { progress: merged, pushed, pulledChanges };
}

// ---------------------------------------------------------------- publishing words to the repository

function b64encodeUtf8(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64decodeUtf8(s) { return decodeURIComponent(escape(atob(s.replace(/\n/g, '')))); }

/**
 * Append `newWords` to data/words.json in the repository (one commit). Words
 * whose id already exists are skipped. Returns the ids that were added.
 */
export async function publishWords(token, newWords) {
  const file = await api(token, '/repos/' + REPO + '/contents/' + WORDS_PATH);
  const doc = JSON.parse(b64decodeUtf8(file.content));
  const have = new Set((doc.words || []).map((w) => w.id));
  const added = [];
  for (const w of newWords) { if (have.has(w.id)) continue; const copy = Object.assign({}, w); delete copy.updatedAt; doc.words.push(copy); added.push(w.id); }
  if (!added.length) return added;
  await api(token, '/repos/' + REPO + '/contents/' + WORDS_PATH, {
    method: 'PUT',
    body: { message: 'Add ' + added.length + ' word' + (added.length === 1 ? '' : 's') + ' from the app', content: b64encodeUtf8(JSON.stringify(doc, null, 2) + '\n'), sha: file.sha },
  });
  return added;
}
