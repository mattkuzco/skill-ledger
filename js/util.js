// Shown in Settings; keep in sync with VERSION in sw.js.
export const APP_VERSION = '11';

// Small shared helpers. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoDate(new Date());
export const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };
export const diffDays = (a, b) => Math.round((parseDate(a) - parseDate(b)) / 86400000);
export const weekStart = (s) => { const d = parseDate(s); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return isoDate(d); };

const LOCALE = 'it-IT';
export const fmtDate = (s) => parseDate(s).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
export const fmtDateLong = (s) => parseDate(s).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtWeekday = (s) => parseDate(s).toLocaleDateString(LOCALE, { weekday: 'narrow' });

export function relDue(dateStr) {
  if (!dateStr) return '';
  const d = diffDays(dateStr, today());
  if (d < 0) return `in ritardo di ${-d} g`;
  if (d === 0) return 'oggi';
  if (d === 1) return 'domani';
  return `tra ${d} g`;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

export const COLORS = ['cobalt', 'amber', 'teal', 'rose', 'violet', 'olive'];
export const colorVar = (k) => `var(--c-${COLORS.includes(k) ? k : 'cobalt'})`;

export const STAGES = [
  ['queued', 'In coda', '--q'],
  ['learning', 'Sto imparando', '--l'],
  ['practicing', 'Mi esercito', '--p'],
  ['mastered', 'Padroneggiato', '--m'],
];
export const stageLabel = (k) => (STAGES.find((s) => s[0] === k) || STAGES[0])[1];
export const stageVar = (k) => (STAGES.find((s) => s[0] === k) || STAGES[0])[2];

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
