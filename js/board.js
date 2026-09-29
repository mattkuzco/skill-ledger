// The topic "Quaderno": an infinite handwriting canvas, one per topic (like a OneNote page
// that never ends). Pan with a finger, pinch to zoom, write with the pen.
//
// Storage: strokes are grouped in square tiles of TILE world units, one record per tile
//   { kind: 'tile', topicId, tx, ty, s: [stroke, ...] }   (stroke format as in ink.js)
// so a big notebook syncs in small pieces and two devices rarely touch the same record.
// Photos placed on the board are attachments with { board: true, x, y, bw, bh } in world units.
// Board settings live on the topic: topic.board = { paper, dark }.
// dark = black paper; strokes keep their colour and are shown in a light version (see ink.js).

import * as store from './store.js';
import { drawStroke, penSegment, penTail, penStyle, penWidth, PEN_COLORS, HL_COLORS, SIZES, paperColor, shownColor, lineColor } from './ink.js';
import * as att from './attachments.js';
import { today, toast, debounce } from './util.js';

const TILE = 1024;
const MIN_Z = 0.08;
const MAX_Z = 6;

export const tilesOf = (topicId) => store.all('tile').filter((t) => t.topicId === topicId);
export const boardImagesOf = (topicId) => store.all('attachment').filter((a) => a.topicId === topicId && a.board);
export const strokeTotal = (topicId) => tilesOf(topicId).reduce((n, t) => n + (t.s?.length || 0), 0);
export const hasContent = (topicId) => strokeTotal(topicId) > 0 || boardImagesOf(topicId).length > 0;
export const isDark = (topicId) => !!store.get(topicId)?.board?.dark;
export const lastEdit = (topicId) => Math.max(0, ...tilesOf(topicId).map((t) => t.updated_at), ...boardImagesOf(topicId).map((a) => a.updated_at));

/* ---------- geometry ---------- */
const bboxCache = new WeakMap();
export function strokeBox(st) {
  let b = bboxCache.get(st);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < st.p.length; i += 3) {
      const x = st.p[i]; const y = st.p[i + 1];
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    }
    const pad = st.w;
    b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    bboxCache.set(st, b);
  }
  return b;
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const imgBox = (a) => [a.x, a.y, a.x + a.bw, a.y + a.bh];

export function contentBounds(topicId) {
  let b = null;
  const grow = (x) => { b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : [...x]; };
  for (const t of tilesOf(topicId)) for (const st of t.s || []) grow(strokeBox(st));
  for (const a of boardImagesOf(topicId)) grow(imgBox(a));
  return b;
}

/* ---------- bitmaps for photos ---------- */
const bitmaps = new Map(); // attachment id -> ImageBitmap | 'loading' | 'missing'
function bitmapFor(a, onReady) {
  const cur = bitmaps.get(a.id);
  if (cur && cur !== 'loading' && cur !== 'missing') return cur;
  if (!cur) {
    bitmaps.set(a.id, 'loading');
    att.getBlob(a.id).then((blob) => (blob ? createImageBitmap(blob) : null)).then((bmp) => {
      bitmaps.set(a.id, bmp || 'missing');
      if (bmp) onReady?.();
    }).catch(() => bitmaps.set(a.id, 'missing'));
  }
  return null;
}

/* ---------- static rendering (previews, AI) ---------- */
function drawPattern(g, paper, view, W, H, dpr, { faint = false, dark = false } = {}) {
  if (paper === 'blank') return;
  let step = 40;
  while (step * view.z < 14) step *= 2; // keep lines at least 14 css px apart when zoomed out
  const sx = step * view.z * dpr;
  const ox = ((-view.x * view.z * dpr) % sx + sx) % sx;
  const oy = ((-view.y * view.z * dpr) % sx + sx) % sx;
  g.save();
  if (paper === 'grid' || paper === 'lined') {
    g.strokeStyle = lineColor(paper === 'lined' ? 'lined' : 'grid', dark, faint);
    g.lineWidth = Math.max(1, dpr * 0.8);
    g.beginPath();
    if (paper === 'grid') for (let x = ox; x < W; x += sx) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, H); }
    for (let y = oy; y < H; y += sx) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); }
    g.stroke();
  } else if (paper === 'dots') {
    g.fillStyle = lineColor('dots', dark, faint);
    const r = Math.max(1, 1.4 * dpr * Math.min(1, view.z));
    for (let x = ox; x < W; x += sx) for (let y = oy; y < H; y += sx) g.fillRect(x - r / 2, y - r / 2, r, r);
  }
  g.restore();
}

function drawWorld(g, topicId, tiles, images, view, W, H, dpr, { onBitmap, skipStroke, dark = false } = {}) {
  const vis = [view.x, view.y, view.x + W / (view.z * dpr), view.y + H / (view.z * dpr)];
  g.setTransform(view.z * dpr, 0, 0, view.z * dpr, -view.x * view.z * dpr, -view.y * view.z * dpr);
  for (const a of images) {
    if (!overlaps(imgBox(a), vis)) continue;
    const bmp = bitmapFor(a, onBitmap);
    if (bmp) g.drawImage(bmp, a.x, a.y, a.bw, a.bh);
    else { g.fillStyle = dark ? '#2A2F39' : '#ECEEF3'; g.fillRect(a.x, a.y, a.bw, a.bh); }
  }
  for (const t of tiles) {
    for (const st of t.s || []) {
      if (st === skipStroke) continue;
      if (overlaps(strokeBox(st), vis)) drawStroke(g, st, 1, dark);
    }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

// Preview image of the whole board for the topic page (data URL, cached per edit).
const thumbCache = new Map();
export function thumbnail(topicId, width = 640, height = 240) {
  const dark = isDark(topicId);
  const key = `${topicId}:${lastEdit(topicId)}:${width}x${height}:${dark ? 'd' : 'l'}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const b = contentBounds(topicId);
  if (!b) return '';
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const g = c.getContext('2d');
  g.fillStyle = paperColor(dark); g.fillRect(0, 0, width, height);
  const pad = 30;
  const z = Math.min(1.2, (width - pad * 2) / Math.max(1, b[2] - b[0]), (height - pad * 2) / Math.max(1, b[3] - b[1]));
  const view = { x: (b[0] + b[2]) / 2 - width / 2 / z, y: (b[1] + b[3]) / 2 - height / 2 / z, z };
  drawWorld(g, topicId, tilesOf(topicId), boardImagesOf(topicId), view, width, height, 1, { dark });
  const url = c.toDataURL('image/png');
  thumbCache.set(key, url);
  return url;
}

// Render the board as page-sized JPEG regions for the AI (skips empty regions).
// Always dark ink on white, even for a black board: that's what handwriting recognition reads best.
export async function regionBlobs(topicId, { maxRegions = 16 } = {}) {
  const b = contentBounds(topicId);
  if (!b) return [];
  const images = boardImagesOf(topicId);
  await Promise.all(images.map((a) => new Promise((res) => { if (bitmapFor(a, res)) res(); else setTimeout(res, 1500); })));
  const RW = 1500; const RH = 2000; // world units per region
  const out = [];
  const tiles = tilesOf(topicId);
  for (let y = b[1] - 20; y < b[3] && out.length < maxRegions; y += RH) {
    for (let x = b[0] - 20; x < b[2] && out.length < maxRegions; x += RW) {
      const box = [x, y, x + RW, y + RH];
      const any = tiles.some((t) => (t.s || []).some((st) => overlaps(strokeBox(st), box))) || images.some((a) => overlaps(imgBox(a), box));
      if (!any) continue;
      const w = Math.min(RW, b[2] + 20 - x); const h = Math.min(RH, b[3] + 20 - y);
      const scale = Math.min(1, 1400 / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
      const g = c.getContext('2d');
      g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height);
      drawWorld(g, topicId, tiles, images, { x, y, z: scale }, c.width, c.height, 1);
      out.push(await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85)));
    }
  }
  return out;
}

/* ---------- the editor ---------- */
export function mountBoard(root, topic, { onAction } = {}) {
  const topicId = topic.id;
  const stage = root.querySelector('[data-board-stage]');
  const base = root.querySelector('[data-board-base]');
  const over = root.querySelector('[data-board-over]');
  const bar = root.querySelector('[data-board-bar]');
  const zoomLabel = () => root.querySelector('[data-board-zoom]');
  // Low-latency ink: a "desynchronized" canvas is shown on screen as soon as it is drawn,
  // without waiting for the browser's next frame (Chrome on Android and ChromeOS). The pen
  // stroke is painted straight onto it, one piece per pen event, like OneNote does.
  const wantDirect = store.getMeta('inkLowLatency', true) !== false;
  let g = null;
  if (wantDirect) { try { g = base.getContext('2d', { desynchronized: true, alpha: false }); } catch { g = null; } }
  if (!g) g = base.getContext('2d', { alpha: false });
  const direct = wantDirect && !!g.getContextAttributes?.().desynchronized;
  root.dataset.lowLatency = direct ? '1' : '0';
  const og = over.getContext('2d');
  // Nothing sits above the ink layer unless needed (lets the browser put it on a fast path).
  let overShown = true;
  const showOver = (on) => { if (on !== overShown) { overShown = on; over.style.visibility = on ? '' : 'hidden'; } };

  // Local working copy of the tiles, keyed by record id (or a temporary key until first save).
  // Two devices may create a tile for the same square; both are kept and both are drawn.
  const tiles = new Map();
  const dirty = new Set();
  const loadTiles = () => {
    const keyOfId = new Map([...tiles].filter(([, t]) => t.id).map(([k, t]) => [t.id, k]));
    for (const t of tilesOf(topicId)) {
      const key = keyOfId.get(t.id) || t.id;
      if (dirty.has(key)) continue;
      tiles.set(key, { ...t, s: (t.s || []).slice() });
    }
    for (const [key, t] of tiles) if (t.id && !store.get(t.id) && !dirty.has(key)) tiles.delete(key);
  };
  let images = boardImagesOf(topicId).map((a) => ({ ...a }));
  loadTiles();

  let paper = topic.board?.paper || 'grid';
  let dark = !!topic.board?.dark;
  const applyBg = () => { stage.style.background = paperColor(dark); root.classList.toggle('dark-paper', dark); };
  applyBg();
  const tool = { t: 'p', c: PEN_COLORS[0], hc: HL_COLORS[0], size: 1, mode: 'draw' }; // mode: draw | erase | select | hand
  let fingerMode = store.getMeta('inkFinger', null);
  const undo = []; const redo = [];
  let dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  let W = 0; let H = 0;
  let selected = null; // image id

  // View: world coordinate at the top-left and zoom (css px per world unit).
  const saved = store.getMeta(`board:${topicId}`, null);
  const view = saved ? { ...saved } : { x: -60, y: -60, z: 1 };

  /* --- sizing & drawing --- */
  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = Math.round(r.width * dpr); H = Math.round(r.height * dpr);
    for (const c of [base, over]) { c.width = W; c.height = H; }
    rect = null;
    if (!saved && !resize.done) fitDefault(r.width);
    resize.done = true;
    redraw();
  }
  function fitDefault(cssW) {
    const b = contentBounds(topicId);
    if (b) fitTo(b, cssW);
    else { view.z = Math.min(1.4, Math.max(0.6, cssW / 1100)); view.x = -40; view.y = -40; }
  }
  function fitTo(b, cssW = W / dpr, cssH = H / dpr) {
    const pad = 40;
    view.z = Math.min(1.6, Math.max(MIN_Z, (cssW - pad * 2) / Math.max(200, b[2] - b[0]), (cssH - pad * 2) / Math.max(200, b[3] - b[1])));
    view.x = b[0] - pad / view.z;
    view.y = b[1] - pad / view.z;
  }
  const allTiles = () => [...tiles.values()];
  function redraw() {
    if (!W) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = paperColor(dark); g.fillRect(0, 0, W, H);
    drawPattern(g, paper, view, W, H, dpr, { dark });
    drawWorld(g, topicId, allTiles(), images, view, W, H, dpr, { dark, onBitmap: () => requestAnimationFrame(redraw) });
    if (active?.kind === 'draw' && active.st.t === 'p') { worldOn(g); drawStroke(g, active.st, 1, dark); g.setTransform(1, 0, 0, 1, 0, 0); }
    drawOverlay();
    const zl = zoomLabel(); if (zl) zl.textContent = `${Math.round(view.z * 100)}%`;
  }
  const worldOn = (ctx) => ctx.setTransform(view.z * dpr, 0, 0, view.z * dpr, -view.x * view.z * dpr, -view.y * view.z * dpr);
  // The overlay holds what isn't final yet: the live highlighter stroke, the predicted tip of the
  // pen (only without low-latency mode, where the pen itself is already on the ink layer) and
  // the photo selection box.
  function drawOverlay() {
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.clearRect(0, 0, W, H);
    let any = false;
    if (active?.kind === 'draw') {
      const st = active.st;
      const n = st.p.length / 3;
      const lastP = st.p[st.p.length - 1];
      const pred = active.pred?.length ? active.pred.flatMap(([x, y]) => [x, y, lastP]) : [];
      if (st.t === 'h') { worldOn(og); drawStroke(og, pred.length ? { ...st, p: st.p.concat(pred) } : st, 1, dark); any = true; }
      else if (!direct && n >= 2) { worldOn(og); drawStroke(og, { ...st, p: st.p.slice(-6).concat(pred) }, 1, dark); any = true; }
      og.setTransform(1, 0, 0, 1, 0, 0);
    }
    const sel = images.find((a) => a.id === selected);
    if (sel) any = true;
    if (sel) {
      const [sx, sy] = toScreen(sel.x, sel.y);
      const sw = sel.bw * view.z * dpr; const sh = sel.bh * view.z * dpr;
      const selC = dark ? '#86A2FF' : '#3552C9';
      og.strokeStyle = selC; og.lineWidth = 2 * dpr; og.setLineDash([6 * dpr, 4 * dpr]);
      og.strokeRect(sx, sy, sw, sh);
      og.setLineDash([]);
      og.fillStyle = selC;
      const hs = 14 * dpr;
      og.fillRect(sx + sw - hs / 2, sy + sh - hs / 2, hs, hs);
    }
    showOver(any);
  }
  // Paint pen pieces [from, to) of the live stroke onto the ink layer, plus the tail at the end.
  function paintPen(st, from, to, tail) {
    g.save(); worldOn(g); penStyle(g, st, dark);
    if (st.p.length === 3 && tail) { g.beginPath(); g.arc(st.p[0], st.p[1], penWidth(st, 0, 1) / 2, 0, Math.PI * 2); g.fill(); } // a dot
    for (let i = Math.max(1, from); i < to; i++) penSegment(g, st, i, 1);
    if (tail) penTail(g, st, 1);
    g.restore();
  }
  const toScreen = (x, y) => [(x - view.x) * view.z * dpr, (y - view.y) * view.z * dpr];
  let rect = null; // cached: reading layout on every pen event costs time
  const getRect = () => rect || (rect = base.getBoundingClientRect());
  function toWorld(ev) {
    const r = getRect();
    return [view.x + (ev.clientX - r.left) / view.z, view.y + (ev.clientY - r.top) / view.z];
  }

  /* --- fast pan/zoom: move a snapshot, redraw fully when the gesture ends --- */
  let snap = null;
  function beginGesture() {
    if (snap) return;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(base, 0, 0);
    snap = { c, view: { ...view } };
  }
  function paintGesture() {
    if (!snap) return;
    const ratio = view.z / snap.view.z;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = paperColor(dark); g.fillRect(0, 0, W, H);
    g.drawImage(snap.c, (snap.view.x - view.x) * view.z * dpr, (snap.view.y - view.y) * view.z * dpr, W * ratio, H * ratio);
    const zl = zoomLabel(); if (zl) zl.textContent = `${Math.round(view.z * 100)}%`;
  }
  const endGesture = debounce(() => { snap = null; redraw(); saveView(); }, 90);
  const saveView = debounce(() => store.setMeta(`board:${topicId}`, { x: view.x, y: view.y, z: view.z }), 400);
  function zoomAt(cssX, cssY, factor) {
    const nz = Math.min(MAX_Z, Math.max(MIN_Z, view.z * factor));
    const wx = view.x + cssX / view.z; const wy = view.y + cssY / view.z;
    view.z = nz; view.x = wx - cssX / nz; view.y = wy - cssY / nz;
  }

  /* --- saving --- */
  // Saved once you pause, so writing is never interrupted by the database.
  const saveTiles = debounce(async () => {
    if (active?.kind === 'draw' || active?.kind === 'erase') { saveTiles(); return; }
    await saveTilesNow(); setSaved(true);
  }, 1200);
  let savedState = true;
  function setSaved(ok) { if (ok === savedState) return; savedState = ok; const s = root.querySelector('[data-board-saved]'); if (s) s.textContent = ok ? 'Salvato' : 'Salvataggio…'; }
  function updateHistory() {
    const u = bar.querySelector('[data-b=undo]'); const r = bar.querySelector('[data-b=redo]');
    if (u) u.disabled = !undo.length; if (r) r.disabled = !redo.length;
  }
  function touch(key) { dirty.add(key); setSaved(false); saveTiles(); }
  function tileFor(st) {
    const tx = Math.floor(st.p[0] / TILE); const ty = Math.floor(st.p[1] / TILE);
    for (const [key, t] of tiles) if (t.tx === tx && t.ty === ty) return key;
    const key = `new:${tx},${ty}:${Date.now()}`;
    tiles.set(key, { topicId, tx, ty, s: [] });
    return key;
  }

  /* --- erasing --- */
  function eraseAt(x, y, removed) {
    const R = 12 / view.z;
    let hit = false;
    const probe = [x - R, y - R, x + R, y + R];
    for (const [key, t] of tiles) {
      for (let i = t.s.length - 1; i >= 0; i--) {
        const st = t.s[i];
        if (!overlaps(strokeBox(st), probe)) continue;
        const r2 = (R + st.w / 2) ** 2;
        for (let k = 0; k < st.p.length; k += 3) {
          if ((st.p[k] - x) ** 2 + (st.p[k + 1] - y) ** 2 <= r2) {
            t.s.splice(i, 1); removed.push({ key, st, index: i }); touch(key); hit = true; break;
          }
        }
      }
    }
    if (hit) redraw();
  }

  /* --- undo --- */
  function doUndo() {
    const op = undo.pop(); if (!op) return;
    if (op.op === 'add') { const t = tiles.get(op.key); const i = t ? t.s.lastIndexOf(op.st) : -1; if (i >= 0) { t.s.splice(i, 1); touch(op.key); } }
    else [...op.items].reverse().forEach(({ key, st, index }) => { const k = tiles.has(key) ? key : tileFor(st); tiles.get(k).s.splice(Math.min(index, tiles.get(k).s.length), 0, st); touch(k); });
    redo.push(op); redraw(); renderBar();
  }
  function doRedo() {
    const op = redo.pop(); if (!op) return;
    if (op.op === 'add') { const k = tiles.has(op.key) ? op.key : tileFor(op.st); tiles.get(k).s.push(op.st); touch(k); }
    else op.items.forEach(({ key, st }) => { const t = tiles.get(key); const i = t ? t.s.indexOf(st) : -1; if (i >= 0) { t.s.splice(i, 1); touch(key); } });
    undo.push(op); redraw(); renderBar();
  }

  /* --- pointers --- */
  const pointers = new Map(); // id -> {x, y, type}
  let active = null;          // draw | erase | pan | pinch | move | resize
  const capture = (id) => { try { stage.setPointerCapture(id); } catch { /* synthetic */ } };
  const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? Math.round(Math.min(1, e.pressure) * 100) : 55);
  const cssPos = (e) => { const r = getRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const q = (v) => Math.round(v * 10) / 10; // points keep a tenth of a unit: smooth even when zoomed in
  let lastPenUp = 0;

  const touchPts = () => [...pointers.values()].filter((p) => p.type === 'touch');
  function startPinch() {
    const [a, b] = touchPts();
    if (active?.kind === 'draw') { active = null; redraw(); } // a second finger cancels a finger stroke
    beginGesture();
    active = { kind: 'pinch', ptype: 'touch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: view.z, mid0: [(a.x + b.x) / 2, (a.y + b.y) / 2], v0: { ...view } };
  }
  function hitImage(x, y) {
    for (let i = images.length - 1; i >= 0; i--) { const a = images[i]; if (x >= a.x && x <= a.x + a.bw && y >= a.y && y <= a.y + a.bh) return a; }
    return null;
  }
  function hitHandle(x, y) {
    const a = images.find((i) => i.id === selected); if (!a) return null;
    const h = 16 / view.z;
    return Math.abs(x - (a.x + a.bw)) < h && Math.abs(y - (a.y + a.bh)) < h ? a : null;
  }

  stage.addEventListener('pointerdown', (ev) => {
    rect = null;
    const [cx, cy] = cssPos(ev);
    pointers.set(ev.pointerId, { x: cx, y: cy, type: ev.pointerType });
    if (ev.pointerType === 'pen' && fingerMode === null) { fingerMode = 'scroll'; store.setMeta('inkFinger', 'scroll'); renderBar(); }
    const penBusy = active && active.ptype === 'pen';
    if (ev.pointerType === 'touch' && penBusy) return; // palm while writing: ignore completely
    if (ev.pointerType === 'touch' && touchPts().length >= 2 && (!active || active.ptype === 'touch')) { capture(ev.pointerId); startPinch(); return; }
    if (active) return; // palm rejection: one drawing pointer at a time
    ev.preventDefault();
    capture(ev.pointerId);
    const [x, y] = toWorld(ev);
    const panWith = (ev.pointerType === 'touch' && fingerMode === 'scroll') || tool.mode === 'hand' || ev.button === 1 || (ev.pointerType === 'mouse' && spaceDown);
    if (panWith) { beginGesture(); active = { kind: 'pan', ptype: ev.pointerType, id: ev.pointerId, sx: cx, sy: cy, v0: { ...view } }; return; }
    if (ev.pointerType === 'mouse' && ev.button === 2) return;
    if (tool.mode === 'select') {
      const h = hitHandle(x, y);
      if (h) { active = { kind: 'resize', ptype: ev.pointerType, id: ev.pointerId, img: h, ratio: h.bh / h.bw }; return; }
      const img = hitImage(x, y);
      selected = img ? img.id : null; renderBar(); drawOverlay();
      if (img) active = { kind: 'move', ptype: ev.pointerType, id: ev.pointerId, img, dx: x - img.x, dy: y - img.y };
      else { beginGesture(); active = { kind: 'pan', ptype: ev.pointerType, id: ev.pointerId, sx: cx, sy: cy, v0: { ...view } }; }
      return;
    }
    const erasing = tool.mode === 'erase' || (ev.pointerType === 'pen' && (ev.buttons & 34));
    if (erasing) { active = { kind: 'erase', ptype: ev.pointerType, id: ev.pointerId, removed: [], last: [x, y] }; eraseAt(x, y, active.removed); return; }
    const st = tool.t === 'h'
      ? { t: 'h', c: tool.hc, w: SIZES.h[tool.size], p: [q(x), q(y), 50] }
      : { t: 'p', c: tool.c, w: SIZES.p[tool.size], p: [q(x), q(y), pressureOf(ev)] };
    active = { kind: 'draw', ptype: ev.pointerType, id: ev.pointerId, st, pred: [], raf: 0, raw: false };
    if (st.t === 'h') drawOverlay();
  });

  // New points for the stroke (or eraser) in progress. Called for every pen event.
  function addPoints(ev) {
    const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
    const st = active.st;
    const n0 = st ? st.p.length / 3 : 0;
    for (const e of evs.length ? evs : [ev]) {
      const [wx, wy] = toWorld(e);
      if (active.kind === 'erase') {
        const [lx, ly] = active.last;
        const steps = Math.max(1, Math.ceil(Math.hypot(wx - lx, wy - ly) / (6 / view.z)));
        for (let k = 1; k <= steps; k++) eraseAt(lx + ((wx - lx) * k) / steps, ly + ((wy - ly) * k) / steps, active.removed);
        active.last = [wx, wy];
        continue;
      }
      const pts = st.p;
      const rx = q(wx); const ry = q(wy);
      if (Math.abs(rx - pts[pts.length - 3]) + Math.abs(ry - pts[pts.length - 2]) < 1.2 / view.z) continue; // under ~1 screen px
      let pr = 50;
      if (st.t === 'p') {
        pr = pressureOf(e);
        if (active.ptype === 'pen') pr = Math.round(pts[pts.length - 1] + (pr - pts[pts.length - 1]) * 0.5); // smooth pressure changes
      }
      pts.push(rx, ry, pr);
    }
    if (active.kind !== 'draw') return;
    const n1 = st.p.length / 3;
    if (st.t === 'p' && n1 > n0) paintPen(st, n0, n1, false); // straight onto the ink layer: no waiting for the next frame
    if ((st.t === 'h' || !direct) && !active.raf) active.raf = requestAnimationFrame(() => { if (active?.kind === 'draw') { active.raf = 0; drawOverlay(); } });
  }

  // pointerrawupdate delivers pen positions as soon as they arrive, instead of once per frame.
  if ('onpointerrawupdate' in window) {
    stage.addEventListener('pointerrawupdate', (ev) => {
      if (!active || ev.pointerId !== active.id || (active.kind !== 'draw' && active.kind !== 'erase')) return;
      active.raw = true;
      addPoints(ev);
    });
  }

  stage.addEventListener('pointermove', (ev) => {
    const p = pointers.get(ev.pointerId);
    if (p) { const [cx, cy] = cssPos(ev); p.x = cx; p.y = cy; }
    if (!active) return;
    if (active.kind === 'pinch') {
      const tp = touchPts();
      if (tp.length < 2) return;
      const [a, b] = tp;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      Object.assign(view, active.v0);
      zoomAt(active.mid0[0], active.mid0[1], d / Math.max(1, active.d0));
      view.x -= (mid[0] - active.mid0[0]) / view.z; view.y -= (mid[1] - active.mid0[1]) / view.z;
      paintGesture();
      return;
    }
    if (ev.pointerId !== active.id) return;
    ev.preventDefault();
    const [cx, cy] = cssPos(ev);
    if (active.kind === 'pan') {
      view.x = active.v0.x - (cx - active.sx) / view.z; view.y = active.v0.y - (cy - active.sy) / view.z;
      paintGesture(); return;
    }
    const [x, y] = toWorld(ev);
    if (active.kind === 'move') { active.img.x = x - active.dx; active.img.y = y - active.dy; redraw(); return; }
    if (active.kind === 'resize') { const img = active.img; img.bw = Math.max(40, x - img.x); img.bh = img.bw * active.ratio; redraw(); return; }
    if (!active.raw) addPoints(ev);
    if (active.kind === 'draw' && (active.st.t === 'h' || !direct)) {
      active.pred = (ev.getPredictedEvents ? ev.getPredictedEvents().slice(0, 3) : []).map((e) => toWorld(e).map(q));
      if (!active.raf) active.raf = requestAnimationFrame(() => { if (active?.kind === 'draw') { active.raf = 0; drawOverlay(); } });
    }
  });

  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    if (!active) return;
    if (active.kind === 'pinch') {
      if (touchPts().length < 2) { active = null; endGesture(); }
      return;
    }
    if (ev.pointerId !== active.id) return;
    const a = active; active = null;
    if (a.kind === 'pan') endGesture();
    else if (a.kind === 'draw') {
      cancelAnimationFrame(a.raf);
      const key = tileFor(a.st);
      tiles.get(key).s.push(a.st);
      if (a.st.t === 'p') paintPen(a.st, a.st.p.length / 3, a.st.p.length / 3, true); // only the last bit is missing
      else { worldOn(g); drawStroke(g, a.st, 1, dark); g.setTransform(1, 0, 0, 1, 0, 0); }
      drawOverlay();
      lastPenUp = Date.now();
      undo.push({ op: 'add', key, st: a.st }); redo.length = 0; touch(key); updateHistory();
    } else if (a.kind === 'erase' && a.removed.length) {
      lastPenUp = Date.now();
      undo.push({ op: 'erase', items: a.removed }); redo.length = 0; updateHistory();
    } else if (a.kind === 'move' || a.kind === 'resize') {
      const img = a.img;
      const cur = store.get(img.id);
      if (cur) store.put('attachment', { ...cur, x: Math.round(img.x), y: Math.round(img.y), bw: Math.round(img.bw), bh: Math.round(img.bh) });
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    beginGesture();
    const [cx, cy] = cssPos(ev);
    if (ev.ctrlKey || ev.metaKey) zoomAt(cx, cy, Math.exp(-ev.deltaY * 0.0022));
    else { view.x += (ev.shiftKey ? ev.deltaY : ev.deltaX) / view.z; view.y += (ev.shiftKey ? 0 : ev.deltaY) / view.z; }
    paintGesture();
    endGesture();
  }, { passive: false });

  let spaceDown = false;
  const onKey = (ev) => {
    if (ev.target.matches('input, textarea, select')) return;
    if (ev.type === 'keydown' && ev.code === 'Space') { spaceDown = true; stage.style.cursor = 'grab'; ev.preventDefault(); }
    if (ev.type === 'keyup' && ev.code === 'Space') { spaceDown = false; stage.style.cursor = ''; }
    if (ev.type !== 'keydown') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? doRedo() : doUndo(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); doRedo(); }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected) { ev.preventDefault(); deleteSelected(); }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKey);

  /* --- photos --- */
  async function addImages(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) { toast('Sul quaderno puoi inserire solo immagini. I PDF vanno allegati alle note.', 'bad'); return; }
    let k = 0;
    for (const f of list) {
      const cssW = W / dpr; const cssH = H / dpr;
      const cx = view.x + cssW / 2 / view.z + k * 30; const cy = view.y + cssH / 2 / view.z + k * 30;
      const a = await att.addBoardImage(topicId, f, { cx, cy, maxW: Math.min(900, (cssW * 0.6) / view.z) });
      if (a) { images.push({ ...a }); selected = a.id; k++; }
    }
    if (k) { tool.mode = 'select'; renderBar(); redraw(); toast(`${k === 1 ? 'Foto inserita' : k + ' foto inserite'}: trascinala o usa l'angolo per ridimensionarla`); }
  }
  async function deleteSelected() {
    if (!selected) return;
    await att.removeAttachment(selected);
    images = images.filter((a) => a.id !== selected);
    selected = null; renderBar(); redraw();
    toast('Foto rimossa dal quaderno');
  }
  root.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addImages(files); }
  });
  stage.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  stage.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addImages(e.dataTransfer.files); } });

  /* --- toolbar --- */
  const ICON = {
    p: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
    h: '<path d="M9 15l-3 5h6l1-2M9 15l7-11 4 3-7 11z"/>',
    e: '<path d="M8 20h12M5 14l8-8 6 6-6 6H9z"/>',
    s: '<path d="M5 3l6 16 2.2-6.8L20 10z"/>',
    hand: '<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3 14a1.5 1.5 0 0 1 2.5-1.6L8 15"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    img: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  function renderBar() {
    const colors = tool.t === 'h' ? HL_COLORS : PEN_COLORS;
    const cur = tool.t === 'h' ? tool.hc : tool.c;
    const is = (m, t) => tool.mode === m && (!t || tool.t === t);
    bar.innerHTML = `
      <div class="ink-group" aria-label="Strumento">
        <button type="button" data-b="tool" data-v="p" aria-pressed="${is('draw', 'p')}" title="Penna">${svg('p')}<span>Penna</span></button>
        <button type="button" data-b="tool" data-v="h" aria-pressed="${is('draw', 'h')}" title="Evidenziatore">${svg('h')}<span>Evidenz.</span></button>
        <button type="button" data-b="mode" data-v="erase" aria-pressed="${is('erase')}" title="Gomma (o tasto laterale della penna)">${svg('e')}<span>Gomma</span></button>
        <button type="button" data-b="mode" data-v="select" aria-pressed="${is('select')}" title="Seleziona e sposta le foto">${svg('s')}<span>Seleziona</span></button>
        <button type="button" data-b="mode" data-v="hand" aria-pressed="${is('hand')}" title="Sposta il foglio">${svg('hand')}<span>Sposta</span></button>
      </div>
      ${tool.mode === 'draw' ? `
      <div class="ink-group swatches-ink" aria-label="Colore">${colors.map((c) => `<button type="button" data-b="color" data-v="${c}" aria-pressed="${c === cur}" style="--sw:${shownColor(c, dark)}" title="Colore"></button>`).join('')}</div>
      <div class="ink-group" aria-label="Spessore">${[0, 1, 2].map((i) => `<button type="button" data-b="size" data-v="${i}" aria-pressed="${tool.size === i}" title="Spessore ${i + 1}"><i style="width:${[4, 7, 11][i]}px;height:${[4, 7, 11][i]}px"></i></button>`).join('')}</div>` : ''}
      ${selected ? `<div class="ink-group"><button type="button" data-b="del-img" class="danger-text">Elimina foto</button></div>` : ''}
      <div class="ink-group">
        <button type="button" data-b="undo" title="Annulla" ${undo.length ? '' : 'disabled'}>${svg('undo')}</button>
        <button type="button" data-b="redo" title="Ripeti" ${redo.length ? '' : 'disabled'}>${svg('redo')}</button>
      </div>
      <div class="ink-group">
        <button type="button" data-b="zoom" data-v="0.8" title="Riduci">−</button>
        <button type="button" data-b="fit" title="Mostra tutto">${svg('fit')}<span data-board-zoom>${Math.round(view.z * 100)}%</span></button>
        <button type="button" data-b="zoom" data-v="1.25" title="Ingrandisci">+</button>
      </div>
      <div class="ink-group">
        <label class="bar-file" title="Inserisci una foto (fotocamera o galleria)">${svg('img')}<span>Foto</span><input type="file" accept="image/*" multiple data-b-file hidden></label>
        <select data-b="paper" aria-label="Tipo di foglio">${[['grid', 'Quadretti'], ['lined', 'Righe'], ['dots', 'Puntini'], ['blank', 'Senza righe']].map(([k, l]) => `<option value="${k}" ${paper === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select data-b="bg" aria-label="Colore del foglio">${[['light', 'Foglio bianco'], ['dark', 'Foglio nero']].map(([k, l]) => `<option value="${k}" ${(dark ? 'dark' : 'light') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button type="button" data-b="finger" title="Cosa fa il dito sullo schermo">${fingerMode === 'scroll' ? 'Dito: sposta' : 'Dito: scrive'}</button>
      </div>`;
  }
  bar.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-b]'); if (!b || b.tagName === 'SELECT') return;
    const k = b.dataset.b; const v = b.dataset.v;
    if (k === 'tool') { tool.mode = 'draw'; tool.t = v; }
    if (k === 'mode') tool.mode = v;
    if (k === 'color') { if (tool.t === 'h') tool.hc = v; else tool.c = v; }
    if (k === 'size') tool.size = +v;
    if (k === 'undo') return doUndo();
    if (k === 'redo') return doRedo();
    if (k === 'del-img') return deleteSelected();
    if (k === 'zoom') { zoomAt(W / dpr / 2, H / dpr / 2, +v); redraw(); saveView(); }
    if (k === 'fit') { const bx = contentBoundsLocal(); if (bx) fitTo(bx); else { view.z = 1; view.x = -40; view.y = -40; } redraw(); saveView(); }
    if (k === 'finger') { fingerMode = fingerMode === 'scroll' ? 'draw' : 'scroll'; store.setMeta('inkFinger', fingerMode); }
    if (tool.mode !== 'select' && selected) { selected = null; drawOverlay(); }
    stage.dataset.mode = tool.mode;
    renderBar();
  });
  bar.addEventListener('change', (ev) => {
    if (ev.target.dataset.b === 'paper' || ev.target.dataset.b === 'bg') {
      if (ev.target.dataset.b === 'paper') paper = ev.target.value;
      else { dark = ev.target.value === 'dark'; applyBg(); renderBar(); }
      redraw();
      const t = store.get(topicId); if (t) store.put('topic', { ...t, board: { ...(t.board || {}), paper, dark } });
    }
    if (ev.target.matches('[data-b-file]')) { addImages(ev.target.files); ev.target.value = ''; }
  });
  function contentBoundsLocal() {
    let b = null;
    const grow = (x) => { b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : [...x]; };
    for (const t of tiles.values()) for (const st of t.s) grow(strokeBox(st));
    for (const a of images) grow(imgBox(a));
    return b;
  }

  /* --- remote changes (another device drew on this board) --- */
  const signature = () => tilesOf(topicId).map((t) => t.id + t.updated_at).join() + '|' + boardImagesOf(topicId).map((a) => a.id + a.updated_at).join();
  let lastSig = signature();
  let remoteTimer = 0;
  function applyRemote() {
    clearTimeout(remoteTimer);
    // redrawing a big board takes a moment: wait until the pen has been still for a bit
    if (active || Date.now() - lastPenUp < 1500) { remoteTimer = setTimeout(applyRemote, 700); return; }
    loadTiles();
    images = boardImagesOf(topicId).map((a) => ({ ...a }));
    redraw();
  }
  const unsub = store.subscribe((src) => {
    if (src !== 'remote') return;
    const tb = store.get(topicId)?.board || {};
    const look = (tb.paper || 'grid') !== paper || !!tb.dark !== dark;
    if (look) { paper = tb.paper || 'grid'; dark = !!tb.dark; applyBg(); renderBar(); }
    const sig = signature();
    if (sig === lastSig && !look) return;
    lastSig = sig;
    applyRemote();
  });

  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);
  renderBar();
  stage.dataset.mode = tool.mode;
  resize();

  return {
    saveNow: () => saveTilesNow(),
    destroy() { ro.disconnect(); unsub(); clearTimeout(remoteTimer); document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKey); },
  };

  async function saveTilesNow() {
    const keys = [...dirty]; dirty.clear();
    for (const key of keys) {
      const t = tiles.get(key);
      if (!t) continue;
      if (!t.s.length) { if (t.id) await store.remove(t.id); tiles.delete(key); continue; }
      const rec = await store.put('tile', { id: t.id, topicId, tx: t.tx, ty: t.ty, s: t.s });
      t.id = rec.id;
    }
  }
}

export { today };
