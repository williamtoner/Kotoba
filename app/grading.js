/**
 * grading.js — deciding whether a typed answer is right. Pure functions.
 *
 * Kana answers: katakana is folded to hiragana and punctuation dropped, so
 * アメリカ and あめりか both pass. Romaji is accepted too: both sides are
 * turned into a lenient romaji form where "ohayo gozaimas", "ohayou
 * gozaimasu" and おはようございます all meet.
 *
 * English answers: case, punctuation and leading articles are ignored and a
 * typo or two is tolerated on longer words.
 */

export function normKana(s) {
  s = (s || '').normalize('NFKC').toLowerCase(); let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x30A1 && c <= 0x30F6) out += String.fromCodePoint(c - 0x60);
    else if (ch === 'ー') out += ch;
    else if (/[\s\p{P}\p{S}]/u.test(ch)) continue;
    else out += ch;
  }
  return out;
}

const LEAD = /^(a|an|the|to|it's|its|it is|i'm|im|i am|i) /;
export function normEn(s) {
  s = (s || '').toLowerCase().normalize('NFKC').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let prev; do { prev = s; s = s.replace(LEAD, ''); } while (s !== prev);
  return s;
}

export function lev(a, b) {
  if (a === b) return 0; const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) { cur[0] = i; for (let j = 1; j <= n; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); } [prev, cur] = [cur, prev]; }
  return prev[n];
}

export function enMatches(typed, meanings) {
  const t = normEn(typed); if (!t) return false;
  const ts = t.replace(/ /g, '');
  for (const m of meanings || []) {
    const nm = normEn(m); if (!nm) continue;
    if (nm === t || nm.replace(/ /g, '') === ts) return true;
    const tol = Math.min(2, Math.floor(Math.max(nm.length, t.length) / 6));
    if (tol && lev(nm, t) <= tol) return true;
  }
  return false;
}

const KR = { 'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o', 'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko', 'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so', 'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to', 'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no', 'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho', 'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo', 'や': 'ya', 'ゆ': 'yu', 'よ': 'yo', 'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro', 'わ': 'wa', 'を': 'o', 'ん': 'n', 'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go', 'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo', 'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do', 'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo', 'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po', 'ゔ': 'vu', 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
  'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo', 'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho', 'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho', 'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo', 'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo', 'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo', 'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo', 'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo', 'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo', 'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo', 'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo', 'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo', 'てぃ': 'ti', 'でぃ': 'di', 'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'wo', 'しぇ': 'she', 'ちぇ': 'che', 'じぇ': 'je', 'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo' };

export function kanaToRomaji(k) {
  let out = '', i = 0, small = false;
  while (i < k.length) {
    const two = k.slice(i, i + 2), one = k[i];
    if (one === 'っ') { small = true; i++; continue; }
    if (one === 'ー') { const v = out.match(/[aeiou]$/); if (v) out += v[0]; i++; continue; }
    let r = KR[two]; let step = 2; if (!r) { r = KR[one]; step = 1; }
    if (!r) { out += one; i++; small = false; continue; }
    if (small) { out += r[0] === 'c' ? 't' : r[0]; small = false; }
    out += r; i += step;
  }
  return out;
}

export function foldRomaji(s) {
  s = (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  s = s.replace(/si/g, 'shi').replace(/ti/g, 'chi').replace(/tu/g, 'tsu').replace(/(^|[^cs])hu/g, '$1fu').replace(/zi/g, 'ji').replace(/di/g, 'ji').replace(/du/g, 'zu')
    .replace(/sy([auo])/g, 'sh$1').replace(/ty([auo])/g, 'ch$1').replace(/zy([auo])/g, 'j$1').replace(/jy([auo])/g, 'j$1').replace(/cy([auo])/g, 'ch$1')
    .replace(/wo/g, 'o').replace(/n([mbp])/g, 'm$1').replace(/ha$/, 'wa').replace(/masu/g, 'mas').replace(/desu/g, 'des')
    .replace(/ou/g, 'o').replace(/oo/g, 'o').replace(/uu/g, 'u').replace(/ee/g, 'e').replace(/ei/g, 'e').replace(/aa/g, 'a').replace(/ii/g, 'i');
  return s;
}

export function kanaForms(w) { return [w.kana].concat(w.kanaAlts || []).map(normKana).filter(Boolean); }

export function kanaMatches(typed, w) {
  const t = normKana(typed); if (!t) return false;
  const forms = kanaForms(w);
  if (forms.includes(t)) return true;
  if (/[a-z]/i.test(typed)) { const f = foldRomaji(typed); return !!f && forms.some((k) => foldRomaji(kanaToRomaji(k)) === f); }
  return false;
}

/** Another word in the deck that the learner typed and that shares a meaning with `w`, or null. */
export function synonymHit(typed, w, words) {
  const mine = new Set((w.meanings || []).map(normEn));
  for (const id in words) {
    const o = words[id];
    if (id === w.id) continue;
    if (kanaMatches(typed, o) && (o.meanings || []).some((m) => mine.has(normEn(m)))) return o;
  }
  return null;
}
