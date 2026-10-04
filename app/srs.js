/**
 * srs.js — the FSRS-5 scheduler, pure functions only.
 *
 * A card is one direction of one word: {state, s, d, due, last, reps,
 * lapses, firstReview}. `state` is 'new' | 'learning' | 'review' |
 * 'relearning'. Times are milliseconds since the epoch. Nothing here reads
 * the clock or the store, so it runs unchanged in Node for the tests.
 */

export const TYPES = ['jpen', 'enjp', 'audio'];
export const TYPE_LABEL = { jpen: 'Read it', enjp: 'Say it in Japanese', audio: 'Listen' };
export const LEARN_MS = 10 * 60 * 1000;   // a failed card comes back after ten minutes
export const AHEAD_MS = 20 * 60 * 1000;   // learning cards due within this are shown early when nothing else is due
export const DAY = 86400000;
export const LEECH_LAPSES = 4;

// FSRS-5 default weights.
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5, FACTOR = 19 / 81;

const retrievability = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
export const intervalDays = (s, r) => Math.max(1, Math.round(s / FACTOR * (Math.pow(r, 1 / DECAY) - 1)));
const clampD = (d) => Math.min(10, Math.max(1, d));
const d0 = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
const s0 = (g) => Math.max(0.1, W[g - 1]);
const nextD = (d, g) => { const nd = d - W[6] * (g - 3) * (10 - d) / 9; return clampD(W[7] * d0(4) + (1 - W[7]) * nd); };
const sSuccess = (d, s, r, g) => s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1) + 1);
const sFail = (d, s, r) => Math.min(W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)), s);
const sShort = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

/** Grade a card: g is 1 Again, 2 Hard, 3 Good, 4 Easy. Returns a new card. */
export function gradeCard(card, g, now, retention) {
  const c = Object.assign({ state: 'new', reps: 0, lapses: 0 }, card || {});
  if (c.state === 'new') {
    c.d = d0(g); c.s = s0(g); c.firstReview = now; c.reps = 0; c.lapses = 0;
  } else if (c.state === 'review') {
    const t = Math.max(0, (now - (c.last || now)) / DAY); const r = retrievability(t, c.s);
    c.d = nextD(c.d, g); c.s = g === 1 ? sFail(c.d, c.s, r) : sSuccess(c.d, c.s, r, g);
  } else {
    c.d = nextD(c.d, g); c.s = Math.max(0.1, sShort(c.s, g));
  }
  c.reps = (c.reps || 0) + 1; c.last = now;
  if (g === 1) {
    if (c.state === 'review') c.lapses = (c.lapses || 0) + 1;
    c.state = (c.state === 'review' || c.state === 'relearning') ? 'relearning' : 'learning';
    c.due = now + LEARN_MS;
  } else {
    c.state = 'review'; c.due = now + intervalDays(c.s, retention) * DAY;
  }
  return c;
}

export function previewInterval(card, g, now, retention) {
  return fmtDelta(gradeCard(card, g, now, retention).due - now);
}

export function fmtDelta(ms) {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000); if (m < 60) return m + ' min';
  const h = Math.round(ms / 3600000); if (h < 36) return h + ' h';
  const d = Math.round(ms / DAY); if (d < 30) return d + ' d';
  const mo = Math.round(d / 30); if (mo < 18) return mo + ' mo';
  return (d / 365).toFixed(1) + ' y';
}

export const cardKey = (wid, type) => wid + '/' + type;

/**
 * Pick the next card. `words` is the live word map (id -> word, suspended
 * ones already removed), `cards` the progress card map keyed by cardKey.
 * `newBudget` is Infinity when there is no daily cap. `recent` is a list of
 * card keys shown in the last few turns, to avoid immediate repeats.
 */
export function pickNext(words, cards, now, newBudget, recent) {
  const due = [], fresh = [], ahead = [];
  for (const id in words) {
    const w = words[id];
    for (const ty of TYPES) {
      const c = cards[cardKey(id, ty)] || { state: 'new' };
      if (c.state === 'new') fresh.push({ wid: id, type: ty, added: w.addedAt || 0, o: TYPES.indexOf(ty) });
      else if (c.due <= now) due.push({ wid: id, type: ty, due: c.due });
      else if ((c.state === 'learning' || c.state === 'relearning') && c.due <= now + AHEAD_MS) ahead.push({ wid: id, type: ty, due: c.due });
    }
  }
  const notRecent = (x) => !(recent || []).includes(cardKey(x.wid, x.type));
  due.sort((a, b) => a.due - b.due);
  let pool = due.filter(notRecent); if (!pool.length) pool = due;
  if (pool.length) return pool[0];
  if (newBudget > 0 && fresh.length) { fresh.sort((a, b) => (a.added - b.added) || (a.o - b.o)); return fresh[0]; }
  ahead.sort((a, b) => a.due - b.due);
  if (ahead.length) return ahead[0];
  return null;
}

export function counts(words, cards, now) {
  let due = 0, fresh = 0, total = 0;
  for (const id in words) {
    total++;
    for (const ty of TYPES) {
      const c = cards[cardKey(id, ty)] || { state: 'new' };
      if (c.state === 'new') fresh++; else if (c.due <= now) due++;
    }
  }
  return { due, fresh, total };
}

export function newToday(cards, startOfDay) {
  let n = 0;
  for (const k in cards) { const c = cards[k]; if (c.firstReview && c.firstReview >= startOfDay) n++; }
  return n;
}

export function isLeech(cards, wid) {
  return TYPES.some((t) => ((cards[cardKey(wid, t)] || {}).lapses || 0) >= LEECH_LAPSES);
}

/** Consecutive days with at least one review, ending today or yesterday. */
export function streak(days, startOfToday, dayKey) {
  let n = 0, t = startOfToday;
  if (!((days[dayKey(t)] || {}).reviews)) t -= DAY;
  while (((days[dayKey(t)] || {}).reviews || 0) > 0) { n++; t -= DAY; }
  return n;
}
