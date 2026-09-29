// Supabase sync over plain REST (no SDK).
//
// Server table `records` (see supabase/schema.sql):
//   id uuid pk, user_id uuid, kind text, data jsonb, updated_at bigint (client ms),
//   deleted bool, synced_at timestamptz (set by a trigger on every write).
// A trigger also refuses updates whose updated_at is older than the stored one, so the
// server keeps the newest version no matter which device pushes last.
//
// Sync = pull everything with synced_at > cursor, merge (last writer wins), then push dirty.

import * as store from './store.js';

const state = { status: 'off', error: '', lastSync: null, running: false };
const listeners = new Set();
export const syncState = () => ({ ...state });
export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function set(patch) { Object.assign(state, patch); listeners.forEach((fn) => fn(syncState())); }

export const config = () => store.getMeta('supabase', null); // { url, anonKey }
export const session = () => store.getMeta('session', null); // { access_token, refresh_token, expires_at, user }
export const isConfigured = () => !!(config()?.url && config()?.anonKey);
export const isSignedIn = () => !!session()?.access_token;

function base() {
  const c = config();
  if (!c) throw new Error('Supabase non configurato.');
  return c.url.replace(/\/+$/, '');
}

async function http(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const c = config();
  const h = { apikey: c.anonKey, 'Content-Type': 'application/json', ...headers };
  if (auth) {
    await ensureFreshToken();
    h.Authorization = `Bearer ${session().access_token}`;
  }
  let res;
  try {
    res = await fetch(base() + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error('Nessuna connessione a Supabase.'), { offline: true });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const msg = json?.msg || json?.error_description || json?.message || json?.error || `Errore ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return json;
}

async function saveSession(s) {
  const expires_at = s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600);
  await store.setMeta('session', {
    access_token: s.access_token, refresh_token: s.refresh_token, expires_at,
    user: { id: s.user?.id, email: s.user?.email },
  });
}

async function ensureFreshToken() {
  const s = session();
  if (!s) throw new Error('Non hai effettuato l\'accesso.');
  if (s.expires_at - 60 > Date.now() / 1000) return;
  const fresh = await http('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', auth: false, body: { refresh_token: s.refresh_token },
  }).catch(async (e) => {
    if (e.status === 400 || e.status === 401) { await store.setMeta('session', null); set({ status: 'signed-out' }); }
    throw e;
  });
  await saveSession({ ...fresh, user: fresh.user || s.user });
}

/* ---------- account ---------- */
export async function configure(url, anonKey) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/.+/.test(clean)) throw new Error('L\'URL deve iniziare con https://');
  if (!anonKey || anonKey.trim().length < 20) throw new Error('Incolla la chiave "anon public" del progetto.');
  await store.setMeta('supabase', { url: clean, anonKey: anonKey.trim() });
  set({ status: isSignedIn() ? 'idle' : 'signed-out', error: '' });
}

export async function signIn(email, password) {
  const s = await http('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
  await connectAccount(s);
}

export async function signUp(email, password) {
  const s = await http('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password } });
  if (s?.access_token) { await connectAccount(s); return { confirmed: true }; }
  return { confirmed: false }; // email confirmation required
}

async function connectAccount(s) {
  const prevUser = store.getMeta('syncUser', null);
  await saveSession(s);
  if (prevUser !== s.user?.id) {
    // New account on this device: upload everything local and pull from scratch.
    await store.setMeta('cursor', null);
    await store.setMeta('syncUser', s.user?.id);
    await store.markAllDirty();
  }
  set({ status: 'idle', error: '' });
  await syncNow();
}

export async function signOut() {
  try { await http('/auth/v1/logout', { method: 'POST' }); } catch { /* ignore */ }
  await store.setMeta('session', null);
  set({ status: 'signed-out', error: '' });
}

/* ---------- sync ---------- */
const PAGE = 1000;

async function pull() {
  let cursor = store.getMeta('cursor', null);
  let total = 0;
  for (;;) {
    const q = new URLSearchParams({ select: 'id,kind,data,updated_at,deleted,synced_at', order: 'synced_at.asc', limit: String(PAGE) });
    if (cursor) q.set('synced_at', `gt.${cursor}`);
    const rows = await http(`/rest/v1/records?${q}`);
    if (!rows.length) break;
    total += await store.applyIncoming(rows.map((r) => ({
      id: r.id, kind: r.kind, data: r.data || {}, updated_at: Number(r.updated_at), deleted: !!r.deleted,
    })));
    cursor = rows[rows.length - 1].synced_at;
    await store.setMeta('cursor', cursor);
    if (rows.length < PAGE) break;
  }
  return total;
}

async function push() {
  const dirty = store.dirtyRecords();
  if (!dirty.length) return 0;
  const userId = session().user.id;
  for (let i = 0; i < dirty.length; i += 500) {
    const batch = dirty.slice(i, i + 500);
    const snapshot = batch.map((r) => ({ id: r.id, updated_at: r.updated_at }));
    await http('/rest/v1/records?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: batch.map((r) => ({
        id: r.id, user_id: userId, kind: r.kind, updated_at: r.updated_at, deleted: !!r.deleted,
        data: r.deleted ? {} : store.dataOf(r),
      })),
    });
    await store.markPushed(snapshot);
  }
  return dirty.length;
}

/* ---------- attachment files (Supabase Storage, bucket "attachments") ---------- */
const BUCKET = 'attachments';
const objectPath = (id) => `${session().user.id}/${id}`;

async function storageFetch(path, { method = 'GET', body, headers = {} } = {}) {
  await ensureFreshToken();
  const c = config();
  let res;
  try {
    res = await fetch(`${base()}/storage/v1/object/${path}`, {
      method, body, headers: { apikey: c.anonKey, Authorization: `Bearer ${session().access_token}`, ...headers },
    });
  } catch {
    throw Object.assign(new Error('Nessuna connessione a Supabase.'), { offline: true });
  }
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    const msg = j?.message || j?.error || `Errore file ${res.status}`;
    if (/bucket not found/i.test(msg)) {
      throw Object.assign(new Error('Su Supabase manca lo spazio "attachments" per foto e PDF. Esegui di nuovo supabase/schema.sql nel SQL Editor: le note si sincronizzano comunque, le foto appena lo crei.'), { status: res.status });
    }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return res;
}

// Upload files that exist on this device but not yet on the server, then mark them remote.
async function pushFiles() {
  const pending = store.all('attachment').filter((a) => !a.remote);
  for (const a of pending) {
    const blob = await store.getBlobLocal(a.id);
    if (!blob) continue; // created elsewhere and not downloaded yet: nothing to upload
    await storageFetch(`${BUCKET}/${objectPath(a.id)}`, {
      method: 'POST', body: blob, headers: { 'Content-Type': blob.type || a.mime || 'application/octet-stream', 'x-upsert': 'true' },
    });
    const cur = store.get(a.id);
    if (cur) await store.put('attachment', { ...cur, remote: true });
  }
}

async function deleteRemoteFiles(tombstones) {
  for (const t of tombstones) {
    try { await storageFetch(`${BUCKET}/${objectPath(t.id)}`, { method: 'DELETE' }); } catch { /* already gone or offline */ }
  }
}

// Get an attachment's file: local cache first, then Supabase Storage.
const inflight = new Map();
export async function fetchFile(id) {
  const local = await store.getBlobLocal(id);
  if (local) return local;
  const a = store.get(id);
  if (!a?.remote || !isConfigured() || !isSignedIn()) return null;
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const res = await storageFetch(`authenticated/${BUCKET}/${objectPath(id)}`);
    const blob = await res.blob();
    const typed = blob.type ? blob : new Blob([blob], { type: a.mime });
    await store.putBlob(id, typed);
    return typed;
  })().finally(() => inflight.delete(id));
  return p;
}

let again = false;
export async function syncNow() {
  if (!isConfigured() || !isSignedIn()) { set({ status: isConfigured() ? 'signed-out' : 'off' }); return; }
  if (state.running) { again = true; return; }
  if (!navigator.onLine) { set({ status: 'offline' }); return; }
  set({ running: true, status: 'syncing', error: '' });
  try {
    await pull();
    const tomb = store.dirtyRecords().filter((r) => r.deleted && r.kind === 'attachment');
    await push();
    await deleteRemoteFiles(tomb);
    await pushFiles();
    await push(); // records flagged remote by pushFiles
    set({ status: 'idle', lastSync: new Date().toISOString() });
    await store.setMeta('lastSync', new Date().toISOString());
  } catch (e) {
    console.error('sync', e);
    set({ status: e.offline ? 'offline' : isSignedIn() ? 'error' : 'signed-out', error: e.message });
  } finally {
    set({ running: false });
    if (again) { again = false; setTimeout(syncNow, 300); }
  }
}

let timer;
export function scheduleSync(ms = 3000) {
  if (!isSignedIn()) return;
  // While the Quaderno is open, sync less eagerly so uploads never compete with the pen.
  if (document.body.classList.contains('board-mode')) ms = Math.max(ms, 10000);
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export function startAutoSync() {
  set({ status: !isConfigured() ? 'off' : isSignedIn() ? 'idle' : 'signed-out', lastSync: store.getMeta('lastSync', null) });
  store.subscribe((src) => { if (src === 'local') scheduleSync(); });
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => set({ status: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 5 * 60 * 1000);
  syncNow();
}
