// Shared UI pieces: modal, action registry, small components.

import * as store from './store.js';
import { esc, colorVar, STAGES, today, weekStart } from './util.js';
import { isCardDue, isTopicDue, stateOf, recallNow } from './srs.js';
import { presetForTopic, presetForScope, areaPresetId, getPreset } from './presets.js';

/* ---------- action registry ---------- */
const actions = {};
export function registerActions(map) { Object.assign(actions, map); }
export function runAction(name, el, ev) {
  const fn = actions[name];
  if (!fn) { console.warn('no action', name); return; }
  return fn(el, ev);
}

/* ---------- modal ---------- */
let modalOpen = false;
let onModalClose = null;
export const isModalOpen = () => modalOpen;
export function openModal(html, { wide = false, onMount, onClose } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="overlay" data-overlay><div class="panel ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  modalOpen = true;
  onModalClose = onClose || null;
  const first = root.querySelector('[autofocus], input:not([type=hidden]), textarea, select');
  // don't steal focus from a field the user already tapped
  if (first) setTimeout(() => { if (!root.contains(document.activeElement)) first.focus(); }, 20);
  if (onMount) onMount(root.querySelector('.panel'));
}
export function closeModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  modalOpen = false;
  const cb = onModalClose; onModalClose = null;
  if (cb) cb();
  document.dispatchEvent(new CustomEvent('modal-closed'));
}
export function modalError(msg) {
  const el = document.querySelector('#modal-root [data-error]');
  if (el) { el.textContent = msg; el.hidden = !msg; }
}

/* ---------- data helpers ---------- */
export const areas = () => store.all('area').sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
export const topicsOf = (areaId) => store.all('topic').filter((t) => !areaId || t.areaId === areaId);
export const notesOf = (topicId) => store.all('note').filter((n) => n.topicId === topicId).sort((a, b) => b.updated_at - a.updated_at);
export const cardsOf = (topicId) => store.all('card').filter((c) => c.topicId === topicId);
export const questionsOf = (topicId) => store.all('question').filter((q) => q.topicId === topicId);

// scope: 'all' | 'area:<id>' | 'topic:<id>'
export function inScope(rec, scope) {
  if (!scope || scope === 'all') return true;
  const [k, id] = scope.split(':');
  if (k === 'topic') return rec.topicId === id;
  if (k === 'area') {
    const t = store.get(rec.topicId);
    return (t && t.areaId === id) || rec.areaId === id;
  }
  return true;
}
export function scopeLabel(scope) {
  if (!scope || scope === 'all') return 'Tutte le aree';
  const [k, id] = scope.split(':');
  const r = store.get(id);
  if (!r) return 'Tutte le aree';
  return k === 'area' ? r.name : r.title;
}
/* ---------- study queue (like Anki: per-deck daily limits) ---------- */
// Extra new cards allowed today for a scope ("Studia altre nuove oggi"), on this device.
export function extraNewToday(scope) {
  const m = store.getMeta('extraNew', null);
  return m && m.day === today() ? m.scopes?.[scope] || 0 : 0;
}
export async function addExtraNew(scope, n) {
  let m = store.getMeta('extraNew', null);
  if (!m || m.day !== today()) m = { day: today(), scopes: {} };
  m.scopes[scope] = (m.scopes[scope] || 0) + n;
  await store.setMeta('extraNew', m);
}
const hash = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return x >>> 0; };
// Random but stable for the day, so counts on the home page match the session.
const dayShuffle = (list, day) => list.sort((a, b) => hash(a.id + day) - hash(b.id + day));
const byCreated = (a, b) => (a.created || '').localeCompare(b.created || '') || a.updated_at - b.updated_at;

// Cards to study now in a scope: learning cards (no limit), then reviews and new cards within
// each topic's daily limits. For an area (or everything), the area's own limits cap the total,
// like a parent deck in Anki. Topic = deck, area = parent deck.
export function studyQueue(scope, { now = Date.now() } = {}) {
  const day = today();
  const all = store.all('card');
  const extra = extraNewToday(scope);
  const topicScope = String(scope).startsWith('topic:');
  const areaOf = new Map();
  const aid = (tid) => { if (!areaOf.has(tid)) areaOf.set(tid, store.get(tid)?.areaId || ''); return areaOf.get(tid); };
  const doneN = new Map(); const doneR = new Map(); const aDoneN = new Map(); const aDoneR = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const c of all) {
    if (c.srs?.firstDay === day) { bump(doneN, c.topicId); bump(aDoneN, aid(c.topicId)); }
    if (c.srs?.revDay === day) { bump(doneR, c.topicId); bump(aDoneR, aid(c.topicId)); }
  }
  const caps = new Map();
  const areaCap = (areaId) => {
    if (!caps.has(areaId)) {
      const p = getPreset(areaPresetId(areaId)).cards;
      caps.set(areaId, { n: Math.max(0, p.newPerDay + extra - (aDoneN.get(areaId) || 0)), r: Math.max(0, p.reviewsPerDay - (aDoneR.get(areaId) || 0)) });
    }
    return caps.get(areaId);
  };
  const byTopic = new Map();
  for (const c of all) {
    if (!inScope(c, scope) || !isCardDue(c, now)) continue;
    if (!byTopic.has(c.topicId)) byTopic.set(c.topicId, []);
    byTopic.get(c.topicId).push(c);
  }
  const learn = []; let review = []; const fresh = []; let newHidden = 0; let revHidden = 0;
  const topics = [...byTopic.keys()].sort((a, b) => (store.get(a)?.title || '').localeCompare(store.get(b)?.title || ''));
  for (const tid of topics) {
    const p = presetForTopic(tid).cards;
    const cap = topicScope ? null : areaCap(aid(tid));
    let nLeft = Math.max(0, p.newPerDay + extra - (doneN.get(tid) || 0));
    let rLeft = Math.max(0, p.reviewsPerDay - (doneR.get(tid) || 0));
    if (cap) { nLeft = Math.min(nLeft, cap.n); rLeft = Math.min(rLeft, cap.r); }
    const L = []; const R = []; const N = [];
    for (const c of byTopic.get(tid)) { const st = stateOf(c.srs); (st === 'new' ? N : st === 'review' ? R : L).push(c); }
    learn.push(...L);
    R.sort((a, b) => (a.srs?.due || '').localeCompare(b.srs?.due || '') || byCreated(a, b)); // most overdue first
    const takeR = R.slice(0, rLeft); revHidden += R.length - takeR.length; review.push(...takeR);
    if (p.newOrder === 'random') dayShuffle(N, day); else N.sort(byCreated);
    const takeN = N.slice(0, nLeft); newHidden += N.length - takeN.length; fresh.push(...takeN);
    if (cap) { cap.n -= takeN.length; cap.r -= takeR.length; }
  }
  const sp = presetForScope(scope).cards;
  if (sp.reviewOrder === 'random') review = dayShuffle(review, day);
  else if (sp.reviewOrder === 'difficulty') review.sort((a, b) => recallNow(a.srs) - recallNow(b.srs));
  else review.sort((a, b) => (a.srs?.due || '').localeCompare(b.srs?.due || ''));
  learn.sort((a, b) => (a.srs?.dueAt || 0) - (b.srs?.dueAt || 0));
  return { learn, review, fresh, newHidden, revHidden, mix: sp.mix, count: learn.length + review.length + fresh.length };
}
export const dueCards = (scope) => { const q = studyQueue(scope); return [...q.learn, ...q.review, ...q.fresh]; };
export const dueTopics = () => store.all('topic').filter(isTopicDue).sort((a, b) => a.nextReview.localeCompare(b.nextReview));

export function minutesThisWeek() {
  const wk = weekStart(today());
  return store.all('session').filter((s) => s.date && weekStart(s.date) === wk).reduce((n, s) => n + (+s.minutes || 0), 0);
}
export function streakDays() {
  const days = new Set([
    ...store.all('session').map((s) => s.date),
    ...store.all('attempt').map((a) => a.date),
    ...store.all('card').map((c) => c.srs?.last).filter(Boolean),
  ]);
  let n = 0;
  const d = new Date();
  if (!days.has(today())) d.setDate(d.getDate() - 1);
  for (;;) {
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!days.has(s)) break;
    n++; d.setDate(d.getDate() - 1);
  }
  return n;
}

/* ---------- components ---------- */
export function areaChip(areaId, { link = false } = {}) {
  const a = store.get(areaId);
  if (!a) return '';
  const inner = `<i style="background:${colorVar(a.color)}"></i><span>${esc(a.name)}</span>`;
  return link ? `<a class="chip" href="#/area/${a.id}">${inner}</a>` : `<span class="chip">${inner}</span>`;
}
export function confDots(n) {
  n = +n || 0;
  return `<span class="conf" title="Sicurezza ${n}/5" aria-label="Sicurezza ${n} su 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
}
export function stageBar(list, { legend = true } = {}) {
  const n = list.length || 1;
  const bar = `<div class="bar" role="img" aria-label="Avanzamento">${STAGES.map(([k, , v]) => `<span style="width:${(list.filter((t) => t.stage === k).length / n) * 100}%;background:var(${v})"></span>`).join('')}</div>`;
  if (!legend) return bar;
  return `${bar}
  <div class="legend">${STAGES.map(([k, l, v]) => `<span><i style="background:var(${v})"></i>${l} <b class="mono">${list.filter((t) => t.stage === k).length}</b></span>`).join('')}</div>`;
}
export function emptyState(title, body, actionsHtml = '') {
  return `<div class="empty"><h3>${title}</h3><p>${body}</p>${actionsHtml ? `<div class="row gap">${actionsHtml}</div>` : ''}</div>`;
}
export function areaOptions(selected) {
  return areas().map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
}
export function topicOptions(areaId, selected, { none = true } = {}) {
  const list = topicsOf(areaId).sort((a, b) => a.title.localeCompare(b.title));
  return (none ? '<option value="">Nessuno / generale</option>' : '') +
    list.map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
}
export function scopeOptions(selected) {
  const opts = [`<option value="all" ${!selected || selected === 'all' ? 'selected' : ''}>Tutte le aree</option>`];
  for (const a of areas()) {
    opts.push(`<option value="area:${a.id}" ${selected === 'area:' + a.id ? 'selected' : ''}>${esc(a.name)}</option>`);
    for (const t of topicsOf(a.id).sort((x, y) => x.title.localeCompare(y.title))) {
      opts.push(`<option value="topic:${t.id}" ${selected === 'topic:' + t.id ? 'selected' : ''}>&nbsp;&nbsp;↳ ${esc(t.title)}</option>`);
    }
  }
  return opts.join('');
}

// Inline two-step delete: first click swaps the button for a confirm.
export function confirmButton(label, action, attrs = '') {
  return `<span class="confirm-wrap"><button type="button" class="btn danger" data-action="confirm-step" data-label="${esc(label)}">${esc(label)}</button><button type="button" class="btn danger solid" data-action="${action}" ${attrs} hidden>Conferma</button></span>`;
}
registerActions({
  'confirm-step': (el) => { el.hidden = true; const next = el.nextElementSibling; next.hidden = false; next.focus(); },
  'close-modal': () => closeModal(),
});
