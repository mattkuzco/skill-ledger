import * as store from '../store.js';
import { esc, today, addDays, shuffle, plural, toast } from '../util.js';
import { GRADES, schedule, previewInterval, stateOf, LEARN_AHEAD } from '../srs.js';
import { registerActions, studyQueue, addExtraNew, inScope, scopeLabel, scopeOptions, emptyState, areaChip } from '../ui.js';
import { presetForTopic, presetForScope, topicPresetId, areaPresetId, DEFAULT_ID } from '../presets.js';
import { navigate } from '../router.js';

const optionsHref = (scope) => {
  const [k, id] = String(scope || 'all').split(':');
  if (k === 'topic') return `#/options/${topicPresetId(id)}?for=topic:${id}`;
  if (k === 'area') return `#/options/${areaPresetId(id)}?for=area:${id}`;
  return `#/options/${DEFAULT_ID}`;
};
const countsLine = (q, cls = '') => `<span class="srs-counts ${cls}"><span class="c-new" title="Nuove">${q.fresh.length}</span><span class="c-learn" title="In apprendimento">${q.learn.length}</span><span class="c-rev" title="Da ripassare">${q.review.length}</span></span>`;

/* ---------- hub ---------- */
export function renderHub(params) {
  const scope = params.get('scope') || 'all';
  const q = studyQueue(scope);
  const due = q.count;
  const total = store.all('card').filter((c) => inScope(c, scope)).length;
  const qn = store.all('question').filter((x) => inScope(x, scope)).length;
  const qo = presetForScope(scope).quiz;
  const def = qo.count > 0 ? Math.min(qo.count, qn) : qn;
  const counts = [...new Set([5, 10, 20, def].filter((n) => n > 0 && n < qn))].sort((a, b) => a - b);
  const attempts = store.all('attempt').sort((a, b) => b.updated_at - a.updated_at).slice(0, 6);
  return `
  <header class="page-head"><div><span class="eyebrow">Ripasso e verifica</span><h1>Studia</h1></div><a class="btn ghost" href="${optionsHref(scope)}">⚙ Opzioni</a></header>
  <div class="field inline-field"><label for="scope">Cosa vuoi studiare?</label>
    <select id="scope" data-change="study-scope">${scopeOptions(scope)}</select></div>

  <div class="study-grid">
    <section class="study-card">
      <span class="label">Flashcard</span>
      <h2>${due ? `${plural(due, 'carta', 'carte')} per oggi` : 'Niente per oggi'}</h2>
      ${due ? `<p class="counts-legend">${countsLine(q)}<span class="muted small">nuove · in apprendimento · da ripassare</span></p>` : ''}
      <p class="muted">${plural(total, 'carta', 'carte')} in totale.${q.newHidden ? ` Altre ${q.newHidden} nuove aspettano i prossimi giorni (limite giornaliero).` : ''}${q.revHidden ? ` ${plural(q.revHidden, 'ripasso', 'ripassi')} oltre il limite di oggi.` : ''}</p>
      <div class="row gap wrap">
        <a class="btn primary ${due ? '' : 'disabled'}" href="#/study/cards?scope=${encodeURIComponent(scope)}" ${due ? '' : 'aria-disabled="true"'}>Inizia ripasso</a>
        <a class="btn ${total ? '' : 'disabled'}" href="#/study/cards?scope=${encodeURIComponent(scope)}&mode=free" ${total ? '' : 'aria-disabled="true"'}>Ripasso libero</a>
      </div>
    </section>
    <section class="study-card">
      <span class="label">Quiz</span>
      <h2>${qn ? plural(qn, 'domanda', 'domande') : 'Nessuna domanda'}</h2>
      <p class="muted">${qo.order === 'sequential' ? 'In ordine' : 'In ordine casuale'}${qo.weakFirst && qo.order !== 'sequential' ? ', prima quelle sbagliate di recente' : ''}. ${qo.feedback === 'end' ? 'Risultati e spiegazioni alla fine.' : 'Spiegazione dopo ogni risposta.'}${qo.timeLimit ? ` ${qo.timeLimit} secondi per domanda.` : ''}</p>
      <div class="row gap wrap">
        <select id="quiz-n" aria-label="Numero di domande" ${qn ? '' : 'disabled'}>${counts.map((n) => `<option value="${n}" ${n === def ? 'selected' : ''}>${n} domande</option>`).join('')}<option value="${qn}" ${def === qn ? 'selected' : ''}>Tutte (${qn})</option></select>
        <button class="btn primary" data-action="quiz-start" data-scope="${esc(scope)}" ${qn ? '' : 'disabled'}>Inizia quiz</button>
      </div>
    </section>
  </div>

  ${attempts.length ? `<section><div class="sec-head"><h2>Quiz recenti</h2></div><div class="list">${attempts.map((a) => `
    <div class="list-row"><div class="grow"><b>${esc(scopeLabel(a.scope))}</b><div class="meta">${a.date}</div></div><span class="score mono ${a.score / a.total >= 0.8 ? 'ok-text' : a.score / a.total < 0.5 ? 'warn' : ''}">${a.score}/${a.total}</span></div>`).join('')}</div></section>` : ''}`;
}

/* ---------- timers (card stopwatch, quiz countdown) ---------- */
let ticker = 0;
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const sw = document.querySelector('[data-card-timer]');
    if (sw) { const s = Math.floor((Date.now() - +sw.dataset.since) / 1000); sw.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    const cd = document.querySelector('[data-quiz-timer]');
    if (cd && Q && Q.deadline && Q.chosen === null) {
      const left = Math.max(0, Q.deadline - Date.now());
      cd.textContent = `${Math.ceil(left / 1000)} s`;
      cd.classList.toggle('low', left < 5000);
      if (!left) choose(-1); // time is up: counts as wrong
    }
    if (!sw && !cd) { clearInterval(ticker); ticker = 0; }
  }, 250);
}

/* ---------- flashcard session ---------- */
let S = null;       // current card session
let wakeTimer = 0;  // re-render when a learning card comes back

const inLearning = (c) => ['learning', 'relearning'].includes(stateOf(c?.srs));
function startCards(scope, mode) {
  if (mode === 'free') {
    const pool = shuffle(store.all('card').filter((c) => inScope(c, scope) && !c.suspended)).slice(0, 60);
    S = { key: scope + '|free', scope, mode, queue: pool.map((c) => c.id), idx: 0, revealed: false, known: 0, started: Date.now(), total: pool.length, seen: new Set() };
    return;
  }
  const q = studyQueue(scope);
  S = {
    key: scope + '|due', scope, mode, learn: q.learn.map((c) => c.id), review: q.review.map((c) => c.id), fresh: q.fresh.map((c) => c.id),
    mix: q.mix, ratio: q.fresh.length ? Math.max(1, Math.floor(q.review.length / q.fresh.length)) : 0, sinceNew: 0,
    current: null, revealed: false, tally: [0, 0, 0, 0], started: Date.now(), done: 0, undo: [], newHidden: q.newHidden, shownAt: 0,
  };
}
function pickNext({ ahead = false } = {}) {
  const now = Date.now();
  const learning = S.learn.map((id) => store.get(id)).filter((c) => c && inLearning(c) && !c.suspended && !(c.buriedUntil > today()))
    .sort((a, b) => (a.srs.dueAt || 0) - (b.srs.dueAt || 0));
  S.learn = learning.map((c) => c.id);
  if (learning[0] && learning[0].srs.dueAt <= now) return learning[0].id;
  const alive = (list) => { while (list.length && !store.get(list[0])) list.shift(); return list[0] || null; };
  const n = alive(S.fresh); const r = alive(S.review);
  let id;
  if (S.mix === 'newFirst') id = n || r;
  else if (S.mix === 'reviewsFirst') id = r || n;
  else id = n && (!r || S.sinceNew >= S.ratio) ? n : r || n; // new cards spread among the reviews
  if (id) return id;
  if (learning[0] && (ahead || learning[0].srs.dueAt <= now + LEARN_AHEAD)) return learning[0].id;
  return null;
}
const cardOpts = (c) => { const p = presetForTopic(c.topicId).cards; return { p, o: { learnSteps: p.learnSteps, relearnSteps: p.relearnSteps, retention: p.retention, maxInterval: p.maxInterval } }; };

export function renderCards(params) {
  const scope = params.get('scope') || 'all';
  const mode = params.get('mode') === 'free' ? 'free' : 'due';
  if (!S || S.key !== scope + '|' + mode) startCards(scope, mode);
  return mode === 'free' ? renderFree(scope) : renderDue(scope);
}

function renderDue(scope) {
  clearTimeout(wakeTimer);
  if (!S.current) { S.current = pickNext(); S.revealed = false; S.shownAt = Date.now(); }
  const head = sessionHead(scope, 'due');
  if (!S.current) {
    const waiting = S.learn.map((id) => store.get(id)).filter(Boolean).sort((a, b) => a.srs.dueAt - b.srs.dueAt)[0];
    if (waiting) {
      const mins = Math.max(1, Math.ceil((waiting.srs.dueAt - Date.now()) / 60000));
      const ms = waiting.srs.dueAt - Date.now() - LEARN_AHEAD;
      if (ms < 3600e3) wakeTimer = setTimeout(rerender, Math.max(1000, ms));
      return `${head}<div class="summary">
        <span class="label">Pausa</span>
        <h2>${plural(S.learn.length, 'carta torna', 'carte tornano')} più tardi</h2>
        <p>La prossima carta in apprendimento torna tra <b>${mins < 60 ? plural(mins, 'minuto', 'minuti') : `circa ${Math.round(mins / 60)} h`}</b>. Rivederla dopo una pausa aiuta a fissarla; se preferisci, puoi ripassarla subito.</p>
        <div class="row gap wrap center-row"><button class="btn primary" data-action="card-ahead">Ripassala ora</button>${S.done ? '<button class="btn" data-action="card-finish">Termina la sessione</button>' : '<a class="btn" href="#/study">Torna a Studia</a>'}</div>
      </div>`;
    }
    if (S.done) return head + cardsSummary();
    return `${head}${emptyState('Hai finito per oggi', S.newHidden ? `Hai raggiunto il limite di carte nuove per oggi: altre ${S.newHidden} aspettano i prossimi giorni.` : 'Non ci sono carte da ripassare. Puoi fare un ripasso libero o tornare domani.',
      `${S.newHidden ? '<button class="btn primary" data-action="card-more-new">Studiane altre 10 oggi</button>' : ''}<a class="btn" href="#/study/cards?scope=${encodeURIComponent(scope)}&mode=free">Ripasso libero</a><a class="btn" href="#/study">Torna a Studia</a>`)}`;
  }
  const c = store.get(S.current);
  if (!c) { S.current = null; return renderDue(scope); }
  const t = store.get(c.topicId);
  const { p, o } = cardOpts(c);
  const st = stateOf(c.srs);
  const cls = st === 'new' ? 'on-new' : st === 'review' ? 'on-rev' : 'on-learn';
  if (p.showTimer) ensureTicker();
  return `
  ${head}
  <div class="session-bar">${countsLine(S, cls)}${p.showTimer ? `<span class="card-timer mono" data-card-timer data-since="${S.shownAt}">0:00</span>` : ''}
    <span class="session-tools">
      <button class="btn sm ghost" data-action="card-undo" ${S.undo.length ? '' : 'disabled'} title="Annulla l'ultima risposta (Z)">↶ Annulla</button>
      <button class="btn sm ghost" data-action="card-bury" title="Rimanda questa carta a domani (-)">Rimanda</button>
      <button class="btn sm ghost" data-action="card-suspend" title="Sospendi: non verrà più proposta finché non la riattivi (@)">Sospendi</button>
    </span></div>
  <div class="flash ${S.revealed ? 'revealed' : ''}" ${S.revealed ? '' : 'data-action="card-reveal"'} tabindex="0">
    <div class="flash-meta">${t ? areaChip(t.areaId) + `<span>${esc(t.title)}</span>` : ''}${st === 'new' ? '<span class="badge new">Nuova</span>' : st !== 'review' ? '<span class="badge learn">In apprendimento</span>' : ''}${c.leech ? '<span class="badge leech">Sanguisuga</span>' : ''}</div>
    <div class="flash-front">${esc(c.front)}</div>
    ${S.revealed ? `<hr><div class="flash-back">${esc(c.back)}</div>` : `<div class="flash-hint">Pensa alla risposta, poi tocca per girare <kbd>Spazio</kbd></div>`}
  </div>
  ${S.revealed
    ? `<div class="grade-row">${GRADES.map((g) => `<button class="btn grade g${g.value}" data-action="card-grade" data-grade="${g.value}">${g.label}${p.showIntervals ? `<span class="mono small">${previewInterval(c.srs, g.value, o)}</span>` : ''}<kbd>${g.key}</kbd></button>`).join('')}</div>`
    : `<div class="grade-row one"><button class="btn primary big" data-action="card-reveal">Mostra risposta</button></div>`}
  `;
}

function renderFree(scope) {
  const head = sessionHead(scope, 'free');
  if (!S.total) return `${head}${emptyState('Nessuna flashcard qui', 'Aggiungi flashcard da un argomento.', '<a class="btn" href="#/study">Torna a Studia</a>')}`;
  if (S.idx >= S.queue.length) return head + cardsSummary();
  const c = store.get(S.queue[S.idx]);
  if (!c) { S.idx++; return renderFree(scope); }
  const t = store.get(c.topicId);
  const left = S.queue.length - S.idx;
  return `
  ${head}
  <div class="session-progress"><span style="width:${(S.seen.size / S.total) * 100}%"></span></div>
  <p class="small muted mono center">${plural(left, 'carta rimasta', 'carte rimaste')}</p>
  <div class="flash ${S.revealed ? 'revealed' : ''}" ${S.revealed ? '' : 'data-action="card-reveal"'} tabindex="0">
    <div class="flash-meta">${t ? areaChip(t.areaId) + `<span>${esc(t.title)}</span>` : ''}</div>
    <div class="flash-front">${esc(c.front)}</div>
    ${S.revealed ? `<hr><div class="flash-back">${esc(c.back)}</div>` : `<div class="flash-hint">Pensa alla risposta, poi tocca per girare <kbd>Spazio</kbd></div>`}
  </div>
  ${S.revealed
    ? `<div class="grade-row two"><button class="btn grade g0" data-action="card-free" data-known="0">Da rivedere <kbd>1</kbd></button><button class="btn grade g2" data-action="card-free" data-known="1">Lo so <kbd>2</kbd></button></div>`
    : `<div class="grade-row one"><button class="btn primary big" data-action="card-reveal">Mostra risposta</button></div>`}`;
}

function sessionHead(scope, mode) {
  return `<header class="session-head"><a class="btn ghost" href="#/study">← Esci</a><div class="center"><span class="label">${mode === 'free' ? 'Ripasso libero' : 'Ripasso flashcard'}</span><b>${esc(scopeLabel(scope))}</b></div><a class="btn ghost sm" href="${optionsHref(scope)}" title="Opzioni di studio">⚙</a></header>`;
}

function cardsSummary() {
  const mins = Math.max(1, Math.round((Date.now() - S.started) / 60000));
  const n = S.mode === 'free' ? S.total : S.done;
  const body = S.mode === 'free'
    ? `<p>Ne sapevi <b>${S.known}</b> su ${S.total}.</p>`
    : `<p>${GRADES.map((g, i) => `${g.label}: <b class="mono">${S.tally[i]}</b>`).join(' · ')}</p>`;
  return `<div class="summary">
    <span class="label">Sessione completata</span>
    <h2>${S.mode === 'free' ? plural(n, 'carta ripassata', 'carte ripassate') : plural(n, 'risposta', 'risposte')}</h2>
    ${body}
    <p class="muted">Circa ${mins} min.${S.mode !== 'free' && S.newHidden ? ` Altre ${S.newHidden} carte nuove aspettano i prossimi giorni.` : ''}</p>
    <div class="row gap wrap center-row">
      <button class="btn primary" data-action="log-quick" data-kind="cards" data-min="${mins}" data-scope="${esc(S.scope)}" data-note="Ripasso flashcard: ${n} ${S.mode === 'free' ? 'carte' : 'risposte'}" ${S.logged ? 'disabled' : ''}>${S.logged ? 'Registrato nel registro' : `Registra ${mins} min nel registro`}</button>
      ${S.mode !== 'free' && S.newHidden ? '<button class="btn" data-action="card-more-new">Studia altre 10 nuove</button>' : ''}
      <a class="btn" href="#/study">Torna a Studia</a>
    </div>
  </div>`;
}

function snapshot(c) {
  S.undo.push({ card: JSON.parse(JSON.stringify(c)), learn: [...S.learn], review: [...S.review], fresh: [...S.fresh], tally: [...S.tally], done: S.done, sinceNew: S.sinceNew });
  if (S.undo.length > 50) S.undo.shift();
}
const dropFromLists = (id) => { for (const k of ['learn', 'review', 'fresh']) S[k] = S[k].filter((x) => x !== id); };

async function grade(g) {
  const c = store.get(S.current);
  if (!c) return;
  const { p, o } = cardOpts(c);
  snapshot(c);
  const was = stateOf(c.srs);
  const next = schedule(c.srs, g, o);
  dropFromLists(c.id);
  if (was === 'new') S.sinceNew = 0; else if (was === 'review') S.sinceNew++;
  const extra = {};
  let msg = '';
  if (was === 'review' && g === 0) {
    // a leech: forgotten again and again. Anki flags it at the threshold, then every half threshold.
    const L = next.lapses; const T = +p.leechThreshold || 0;
    if (T > 0 && L >= T && (L - T) % Math.max(1, Math.ceil(T / 2)) === 0) {
      extra.leech = true;
      if (p.leechAction === 'suspend') extra.suspended = true;
      msg = `Carta "sanguisuga": l'hai dimenticata ${L} volte. ${extra.suspended ? 'L\'ho sospesa: riscrivila in modo più semplice o dividila in due, poi riattivala.' : 'Prova a riscriverla in modo più semplice o a dividerla in due.'}`;
    }
  }
  if ((next.state === 'learning' || next.state === 'relearning') && !extra.suspended) S.learn.push(c.id);
  S.tally[g]++; S.done++; S.current = null;
  await store.put('card', { ...c, ...extra, srs: next });
  if (msg) toast(msg, 'bad');
  rerender();
}
async function undo() {
  const u = S?.undo?.pop();
  if (!u) return;
  const c = u.card;
  await store.put('card', { ...c, leech: !!c.leech, suspended: !!c.suspended, buriedUntil: c.buriedUntil || '' });
  Object.assign(S, { learn: u.learn, review: u.review, fresh: u.fresh, tally: u.tally, done: u.done, sinceNew: u.sinceNew, current: c.id, revealed: false, shownAt: Date.now() });
  toast('Risposta annullata');
  rerender();
}
async function setAside(kind) {
  const c = store.get(S?.current);
  if (!c) return;
  snapshot(c);
  dropFromLists(c.id);
  S.current = null;
  await store.put('card', kind === 'bury' ? { ...c, buriedUntil: addDays(today(), 1) } : { ...c, suspended: true });
  toast(kind === 'bury' ? 'Rimandata a domani' : 'Carta sospesa: la riattivi dalla scheda Flashcard dell\'argomento');
  rerender();
}

/* ---------- quiz ---------- */
let Q = null;

// Recently wrong questions weigh more (last 15 quizzes, newer ones count more).
function weakness() {
  const w = new Map();
  const recent = store.all('attempt').sort((a, b) => b.updated_at - a.updated_at).slice(0, 15);
  recent.forEach((a, i) => {
    const k = 1 - i / 15;
    for (const id of a.wrong || []) w.set(id, (w.get(id) || 0) + k);
    for (const id of a.ids || []) if (!(a.wrong || []).includes(id)) w.set(id, (w.get(id) || 0) - k * 0.4);
  });
  return w;
}
function startQuiz(scope, n, ids) {
  const opt = presetForScope(scope).quiz;
  let pool;
  if (ids) pool = ids.map((id) => store.get(id)).filter(Boolean);
  else {
    pool = store.all('question').filter((q) => inScope(q, scope));
    if (opt.order === 'sequential') pool.sort((a, b) => (a.created || '').localeCompare(b.created || '') || a.updated_at - b.updated_at);
    else {
      pool = shuffle(pool);
      if (opt.weakFirst) { const w = weakness(); pool.sort((a, b) => (w.get(b.id) || 0) - (w.get(a.id) || 0)); }
    }
    const count = n || opt.count;
    if (count > 0) pool = pool.slice(0, count);
  }
  const order = (q) => (opt.shuffleOptions ? shuffle(q.options.map((_, i) => i)) : q.options.map((_, i) => i));
  Q = {
    key: scope + '|' + Date.now(), scope, idx: 0, chosen: null, correct: 0, wrong: [], results: [], started: Date.now(),
    opts: opt, main: pool.length, retried: false, deadline: 0, saved: false, order,
    items: pool.map((q) => ({ id: q.id, order: order(q), retry: false })),
  };
}

export function renderQuiz(params) {
  const scope = params.get('scope') || 'all';
  const n = +params.get('n') || 0;
  const ids = params.get('ids') ? params.get('ids').split(',').filter(Boolean) : null;
  if (!Q || Q.scope !== scope || params.get('restart') === '1') {
    startQuiz(scope, n, ids);
    if (params.get('restart') === '1') {
      params.delete('restart');
      history.replaceState(null, '', `#/study/quiz?${params}`);
    }
  }
  const item = Q.items[Q.idx];
  const retry = !!item?.retry;
  const progress = !Q.items.length ? '' : retry ? `Errori ${Q.idx - Q.main + 1}/${Q.items.length - Q.main}` : `${Math.min(Q.idx + 1, Q.main)}/${Q.main}`;
  const head = `<header class="session-head"><a class="btn ghost" href="#/study">← Esci</a><div class="center"><span class="label">${retry ? 'Ripasso degli errori' : 'Quiz'}</span><b>${esc(scopeLabel(scope))}</b></div><span class="mono small">${progress}</span></header>`;
  if (!Q.items.length) return head + emptyState('Nessuna domanda', 'Aggiungi domande da un argomento, a mano, con l\'AI o importandole.', '<a class="btn" href="#/study">Torna a Studia</a>');
  if (Q.idx >= Q.items.length) return head + quizSummary();

  const q = store.get(item.id);
  if (!q) { Q.idx++; return renderQuiz(params); }
  const answered = Q.chosen !== null;
  const t = store.get(q.topicId);
  if (Q.opts.timeLimit && !answered && !Q.deadline) Q.deadline = Date.now() + Q.opts.timeLimit * 1000;
  if (Q.deadline && !answered) ensureTicker();
  return `${head}
  <div class="session-progress"><span style="width:${(Math.min(Q.idx, Q.main) / Q.main) * 100}%"></span></div>
  <div class="quiz">
    <div class="flash-meta">${t ? areaChip(t.areaId) + `<span>${esc(t.title)}</span>` : ''}${Q.deadline && !answered ? `<span class="quiz-timer mono" data-quiz-timer>${Q.opts.timeLimit} s</span>` : ''}</div>
    <h2 class="quiz-q">${esc(q.question)}</h2>
    <div class="options">
      ${item.order.map((oi, pos) => {
        let cls = '';
        if (answered) cls = oi === q.answer ? 'right' : oi === Q.chosen ? 'wrong' : 'dim';
        return `<button class="option ${cls}" data-action="quiz-choose" data-opt="${oi}" ${answered ? 'disabled' : ''}><kbd>${pos + 1}</kbd><span>${esc(q.options[oi])}</span>${answered && oi === q.answer ? '<span class="mark">✓</span>' : answered && oi === Q.chosen ? '<span class="mark">✗</span>' : ''}</button>`;
      }).join('')}
    </div>
    ${answered ? `<div class="feedback ${Q.chosen === q.answer ? 'ok' : 'ko'}"><b>${Q.chosen === q.answer ? 'Corretto.' : Q.chosen === -1 ? 'Tempo scaduto.' : 'Non proprio.'}</b> ${esc(q.explanation || (Q.chosen === q.answer ? '' : 'La risposta giusta è: ' + q.options[q.answer]))}</div>
      <div class="row end"><button class="btn primary" data-action="quiz-next" autofocus>${Q.idx + 1 < Q.items.length || (Q.opts.retryWrong && !Q.retried && Q.wrong.length) ? 'Avanti' : 'Vedi risultato'} <kbd>Invio</kbd></button></div>` : ''}
  </div>`;
}

function quizSummary() {
  const total = Q.main;
  const pct = Math.round((Q.correct / total) * 100);
  const mins = Math.max(1, Math.round((Date.now() - Q.started) / 60000));
  if (!Q.saved) {
    Q.saved = true;
    store.put('attempt', { scope: Q.scope, date: today(), score: Q.correct, total, wrong: Q.wrong, ids: Q.items.filter((i) => !i.retry).map((i) => i.id) });
  }
  const letter = (q, i) => (i === -1 ? 'nessuna (tempo scaduto)' : q.options[i] ?? '');
  const list = Q.opts.feedback === 'end'
    ? Q.results.map((r) => ({ q: store.get(r.id), r })).filter((x) => x.q)
    : Q.wrong.map((id) => ({ q: store.get(id), r: Q.results.find((x) => x.id === id) })).filter((x) => x.q);
  const again = [...new Set(Q.wrong)];
  return `<div class="summary">
    <span class="label">Quiz completato</span>
    <h2 class="big-score mono ${pct >= 80 ? 'ok-text' : pct < 50 ? 'warn' : ''}">${Q.correct}/${total}</h2>
    <p>${pct >= 80 ? 'Ottimo, lo sai bene.' : pct >= 50 ? 'Buona base. Ripassa quelle sbagliate.' : 'Vale la pena rileggere le note e riprovare.'}</p>
    ${list.length ? `<div class="list left quiz-review">${list.map(({ q, r }) => {
      const ok = r && r.chosen === q.answer;
      return `<div class="list-row"><div class="grow"><b>${ok ? '✓' : '✗'} ${esc(q.question)}</b>
        ${!ok && r ? `<div class="meta warn">La tua risposta: ${esc(letter(q, r.chosen))}</div>` : ''}
        <div class="meta ok-text">Giusta: ${esc(q.options[q.answer])}</div>
        ${q.explanation ? `<div class="meta">${esc(q.explanation)}</div>` : ''}</div></div>`;
    }).join('')}</div>` : ''}
    <div class="row gap wrap center-row">
      <a class="btn primary" href="#/study/quiz?scope=${encodeURIComponent(Q.scope)}&n=${total}&restart=1">Rifai il quiz</a>
      ${again.length ? `<a class="btn" href="#/study/quiz?scope=${encodeURIComponent(Q.scope)}&ids=${again.join(',')}&restart=1">Rifai solo le sbagliate (${again.length})</a>` : ''}
      <button class="btn" data-action="log-quick" data-kind="quiz" data-min="${mins}" data-scope="${esc(Q.scope)}" data-note="Quiz: ${Q.correct}/${total}" ${Q.logged ? 'disabled' : ''}>${Q.logged ? 'Registrato' : `Registra ${mins} min`}</button>
      <a class="btn" href="#/study">Torna a Studia</a>
    </div>
  </div>`;
}

/* ---------- keyboard ---------- */
export function onKey(e, route) {
  if (e.target.closest('input, textarea, select') || document.getElementById('modal-root').children.length) return;
  if (route === 'cards' && S) {
    if (S.mode === 'free') {
      if (S.idx >= S.queue.length) return;
      if (!S.revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
      else if (S.revealed && ['1', '2'].includes(e.key)) free(e.key === '2');
      return;
    }
    if ((e.key === 'z' || e.key === 'Z') && !e.altKey) { e.preventDefault(); undo(); return; }
    if (!S.current) return;
    if (!S.revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (S.revealed && ['1', '2', '3', '4'].includes(e.key)) grade(+e.key - 1);
    else if (e.key === '-') setAside('bury');
    else if (e.key === '@') setAside('suspend');
  }
  if (route === 'quiz' && Q && Q.idx < Q.items.length) {
    const item = Q.items[Q.idx];
    if (Q.chosen === null && /^[1-9]$/.test(e.key) && +e.key <= item.order.length) choose(item.order[+e.key - 1]);
    else if (Q.chosen !== null && e.key === 'Enter') { e.preventDefault(); next(); }
  }
}

function rerender() { document.dispatchEvent(new CustomEvent('rerender')); }
function reveal() { S.revealed = true; rerender(); }
function free(known) {
  const id = S.queue[S.idx];
  S.seen.add(id);
  if (known) S.known++; else S.queue.push(id);
  S.revealed = false;
  S.idx++;
  rerender();
}
function choose(opt) {
  if (!Q || Q.chosen !== null) return;
  const item = Q.items[Q.idx];
  const q = store.get(item.id);
  Q.chosen = opt; Q.deadline = 0;
  if (!item.retry) {
    if (opt === q.answer) Q.correct++; else Q.wrong.push(q.id);
    Q.results.push({ id: q.id, chosen: opt });
    if (Q.opts.feedback === 'end') { next(); return; } // exam mode: results at the end
  }
  rerender();
}
function next() {
  Q.idx++; Q.chosen = null; Q.deadline = 0;
  // wrong answers come back once at the end, like relearning (not scored)
  if (Q.idx >= Q.items.length && Q.opts.retryWrong && !Q.retried && Q.wrong.length) {
    Q.retried = true;
    const qs = [...new Set(Q.wrong)].map((id) => store.get(id)).filter(Boolean);
    Q.items.push(...qs.map((q) => ({ id: q.id, order: Q.order(q), retry: true })));
  }
  rerender();
}

registerActions({
  'study-scope': (el) => navigate(`#/study?scope=${encodeURIComponent(el.value)}`),
  'quiz-start': (el) => {
    const n = +document.getElementById('quiz-n')?.value || 0;
    Q = null;
    navigate(`#/study/quiz?scope=${encodeURIComponent(el.dataset.scope)}&n=${n}`);
  },
  'card-reveal': () => reveal(),
  'card-grade': (el) => grade(+el.dataset.grade),
  'card-free': (el) => free(el.dataset.known === '1'),
  'card-undo': () => undo(),
  'card-bury': () => setAside('bury'),
  'card-suspend': () => setAside('suspend'),
  'card-ahead': () => { S.current = pickNext({ ahead: true }); S.revealed = false; S.shownAt = Date.now(); rerender(); },
  'card-finish': () => { S.learn = []; rerender(); },
  'card-more-new': async () => { await addExtraNew(S.scope, 10); const k = S.scope; S = null; startCards(k, 'due'); rerender(); },
  'quiz-choose': (el) => choose(+el.dataset.opt),
  'quiz-next': () => next(),
  'log-quick': async (el) => {
    const scope = el.dataset.scope || 'all';
    const [k, id] = scope.split(':');
    const topic = k === 'topic' ? store.get(id) : null;
    const areaId = k === 'area' ? id : topic?.areaId || '';
    if (el.dataset.kind === 'cards' && S) { if (S.logged) return; S.logged = true; }
    if (el.dataset.kind === 'quiz' && Q) { if (Q.logged) return; Q.logged = true; }
    await store.put('session', { date: today(), minutes: +el.dataset.min || 1, areaId, topicId: topic?.id || '', note: el.dataset.note || '' });
    toast('Sessione registrata');
  },
});

// Reset sessions when leaving study routes so the next visit starts fresh.
export function resetSessions() { S = null; Q = null; clearTimeout(wakeTimer); }
