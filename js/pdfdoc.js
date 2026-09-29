// PDFs you can write on, like a OneNote "printout": the pages are laid out one below the
// other on an infinite sheet and the Quaderno pen engine (board.js) draws ink on top.
//
// Layout: world units where an A4 page is 1000 units wide (1 PDF point = 1000/595.28 units),
// pages centred on the widest one, GAP units apart. It depends only on the PDF itself, so the
// same file gives the same layout on every device and ink stays exactly where it was written.
// Ink is stored in tiles with { docId: <attachment id> } (see board.js). The PDF is never modified.
//
// Rendering (PDF.js, bundled in vendor/): each page has a "base" image at one of a few sizes
// chosen from the zoom, and when zoomed in further a "detail" image of just the visible part
// at full sharpness. Rendering waits while the pen is busy so it never slows down writing.

import * as store from './store.js';

const V = new URL('../vendor/pdfjs-6.3.289/', import.meta.url).href;
export const UNIT = 1000 / 595.28;
export const GAP = 40;
const BASE_STEPS = [384, 768, 1280, 1920]; // page widths in pixels for the base images
const BUDGET = 36e6;                        // pixels kept in base images (~140 MB)

let libPromise = null;
function lib() {
  if (!libPromise) {
    libPromise = import(V + 'pdf.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.mjs'; return m; })
      .catch((e) => { libPromise = null; throw e; });
  }
  return libPromise;
}

const r2 = (v) => Math.round(v * 100) / 100;
export function layout(sizes) {
  const maxW = Math.max(...sizes.map((s) => s[0])) * UNIT;
  let y = 0;
  return sizes.map(([w, h], i) => {
    const pw = r2(w * UNIT); const ph = r2(h * UNIT);
    const pg = { n: i + 1, x: r2((maxW - pw) / 2), y: r2(y), w: pw, h: ph };
    y += ph + GAP;
    return pg;
  });
}

// Open a PDF blob. Page sizes are remembered per attachment so big files open quickly next time.
export async function openPdf(id, blob) {
  const pdfjs = await lib();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data, cMapUrl: V + 'cmaps/', cMapPacked: true, standardFontDataUrl: V + 'standard_fonts/',
    wasmUrl: V + 'wasm/', iccUrl: V + 'iccs/', enableXfa: false,
  }).promise;
  const key = `pdfsizes:${id}`;
  let sizes = store.getMeta(key, null);
  if (!Array.isArray(sizes) || sizes.length !== doc.numPages) {
    sizes = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      return [r2(v.width), r2(v.height)];
    })));
    store.setMeta(key, sizes);
  }
  return { doc, pages: layout(sizes) };
}

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const pageBox = (pg) => [pg.x, pg.y, pg.x + pg.w, pg.y + pg.h];

// The page layer drawn under the ink. onReady: a new image is available (redraw).
// isBusy: true while writing, so rendering waits.
export function pdfLayer(doc, pages, { onReady, isBusy }) {
  const base = new Map();   // page n -> { c: canvas, px: width in pixels }
  const detail = new Map(); // page n -> { c, box: world rect, k: pixels per unit }
  let jobs = [];
  let running = null;       // { job, task }
  let timer = 0;
  let destroyed = false;
  let center = 0;           // world y at the middle of the screen, for eviction
  const width = Math.max(...pages.map((p) => p.x + p.w));
  const height = pages.length ? pages[pages.length - 1].y + pages[pages.length - 1].h : 0;
  const darkUi = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  };
  const gutter = darkUi() ? '#22262E' : '#D8DCE3';

  function draw(g, vis, view, dpr) {
    const line = 1 / (view.z * dpr);
    for (const pg of pages) {
      const box = pageBox(pg);
      if (!overlaps(box, vis)) continue;
      g.fillStyle = '#FFFFFF';
      g.fillRect(pg.x, pg.y, pg.w, pg.h);
      const b = base.get(pg.n);
      if (b) g.drawImage(b.c, pg.x, pg.y, pg.w, pg.h);
      const d = detail.get(pg.n);
      if (d && overlaps(d.box, vis)) g.drawImage(d.c, d.box[0], d.box[1], d.box[2] - d.box[0], d.box[3] - d.box[1]);
      g.strokeStyle = 'rgba(20, 28, 48, 0.22)';
      g.lineWidth = line;
      g.strokeRect(pg.x - line / 2, pg.y - line / 2, pg.w + line, pg.h + line);
    }
  }

  // Decide what needs rendering for this view; replaces any earlier plan.
  function update(view, W, H, dpr) {
    if (destroyed) return;
    const vw = W / (view.z * dpr); const vh = H / (view.z * dpr);
    const vis = [view.x, view.y, view.x + vw, view.y + vh];
    center = view.y + vh / 2;
    const near = [vis[0], vis[1] - vh * 0.6, vis[2], vis[3] + vh * 0.6]; // prefetch half a screen around
    const k = view.z * dpr; // pixels per unit
    const next = [];
    for (const pg of pages) {
      const box = pageBox(pg);
      const visible = overlaps(box, vis);
      if (!overlaps(box, near)) { detail.delete(pg.n); continue; }
      const need = pg.w * k;
      const step = BASE_STEPS.find((s) => s >= need) || BASE_STEPS[BASE_STEPS.length - 1];
      const b = base.get(pg.n);
      if (!b || b.px < step * 0.98) next.push({ kind: 'base', pg, px: step, prio: visible ? 0 : 2 });
      if (visible && need > BASE_STEPS[BASE_STEPS.length - 1] * 1.08) {
        // zoomed in past the biggest base image: render just what is on screen, sharp
        const m = 0.15;
        const clip = [Math.max(pg.x, vis[0] - vw * m), Math.max(pg.y, vis[1] - vh * m), Math.min(pg.x + pg.w, vis[2] + vw * m), Math.min(pg.y + pg.h, vis[3] + vh * m)];
        const d = detail.get(pg.n);
        const covered = d && d.k >= k * 0.95 && d.k <= k * 1.6 && d.box[0] <= vis[0] + 1 && d.box[1] <= Math.max(pg.y, vis[1]) + 1 && d.box[2] >= Math.min(pg.x + pg.w, vis[2]) - 1 && d.box[3] >= Math.min(pg.y + pg.h, vis[3]) - 1;
        if (!covered) next.push({ kind: 'detail', pg, k, box: clip, prio: 1 });
      } else if (!visible || need <= BASE_STEPS[BASE_STEPS.length - 1]) detail.delete(pg.n);
    }
    next.sort((a, b) => a.prio - b.prio || Math.abs(a.pg.y + a.pg.h / 2 - center) - Math.abs(b.pg.y + b.pg.h / 2 - center));
    jobs = next;
    // a detail render for an old view is no longer useful
    if (running && running.job.kind === 'detail' && !jobs.some((j) => j.kind === 'detail' && j.pg.n === running.job.pg.n && Math.abs(j.k - running.job.k) < 0.01)) cancelRunning(false);
    pump();
  }

  // requeue: the job is still wanted (paused for the pen), not outdated
  function cancelRunning(requeue) {
    if (!running) return;
    running.requeue = requeue;
    running.cancelled = true;
    try { running.task?.cancel(); } catch { /* already done */ }
  }
  function pump(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }
  async function run() {
    if (destroyed || running || !jobs.length) return;
    if (isBusy()) { pump(300); return; }
    const job = jobs.shift();
    running = { job, task: null, requeue: false };
    const mine = running;
    try {
      const page = await doc.getPage(job.pg.n);
      if (destroyed) return;
      const kk = job.kind === 'base' ? job.px / job.pg.w : job.k;
      const viewport = page.getViewport({ scale: kk * UNIT });
      const c = document.createElement('canvas');
      let transform = null;
      if (job.kind === 'base') { c.width = Math.round(job.pg.w * kk); c.height = Math.round(job.pg.h * kk); }
      else {
        c.width = Math.max(1, Math.ceil((job.box[2] - job.box[0]) * kk));
        c.height = Math.max(1, Math.ceil((job.box[3] - job.box[1]) * kk));
        transform = [1, 0, 0, 1, -(job.box[0] - job.pg.x) * kk, -(job.box[1] - job.pg.y) * kk];
      }
      const ctx = c.getContext('2d', { alpha: false });
      if (mine.cancelled) throw Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }); // cancelled while loading the page
      running.task = page.render({ canvasContext: ctx, viewport, transform, background: '#FFFFFF' });
      await running.task.promise;
      if (destroyed) return;
      if (job.kind === 'base') { base.set(job.pg.n, { c, px: c.width }); evict(); }
      else detail.set(job.pg.n, { c, box: [job.box[0], job.box[1], job.box[0] + c.width / kk, job.box[1] + c.height / kk], k: kk });
      onReady?.();
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn('PDF render', e);
      else if (mine.requeue && !jobs.some((j) => j.kind === job.kind && j.pg.n === job.pg.n)) jobs.unshift(job); // paused: try again later
    } finally {
      running = null;
      if (!destroyed && jobs.length) pump(isBusy() ? 300 : 0);
    }
  }

  // Keep memory in check: drop the base images farthest from what is on screen.
  function evict() {
    let px = 0;
    for (const b of base.values()) px += b.c.width * b.c.height;
    if (px <= BUDGET) return;
    const far = [...base.keys()].map((n) => [n, Math.abs(pages[n - 1].y + pages[n - 1].h / 2 - center)]).sort((a, b) => b[1] - a[1]);
    for (const [n] of far) {
      if (px <= BUDGET * 0.8) break;
      const b = base.get(n); px -= b.c.width * b.c.height;
      b.c.width = 0; b.c.height = 0; // free the memory now
      base.delete(n);
    }
  }

  // Page at a world y (the one containing it, or the nearest).
  function pageAt(y) {
    let best = pages[0];
    for (const pg of pages) { if (y >= pg.y - GAP / 2) best = pg; else break; }
    return best;
  }

  return {
    pages, width, height, gutter, draw, update, pageAt,
    pause() { cancelRunning(true); },
    ready: (n) => base.has(n),
    // for tests and debugging: what is rendered right now
    stats: () => ({ base: [...base].map(([n, b]) => [n, b.px]), detail: [...detail].map(([n, d]) => [n, Math.round(d.k * 100) / 100]), jobs: jobs.length, busy: !!running }),
    destroy() {
      destroyed = true; clearTimeout(timer); cancelRunning(false);
      for (const b of base.values()) { b.c.width = 0; b.c.height = 0; }
      base.clear(); detail.clear();
      doc.destroy?.();
    },
  };
}
