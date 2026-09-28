// Local-first record store on IndexedDB.
//
// Every piece of user data is a "record": { id, kind, updated_at, deleted, dirty, ...fields }.
// Kinds: area, topic, note, card, question, attempt, session, checkin.
// All records are loaded into memory at startup (personal data is small), writes go to
// IndexedDB and memory together. `dirty` marks records not yet pushed to the server.
// Deletes are soft (deleted: true) so they can sync; they're purged after a successful push.
//
// A separate "meta" store holds device-local settings (sync session, API key, cursors).
// Meta is never synced.
//
// A "blobs" store holds attachment files (photos, PDFs) by attachment id. The attachment
// record syncs like any other; the file itself syncs through Supabase Storage (see sync.js).

import { uid } from './util.js';

const DB_NAME = 'skill-ledger';
const DB_VERSION = 2;
const META_FIELDS = ['id', 'kind', 'updated_at', 'deleted', 'dirty'];

let db;
const records = new Map(); // id -> record
const meta = new Map();
const listeners = new Set();

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function txDone(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}

export async function init() {
  db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains('records')) {
        const s = d.createObjectStore('records', { keyPath: 'id' });
        s.createIndex('kind', 'kind');
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const tx = db.transaction(['records', 'meta'], 'readonly');
  const [recs, metas] = await Promise.all([
    req(tx.objectStore('records').getAll()),
    req(tx.objectStore('meta').getAll()),
  ]);
  recs.forEach((r) => records.set(r.id, r));
  metas.forEach((m) => meta.set(m.key, m.value));
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(source) { listeners.forEach((fn) => { try { fn(source); } catch (e) { console.error(e); } }); }

/* ---------- reads ---------- */
export function all(kind, { includeDeleted = false } = {}) {
  const out = [];
  for (const r of records.values()) if (r.kind === kind && (includeDeleted || !r.deleted)) out.push(r);
  return out;
}
export function get(id) { const r = records.get(id); return r && !r.deleted ? r : undefined; }
export function getRaw(id) { return records.get(id); }
export function allRaw() { return [...records.values()]; }
export function dirtyRecords() { return [...records.values()].filter((r) => r.dirty); }
export function isEmpty() { return ![...records.values()].some((r) => !r.deleted); }

/* ---------- writes ---------- */
async function persist(list) {
  const tx = db.transaction('records', 'readwrite');
  const s = tx.objectStore('records');
  list.forEach((r) => s.put(r));
  await txDone(tx);
}
async function purge(ids) {
  const tx = db.transaction('records', 'readwrite');
  const s = tx.objectStore('records');
  ids.forEach((id) => s.delete(id));
  await txDone(tx);
}

// Monotonic timestamp so two writes in the same millisecond still order correctly.
let lastTs = 0;
function stamp() { const t = Math.max(Date.now(), lastTs + 1); lastTs = t; return t; }

export async function put(kind, fields) {
  const prev = fields.id ? records.get(fields.id) : undefined;
  const rec = { ...(prev || {}), ...fields, id: fields.id || uid(), kind, updated_at: stamp(), deleted: false, dirty: true };
  records.set(rec.id, rec);
  await persist([rec]);
  emit('local');
  return rec;
}

export async function putMany(kind, list) {
  const out = list.map((fields) => {
    const prev = fields.id ? records.get(fields.id) : undefined;
    const rec = { ...(prev || {}), ...fields, id: fields.id || uid(), kind, updated_at: stamp(), deleted: false, dirty: true };
    records.set(rec.id, rec);
    return rec;
  });
  await persist(out);
  emit('local');
  return out;
}

export async function remove(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => records.get(id)).filter(Boolean);
  const out = list.map((r) => {
    const rec = { id: r.id, kind: r.kind, updated_at: stamp(), deleted: true, dirty: true };
    records.set(rec.id, rec);
    return rec;
  });
  await persist(out);
  emit('local');
}

// Record fields that sync (everything except bookkeeping).
export function dataOf(rec) {
  const d = {};
  for (const k in rec) if (!META_FIELDS.includes(k)) d[k] = rec[k];
  return d;
}

// Apply a record that came from elsewhere (server or import). Last writer wins.
// Returns true if it changed local state.
export function mergeIncoming(list, { markDirty = false } = {}) {
  const changed = [];
  for (const inc of list) {
    const cur = records.get(inc.id);
    if (cur && cur.updated_at >= inc.updated_at) continue;
    const rec = inc.deleted
      ? { id: inc.id, kind: inc.kind, updated_at: inc.updated_at, deleted: true, dirty: markDirty }
      : { ...inc.data, id: inc.id, kind: inc.kind, updated_at: inc.updated_at, deleted: false, dirty: markDirty };
    records.set(rec.id, rec);
    changed.push(rec);
  }
  return changed;
}
export async function applyIncoming(list, opts) {
  const changed = mergeIncoming(list, opts);
  if (changed.length) { await persist(changed); emit('remote'); }
  return changed.length;
}

// After a push: clear dirty on records unchanged since the push started, drop pushed tombstones.
export async function markPushed(pushed) {
  const clean = [];
  const gone = [];
  for (const p of pushed) {
    const cur = records.get(p.id);
    if (!cur || cur.updated_at !== p.updated_at) continue;
    if (cur.deleted) { records.delete(cur.id); gone.push(cur.id); }
    else { cur.dirty = false; clean.push(cur); }
  }
  if (clean.length) await persist(clean);
  if (gone.length) await purge(gone);
}

// Mark every live record dirty (used when connecting a new account so local data uploads).
export async function markAllDirty() {
  const list = [...records.values()].map((r) => ({ ...r, dirty: true }));
  list.forEach((r) => records.set(r.id, r));
  await persist(list);
}

export async function wipe() {
  const tx = db.transaction(['records', 'blobs'], 'readwrite');
  tx.objectStore('records').clear();
  tx.objectStore('blobs').clear();
  await txDone(tx);
  records.clear();
  emit('local');
}

/* ---------- blobs (attachment files, device-local cache) ---------- */
export async function putBlob(id, blob) {
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').put({ id, blob });
  await txDone(tx);
}
export async function getBlobLocal(id) {
  const tx = db.transaction('blobs', 'readonly');
  const row = await req(tx.objectStore('blobs').get(id));
  return row ? row.blob : null;
}
export async function hasBlob(id) {
  const tx = db.transaction('blobs', 'readonly');
  return (await req(tx.objectStore('blobs').count(id))) > 0;
}
export async function deleteBlob(id) {
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').delete(id);
  await txDone(tx);
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});
const base64ToBlob = (b64, type) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};
export { blobToBase64 };

/* ---------- meta (device-local) ---------- */
export function getMeta(key, fallback = null) { return meta.has(key) ? meta.get(key) : fallback; }
export async function setMeta(key, value) {
  meta.set(key, value);
  const tx = db.transaction('meta', 'readwrite');
  if (value === null || value === undefined) { tx.objectStore('meta').delete(key); meta.delete(key); }
  else tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}

/* ---------- export / import ---------- */
// Backup includes attachment files as base64 (only those present on this device).
export async function exportJSON() {
  const live = [...records.values()].filter((r) => !r.deleted)
    .map((r) => ({ id: r.id, kind: r.kind, updated_at: r.updated_at, data: dataOf(r) }));
  const blobs = [];
  for (const r of live.filter((x) => x.kind === 'attachment')) {
    const b = await getBlobLocal(r.id);
    if (b) blobs.push({ id: r.id, type: b.type || r.data.mime || 'application/octet-stream', data: await blobToBase64(b) });
  }
  return { app: 'skill-ledger', version: 2, exported_at: new Date().toISOString(), records: live, blobs };
}
export async function importJSON(obj) {
  if (!obj || obj.app !== 'skill-ledger' || !Array.isArray(obj.records)) throw new Error('File non valido: non è un backup di Skill Ledger.');
  for (const b of Array.isArray(obj.blobs) ? obj.blobs : []) {
    if (b && b.id && b.data && !(await hasBlob(b.id))) await putBlob(b.id, base64ToBlob(b.data, b.type));
  }
  const list = obj.records.filter((r) => r && r.id && r.kind && typeof r.updated_at === 'number')
    .map((r) => ({ ...r, deleted: false, data: r.kind === 'attachment' ? { ...r.data, remote: false } : r.data }));
  return applyIncoming(list, { markDirty: true });
}
