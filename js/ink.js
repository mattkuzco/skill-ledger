// Handwritten notes: a vector ink editor for pens (pressure), mouse and fingers.
//
// Data (note.ink): { paper: 'lined'|'grid'|'dots'|'blank', dark?: true, pages: [{ s: [stroke, ...] }] }
// stroke: { t: 'p' (pen) | 'h' (highlighter), c: color, w: width in page units, p: [x, y, pressure 0-100, ...] }
// Pages use a fixed logical size (A4 ratio) so strokes look the same on any screen.

import * as store from './store.js';

export const PAGE_W = 1000;
export const PAGE_H = 1414;
const PAPER = '#FFFEFA';
export const DARK_PAPER = '#16191F';
export const paperColor = (dark) => (dark ? DARK_PAPER : PAPER);

export const PEN_COLORS = ['#1B2230', '#3552C9', '#B83A3A', '#2B7F55', '#7A4BC4'];
export const HL_COLORS = ['#F6D743', '#8EE08A', '#FF9FC6', '#8FD3FF'];

// On black paper the same ink is shown in a light version (like OneNote in dark mode):
// strokes keep their original colour, so switching paper never makes old notes unreadable
// and the AI always gets dark ink on white.
const DARK_INK = { '#1B2230': '#F1F3F7', '#3552C9': '#86A2FF', '#B83A3A': '#FF7E7E', '#2B7F55': '#62D69F', '#7A4BC4': '#BD98FF' };
export const shownColor = (c, dark) => (dark ? DARK_INK[c] || c : c);

// Grid colours for light and dark paper: [normal, faint].
const LINES = {
  light: { lined: ['#D9DFEA', '#EEF1F6'], margin: ['#F0BDBD', '#F8E6E6'], grid: ['#E4E8F0', '#F1F3F7'], dots: ['#C9CFDB', '#E8EBF1'] },
  dark: { lined: ['#2D333F', '#252A33'], margin: ['#5A2F35', '#3D272B'], grid: ['#272C36', '#20242C'], dots: ['#454D5C', '#30353F'] },
};
export const lineColor = (what, dark, faint) => LINES[dark ? 'dark' : 'light'][what][faint ? 1 : 0];
export const SIZES = { p: [2.5, 4.5, 8], h: [18, 28, 40] };

export const emptyInk = () => ({ paper: 'lined', pages: [{ s: [] }] });
export const strokeCount = (ink) => (ink?.pages || []).reduce((n, pg) => n + pg.s.length, 0);

/* ---------- drawing ---------- */
function drawPaper(g, paper, scale, { faint = false, dark = false } = {}) {
  g.fillStyle = paperColor(dark);
  g.fillRect(0, 0, PAGE_W * scale, PAGE_H * scale);
  const step = 40 * scale;
  g.save();
  if (paper === 'lined') {
    g.strokeStyle = lineColor('lined', dark, faint); g.lineWidth = Math.max(1, scale);
    for (let y = 120 * scale; y < PAGE_H * scale; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(PAGE_W * scale, y); g.stroke(); }
    g.strokeStyle = lineColor('margin', dark, faint);
    g.beginPath(); g.moveTo(90 * scale, 0); g.lineTo(90 * scale, PAGE_H * scale); g.stroke();
  } else if (paper === 'grid') {
    g.strokeStyle = lineColor('grid', dark, faint); g.lineWidth = Math.max(1, scale * 0.8);
    for (let x = step; x < PAGE_W * scale; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, PAGE_H * scale); g.stroke(); }
    for (let y = step; y < PAGE_H * scale; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(PAGE_W * scale, y); g.stroke(); }
  } else if (paper === 'dots') {
    g.fillStyle = lineColor('dots', dark, faint);
    const r = Math.max(1, 1.6 * scale);
    for (let x = step; x < PAGE_W * scale; x += step) for (let y = step; y < PAGE_H * scale; y += step) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
  }
  g.restore();
}

export function drawStroke(g, st, scale, dark = false) {
  const p = st.p;
  const n = p.length / 3;
  if (!n) return;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const c = shownColor(st.c, dark);
  g.strokeStyle = c;
  g.fillStyle = c;
  if (st.t === 'h') {
    // multiply darkens on white paper; on black it would vanish, so there we lighten instead
    g.globalAlpha = dark ? 0.62 : 0.38;
    g.globalCompositeOperation = dark ? 'screen' : 'multiply';
    g.lineWidth = st.w * scale;
    g.beginPath();
    g.moveTo(p[0] * scale, p[1] * scale);
    if (n === 1) g.lineTo(p[0] * scale + 0.1, p[1] * scale);
    for (let i = 1; i < n; i++) g.lineTo(p[i * 3] * scale, p[i * 3 + 1] * scale);
    g.stroke();
    g.restore();
    return;
  }
  if (n === 1) { g.beginPath(); g.arc(p[0] * scale, p[1] * scale, penWidth(st, 0, scale) / 2, 0, Math.PI * 2); g.fill(); g.restore(); return; }
  for (let i = 1; i < n; i++) penSegment(g, st, i, scale);
  penTail(g, st, scale);
  g.restore();
}

/* Pen strokes are drawn piece by piece so the editor can paint a stroke while it is being
   written (each new point adds one piece) and get exactly the same result as a full redraw.
   Piece i (1 ≤ i < n) runs from the previous anchor to the midpoint of points i-1 and i,
   bending through point i-1; the anchors are point 0 and then the midpoints. The tail joins
   the last midpoint to the last point. Width follows pen pressure. */
export const penWidth = (st, i, scale) => Math.max(0.6, st.w * (0.35 + 0.95 * (st.p[i * 3 + 2] / 100)) * scale);
export function penSegment(g, st, i, scale) {
  const p = st.p;
  const x0 = p[(i - 1) * 3] * scale; const y0 = p[(i - 1) * 3 + 1] * scale;
  const x1 = p[i * 3] * scale; const y1 = p[i * 3 + 1] * scale;
  g.lineWidth = (penWidth(st, i - 1, scale) + penWidth(st, i, scale)) / 2;
  g.beginPath();
  if (i === 1) { g.moveTo(x0, y0); g.lineTo((x0 + x1) / 2, (y0 + y1) / 2); }
  else {
    g.moveTo((p[(i - 2) * 3] * scale + x0) / 2, (p[(i - 2) * 3 + 1] * scale + y0) / 2);
    g.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  g.stroke();
}
export function penTail(g, st, scale) {
  const p = st.p; const n = p.length / 3;
  if (n < 2) return;
  const x0 = p[(n - 2) * 3] * scale; const y0 = p[(n - 2) * 3 + 1] * scale;
  const x1 = p[(n - 1) * 3] * scale; const y1 = p[(n - 1) * 3 + 1] * scale;
  g.lineWidth = penWidth(st, n - 1, scale);
  g.beginPath(); g.moveTo((x0 + x1) / 2, (y0 + y1) / 2); g.lineTo(x1, y1); g.stroke();
}
// Style for painting pen pieces directly (used by the live editor).
export function penStyle(g, st, dark) {
  const c = shownColor(st.c, dark);
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = c; g.fillStyle = c;
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
}

// opts.light forces white paper (used for the AI, which reads dark ink on white best).
export function renderPage(g, ink, pageIndex, scale, opts = {}) {
  const dark = !!ink.dark && !opts.light;
  drawPaper(g, ink.paper, scale, { ...opts, dark });
  for (const st of ink.pages[pageIndex]?.s || []) drawStroke(g, st, scale, dark);
}

// Small preview of the first page, as a data URL (cached per note version).
const thumbCache = new Map();
export function thumbnail(note, width = 240) {
  const key = `${note.id}:${note.updated_at}:${width}:${note.ink?.dark ? 'd' : 'l'}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const scale = width / PAGE_W;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(PAGE_H * scale * 0.5); // top half of the page
  renderPage(c.getContext('2d'), note.ink || emptyInk(), 0, scale, { faint: true });
  const url = c.toDataURL('image/png');
  thumbCache.set(key, url);
  return url;
}

// Full page as JPEG (for the AI). Pages without strokes are skipped by callers.
export async function pageBlob(ink, pageIndex, width = 1000) {
  const scale = width / PAGE_W;
  const c = document.createElement('canvas');
  c.width = width; c.height = Math.round(PAGE_H * scale);
  renderPage(c.getContext('2d'), ink, pageIndex, scale, { faint: true, light: true });
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
}

/* ---------- editor ---------- */
export function mountEditor(root, note, { onChange }) {
  const ink = structuredClone(note.ink || emptyInk());
  if (!ink.pages?.length) ink.pages = [{ s: [] }];
  const tool = { t: 'p', c: PEN_COLORS[0], hc: HL_COLORS[0], size: 1, eraser: false };
  let fingerMode = store.getMeta('inkFinger', null); // null = auto (draw until a pen is seen)
  const undo = []; const redo = [];
  const pagesEl = root.querySelector('[data-ink-pages]');
  const pages = []; // { wrap, base, over, g, og, scale }
  let active = null; // current gesture

  const changed = () => { onChange(ink); updateButtons(); };

  // Pages are virtualised: only canvases near the viewport hold pixels, so a long
  // notebook doesn't eat the tablet's memory. The page box keeps its size via CSS.
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2.5);
  function sizeCanvas(c, on) {
    const cssW = pagesEl.clientWidth;
    const d = DPR();
    const w = on ? Math.round(cssW * d) : 1;
    const h = on ? Math.round(cssW * (PAGE_H / PAGE_W) * d) : 1;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return (cssW * d) / PAGE_W;
  }
  function showPage(i) { const pg = pages[i]; pg.visible = true; pg.scale = sizeCanvas(pg.base, true); redrawPage(i); }
  function hidePage(i) {
    const pg = pages[i];
    if (active && active.page === i) return;
    pg.visible = false; sizeCanvas(pg.base, false); sizeCanvas(pg.over, false);
  }
  function ensureOverlay(i) { const pg = pages[i]; if (!pg.visible) showPage(i); sizeCanvas(pg.over, true); }
  function redrawPage(i) {
    const pg = pages[i];
    if (pg.visible) renderPage(pg.g, ink, i, pg.scale);
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.i;
      if (e.isIntersecting) { if (!pages[i].visible) showPage(i); } else hidePage(i);
    }
  }, { rootMargin: '1200px 0px' });
  function addPageEl(i) {
    const wrap = document.createElement('div');
    wrap.className = `ink-page${ink.dark ? ' dark' : ''}`;
    wrap.dataset.i = i;
    wrap.innerHTML = `<canvas class="ink-base"></canvas><canvas class="ink-over"></canvas><span class="ink-page-n mono">${i + 1}</span>`;
    pagesEl.appendChild(wrap);
    const base = wrap.querySelector('.ink-base');
    const over = wrap.querySelector('.ink-over');
    const pg = { wrap, base, over, g: base.getContext('2d'), og: over.getContext('2d'), scale: 1, visible: false };
    pages.push(pg);
    bindPointer(over, i);
    showPage(i);
    io.observe(wrap);
  }
  function relayout() { pages.forEach((pg, i) => { if (pg.visible) showPage(i); }); }

  /* --- pointer handling --- */
  function toPage(ev, canvas) {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((ev.clientX - r.left) / r.width) * PAGE_W), Math.round(((ev.clientY - r.top) / r.height) * PAGE_H)];
  }
  function pressureOf(ev) {
    if (ev.pointerType === 'pen' && ev.pressure > 0) return Math.round(Math.min(1, ev.pressure) * 100);
    return 55; // mouse and finger: constant medium pressure
  }

  const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* synthetic or already released */ } };

  function bindPointer(canvas, pageIndex) {
    canvas.addEventListener('pointerdown', (ev) => {
      if (active) return; // one gesture at a time (palm rejection)
      if (ev.pointerType === 'pen' && fingerMode === null) { fingerMode = 'scroll'; store.setMeta('inkFinger', 'scroll'); updateButtons(); }
      if (ev.pointerType === 'touch' && fingerMode === 'scroll') {
        active = { kind: 'scroll', id: ev.pointerId, y: ev.clientY, x: ev.clientX, sy: window.scrollY, sx: pagesEl.scrollLeft };
        capture(canvas, ev.pointerId);
        return;
      }
      if (ev.button > 0 && ev.pointerType === 'mouse') return;
      ev.preventDefault();
      capture(canvas, ev.pointerId);
      // pen eraser end (32) or side button held (2) = temporary eraser
      const eraser = tool.eraser || (ev.pointerType === 'pen' && (ev.buttons & 34));
      if (eraser) {
        const start = toPage(ev, canvas);
        active = { kind: 'erase', id: ev.pointerId, page: pageIndex, removed: [], last: start };
        eraseAt(pageIndex, start);
        return;
      }
      const [x, y] = toPage(ev, canvas);
      const st = tool.t === 'h'
        ? { t: 'h', c: tool.hc, w: SIZES.h[tool.size], p: [x, y, 50] }
        : { t: 'p', c: tool.c, w: SIZES.p[tool.size], p: [x, y, pressureOf(ev)] };
      ensureOverlay(pageIndex);
      active = { kind: 'draw', id: ev.pointerId, page: pageIndex, st, raf: 0, pred: [] };
      paintLive();
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!active || ev.pointerId !== active.id) return;
      if (active.kind === 'scroll') {
        window.scrollTo(window.scrollX, active.sy - (ev.clientY - active.y));
        return;
      }
      ev.preventDefault();
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const e of (evs.length ? evs : [ev])) {
        const [x, y] = toPage(e, canvas);
        if (active.kind === 'erase') {
          // fill the gap since the last point so fast swipes don't skip strokes
          const [lx, ly] = active.last || [x, y];
          const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / 7));
          for (let k = 1; k <= steps; k++) eraseAt(active.page, [lx + ((x - lx) * k) / steps, ly + ((y - ly) * k) / steps]);
          active.last = [x, y];
          continue;
        }
        const p = active.st.p;
        const lx = p[p.length - 3]; const ly = p[p.length - 2];
        if (Math.abs(x - lx) + Math.abs(y - ly) < 2) continue; // skip jitter
        p.push(x, y, active.st.t === 'h' ? 50 : pressureOf(e));
      }
      if (active.kind === 'draw') {
        // predicted points make the line keep up with the pen tip (drawn, never saved)
        const pr = ev.getPredictedEvents ? ev.getPredictedEvents().slice(0, 3) : [];
        active.pred = pr.map((e) => toPage(e, canvas));
        if (!active.raf) active.raf = requestAnimationFrame(paintLive);
      }
    });
    const end = (ev) => {
      if (!active || ev.pointerId !== active.id) return;
      const a = active; active = null;
      if (a.kind === 'draw') {
        cancelAnimationFrame(a.raf);
        pages[a.page].og.clearRect(0, 0, pages[a.page].over.width, pages[a.page].over.height);
        ink.pages[a.page].s.push(a.st);
        drawStroke(pages[a.page].g, a.st, pages[a.page].scale, !!ink.dark);
        undo.push({ op: 'add', page: a.page, st: a.st }); redo.length = 0;
        changed();
      } else if (a.kind === 'erase' && a.removed.length) {
        undo.push({ op: 'erase', page: a.page, items: a.removed }); redo.length = 0;
        changed();
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // pen side button / long press
  }

  function paintLive() {
    if (!active || active.kind !== 'draw') return;
    active.raf = 0;
    const pg = pages[active.page];
    pg.og.clearRect(0, 0, pg.over.width, pg.over.height);
    const st = active.st;
    const lastP = st.p[st.p.length - 1];
    const shown = active.pred?.length ? { ...st, p: st.p.concat(active.pred.flatMap(([x, y]) => [x, y, lastP])) } : st;
    drawStroke(pg.og, shown, pg.scale, !!ink.dark);
  }

  const bboxes = new WeakMap();
  function bbox(st) {
    let b = bboxes.get(st);
    if (!b) {
      b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < st.p.length; i += 3) { b[0] = Math.min(b[0], st.p[i]); b[1] = Math.min(b[1], st.p[i + 1]); b[2] = Math.max(b[2], st.p[i]); b[3] = Math.max(b[3], st.p[i + 1]); }
      bboxes.set(st, b);
    }
    return b;
  }
  function eraseAt(pageIndex, [x, y]) {
    const R = 14;
    const list = ink.pages[pageIndex].s;
    let hit = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const st = list[i]; const b = bbox(st); const pad = R + st.w;
      if (x < b[0] - pad || x > b[2] + pad || y < b[1] - pad || y > b[3] + pad) continue;
      const r2 = (R + st.w / 2) ** 2;
      for (let k = 0; k < st.p.length; k += 3) {
        if ((st.p[k] - x) ** 2 + (st.p[k + 1] - y) ** 2 <= r2) {
          list.splice(i, 1);
          active?.removed?.push({ index: i, st });
          hit = true;
          break;
        }
      }
    }
    if (hit) redrawPage(pageIndex);
  }

  function doUndo() {
    const op = undo.pop(); if (!op) return;
    const list = ink.pages[op.page].s;
    if (op.op === 'add') { const i = list.lastIndexOf(op.st); if (i >= 0) list.splice(i, 1); }
    else if (op.op === 'erase') [...op.items].reverse().forEach(({ index, st }) => list.splice(index, 0, st));
    redo.push(op); redrawPage(op.page); changed();
  }
  function doRedo() {
    const op = redo.pop(); if (!op) return;
    const list = ink.pages[op.page].s;
    if (op.op === 'add') list.push(op.st);
    else if (op.op === 'erase') op.items.forEach(({ st }) => { const i = list.indexOf(st); if (i >= 0) list.splice(i, 1); });
    undo.push(op); redrawPage(op.page); changed();
  }

  /* --- toolbar --- */
  const bar = root.querySelector('[data-ink-bar]');
  function renderBar() {
    const colors = tool.t === 'h' ? HL_COLORS : PEN_COLORS;
    const cur = tool.t === 'h' ? tool.hc : tool.c;
    bar.innerHTML = `
      <div class="ink-group" role="radiogroup" aria-label="Strumento">
        <button type="button" data-ink="tool" data-v="p" aria-pressed="${!tool.eraser && tool.t === 'p'}" title="Penna"><svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg><span>Penna</span></button>
        <button type="button" data-ink="tool" data-v="h" aria-pressed="${!tool.eraser && tool.t === 'h'}" title="Evidenziatore"><svg viewBox="0 0 24 24"><path d="M9 15l-3 5h6l1-2M9 15l7-11 4 3-7 11z"/></svg><span>Evidenziatore</span></button>
        <button type="button" data-ink="tool" data-v="e" aria-pressed="${tool.eraser}" title="Gomma"><svg viewBox="0 0 24 24"><path d="M8 20h12M5 14l8-8 6 6-6 6H9z"/></svg><span>Gomma</span></button>
      </div>
      <div class="ink-group swatches-ink" aria-label="Colore">${colors.map((c) => `<button type="button" data-ink="color" data-v="${c}" aria-pressed="${c === cur}" style="--sw:${shownColor(c, ink.dark)}" title="Colore"></button>`).join('')}</div>
      <div class="ink-group" aria-label="Spessore">${[0, 1, 2].map((i) => `<button type="button" data-ink="size" data-v="${i}" aria-pressed="${tool.size === i}" title="Spessore ${i + 1}"><i style="width:${[4, 7, 11][i]}px;height:${[4, 7, 11][i]}px"></i></button>`).join('')}</div>
      <div class="ink-group">
        <button type="button" data-ink="undo" title="Annulla (Ctrl+Z)" ${undo.length ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
        <button type="button" data-ink="redo" title="Ripeti" ${redo.length ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg></button>
      </div>
      <div class="ink-group">
        <select data-ink="paper" aria-label="Tipo di carta">${[['lined', 'Righe'], ['grid', 'Quadretti'], ['dots', 'Puntini'], ['blank', 'Senza righe']].map(([k, l]) => `<option value="${k}" ${ink.paper === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select data-ink="bg" aria-label="Colore del foglio">${[['light', 'Foglio bianco'], ['dark', 'Foglio nero']].map(([k, l]) => `<option value="${k}" ${(ink.dark ? 'dark' : 'light') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button type="button" data-ink="finger" title="Cosa fa il dito sullo schermo" aria-pressed="${fingerMode !== 'scroll'}">${fingerMode === 'scroll' ? 'Dito: scorre' : 'Dito: scrive'}</button>
      </div>`;
  }
  function updateButtons() { renderBar(); }
  bar.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-ink]'); if (!b) return;
    const k = b.dataset.ink; const v = b.dataset.v;
    if (k === 'tool') { tool.eraser = v === 'e'; if (v !== 'e') tool.t = v; }
    if (k === 'color') { if (tool.t === 'h') tool.hc = v; else tool.c = v; tool.eraser = false; }
    if (k === 'size') tool.size = +v;
    if (k === 'undo') return doUndo();
    if (k === 'redo') return doRedo();
    if (k === 'finger') { fingerMode = fingerMode === 'scroll' ? 'draw' : 'scroll'; store.setMeta('inkFinger', fingerMode); }
    renderBar();
  });
  bar.addEventListener('change', (ev) => {
    if (ev.target.dataset.ink === 'paper') { ink.paper = ev.target.value; pages.forEach((_, i) => redrawPage(i)); changed(); }
    if (ev.target.dataset.ink === 'bg') {
      if (ev.target.value === 'dark') ink.dark = true; else delete ink.dark;
      pages.forEach((pg, i) => { pg.wrap.classList.toggle('dark', !!ink.dark); redrawPage(i); });
      changed();
    }
  });
  const onKey = (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.target.matches('input, textarea')) return;
    if (ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? doRedo() : doUndo(); }
    if (ev.key.toLowerCase() === 'y') { ev.preventDefault(); doRedo(); }
  };
  document.addEventListener('keydown', onKey);

  root.querySelector('[data-ink-addpage]')?.addEventListener('click', () => {
    ink.pages.push({ s: [] }); addPageEl(ink.pages.length - 1); changed();
    pages[pages.length - 1].wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  renderBar();
  ink.pages.forEach((_, i) => addPageEl(i));
  let rw = pagesEl.clientWidth;
  const ro = new ResizeObserver(() => { if (pagesEl.clientWidth !== rw) { rw = pagesEl.clientWidth; relayout(); } });
  ro.observe(pagesEl);

  return {
    ink,
    destroy() { ro.disconnect(); io.disconnect(); document.removeEventListener('keydown', onKey); },
  };
}
