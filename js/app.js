import * as store from './store.js';
import * as sync from './sync.js';
import { parse, onLeave, runLeave } from './router.js';
import { runAction, isModalOpen, closeModal } from './ui.js';
import { $ } from './util.js';
import * as home from './views/home.js';
import * as areasView from './views/areas.js';
import * as topicView from './views/topic.js';
import * as study from './views/study.js';
import * as logView from './views/log.js';
import * as settings from './views/settings.js';
import { hydrate, openLinkModal, findUrl } from './attachments.js';

let current = parse();
let pending = false;

function route(r) {
  const [a, b] = r.parts;
  switch (a) {
    case undefined: return { nav: 'home', title: 'Oggi', html: () => home.render() };
    case 'areas': return { nav: 'areas', title: 'Aree', html: () => areasView.renderList(r.params) };
    case 'area': return { nav: 'areas', title: store.get(b)?.name || 'Area', html: () => areasView.renderDetail(b) };
    case 'topic': return { nav: 'areas', title: store.get(b)?.title || 'Argomento', html: () => topicView.renderTopic(b, r.params) };
    case 'board': return { nav: 'areas', title: `Quaderno · ${store.get(b)?.title || ''}`, html: () => topicView.renderBoard(b), mount: () => topicView.mountBoardView(b), editor: true, board: true };
    case 'pdf': return { nav: 'areas', title: store.get(b)?.name || 'PDF', html: () => topicView.renderPdf(b), mount: () => topicView.mountPdfView(b), editor: true, board: true };
    case 'note': return { nav: 'areas', title: store.get(b)?.title || 'Nota', html: () => topicView.renderNote(b), mount: () => topicView.mountNote(b), editor: true };
    case 'study':
      if (b === 'cards') return { nav: 'study', title: 'Ripasso', html: () => study.renderCards(r.params), focus: true, session: 'cards' };
      if (b === 'quiz') return { nav: 'study', title: 'Quiz', html: () => study.renderQuiz(r.params), focus: true, session: 'quiz' };
      return { nav: 'study', title: 'Studia', html: () => study.renderHub(r.params) };
    case 'log': return { nav: 'log', title: 'Registro', html: () => logView.render() };
    case 'settings': return { nav: 'settings', title: 'Impostazioni', html: () => settings.render() };
    default: return { nav: 'home', title: 'Oggi', html: () => home.render() };
  }
}

function render({ scroll = false } = {}) {
  pending = false;
  const r = route(current);
  const main = $('#main');
  main.innerHTML = r.html();
  main.dataset.route = current.parts[0] || 'home';
  main.classList.toggle('session', !!r.session);
  document.body.classList.toggle('in-session', !!r.session);
  document.body.classList.toggle('focus-note', !!r.editor);
  document.body.classList.toggle('board-mode', !!r.board);
  document.title = `${r.title} · Skill Ledger`;
  document.querySelectorAll('[data-nav]').forEach((el) => el.setAttribute('aria-current', el.dataset.nav === r.nav ? 'page' : 'false'));
  if (r.mount) r.mount();
  else hydrate(main);
  if (scroll) window.scrollTo(0, 0);
  if (r.focus) {
    const target = main.querySelector('[autofocus]') || main.querySelector('.flash, .option');
    target?.focus({ preventScroll: true });
  }
  renderSyncBadge();
}

function safeRender(source) {
  const r = route(current);
  if (r.editor) return; // the note editor owns its own state; never re-render under the pen
  const ae = document.activeElement;
  const typing = ae && $('#main').contains(ae) && ae.matches('input, textarea, select');
  const playing = [...$('#main').querySelectorAll('audio, video')].some((m) => !m.paused);
  if (isModalOpen() || typing || playing) { pending = true; return; }
  render();
}

/* ---------- sync badge ---------- */
const BADGE = { off: ['Solo su questo dispositivo', ''], 'signed-out': ['Sync: accedi', 'warn'], idle: ['Sincronizzato', 'ok'], syncing: ['Sincronizzazione…', 'busy'], offline: ['Offline', 'warn'], error: ['Errore di sync', 'bad'] };
function renderSyncBadge() {
  const st = sync.syncState();
  const [label, cls] = BADGE[st.status] || BADGE.off;
  document.querySelectorAll('[data-sync-badge]').forEach((el) => {
    el.className = `sync-badge ${cls}`;
    el.title = st.error || label;
    el.querySelector('span').textContent = label;
  });
}

/* ---------- events ---------- */
function bindEvents() {
  document.addEventListener('click', (ev) => {
    const dis = ev.target.closest('[data-disabled], a[aria-disabled="true"]');
    if (dis) { ev.preventDefault(); return; }
    if (ev.target.closest('[data-overlay]') === ev.target) { closeModal(); return; }
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    if (el.tagName !== 'A') ev.preventDefault();
    runAction(el.dataset.action, el, ev);
  });
  document.addEventListener('submit', (ev) => {
    const form = ev.target.closest('[data-form]');
    if (!form) return;
    ev.preventDefault();
    runAction(form.dataset.form, form, ev);
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-change]');
    if (el) runAction(el.dataset.change, el, ev);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isModalOpen()) { closeModal(); return; }
    const r = route(current);
    if (r.session) study.onKey(ev, r.session);
  });
  document.addEventListener('rerender', () => render());
  document.addEventListener('modal-closed', () => { if (pending) render(); });
  document.addEventListener('ended', () => { if (pending && !isModalOpen()) render(); }, true);
  document.addEventListener('focusout', () => setTimeout(() => {
    const ae = document.activeElement;
    if (pending && !isModalOpen() && !(ae && ae.matches('input, textarea, select'))) render();
  }, 50));

  window.addEventListener('hashchange', async () => {
    const prev = current;
    current = parse();
    if (isModalOpen()) closeModal();
    await runLeave(prev);
    if (prev.parts[0] === 'study' && (prev.parts[1] !== current.parts[1] || current.parts[0] !== 'study')) study.resetSessions();
    render({ scroll: true });
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', settings.applyTheme);
}

onLeave(async (prev) => {
  if (prev.parts[0] === 'note' && prev.parts[1]) await topicView.leaveNote(prev.parts[1]);
  if (prev.parts[0] === 'board' || prev.parts[0] === 'pdf') await topicView.leaveBoard();
});

// "Condividi → Skill Ledger" from Chrome or another Android app opens ./?share_url=…&share_text=…
function handleShare() {
  const q = new URLSearchParams(location.search);
  if (!q.has('share_url') && !q.has('share_text') && !q.has('share_title')) return;
  const text = q.get('share_text') || '';
  const url = q.get('share_url') || findUrl(text);
  const title = (q.get('share_title') || text.replace(url, '')).trim().slice(0, 200);
  history.replaceState(null, '', location.pathname + location.hash);
  if (!url) { import('./util.js').then((u) => u.toast('Nel contenuto condiviso non c\'è un link', 'bad')); return; }
  openLinkModal({ url, title, pickTopic: true });
}

async function boot() {
  try {
    await store.init();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty"><h3>Impossibile aprire l'archivio locale</h3><p>Il browser blocca lo spazio di archiviazione (per esempio in navigazione privata). ${e.message || ''}</p></div>`;
    return;
  }
  settings.applyTheme();
  bindEvents();
  store.subscribe(safeRender);
  current = parse(); // the hash may have changed while the store was loading
  sync.onSyncChange(() => {
    renderSyncBadge();
    if (current.parts[0] === 'settings') safeRender('sync');
  });
  render();
  handleShare();
  sync.startAutoSync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // When a new version takes over, reload once so the new files are used right away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update())
      .catch((e) => console.warn('SW', e));
  }
}

boot();
