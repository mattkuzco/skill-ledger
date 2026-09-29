// Export a topic's Quaderno as a PDF: A4 pages, ink as vector paths (sharp at any zoom and
// when printed), photos as JPEG, the paper pattern as thin lines.
//
// Scale: "natural" size is 1000 board units = the width of an A4 page (the same scale used for
// PDFs opened in the app). "fit" shrinks wider notes so the full width fits on the page;
// "real" keeps the natural size and splits wide notes over several pages side by side.
// Page breaks are moved up to a gap between lines of writing, so no line is cut in half.

import * as store from './store.js';
import { tilesOf, boardImagesOf, strokeBox, contentBounds, isDark } from './board.js';
import { penWidth, paperColor, shownColor, lineColor } from './ink.js';
import * as att from './attachments.js';
import { PdfDoc, num as f, rgb, textString, winAnsi, textWidth, pdfDate } from './pdfwrite.js';

const A4 = [595.28, 841.89];
const M = 28;          // page margin (pt)
const FOOT = 14;       // footer band (pt)
const NATURAL = 595.28 / 1000;
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const imgBox = (a) => [a.x, a.y, a.x + a.bw, a.y + a.bh];

// Work out pages for the given options. Returns null for an empty notebook.
export function plan(topicId, { orient = 'auto', scale = 'fit' } = {}) {
  const c = contentBounds(topicId);
  if (!c) return null;
  const b = [c[0] - 24, c[1] - 24, c[2] + 24, c[3] + 24];
  const cw = b[2] - b[0]; const ch = b[3] - b[1];
  const portraitW = (A4[0] - 2 * M) / NATURAL;
  const land = orient === 'landscape' || (orient === 'auto' && cw > portraitW * 1.05 && cw > ch * 0.9);
  const [pw, ph] = land ? [A4[1], A4[0]] : A4;
  const aw = pw - 2 * M; const ah = ph - 2 * M - FOOT;
  const k = scale === 'real' ? NATURAL : Math.min(NATURAL, aw / cw);
  const wu = aw / k; const hu = ah / k; // page content size in board units
  const cols = scale === 'real' ? Math.max(1, Math.ceil(cw / wu - 0.02)) : 1;
  const x0 = b[0] - (cols * wu - cw) / 2; // centre the notes horizontally

  // boxes of everything on the board, to find clean page breaks and skip empty pages
  const boxes = [...tilesOf(topicId).flatMap((t) => (t.s || []).map(strokeBox)), ...boardImagesOf(topicId).map(imgBox)];
  const rows = [];
  let y = b[1];
  while (y < b[3] - 1 && rows.length < 400) {
    // skip empty stretches of the board: no blank pages, the next page starts just above the writing
    let next = Infinity;
    for (const bx of boxes) if (bx[3] > y && bx[1] < next) next = bx[1];
    if (next === Infinity) break;
    if (next - y > hu * 0.2) y = next - 24;
    let end = y + hu;
    if (end < b[3]) {
      // move the cut up (at most 18% of a page) to where the fewest lines of writing cross it
      let best = end; let bestN = Infinity;
      for (let cut = end; cut >= y + hu * 0.82; cut -= 3) {
        let n = 0;
        for (const bx of boxes) if (bx[1] < cut && bx[3] > cut) n++;
        if (n < bestN) { bestN = n; best = cut; if (!n) break; }
      }
      end = best;
    }
    rows.push([y, end]);
    y = end;
  }
  const regions = [];
  for (const [ry0, ry1] of rows) {
    for (let col = 0; col < cols; col++) {
      const r = [x0 + col * wu, ry0, x0 + (col + 1) * wu, ry1];
      if (cols > 1 && !boxes.some((bx) => overlaps(bx, r))) continue; // side pages with nothing on them
      regions.push(r);
    }
  }
  return { land, pw, ph, aw, ah, k, cols, regions, pct: Math.round((k / NATURAL) * 100) };
}

/* ---------- ink as PDF paths (same geometry as ink.js drawStroke) ---------- */
function penOps(st, dark) {
  const p = st.p; const n = p.length / 3;
  let out = `${rgb(shownColor(st.c, dark))} RG\n`;
  const W = (i) => Math.round(penWidth(st, i, 1) * 4) / 4; // widths in quarter units: fewer path breaks
  if (n === 1) return out + `${f(W(0))} w ${f(p[0])} ${f(p[1])} m ${f(p[0])} ${f(p[1])} l S\n`;
  let cur = null;
  for (let i = 1; i < n; i++) {
    const x0 = p[(i - 1) * 3]; const y0 = p[(i - 1) * 3 + 1]; const x1 = p[i * 3]; const y1 = p[i * 3 + 1];
    const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
    const sx = i === 1 ? x0 : (p[(i - 2) * 3] + x0) / 2; const sy = i === 1 ? y0 : (p[(i - 2) * 3 + 1] + y0) / 2;
    const w = Math.round(((penWidth(st, i - 1, 1) + penWidth(st, i, 1)) / 2) * 4) / 4;
    if (w !== cur) { if (cur !== null) out += 'S\n'; out += `${f(w)} w ${f(sx)} ${f(sy)} m `; cur = w; }
    if (i === 1) out += `${f(mx)} ${f(my)} l `;
    else { // the quadratic curve through point i-1, as a cubic
      out += `${f(sx + (2 / 3) * (x0 - sx))} ${f(sy + (2 / 3) * (y0 - sy))} ${f(mx + (2 / 3) * (x0 - mx))} ${f(my + (2 / 3) * (y0 - my))} ${f(mx)} ${f(my)} c `;
    }
  }
  const xl = p[(n - 1) * 3]; const yl = p[(n - 1) * 3 + 1];
  const lx = (p[(n - 2) * 3] + xl) / 2; const ly = (p[(n - 2) * 3 + 1] + yl) / 2;
  const wt = W(n - 1);
  if (wt !== cur) out += `S\n${f(wt)} w ${f(lx)} ${f(ly)} m `;
  return out + `${f(xl)} ${f(yl)} l S\n`;
}
function highlightOps(st, dark) {
  const p = st.p; const n = p.length / 3;
  let out = `q /GH gs ${rgb(shownColor(st.c, dark))} RG ${f(st.w)} w ${f(p[0])} ${f(p[1])} m `;
  if (n === 1) out += `${f(p[0] + 0.1)} ${f(p[1])} l `;
  for (let i = 1; i < n; i++) out += `${f(p[i * 3])} ${f(p[i * 3 + 1])} l `;
  return out + 'S Q\n';
}
function patternOps(paper, dark, r, k) {
  if (paper === 'blank') return '';
  let step = 40;
  while (step * k < 9) step *= 2; // same idea as on screen: lines never too dense
  const lw = 0.4 / k;
  const sx = Math.ceil(r[0] / step) * step; const sy = Math.ceil(r[1] / step) * step;
  let out = '';
  if (paper === 'dots') {
    out += `${rgb(lineColor('dots', dark, false))} rg\n`;
    const d = 1.2 / k;
    for (let x = sx; x <= r[2]; x += step) for (let y = sy; y <= r[3]; y += step) out += `${f(x - d / 2)} ${f(y - d / 2)} ${f(d)} ${f(d)} re `;
    return out + 'f\n';
  }
  out += `${rgb(lineColor(paper === 'lined' ? 'lined' : 'grid', dark, false))} RG ${f(lw)} w\n`;
  if (paper === 'grid') for (let x = sx; x <= r[2]; x += step) out += `${f(x)} ${f(r[1])} m ${f(x)} ${f(r[3])} l `;
  for (let y = sy; y <= r[3]; y += step) out += `${f(r[0])} ${f(y)} m ${f(r[2])} ${f(y)} l `;
  return out + 'S\n';
}

async function jpegOf(blob) {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width; const h = bmp.height;
  if (blob.type === 'image/jpeg') { bmp.close?.(); return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h }; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0); bmp.close?.();
  const jb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return { bytes: new Uint8Array(await jb.arrayBuffer()), w, h };
}

// Build the PDF. opts: { orient, scale, white (force white paper), pattern (draw the grid) }.
export async function exportBoardPdf(topicId, opts = {}, onProgress = () => {}) {
  const topic = store.get(topicId);
  const pl = plan(topicId, opts);
  if (!pl) throw new Error('Il quaderno è vuoto.');
  const dark = isDark(topicId) && !opts.white;
  const paper = opts.pattern === false ? 'blank' : topic.board?.paper || 'grid';
  const { pw, ph, aw, ah, k } = pl;

  const doc = new PdfDoc();
  const catalog = doc.reserve(); const pagesRef = doc.reserve(); const resRef = doc.reserve();
  const font = doc.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  // multiply darkens like a real highlighter on white; on black paper the app lightens instead
  const gh = doc.add(`<< /Type /ExtGState /CA ${dark ? 0.62 : 0.38} /BM /${dark ? 'Screen' : 'Multiply'} >>`);

  const images = boardImagesOf(topicId);
  const imgName = new Map(); const xobj = [];
  for (let i = 0; i < images.length; i++) {
    onProgress(`Preparo le foto (${i + 1}/${images.length})…`);
    const blob = await att.getBlob(images[i].id).catch(() => null);
    if (!blob) continue;
    try {
      const { bytes, w, h } = await jpegOf(blob);
      const ref = doc.add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`, bytes);
      imgName.set(images[i].id, `Im${i}`); xobj.push(`/Im${i} ${ref} 0 R`);
    } catch (e) { console.warn('export photo', e); }
  }
  doc.set(resRef, `<< /Font << /F1 ${font} 0 R >> /ExtGState << /GH ${gh} 0 R >> /XObject << ${xobj.join(' ')} >> >>`);

  const strokes = tilesOf(topicId).flatMap((t) => t.s || []);
  const footLeft = `${topic.title || 'Quaderno'} · Quaderno`.slice(0, 90);
  const footColor = dark ? '0.55 0.58 0.64' : '0.5 0.53 0.6';
  const kids = [];
  const total = pl.regions.length;
  for (let pi = 0; pi < total; pi++) {
    onProgress(`Pagina ${pi + 1} di ${total}…`);
    await new Promise((r) => setTimeout(r)); // keep the app responsive on big notebooks
    const r = pl.regions[pi];
    const tx = M - r[0] * k; const ty = ph - M + r[1] * k;
    let s = `${rgb(paperColor(dark))} rg 0 0 ${f(pw)} ${f(ph)} re f\n1 J 1 j\n`;
    s += `q ${f(M)} ${f(ph - M - ah)} ${f(aw)} ${f(ah)} re W n\n${f(k)} 0 0 ${f(-k)} ${f(tx)} ${f(ty)} cm\n`;
    s += patternOps(paper, dark, r, k);
    for (const a of images) {
      if (!overlaps(imgBox(a), r)) continue;
      const name = imgName.get(a.id);
      s += name ? `q ${f(a.bw)} 0 0 ${f(-a.bh)} ${f(a.x)} ${f(a.y + a.bh)} cm /${name} Do Q\n`
        : `0.9 0.91 0.93 rg ${f(a.x)} ${f(a.y)} ${f(a.bw)} ${f(a.bh)} re f\n`; // photo not on this device
    }
    for (const st of strokes) {
      if (!st.p?.length || !overlaps(strokeBox(st), r)) continue;
      s += st.t === 'h' ? highlightOps(st, dark) : penOps(st, dark);
    }
    s += 'Q\n';
    const right = `${pi + 1} / ${total}`;
    s += `BT /F1 7.5 Tf ${footColor} rg ${f(M)} ${f(M)} Td ${winAnsi(footLeft)} Tj ET\n`;
    s += `BT /F1 7.5 Tf ${footColor} rg ${f(pw - M - textWidth(right, 7.5))} ${f(M)} Td ${winAnsi(right)} Tj ET\n`;
    const content = await doc.stream('', s);
    kids.push(doc.add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources ${resRef} 0 R /Contents ${content} 0 R /Group << /S /Transparency /CS /DeviceRGB >> >>`));
  }
  doc.set(pagesRef, `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  doc.set(catalog, `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
  const info = doc.add(`<< /Title ${textString(`${topic.title || 'Quaderno'} – Quaderno`)} /Creator (Skill Ledger) /Producer (Skill Ledger) /CreationDate ${pdfDate()} >>`);
  onProgress('Salvo il file…');
  return { blob: doc.build(catalog, info), pages: total, plan: pl };
}

export const fileName = (title) => `${(title || 'quaderno').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'quaderno'}-quaderno.pdf`;
