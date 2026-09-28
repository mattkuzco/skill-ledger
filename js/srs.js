// Spaced repetition.
//
// Flashcards use a simplified SM-2: each card keeps an ease factor, an interval in days,
// a repetition count and a due date. Grades: 0 = Di nuovo, 1 = Difficile, 2 = Bene, 3 = Facile.
//
// Topics use a fixed ladder (1, 3, 7, 14, 30, 60, 120 days), same as the Notion version.

import { today, addDays } from './util.js';

export const GRADES = [
  { value: 0, label: 'Di nuovo', key: '1' },
  { value: 1, label: 'Difficile', key: '2' },
  { value: 2, label: 'Bene', key: '3' },
  { value: 3, label: 'Facile', key: '4' },
];

export function newCardSrs() {
  return { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: today() };
}

export function schedule(srs, grade) {
  const s = { ...newCardSrs(), ...(srs || {}) };
  let { ease, interval, reps, lapses } = s;
  if (grade === 0) {
    reps = 0;
    lapses += 1;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else if (grade === 1) {
    interval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    ease = Math.max(1.3, ease - 0.15);
    reps += 1;
  } else if (grade === 2) {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(interval * ease);
    reps += 1;
  } else {
    interval = reps === 0 ? 4 : reps === 1 ? 6 : Math.round(interval * ease * 1.3);
    ease = ease + 0.15;
    reps += 1;
  }
  interval = Math.min(interval, 3650);
  return { ease: Math.round(ease * 100) / 100, interval, reps, lapses, due: addDays(today(), interval), last: today() };
}

// Human label for the interval a grade would produce, e.g. "3 g".
export function previewInterval(srs, grade) {
  const d = schedule(srs, grade).interval;
  if (d < 30) return `${d} g`;
  if (d < 365) return `${Math.round(d / 30)} mesi`;
  return `${(d / 365).toFixed(1)} anni`;
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
