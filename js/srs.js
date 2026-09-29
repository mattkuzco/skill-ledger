// Spaced repetition.
//
// Flashcards use FSRS-5 (Free Spaced Repetition Scheduler, the algorithm Anki uses by default).
// Each card keeps a memory state:
//   s  = stability: days until the chance of recalling it drops to 90%
//   d  = difficulty: 1 (easy) … 10 (hard)
// and the date of the last review. From these, R(t) = probability of recalling the card
// after t days. The next review is set for when R falls to the desired retention (default 90%).
// Grades: 0 = Di nuovo, 1 = Difficile, 2 = Bene, 3 = Facile  (FSRS ratings 1…4).
//
// Topics use a fixed ladder (1, 3, 7, 14, 30, 60, 120 days).

import { today, addDays, diffDays } from './util.js';
import * as store from './store.js';

export const GRADES = [
  { value: 0, label: 'Di nuovo', key: '1' },
  { value: 1, label: 'Difficile', key: '2' },
  { value: 2, label: 'Bene', key: '3' },
  { value: 3, label: 'Facile', key: '4' },
];

/* ---------- FSRS-5 ---------- */
// Default parameters of FSRS-5 (trained by the FSRS project on millions of Anki reviews).
export const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5;
const FACTOR = 19 / 81; // makes R(S) = 0.9
const MAX_INTERVAL = 3650; // 10 years
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const retentionTarget = () => clamp(+store.getMeta('retention', 0.9) || 0.9, 0.7, 0.99);
export const retrievability = (t, s) => Math.pow(1 + (FACTOR * Math.max(0, t)) / s, DECAY);
const initStability = (G) => Math.max(W[G - 1], 0.1);
const initDifficulty = (G) => W[4] - Math.exp(W[5] * (G - 1)) + 1;
function nextDifficulty(d, G) {
  const delta = -W[6] * (G - 3);
  const dp = d + (delta * (10 - d)) / 9;                 // linear damping
  return clamp(W[7] * initDifficulty(4) + (1 - W[7]) * dp, 1, 10); // mean reversion
}
function recallStability(d, s, r, G) {
  const hard = G === 2 ? W[15] : 1;
  const easy = G === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
}
function forgetStability(d, s, r) {
  const sf = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  return Math.min(sf, s / Math.exp(W[17] * W[18]));
}
const shortTermStability = (s, G) => s * Math.exp(W[17] * (G - 3 + W[18]));
function intervalFor(s) {
  const r = retentionTarget();
  const days = (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
  return clamp(Math.round(days), 1, MAX_INTERVAL);
}

export function newCardSrs() {
  return { v: 'fsrs', s: 0, d: 0, reps: 0, lapses: 0, due: today(), last: '', interval: 0 };
}

// Cards reviewed with the old SM-2 scheduler are converted on the fly:
// ease → difficulty, interval → stability.
function toFsrs(srs) {
  if (!srs) return newCardSrs();
  if (srs.v === 'fsrs') return srs;
  if (!srs.reps && !srs.interval) return { ...newCardSrs(), lapses: srs.lapses || 0, due: srs.due || today() };
  const ease = srs.ease || 2.5;
  const interval = Math.max(1, srs.interval || 1);
  return {
    v: 'fsrs', s: interval, d: clamp(10 - (ease - 1.3) * 5, 1, 10), reps: srs.reps || 1, lapses: srs.lapses || 0,
    last: srs.last || addDays(srs.due || today(), -interval), due: srs.due || today(), interval,
  };
}

// Memory state after a review with rating G (1…4), without the interval.
function stepState(c, G, now) {
  if (!c.s) return { s: initStability(G), d: clamp(initDifficulty(G), 1, 10) };
  const t = c.last ? Math.max(0, diffDays(now, c.last)) : 0;
  const d = nextDifficulty(c.d, G);
  if (t === 0) return { s: Math.max(0.1, shortTermStability(c.s, G)), d }; // second look on the same day
  const r = retrievability(t, c.s);
  return { s: Math.max(0.1, G === 1 ? forgetStability(c.d, c.s, r) : recallStability(c.d, c.s, r, G)), d };
}

// All four outcomes at once, so intervals are always Difficile ≤ Bene < Facile.
function outcomes(srs) {
  const c = toFsrs(srs);
  const now = today();
  const st = [1, 2, 3, 4].map((G) => stepState(c, G, now));
  let hard = intervalFor(st[1].s); let good = intervalFor(st[2].s); let easy = intervalFor(st[3].s);
  hard = Math.min(hard, good);
  good = Math.max(good, hard + (c.s ? 1 : 0));
  easy = Math.max(easy, good + 1);
  const ivl = [0, hard, good, easy]; // "Di nuovo": back later today
  return st.map((x, i) => ({
    v: 'fsrs', s: +x.s.toFixed(3), d: +x.d.toFixed(3),
    reps: i === 0 ? 0 : c.reps + 1, lapses: c.lapses + (i === 0 && c.s ? 1 : 0),
    last: now, interval: ivl[i], due: addDays(now, ivl[i]),
  }));
}

export function schedule(srs, grade) { return outcomes(srs)[grade]; }

// Human label for the interval a grade would produce, e.g. "3 g".
export function previewInterval(srs, grade) {
  const d = schedule(srs, grade).interval;
  if (d === 0) return 'oggi';
  if (d < 30) return `${d} g`;
  if (d < 365) { const m = Math.round(d / 30.4); return m === 1 ? '1 mese' : `${m} mesi`; }
  const y = +(d / 365).toFixed(1); return y === 1 ? '1 anno' : `${String(y).replace('.', ',')} anni`;
}

// Details for the card editor: stability, difficulty and today's chance of remembering.
export function describe(srs) {
  const c = toFsrs(srs);
  if (!c.s) return null;
  const t = c.last ? Math.max(0, diffDays(today(), c.last)) : 0;
  return { stability: c.s, difficulty: c.d, recall: retrievability(t, c.s), due: c.due, reps: c.reps, lapses: c.lapses };
}

export const isCardDue = (card) => !card.srs || !card.srs.due || card.srs.due <= today();

/* ---------- topic ladder ---------- */
export const TOPIC_LADDER = [1, 3, 7, 14, 30, 60, 120];

export function reviewTopic(topic, grade) {
  let step = topic.reviewStep || 0;
  let conf = topic.confidence || 1;
  let next;
  if (grade === 'again') { step = 0; conf = Math.max(1, conf - 1); next = addDays(today(), 1); }
  else {
    step = Math.min(step + (grade === 'easy' ? 2 : 1), TOPIC_LADDER.length - 1);
    if (grade === 'easy') conf = Math.min(5, conf + 1);
    next = addDays(today(), TOPIC_LADDER[step]);
  }
  return { reviewStep: step, confidence: conf, nextReview: next, lastReviewed: today() };
}

export const isTopicDue = (t) => t.stage !== 'queued' && t.nextReview && t.nextReview <= today();
