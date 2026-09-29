import * as store from '../store.js';
import * as sync from '../sync.js';
import * as ai from '../ai.js';
import { esc, toast, APP_VERSION } from '../util.js';
import { registerActions, confirmButton } from '../ui.js';
import { loadSample } from '../seed.js';

let installEvent = null;
let editingProject = false;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; document.dispatchEvent(new CustomEvent('rerender')); });

const STATUS = {
  off: ['Non configurata', ''], 'signed-out': ['Non hai effettuato l\'accesso', ''], idle: ['Sincronizzata', 'ok'],
  syncing: ['Sincronizzazione…', 'busy'], offline: ['Offline: sincronizzerò appena torni online', 'warn'], error: ['Errore', 'bad'],
};

export function render() {
  const cfg = sync.config() || {};
  const ses = sync.session();
  const st = sync.syncState();
  const [label, cls] = STATUS[st.status] || STATUS.off;
  const aic = ai.aiConfig();
  const theme = store.getMeta('theme', 'system');
  const retention = +store.getMeta('retention', 0.9) || 0.9;
  const pending = store.dirtyRecords().length;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  return `
  <header class="page-head"><div><span class="eyebrow">Account, AI e dati</span><h1>Impostazioni</h1></div></header>

  <section class="settings-block">
    <div class="sec-head"><h2>Sincronizzazione</h2><span class="sync-pill ${cls}"><i></i>${label}</span></div>
    <p class="muted">Collega un progetto Supabase gratuito per avere gli stessi dati su telefono e computer. Senza, tutto resta salvato solo su questo dispositivo.</p>
    ${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}
    ${!sync.isConfigured() || editingProject ? `
      <form data-form="sb-config" class="stack">
        <div class="field"><label for="sb-url">URL del progetto</label><input id="sb-url" name="url" type="url" placeholder="https://xxxx.supabase.co" value="${esc(cfg.url || '')}" required></div>
        <div class="field"><label for="sb-key">Chiave "anon public"</label><input id="sb-key" name="key" type="text" autocomplete="off" spellcheck="false" value="${esc(cfg.anonKey || '')}" required><span class="hint">Supabase → Project Settings → API. Prima esegui <code>supabase/schema.sql</code> nel SQL Editor (vedi README).</span></div>
        <div class="row gap"><button class="btn primary" type="submit">Salva configurazione</button></div>
      </form>` : ses ? `
      <div class="kv"><span>Account</span><b>${esc(ses.user?.email || '')}</b></div>
      <div class="kv"><span>Ultima sincronizzazione</span><b class="mono">${st.lastSync ? new Date(st.lastSync).toLocaleString('it-IT') : 'mai'}</b></div>
      <div class="kv"><span>Modifiche in attesa</span><b class="mono">${pending}</b></div>
      <div class="row gap wrap"><button class="btn primary" data-action="sync-now">Sincronizza ora</button><button class="btn" data-action="sb-signout">Esci</button><button class="btn ghost" data-action="sb-edit">Cambia progetto</button></div>
    ` : `
      <form data-form="sb-signin" class="stack">
        <div class="kv"><span>Progetto</span><b class="mono small">${esc(cfg.url)}</b></div>
        <div class="row2">
          <div class="field"><label for="sb-email">Email</label><input id="sb-email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="sb-pass">Password</label><input id="sb-pass" name="password" type="password" autocomplete="current-password" minlength="6" required></div>
        </div>
        <p class="error" data-sb-error hidden></p>
        <div class="row gap wrap"><button class="btn primary" type="submit" name="mode" value="in">Accedi</button><button class="btn" type="submit" name="mode" value="up">Crea account</button><button type="button" class="btn ghost" data-action="sb-edit">Cambia progetto</button></div>
        <span class="hint">Usa lo stesso account su ogni dispositivo. I dati già presenti qui vengono caricati al primo accesso.</span>
      </form>`}
  </section>

  <section class="settings-block">
    <div class="sec-head"><h2>Generazione con AI</h2><span class="sync-pill ${ai.hasKey() ? 'ok' : ''}"><i></i>${ai.hasKey() ? 'Chiave salvata' : 'Nessuna chiave'}</span></div>
    <p class="muted">Serve per creare flashcard e quiz dalle note. La chiave resta solo su questo dispositivo e non viene sincronizzata. Ogni richiesta ha un piccolo costo sul tuo account Anthropic.</p>
    <form data-form="ai-config" class="stack">
      <div class="row2">
        <div class="field"><label for="ai-key">Chiave API Anthropic</label><input id="ai-key" name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(aic.apiKey || '')}"><span class="hint">Creala su console.anthropic.com → API Keys.</span></div>
        <div class="field"><label for="ai-model">Modello</label><input id="ai-model" name="model" type="text" spellcheck="false" value="${esc(aic.model || ai.DEFAULT_MODEL)}"><span class="hint">Predefinito: <code>${ai.DEFAULT_MODEL}</code></span></div>
      </div>
      <div class="row gap"><button class="btn primary" type="submit">Salva</button>${aic.apiKey ? '<button type="button" class="btn ghost" data-action="ai-forget">Rimuovi chiave</button>' : ''}</div>
    </form>
  </section>

  <section class="settings-block">
    <div class="sec-head"><h2>Dati</h2></div>
    <p class="muted">Esporta un backup in JSON o importalo su un altro dispositivo. L'importazione unisce i dati: per ogni elemento vince la versione più recente.</p>
    <div class="row gap wrap">
      <button class="btn" data-action="export">Esporta backup</button>
      <label class="btn file-btn">Importa backup<input type="file" accept="application/json,.json" data-change="import" hidden></label>
      <button class="btn" data-action="load-sample-settings">Carica esempi</button>
      ${confirmButton('Cancella tutto su questo dispositivo', 'wipe')}
    </div>
    <p class="hint">"Cancella tutto" svuota solo questo dispositivo. Se la sincronizzazione è attiva, i dati tornano al prossimo accesso.</p>
  </section>

  <section class="settings-block">
    <div class="sec-head"><h2>Ripasso delle flashcard</h2><span class="sync-pill"><i></i>Algoritmo FSRS-5</span></div>
    <p class="muted">Per ogni carta l'app stima quanto è probabile che te la ricordi e te la ripropone quando quella probabilità scende al livello che scegli qui. Più alto significa ricordare di più, ma con più ripassi al giorno.</p>
    <div class="seg" role="radiogroup" aria-label="Memoria desiderata">${[[0.8, '80%'], [0.85, '85%'], [0.9, '90%'], [0.95, '95%']].map(([v, l]) => `<label><input type="radio" name="retention" value="${v}" data-change="retention" ${Math.abs(retention - v) < 0.001 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    <p class="hint">90% è il valore consigliato. Con 95% i ripassi quasi raddoppiano; con 80% sono circa la metà, ma dimentichi di più. Vale per questo dispositivo.</p>
  </section>

  <section class="settings-block">
    <div class="sec-head"><h2>Aspetto e app</h2></div>
    <div class="row gap wrap">
      <div class="seg" role="radiogroup" aria-label="Tema">${[['system', 'Sistema'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([k, l]) => `<label><input type="radio" name="theme" value="${k}" data-change="theme" ${k === theme ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      ${standalone ? '<span class="sync-pill ok"><i></i>App installata</span>' : installEvent ? '<button class="btn primary" data-action="install">Installa app</button>' : ''}
    </div>
    <p class="hint mono">Versione ${APP_VERSION} · FSRS, quaderno, allegati e link</p>
    ${standalone ? '' : `<p class="hint">Per installarla: su Chrome/Edge usa il pulsante "Installa" nella barra degli indirizzi; su iPhone apri in Safari → Condividi → "Aggiungi alla schermata Home"; su Android menu ⋮ → "Installa app".</p>`}
  </section>`;
}

function rerender() { document.dispatchEvent(new CustomEvent('rerender')); }

registerActions({
  'sb-config': async (form) => {
    const fd = new FormData(form);
    try { await sync.configure(fd.get('url'), fd.get('key')); editingProject = false; toast('Progetto salvato'); }
    catch (e) { toast(e.message, 'bad'); }
    rerender();
  },
  'sb-edit': () => { editingProject = true; rerender(); },
  'sb-signin': async (form, ev) => {
    const fd = new FormData(form);
    const mode = ev.submitter?.value || 'in';
    const err = form.querySelector('[data-sb-error]');
    const btns = form.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    try {
      if (mode === 'up') {
        const r = await sync.signUp(fd.get('email'), fd.get('password'));
        if (!r.confirmed) { err.hidden = false; err.className = 'hint'; err.textContent = 'Account creato. Conferma l\'email che ti è arrivata, poi torna qui e premi Accedi.'; btns.forEach((b) => { b.disabled = false; }); return; }
      } else await sync.signIn(fd.get('email'), fd.get('password'));
      toast('Accesso effettuato');
    } catch (e) {
      err.hidden = false; err.className = 'error';
      err.textContent = /invalid login/i.test(e.message) ? 'Email o password non corretti.' : e.message;
      btns.forEach((b) => { b.disabled = false; });
      return;
    }
    rerender();
  },
  'sb-signout': async () => { await sync.signOut(); toast('Disconnesso'); rerender(); },
  'sync-now': async () => { await sync.syncNow(); rerender(); },
  'ai-config': async (form) => {
    const fd = new FormData(form);
    await store.setMeta('ai', { apiKey: String(fd.get('apiKey') || '').trim(), model: String(fd.get('model') || '').trim() || ai.DEFAULT_MODEL });
    toast('Impostazioni AI salvate'); rerender();
  },
  'ai-forget': async () => { await store.setMeta('ai', { apiKey: '', model: ai.aiConfig().model }); toast('Chiave rimossa'); rerender(); },
  export: async (el) => {
    el.disabled = true;
    const data = JSON.stringify(await store.exportJSON());
    el.disabled = false;
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `skill-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  import: async (input) => {
    const file = input.files?.[0];
    if (!file) return;
    try { const n = await store.importJSON(JSON.parse(await file.text())); toast(`Importati ${n} elementi`); }
    catch (e) { toast(e.message || 'File non valido', 'bad'); }
    input.value = '';
  },
  'load-sample-settings': async () => { await loadSample(); toast('Esempi caricati'); },
  wipe: async () => { await store.wipe(); await store.setMeta('cursor', null); toast('Dati cancellati da questo dispositivo'); },
  retention: async (el) => { await store.setMeta('retention', +el.value); toast(`Memoria desiderata: ${Math.round(el.value * 100)}%. Vale dai prossimi ripassi.`); },
  theme: async (el) => { await store.setMeta('theme', el.value); applyTheme(); },
  install: async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; rerender(); },
});

export function applyTheme() {
  const t = store.getMeta('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#11141B' : '#F4F6F9');
}
