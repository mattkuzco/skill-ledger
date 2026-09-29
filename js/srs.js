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
// Learning steps, limits and the other study options come from presets.js.

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
function intervalFor(s, retention, maxInterval) {
  const r = clamp(retention, 0.7, 0.99);
  const days = (s / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
  return clamp(Math.round(days), 1, clamp(maxInterval || MAX_INTERVAL, 1, 36500));
}

// Card states, as in Anki: new → learning (short steps in minutes) → review (days);
// a forgotten review card goes through relearning steps and back to review.
export const LEARN_AHEAD = 20 * 60 * 1000; // learning cards due within 20 min count as due now
export const stateOf = (srs) => srs?.state || (!srs || !srs.s ? 'new' : 'review');

export function newCardSrs() {
  return { v: 'fsrs', state: 'new', s: 0, d: 0, reps: 0, lapses: 0, due: today(), last: '', interval: 0 };
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
    v: 'fsrs', state: 'review', s: interval, d: clamp(10 - (ease - 1.3) * 5, 1, 10), reps: srs.reps || 1, lapses: srs.lapses || 0,
    last: srs.last || addDays(srs.due || today(), -interval), due: srs.due || today(), interval,
  };
}

// Memory state after a review with rating G (1…4), without the interval.
function stepState(c, G, now) {
  if (!c.s) return { s: initStability(G), d: clamp(initDifficulty(G), 1, 10) };
  const t = c.last ? Math.max(0, diffDays(now, c.last)) : 0;
  const d = nextDifficulty(c.d, G);
  if (t === 0) return { s: Math.max(0.1, shortTermStability(c.s, G)), d }; // another look on the same day
  const r = retrievability(t, c.s);
  return { s: Math.max(0.1, G === 1 ? forgetStability(c.d, c.s, r) : recallStability(c.d, c.s, r, G)), d };
}

// All four outcomes at once. opts (from the card's preset): learnSteps, relearnSteps (minutes),
// retention, maxInterval, now (ms).
function outcomes(srs, opts = {}) {
  const o = { learnSteps: [1, 10], relearnSteps: [10], retention: retentionTarget(), maxInterval: MAX_INTERVAL, now: Date.now(), ...opts };
  const c = toFsrs(srs);
  const state = stateOf(c);
  const day = today();
  const st = [1, 2, 3, 4].map((G) => stepState(c, G, day));
  const ivl = (i) => intervalFor(st[i].s, o.retention, o.maxInterval);
  let hard = ivl(1); let good = ivl(2); let easy = ivl(3);
  if (state === 'review') { hard = Math.min(hard, good); good = Math.max(good, hard + 1); }
  easy = Math.max(easy, good + 1);
  const maxI = clamp(o.maxInterval || MAX_INTERVAL, 1, 36500); // the cap wins over the ordering
  hard = Math.min(hard, maxI); good = Math.min(good, maxI); easy = Math.min(easy, maxI);
  const memory = (i) => ({ v: 'fsrs', s: +st[i].s.toFixed(3), d: +st[i].d.toFixed(3), reps: c.reps + 1, lapses: c.lapses, last: day, firstDay: c.firstDay || day, revDay: c.revDay || '' });
  const toReview = (i, days, extra = {}) => ({ ...memory(i), ...extra, state: 'review', step: 0, interval: days, due: addDays(day, days), dueAt: 0 });
  const toSteps = (i, kind, step, mins, extra = {}) => ({ ...memory(i), ...extra, state: kind, step, interval: 0, due: day, dueAt: o.now + Math.round(mins * 60000) });
  // "Difficile" on a step repeats it; on the first step it waits between the first and the second
  const hardDelay = (steps, cur) => (cur === 0 ? (steps.length > 1 ? (steps[0] + steps[1]) / 2 : Math.min(steps[0] * 1.5, steps[0] + 1440)) : steps[cur]);

  if (state === 'review') {
    const seen = { revDay: day };
    const lapse = { revDay: day, lapses: c.lapses + 1 };
    const again = o.relearnSteps.length ? toSteps(0, 'relearning', 0, o.relearnSteps[0], lapse) : toReview(0, ivl(0), lapse);
    return [again, toReview(1, hard, seen), toReview(2, good, seen), toReview(3, easy, seen)];
  }
  const kind = state === 'relearning' ? 'relearning' : 'learning';
  const steps = kind === 'relearning' ? o.relearnSteps : o.learnSteps;
  if (!steps.length) return [toReview(0, ivl(0)), toReview(1, Math.min(hard, good)), toReview(2, good), toReview(3, easy)];
  const cur = state === 'new' ? 0 : Math.min(c.step || 0, steps.length - 1);
  return [
    toSteps(0, kind, 0, steps[0]),
    toSteps(1, kind, cur, hardDelay(steps, cur)),
    cur + 1 < steps.length ? toSteps(2, kind, cur + 1, steps[cur + 1]) : toReview(2, good),
    toReview(3, easy),
  ];
}

export function schedule(srs, grade, opts) { return outcomes(srs, opts)[grade]; }

// Human label for when a grade brings the card back: "10 min", "1 h", "3 g", "2 mesi"…
export function previewInterval(srs, grade, opts = {}) {
  const r = schedule(srs, grade, opts);
  if (r.dueAt) {
    const mins = Math.max(1, Math.round((r.dueAt - (opts.now || Date.now())) / 60000));
    if (mins < 60) return `${mins} min`;
    if (mins < 1440) { const h = Math.round(mins / 6) / 10; return `${String(h).replace('.', ',')} h`; }
    return `${Math.round(mins / 1440)} g`;
  }
  const d = r.interval;
  if (d < 30) return `${d} g`;
  if (d < 365) { const m = Math.round(d / 30.4); return m === 1 ? '1 mese' : `${m} mesi`; }
  const y = +(d / 365).toFixed(1); return y === 1 ? '1 anno' : `${String(y).replace('.', ',')} anni`;
}

// Details for the card editor: stability, difficulty and today's chance of remembering.
export function describe(srs) {
  const c = toFsrs(srs);
  if (!c.s) return null;
  const t = c.last ? Math.max(0, diffDays(today(), c.last)) : 0;
  return { stability: c.s, difficulty: c.d, recall: retrievability(t, c.s), due: c.due, dueAt: c.dueAt || 0, reps: c.reps, lapses: c.lapses, state: stateOf(c) };
}

// Chance of remembering the card right now (for "hardest first" ordering).
export function recallNow(srs) {
  const c = toFsrs(srs);
  if (!c.s) return 1;
  return retrievability(c.last ? Math.max(0, diffDays(today(), c.last)) : 0, c.s);
}

// Due now, ignoring daily limits (limits are applied when building the study queue).
export function isCardDue(card, now = Date.now()) {
  if (!card || card.suspended) return false;
  if (card.buriedUntil && card.buriedUntil > today()) return false;
  const st = stateOf(card.srs);
  if (st === 'new') return true;
  if (st === 'learning' || st === 'relearning') return (card.srs.dueAt || 0) <= now + LEARN_AHEAD;
  return !card.srs.due || card.srs.due <= today();
}

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
