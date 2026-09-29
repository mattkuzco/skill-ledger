// Study option presets, like Anki's deck options: a preset holds flashcard and quiz settings
// and is assigned to an area (all its topics) or to a single topic (which then differs from
// its area). Records: { kind: 'preset', name, cards: {...}, quiz: {...} }, synced like the rest.
// The "Predefinito" preset has a fixed id, so every device agrees on it even before it is saved.

import * as store from './store.js';

export const DEFAULT_ID = '00000000-0000-4000-8000-000000000001';

export const CARD_DEFAULTS = {
  newPerDay: 20,          // new cards introduced per day
  reviewsPerDay: 200,     // review cards shown per day
  learnSteps: [1, 10],    // minutes between the first looks at a new card
  relearnSteps: [10],     // minutes, after forgetting a card
  newOrder: 'created',    // created | random
  mix: 'mix',             // mix | reviewsFirst | newFirst
  reviewOrder: 'due',     // due | random | difficulty (lowest chance of remembering first)
  retention: 0.9,         // FSRS desired retention
  maxInterval: 3650,      // days
  leechThreshold: 8,      // lapses before a card is a leech
  leechAction: 'tag',     // tag | suspend
  showIntervals: true,    // next interval on the answer buttons
  showTimer: false,       // stopwatch while answering
};
export const QUIZ_DEFAULTS = {
  count: 10,              // questions per quiz, 0 = all
  order: 'random',        // random | sequential
  shuffleOptions: true,
  feedback: 'each',       // each (after every answer) | end
  timeLimit: 0,           // seconds per question, 0 = none
  retryWrong: false,      // ask wrong ones again at the end (not scored)
  weakFirst: true,        // recently wrong questions first
};

// Before presets existed, the desired retention was a device setting: keep it as the default.
function legacyRetention() {
  const r = +store.getMeta('retention', 0);
  return r >= 0.7 && r <= 0.99 ? r : CARD_DEFAULTS.retention;
}
const stored = (id) => { const p = id && store.get(id); return p && p.kind === 'preset' ? p : null; };

export function getPreset(id) {
  const p = stored(id) || stored(DEFAULT_ID) || { id: DEFAULT_ID, name: 'Predefinito' };
  const isDefault = p.id === DEFAULT_ID;
  return {
    ...p, id: p.id, name: isDefault ? 'Predefinito' : p.name || 'Preset',
    isDefault,
    cards: { ...CARD_DEFAULTS, retention: legacyRetention(), ...(p.cards || {}) },
    quiz: { ...QUIZ_DEFAULTS, ...(p.quiz || {}) },
  };
}
export function presets() {
  const list = store.all('preset').filter((p) => p.id !== DEFAULT_ID).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return [getPreset(DEFAULT_ID), ...list.map((p) => getPreset(p.id))];
}

export const areaPresetId = (areaId) => (stored(store.get(areaId)?.presetId) ? store.get(areaId).presetId : DEFAULT_ID);
export const topicPresetId = (topicId) => {
  const t = store.get(topicId);
  return stored(t?.presetId) ? t.presetId : areaPresetId(t?.areaId);
};
export const presetForTopic = (topicId) => getPreset(topicPresetId(topicId));
export function presetForScope(scope) {
  const [k, id] = String(scope || 'all').split(':');
  if (k === 'topic') return presetForTopic(id);
  if (k === 'area') return getPreset(areaPresetId(id));
  return getPreset(DEFAULT_ID);
}

// Who uses a preset explicitly (topics that inherit it from their area are listed with the area).
export function usage(id) {
  const areas = store.all('area').filter((a) => (areaPresetId(a.id) === id));
  const topics = store.all('topic').filter((t) => t.presetId === id && stored(id));
  return { areas, topics };
}

export async function savePreset(p) {
  const { cards, quiz, name, id } = p;
  return store.put('preset', { id, name: id === DEFAULT_ID ? 'Predefinito' : name, cards, quiz });
}
export async function createPreset(name, from = DEFAULT_ID) {
  const src = getPreset(from);
  return store.put('preset', { name, cards: { ...src.cards }, quiz: { ...src.quiz } });
}
// Deleting a preset: whoever used it goes back to the default (or, for topics, to their area).
export async function deletePreset(id) {
  if (id === DEFAULT_ID) return;
  for (const a of store.all('area').filter((x) => x.presetId === id)) await store.put('area', { ...a, presetId: '' });
  for (const t of store.all('topic').filter((x) => x.presetId === id)) await store.put('topic', { ...t, presetId: '' });
  await store.remove(id);
}

/* ---------- learning steps: "1m 10m 1h 1d" <-> minutes ---------- */
export function parseSteps(text) {
  const parts = String(text || '').trim().split(/[\s,;]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^(\d+(?:[.,]\d+)?)\s*(s|m|min|h|g|d)?$/i.exec(p);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.'));
    const u = (m[2] || 'm').toLowerCase();
    const mins = u === 's' ? v / 60 : u === 'h' ? v * 60 : u === 'g' || u === 'd' ? v * 1440 : v;
    if (!(mins > 0) || mins > 1440 * 30) return null;
    out.push(Math.round(mins * 100) / 100);
  }
  return out;
}
export function formatSteps(list) {
  return (list || []).map((m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}g` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`)).join(' ');
}
