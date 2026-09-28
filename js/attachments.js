// Photos and PDFs attached to notes.
// Record: { kind: 'attachment', noteId, topicId, name, mime, size, w, h, remote }
// File: stored in IndexedDB "blobs" by attachment id, synced via Supabase Storage.

import * as store from './store.js';
import { fetchFile } from './sync.js';
import { esc, today, toast, uid } from './util.js';
import { openModal, closeModal } from './ui.js';

const MAX_SIDE = 2200;       // photos are resized to this long side
const MAX_PDF = 20 * 1024 * 1024;

export const attachmentsOf = (noteId) => store.all('attachment').filter((a) => a.noteId === noteId)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.updated_at - b.updated_at);

/* ---------- adding ---------- */
async function compressImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.84));
  return { blob, w, h };
}

export async function addFiles(noteId, files) {
  const note = store.get(noteId);
  if (!note) return 0;
  const existing = attachmentsOf(noteId).length;
  let n = 0;
  for (const file of files) {
    try {
      const id = uid();
      let blob = file; let w = 0; let h = 0; let mime = file.type;
      if (file.type.startsWith('image/')) {
        ({ blob, w, h } = await compressImage(file));
        mime = 'image/jpeg';
      } else if (file.type === 'application/pdf') {
        if (file.size > MAX_PDF) { toast(`${file.name}: PDF troppo grande (max 20 MB)`, 'bad'); continue; }
      } else { toast(`${file.name}: formato non supportato`, 'bad'); continue; }
      await store.putBlob(id, blob);
      await store.put('attachment', {
        id, noteId, topicId: note.topicId, name: file.name || (mime === 'application/pdf' ? 'Documento.pdf' : 'Foto.jpg'),
        mime, size: blob.size, w, h, remote: false, order: existing + n, created: today(),
      });
      n++;
    } catch (e) {
      console.error(e);
      toast(`Impossibile aggiungere ${file.name || 'il file'}`, 'bad');
    }
  }
  return n;
}

// A photo placed on a topic's Quaderno. Position and size are in board (world) units.
export async function addBoardImage(topicId, file, { cx, cy, maxW = 800 }) {
  try {
    const { blob, w, h } = await compressImage(file);
    const id = uid();
    const bw = Math.round(Math.min(maxW, w));
    const bh = Math.round(bw * (h / w));
    await store.putBlob(id, blob);
    return await store.put('attachment', {
      id, noteId: '', topicId, board: true, name: file.name || 'Foto.jpg', mime: 'image/jpeg', size: blob.size, w, h,
      x: Math.round(cx - bw / 2), y: Math.round(cy - bh / 2), bw, bh, remote: false, created: today(),
    });
  } catch (e) {
    console.error(e);
    toast(`Impossibile inserire ${file.name || 'la foto'}`, 'bad');
    return null;
  }
}

export async function removeAttachment(id) {
  await store.remove(id);
  await store.deleteBlob(id);
  const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); }
}

/* ---------- reading ---------- */
const urls = new Map();
export async function objectUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const blob = await fetchFile(id).catch(() => null);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}
export async function getBlob(id) { return fetchFile(id).catch(() => null); }

/* ---------- UI ---------- */
export function pickerButtons(noteId, { compact = false } = {}) {
  return `<label class="btn ${compact ? 'sm' : ''} file-btn" title="Scatta una foto">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Scatta foto
      <input type="file" accept="image/*" capture="environment" data-change="att-add" data-note="${noteId}" hidden></label>
    <label class="btn ${compact ? 'sm' : ''} file-btn" title="Allega immagini o PDF">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7.9"/></svg>Allega file
      <input type="file" accept="image/*,application/pdf" multiple data-change="att-add" data-note="${noteId}" hidden></label>`;
}

export function gallery(noteId) {
  const list = attachmentsOf(noteId);
  if (!list.length) return '';
  return `<div class="att-grid">${list.map((a) => `
    <button class="att" data-action="att-open" data-id="${a.id}" title="${esc(a.name)}">
      ${a.mime === 'application/pdf'
        ? `<span class="att-pdf"><b>PDF</b><span>${esc(a.name)}</span></span>`
        : `<img data-att-src="${a.id}" alt="${esc(a.name)}" loading="lazy">`}
      <span class="att-status" data-att-status="${a.id}"></span>
    </button>`).join('')}</div>`;
}

// Fill <img data-att-src> and note-card thumbnails after a render.
export async function hydrate(root = document) {
  const imgs = [...root.querySelectorAll('img[data-att-src]')];
  await Promise.all(imgs.map(async (img) => {
    const id = img.dataset.attSrc;
    const u = await objectUrl(id);
    if (u) img.src = u;
    else {
      const s = root.querySelector(`[data-att-status="${id}"]`);
      if (s) s.textContent = store.get(id)?.remote ? 'Non scaricato' : 'Solo sull\'altro dispositivo';
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'att-missing', textContent: 'Immagine non disponibile' }));
    }
  }));
}

export async function openViewer(id) {
  const a = store.get(id);
  if (!a) return;
  const list = attachmentsOf(a.noteId);
  const idx = list.findIndex((x) => x.id === id);
  const u = await objectUrl(id);
  const prev = list[idx - 1]; const next = list[idx + 1];
  openModal(`
    <div class="viewer">
      <div class="viewer-bar">
        <b class="grow ellipsis">${esc(a.name)}</b>
        <span class="muted small mono">${idx + 1}/${list.length}</span>
        ${u ? `<a class="btn sm" href="${u}" target="_blank" rel="noopener" download="${esc(a.name)}">Apri</a>` : ''}
        <span class="confirm-wrap"><button type="button" class="btn sm danger" data-action="confirm-step">Elimina</button><button type="button" class="btn sm danger solid" data-action="att-delete" data-id="${a.id}" hidden>Conferma</button></span>
        <button class="btn sm" data-action="close-modal" aria-label="Chiudi">✕</button>
      </div>
      <div class="viewer-body">
        ${!u ? '<p class="muted">File non disponibile su questo dispositivo. Accedi alla sincronizzazione per scaricarlo.</p>'
          : a.mime === 'application/pdf' ? `<div class="pdf-open"><p>PDF · ${(a.size / 1024 / 1024).toFixed(1)} MB</p><a class="btn primary" href="${u}" target="_blank" rel="noopener">Apri il PDF</a></div>`
          : `<img src="${u}" alt="${esc(a.name)}">`}
      </div>
      ${list.length > 1 ? `<div class="viewer-nav"><button class="btn" data-action="att-open" data-id="${prev?.id || ''}" ${prev ? '' : 'disabled'}>← Precedente</button><button class="btn" data-action="att-open" data-id="${next?.id || ''}" ${next ? '' : 'disabled'}>Successiva →</button></div>` : ''}
    </div>`, { wide: true });
}

export { closeModal };
