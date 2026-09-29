// Files attached to a topic: photos, videos, voice recordings and PDFs.
// Record: { kind: 'attachment', topicId, noteId?, name, mime, size, w, h, duration, poster, remote, created }
//   noteId is set only for files attached from inside a note (older versions or paste into a note).
//   Photos placed on the Quaderno have board: true and are managed by board.js.
// File: stored in IndexedDB "blobs" by attachment id, synced via Supabase Storage.

import * as store from './store.js';
import { fetchFile } from './sync.js';
import { esc, today, toast, uid, fmtDate } from './util.js';
import { openModal, closeModal, isModalOpen } from './ui.js';

const MAX_SIDE = 2200;              // photos are resized to this long side
const MAX_BYTES = 50 * 1024 * 1024; // Supabase free plan: 50 MB per file

export const kindOf = (mime = '') => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime === 'application/pdf' ? 'pdf' : 'other');
const byDate = (a, b) => (b.created || '').localeCompare(a.created || '') || b.updated_at - a.updated_at;

export const attachmentsOf = (noteId) => store.all('attachment').filter((a) => a.noteId === noteId && !a.board)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.updated_at - b.updated_at);
export const topicAttachments = (topicId) => store.all('attachment').filter((a) => a.topicId === topicId && !a.board).sort(byDate);

export const fmtDuration = (s) => {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/* ---------- media helpers ---------- */
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

// Duration (and for video: size + a small poster frame) read with a hidden media element.
function probeMedia(blob, kind) {
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    const url = URL.createObjectURL(blob);
    const done = (info) => { URL.revokeObjectURL(url); resolve(info); };
    const timer = setTimeout(() => done({}), 8000);
    el.preload = 'metadata'; el.muted = true; el.playsInline = true;
    el.onerror = () => { clearTimeout(timer); done({}); };
    el.onloadedmetadata = () => {
      let duration = el.duration;
      if (!Number.isFinite(duration)) duration = 0; // some recorders don't write it; fixed below for our own recordings
      if (kind !== 'video') { clearTimeout(timer); done({ duration }); return; }
      const w = el.videoWidth; const h = el.videoHeight;
      el.onseeked = () => {
        try {
          const s = Math.min(1, 480 / Math.max(w, h, 1));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
          clearTimeout(timer); done({ duration, w, h, poster: c.toDataURL('image/jpeg', 0.7) });
        } catch { clearTimeout(timer); done({ duration, w, h }); }
      };
      el.currentTime = Math.min(0.5, (duration || 1) / 3);
    };
    el.src = url;
  });
}

const defaultName = (kind) => {
  const d = new Date();
  const when = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return { image: `Foto del ${when}`, video: `Video del ${when}`, audio: `Registrazione del ${when}`, pdf: 'Documento.pdf' }[kind] || 'File';
};

/* ---------- adding ---------- */
// target: { topicId, noteId? }
export async function addFiles(target, files) {
  let topicId = target.topicId; const noteId = target.noteId || '';
  if (!topicId && noteId) topicId = store.get(noteId)?.topicId;
  if (!topicId) return 0;
  let n = 0;
  for (const file of files) {
    try {
      const kind = kindOf(file.type);
      if (kind === 'other') { toast(`${file.name}: formato non supportato`, 'bad'); continue; }
      let blob = file; let info = {}; let mime = file.type;
      if (kind === 'image') { const r = await compressImage(file); blob = r.blob; info = { w: r.w, h: r.h }; mime = 'image/jpeg'; }
      if (blob.size > MAX_BYTES) { toast(`${file.name}: troppo grande (${fmtSize(blob.size)}, massimo 50 MB)`, 'bad'); continue; }
      if (kind === 'video' || kind === 'audio') info = await probeMedia(blob, kind);
      const id = uid();
      await store.putBlob(id, blob);
      await store.put('attachment', {
        id, topicId, noteId, name: file.name && !/^(image|video|audio)\.\w+$/i.test(file.name) ? file.name : defaultName(kind),
        mime, size: blob.size, w: info.w || 0, h: info.h || 0, duration: info.duration || 0, poster: info.poster || '',
        remote: false, created: new Date().toISOString(),
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

/* ---------- UI: the Allegati tab ---------- */
const ICONS = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  clip: '<path d="M20 12.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7.9"/>',
};
export const icon = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

export function addButtons(topicId) {
  return `<label class="btn file-btn">${icon('camera')}Scatta foto<input type="file" accept="image/*" capture="environment" data-change="att-add" data-topic="${topicId}" hidden></label>
    <button class="btn" data-action="rec-open" data-topic="${topicId}">${icon('mic')}Registra audio</button>
    <label class="btn file-btn">${icon('video')}Registra video<input type="file" accept="video/*" capture="environment" data-change="att-add" data-topic="${topicId}" hidden></label>
    <label class="btn file-btn">${icon('clip')}Carica file<input type="file" accept="image/*,video/*,audio/*,application/pdf" multiple data-change="att-add" data-topic="${topicId}" hidden></label>`;
}

const origin = (a) => { const n = a.noteId && store.get(a.noteId); return n ? ` · da "${esc(n.title || 'nota')}"` : ''; };

export function attachmentsSections(topicId) {
  const all = topicAttachments(topicId);
  const g = { image: [], video: [], audio: [], pdf: [] };
  all.forEach((a) => (g[kindOf(a.mime)] || []).push(a));
  const sec = (title, count, body, extra = '') => `<section class="att-block"><div class="sec-head"><h3>${title} <span class="mono muted n">${count}</span></h3>${extra}</div>${body}</section>`;
  const out = [];
  if (g.image.length) out.push(sec('Foto', g.image.length, `<div class="att-grid">${g.image.map((a) => `
    <button class="att" data-action="att-open" data-id="${a.id}" title="${esc(a.name)}"><img data-att-src="${a.id}" alt="${esc(a.name)}" loading="lazy"><span class="att-status" data-att-status="${a.id}"></span></button>`).join('')}</div>`,
    `<button class="btn sm" data-action="ai-transcribe-photos" data-topic="${topicId}">✦ Trascrivi le foto</button>`));
  if (g.video.length) out.push(sec('Video', g.video.length, `<div class="att-grid">${g.video.map((a) => `
    <button class="att video" data-action="att-open" data-id="${a.id}" title="${esc(a.name)}">
      ${a.poster ? `<img src="${a.poster}" alt="">` : '<span class="att-missing">Video</span>'}
      <span class="att-play" aria-hidden="true"></span>
      ${a.duration ? `<span class="att-dur mono">${fmtDuration(a.duration)}</span>` : ''}
    </button>`).join('')}</div>`));
  if (g.audio.length) out.push(sec('Audio', g.audio.length, `<div class="list">${g.audio.map((a) => `
    <div class="list-row audio-row">
      <span class="audio-ico">${icon('mic')}</span>
      <div class="grow">
        <div class="audio-title">${esc(a.name)}</div>
        <div class="meta">${a.duration ? `<span class="mono">${fmtDuration(a.duration)}</span>` : ''}<span>${a.created ? fmtDate(a.created.slice(0, 10)) : ''}</span><span>${fmtSize(a.size)}</span>${origin(a)}</div>
        <audio controls preload="none" data-att-media="${a.id}"></audio>
      </div>
      <button class="btn sm ghost" data-action="att-open" data-id="${a.id}" aria-label="Dettagli">⋯</button>
    </div>`).join('')}</div>`));
  if (g.pdf.length) out.push(sec('Documenti PDF', g.pdf.length, `<div class="list">${g.pdf.map((a) => `
    <button class="list-row" data-action="att-open" data-id="${a.id}"><span class="pdf-badge mono">PDF</span><span class="grow"><span class="block">${esc(a.name)}</span><span class="meta"><span>${fmtSize(a.size)}</span>${origin(a)}</span></span></button>`).join('')}</div>`));
  return out.join('');
}

// Legacy: files attached inside a note (shown read-only in that note).
export function gallery(noteId) {
  const list = attachmentsOf(noteId);
  if (!list.length) return '';
  return `<div class="att-grid">${list.map((a) => `
    <button class="att" data-action="att-open" data-id="${a.id}" title="${esc(a.name)}">
      ${kindOf(a.mime) === 'image' ? `<img data-att-src="${a.id}" alt="${esc(a.name)}" loading="lazy">` : `<span class="att-pdf"><b>${kindOf(a.mime).toUpperCase()}</b><span>${esc(a.name)}</span></span>`}
    </button>`).join('')}</div>`;
}

// Fill <img data-att-src> and <audio data-att-media> after a render.
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
  // Audio: files already on this device get their source right away (preload="none" keeps it cheap);
  // files only on the server are downloaded when the user presses play, then playback resumes.
  await Promise.all([...root.querySelectorAll('audio[data-att-media]')].map(async (el) => {
    const id = el.dataset.attMedia;
    // Attach listeners first (synchronously) so a quick tap is never missed.
    el.addEventListener('play', async () => {
      if (el.src) return;
      el.pause();
      const u = await objectUrl(id);
      if (!u) { toast('Registrazione non disponibile su questo dispositivo', 'bad'); return; }
      el.src = u; el.play().catch(() => {});
    });
    // Chrome's own recordings carry no duration: seek far once so the player can show the length.
    el.addEventListener('loadedmetadata', () => {
      if (el.duration !== Infinity) return;
      const reset = () => { el.removeEventListener('timeupdate', reset); el.currentTime = 0; };
      el.addEventListener('timeupdate', reset);
      el.currentTime = 1e101;
    });
    if (await store.hasBlob(id) && !el.src) { const u = await objectUrl(id); if (u && !el.src) { el.preload = 'metadata'; el.src = u; } }
  }));
}

export async function openViewer(id) {
  const a = store.get(id);
  if (!a) return;
  const kind = kindOf(a.mime);
  const list = (a.noteId && !a.topicId ? attachmentsOf(a.noteId) : topicAttachments(a.topicId)).filter((x) => kindOf(x.mime) === kind);
  const idx = list.findIndex((x) => x.id === id);
  const prev = list[idx - 1]; const next = list[idx + 1];
  openModal(`<div class="viewer"><div class="viewer-body"><p class="muted pad">Caricamento…</p></div></div>`, { wide: true });
  const u = await objectUrl(id);
  if (!isModalOpen()) return;
  const body = !u ? '<p class="muted pad">File non disponibile su questo dispositivo. Accedi alla sincronizzazione per scaricarlo.</p>'
    : kind === 'pdf' ? `<div class="pdf-open"><p>PDF · ${fmtSize(a.size)}</p><a class="btn primary" href="${u}" target="_blank" rel="noopener">Apri il PDF</a></div>`
    : kind === 'video' ? `<video src="${u}" controls playsinline autoplay></video>`
    : kind === 'audio' ? `<div class="audio-big">${icon('mic')}<audio src="${u}" controls autoplay></audio></div>`
    : `<img src="${u}" alt="${esc(a.name)}">`;
  document.querySelector('#modal-root .panel').innerHTML = `
    <div class="viewer">
      <div class="viewer-bar">
        <input class="viewer-name" type="text" value="${esc(a.name)}" aria-label="Nome del file" data-att-rename="${a.id}">
        <span class="muted small mono">${list.length > 1 ? `${idx + 1}/${list.length}` : ''}</span>
        ${kind === 'image' ? `<button class="btn sm" data-action="ai-transcribe-photo" data-id="${a.id}">✦ Trascrivi</button>` : ''}
        <span class="confirm-wrap"><button type="button" class="btn sm danger" data-action="confirm-step">Elimina</button><button type="button" class="btn sm danger solid" data-action="att-delete" data-id="${a.id}" hidden>Conferma</button></span>
        <button class="btn sm" data-action="close-modal" aria-label="Chiudi">✕</button>
      </div>
      <div class="viewer-body ${kind}">${body}</div>
      <div class="viewer-foot small muted"><span>${[a.duration ? fmtDuration(a.duration) : '', fmtSize(a.size), a.created ? fmtDate(a.created.slice(0, 10)) : ''].filter(Boolean).join(' · ')}${origin(a)}</span>
      ${list.length > 1 ? `<span class="row gap"><button class="btn sm" data-action="att-open" data-id="${prev?.id || ''}" ${prev ? '' : 'disabled'}>← Precedente</button><button class="btn sm" data-action="att-open" data-id="${next?.id || ''}" ${next ? '' : 'disabled'}>Successivo →</button></span>` : ''}</div>
    </div>`;
  const name = document.querySelector('[data-att-rename]');
  name?.addEventListener('change', async () => {
    const cur = store.get(a.id); const v = name.value.trim();
    if (cur && v && v !== cur.name) { await store.put('attachment', { ...cur, name: v }); toast('Nome aggiornato'); }
  });
}

/* ---------- voice recorder ---------- */
let rec = null;
function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  return opts.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

export function openRecorder(topicId, onSaved) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('Questo browser non può registrare audio. Usa Chrome.', 'bad');
    return;
  }
  openModal(`
    <div class="recorder" data-state="idle">
      <h2>Registra audio</h2>
      <p class="muted rec-help">Premi il pulsante per iniziare. Lo schermo resta acceso finché registri.</p>
      <div class="rec-main">
        <button class="rec-btn" data-rec="toggle" aria-label="Inizia a registrare"><span></span></button>
        <div class="rec-info"><b class="rec-time mono">0:00</b><canvas class="rec-level" width="240" height="40" aria-hidden="true"></canvas></div>
      </div>
      <div class="rec-review" hidden>
        <audio controls></audio>
        <div class="field"><label for="rec-name">Nome</label><input id="rec-name" type="text" value="${esc(defaultName('audio'))}"></div>
      </div>
      <p class="error" data-rec-error hidden></p>
      <div class="modal-foot"><div class="row gap push">
        <button class="btn" data-rec="cancel">Annulla</button>
        <button class="btn" data-rec="redo" hidden>Rifai</button>
        <button class="btn primary" data-rec="save" hidden>Salva registrazione</button>
      </div></div>
    </div>`, { onClose: () => stopAll() });

  const root = document.querySelector('.recorder');
  const q = (s) => root.querySelector(s);
  const err = (m) => { const e = q('[data-rec-error]'); e.textContent = m; e.hidden = !m; };
  const setState = (st) => {
    root.dataset.state = st;
    q('.rec-review').hidden = st !== 'review';
    q('[data-rec=save]').hidden = st !== 'review';
    q('[data-rec=redo]').hidden = st !== 'review';
    q('.rec-main').hidden = st === 'review';
    q('.rec-help').textContent = st === 'recording' ? 'Sto registrando. Premi di nuovo per fermare.' : st === 'review' ? 'Ascolta e salva, oppure rifai.' : 'Premi il pulsante per iniziare. Lo schermo resta acceso finché registri.';
    q('[data-rec=toggle]').setAttribute('aria-label', st === 'recording' ? 'Ferma la registrazione' : 'Inizia a registrare');
  };

  async function start() {
    err('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = pickMime();
      const mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48000 });
      rec = { stream, mr, chunks: [], t0: Date.now(), timer: 0, raf: 0, wake: null, ctx: null, blob: null, secs: 0 };
      mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
      mr.onstop = () => {
        rec.blob = new Blob(rec.chunks, { type: mr.mimeType || mime || 'audio/webm' });
        rec.secs = (Date.now() - rec.t0) / 1000;
        q('.rec-review audio').src = URL.createObjectURL(rec.blob);
        setState('review');
      };
      mr.start(1000);
      try { rec.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
      rec.timer = setInterval(() => {
        const s = (Date.now() - rec.t0) / 1000;
        q('.rec-time').textContent = fmtDuration(s);
        if (s > 3 * 3600) stop(); // safety stop after 3 hours
      }, 250);
      meter(stream);
      setState('recording');
    } catch (e) {
      err(e.name === 'NotAllowedError' ? 'Permesso negato: consenti l\'uso del microfono per questo sito nelle impostazioni di Chrome.' : 'Impossibile usare il microfono: ' + e.message);
    }
  }
  function meter(stream) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      rec.ctx = ctx;
      const data = new Uint8Array(an.fftSize);
      const cv = q('.rec-level'); const g = cv.getContext('2d');
      const bars = [];
      const draw = () => {
        an.getByteTimeDomainData(data);
        let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        bars.push(peak / 128); if (bars.length > 60) bars.shift();
        g.clearRect(0, 0, cv.width, cv.height);
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--danger') || '#B83A3A';
        bars.forEach((b, i) => { const h = Math.max(2, b * cv.height); g.fillRect(i * 4, (cv.height - h) / 2, 3, h); });
        rec.raf = requestAnimationFrame(draw);
      };
      draw();
    } catch { /* level meter is optional */ }
  }
  function stop() {
    if (!rec) return;
    clearInterval(rec.timer); cancelAnimationFrame(rec.raf);
    if (rec.mr.state !== 'inactive') rec.mr.stop();
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.ctx?.close?.(); rec.wake?.release?.();
  }
  function stopAll() {
    if (!rec) return;
    rec.mr.onstop = null;
    stop();
    rec = null;
  }

  root.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-rec]'); if (!b) return;
    const k = b.dataset.rec;
    if (k === 'toggle') { if (root.dataset.state === 'recording') stop(); else await start(); }
    if (k === 'cancel') { closeModal(); }
    if (k === 'redo') { rec = null; q('.rec-time').textContent = '0:00'; setState('idle'); }
    if (k === 'save' && rec?.blob) {
      b.disabled = true; b.textContent = 'Salvo…';
      const blob = rec.blob; const secs = rec.secs;
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([blob], `${q('#rec-name').value.trim() || defaultName('audio')}.${ext}`, { type: blob.type });
      const id = uid();
      if (blob.size > MAX_BYTES) { err('La registrazione supera 50 MB e non si può sincronizzare. Registra parti più brevi.'); b.disabled = false; b.textContent = 'Salva registrazione'; return; }
      await store.putBlob(id, blob);
      await store.put('attachment', { id, topicId, noteId: '', name: file.name.replace(/\.(webm|m4a|ogg)$/, ''), mime: blob.type.split(';')[0], size: blob.size, duration: secs, remote: false, created: new Date().toISOString() });
      rec = null;
      closeModal();
      toast('Registrazione salvata negli Allegati');
      onSaved?.();
    }
  });
}

export { closeModal };
