import * as store from '../store.js';
import { esc, today, shuffle, plural, toast } from '../util.js';
import { GRADES, schedule, previewInterval, isCardDue } from '../srs.js';
import { registerActions, dueCards, inScope, scopeLabel, scopeOptions, emptyState, areaChip } from '../ui.js';
import { navigate } from '../router.js';

/* ---------- hub ---------- */
export function renderHub(params) {
  const scope = params.get('scope') || 'all';
  const due = dueCards(scope).length;
  const total = store.all('card').filter((c) => inScope(c, scope)).length;
  const qn = store.all('question').filter((q) => inScope(q, scope)).length;
  const attempts = store.all('attempt').sort((a, b) => b.updated_at - a.updated_at).slice(0, 6);
  return `
  <header class="page-head"><div><span class="eyebrow">Ripasso e verifica</span><h1>Studia</h1></div></header>
  <div class="field inline-field"><label for="scope">Cosa vuoi studiare?</label>
    <select id="scope" data-change="study-scope">${scopeOptions(scope)}</select></div>

  <div class="study-grid">
    <section class="study-card">
      <span class="label">Flashcard</span>
      <h2>${due ? `${plural(due, 'carta', 'carte')} da ripassare` : 'Niente in scadenza'}</h2>
      <p class="muted">${plural(total, 'carta', 'carte')} in totale. Il ripasso programmato mostra solo quelle in scadenza e decide quando rivederle.</p>
      <div class="row gap wrap">
        <a class="btn primary ${due ? '' : 'disabled'}" href="#/study/cards?scope=${encodeURIComponent(scope)}" ${due ? '' : 'aria-disabled="true"'}>Inizia ripasso</a>
        <a class="btn ${total ? '' : 'disabled'}" href="#/study/cards?scope=${encodeURIComponent(scope)}&mode=free" ${total ? '' : 'aria-disabled="true"'}>Ripasso libero</a>
      </div>
    </section>
    <section class="study-card">
      <span class="label">Quiz</span>
      <h2>${qn ? plural(qn, 'domanda', 'domande') : 'Nessuna domanda'}</h2>
      <p class="muted">Domande a scelta multipla in ordine casuale, con spiegazione dopo ogni risposta.</p>
      <div class="row gap wrap">
        <select id="quiz-n" aria-label="Numero di domande" ${qn ? '' : 'disabled'}>${[5, 10, 20].filter((n) => n < qn).map((n) => `<option value="${n}" ${n === 10 ? 'selected' : ''}>${n} domande</option>`).join('')}<option value="${qn}" ${qn <= 10 ? 'selected' : ''}>Tutte (${qn})</option></select>
        <button class="btn primary" data-action="quiz-start" data-scope="${esc(scope)}" ${qn ? '' : 'disabled'}>Inizia quiz</button>
      </div>
    </section>
  </div>

  ${attempts.length ? `<section><div class="sec-head"><h2>Quiz recenti</h2></div><div class="list">${attempts.map((a) => `
    <div class="list-row"><div class="grow"><b>${esc(scopeLabel(a.scope))}</b><div class="meta">${a.date}</div></div><span class="score mono ${a.score / a.total >= 0.8 ? 'ok-text' : a.score / a.total < 0.5 ? 'warn' : ''}">${a.score}/${a.total}</span></div>`).join('')}</div></section>` : ''}`;
}

/* ---------- flashcard session ---------- */
let S = null; // current card session

function startCards(scope, mode) {
  const pool = mode === 'free'
    ? shuffle(store.all('card').filter((c) => inScope(c, scope))).slice(0, 60)
    : shuffle(dueCards(scope)).sort((a, b) => (a.srs?.due || '').localeCompare(b.srs?.due || '')).slice(0, 200);
  S = { key: scope + '|' + mode, scope, mode, queue: pool.map((c) => c.id), idx: 0, revealed: false, tally: [0, 0, 0, 0], known: 0, again: 0, started: Date.now(), total: pool.length, seen: new Set() };
}

export function renderCards(params) {
  const scope = params.get('scope') || 'all';
  const mode = params.get('mode') === 'free' ? 'free' : 'due';
  if (!S || S.key !== scope + '|' + mode) startCards(scope, mode);
  if (!S.total) {
    return `${sessionHead(scope, mode)}${emptyState(mode === 'free' ? 'Nessuna flashcard qui' : 'Hai finito per oggi',
      mode === 'free' ? 'Aggiungi flashcard da un argomento.' : 'Non ci sono carte in scadenza. Puoi fare un ripasso libero o tornare domani.',
      `<a class="btn" href="#/study/cards?scope=${encodeURIComponent(scope)}&mode=free">Ripasso libero</a><a class="btn" href="#/study">Torna a Studia</a>`)}`;
  }
  if (S.idx >= S.queue.length) return sessionHead(scope, mode) + cardsSummary();
  const c = store.get(S.queue[S.idx]);
  if (!c) { S.idx++; return renderCards(params); }
  const t = store.get(c.topicId);
  const left = S.queue.length - S.idx;
  return `
  ${sessionHead(scope, mode)}
  <div class="session-progress"><span style="width:${(S.seen.size / S.total) * 100}%"></span></div>
  <p class="small muted mono center">${plural(left, 'carta rimasta', 'carte rimaste')}</p>
  <div class="flash ${S.revealed ? 'revealed' : ''}" ${S.revealed ? '' : 'data-action="card-reveal"'} tabindex="0">
    <div class="flash-meta">${t ? areaChip(t.areaId) + `<span>${esc(t.title)}</span>` : ''}</div>
    <div class="flash-front">${esc(c.front)}</div>
    ${S.revealed ? `<hr><div class="flash-back">${esc(c.back)}</div>` : `<div class="flash-hint">Pensa alla risposta, poi tocca per girare <kbd>Spazio</kbd></div>`}
  </div>
  ${S.revealed ? (S.mode === 'free'
    ? `<div class="grade-row two"><button class="btn grade g0" data-action="card-free" data-known="0">Da rivedere <kbd>1</kbd></button><button class="btn grade g2" data-action="card-free" data-known="1">Lo so <kbd>2</kbd></button></div>`
    : `<div class="grade-row">${GRADES.map((g) => `<button class="btn grade g${g.value}" data-action="card-grade" data-grade="${g.value}">${g.label}<span class="mono small">${g.value === 0 ? 'di nuovo ora' : previewInterval(c.srs, g.value)}</span><kbd>${g.key}</kbd></button>`).join('')}</div>`)
    : `<div class="grade-row one"><button class="btn primary big" data-action="card-reveal">Mostra risposta</button></div>`}
  `;
}

function sessionHead(scope, mode) {
  return `<header class="session-head"><a class="btn ghost" href="#/study">← Esci</a><div class="center"><span class="label">${mode === 'free' ? 'Ripasso libero' : 'Ripasso flashcard'}</span><b>${esc(scopeLabel(scope))}</b></div><span></span></header>`;
}

function cardsSummary() {
  const mins = Math.max(1, Math.round((Date.now() - S.started) / 60000));
  const body = S.mode === 'free'
    ? `<p>Ne sapevi <b>${S.known}</b> su ${S.total}.</p>`
    : `<p>${GRADES.map((g, i) => `${g.label}: <b class="mono">${S.tally[i]}</b>`).join(' · ')}</p>`;
  return `<div class="summary">
    <span class="label">Sessione completata</span>
    <h2>${plural(S.total, 'carta ripassata', 'carte ripassate')}</h2>
    ${body}
    <p class="muted">Circa ${mins} min.</p>
    <div class="row gap wrap center-row">
      <button class="btn primary" data-action="log-quick" data-kind="cards" data-min="${mins}" data-scope="${esc(S.scope)}" data-note="Ripasso flashcard: ${S.total} carte" ${S.logged ? 'disabled' : ''}>${S.logged ? 'Registrato nel registro' : `Registra ${mins} min nel registro`}</button>
      <a class="btn" href="#/study">Torna a Studia</a>
    </div>
  </div>`;
}

/* ---------- quiz ---------- */
let Q = null;

function startQuiz(scope, n) {
  const pool = shuffle(store.all('question').filter((q) => inScope(q, scope))).slice(0, n || 10);
  Q = {
    key: scope + '|' + Date.now(), scope, idx: 0, chosen: null, correct: 0, wrong: [], started: Date.now(),
    items: pool.map((q) => ({ id: q.id, order: shuffle(q.options.map((_, i) => i)) })), saved: false,
  };
}

export function renderQuiz(params) {
  const scope = params.get('scope') || 'all';
  const n = +params.get('n') || 10;
  if (!Q || Q.scope !== scope || params.get('restart') === '1') {
    startQuiz(scope, n);
    if (params.get('restart') === '1') {
      params.delete('restart');
      history.replaceState(null, '', `#/study/quiz?scope=${encodeURIComponent(scope)}&n=${n}`);
    }
  }
  const head = `<header class="session-head"><a class="btn ghost" href="#/study">← Esci</a><div class="center"><span class="label">Quiz</span><b>${esc(scopeLabel(scope))}</b></div><span class="mono small">${Q.items.length ? `${Math.min(Q.idx + 1, Q.items.length)}/${Q.items.length}` : ''}</span></header>`;
  if (!Q.items.length) return head + emptyState('Nessuna domanda', 'Aggiungi domande da un argomento, a mano o con l\'AI.', '<a class="btn" href="#/study">Torna a Studia</a>');
  if (Q.idx >= Q.items.length) return head + quizSummary();

  const item = Q.items[Q.idx];
  const q = store.get(item.id);
  if (!q) { Q.idx++; return renderQuiz(params); }
  const answered = Q.chosen !== null;
  const t = store.get(q.topicId);
  return `${head}
  <div class="session-progress"><span style="width:${(Q.idx / Q.items.length) * 100}%"></span></div>
  <div class="quiz">
    <div class="flash-meta">${t ? areaChip(t.areaId) + `<span>${esc(t.title)}</span>` : ''}</div>
    <h2 class="quiz-q">${esc(q.question)}</h2>
    <div class="options">
      ${item.order.map((oi, pos) => {
        let cls = '';
        if (answered) cls = oi === q.answer ? 'right' : oi === Q.chosen ? 'wrong' : 'dim';
        return `<button class="option ${cls}" data-action="quiz-choose" data-opt="${oi}" ${answered ? 'disabled' : ''}><kbd>${pos + 1}</kbd><span>${esc(q.options[oi])}</span>${answered && oi === q.answer ? '<span class="mark">✓</span>' : answered && oi === Q.chosen ? '<span class="mark">✗</span>' : ''}</button>`;
      }).join('')}
    </div>
    ${answered ? `<div class="feedback ${Q.chosen === q.answer ? 'ok' : 'ko'}"><b>${Q.chosen === q.answer ? 'Corretto.' : 'Non proprio.'}</b> ${esc(q.explanation || (Q.chosen === q.answer ? '' : 'La risposta giusta è: ' + q.options[q.answer]))}</div>
      <div class="row end"><button class="btn primary" data-action="quiz-next" autofocus>${Q.idx + 1 < Q.items.length ? 'Avanti' : 'Vedi risultato'} <kbd>Invio</kbd></button></div>` : ''}
  </div>`;
}

function quizSummary() {
  const total = Q.items.length;
  const pct = Math.round((Q.correct / total) * 100);
  const mins = Math.max(1, Math.round((Date.now() - Q.started) / 60000));
  if (!Q.saved) {
    Q.saved = true;
    store.put('attempt', { scope: Q.scope, date: today(), score: Q.correct, total, wrong: Q.wrong });
  }
  const wrongQs = Q.wrong.map((id) => store.get(id)).filter(Boolean);
  return `<div class="summary">
    <span class="label">Quiz completato</span>
    <h2 class="big-score mono ${pct >= 80 ? 'ok-text' : pct < 50 ? 'warn' : ''}">${Q.correct}/${total}</h2>
    <p>${pct >= 80 ? 'Ottimo, lo sai bene.' : pct >= 50 ? 'Buona base. Ripassa quelle sbagliate.' : 'Vale la pena rileggere le note e riprovare.'}</p>
    ${wrongQs.length ? `<div class="list left">${wrongQs.map((q) => `<div class="list-row"><div class="grow"><b>${esc(q.question)}</b><div class="meta ok-text">${esc(q.options[q.answer])}</div></div></div>`).join('')}</div>` : ''}
    <div class="row gap wrap center-row">
      <a class="btn primary" href="#/study/quiz?scope=${encodeURIComponent(Q.scope)}&n=${total}&restart=1">Rifai il quiz</a>
      <button class="btn" data-action="log-quick" data-kind="quiz" data-min="${mins}" data-scope="${esc(Q.scope)}" data-note="Quiz: ${Q.correct}/${total}" ${Q.logged ? 'disabled' : ''}>${Q.logged ? 'Registrato' : `Registra ${mins} min`}</button>
      <a class="btn" href="#/study">Torna a Studia</a>
    </div>
  </div>`;
}

/* ---------- keyboard ---------- */
export function onKey(e, route) {
  if (e.target.closest('input, textarea, select') || document.getElementById('modal-root').children.length) return;
  if (route === 'cards' && S && S.idx < S.queue.length) {
    if (!S.revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (S.revealed && S.mode !== 'free' && ['1', '2', '3', '4'].includes(e.key)) grade(+e.key - 1);
    else if (S.revealed && S.mode === 'free' && ['1', '2'].includes(e.key)) free(e.key === '2');
  }
  if (route === 'quiz' && Q && Q.idx < Q.items.length) {
    const item = Q.items[Q.idx];
    if (Q.chosen === null && /^[1-9]$/.test(e.key) && +e.key <= item.order.length) choose(item.order[+e.key - 1]);
    else if (Q.chosen !== null && e.key === 'Enter') { e.preventDefault(); next(); }
  }
}

function rerender() { document.dispatchEvent(new CustomEvent('rerender')); }
function reveal() { S.revealed = true; rerender(); }
async function grade(g) {
  const c = store.get(S.queue[S.idx]);
  S.tally[g]++;
  S.seen.add(c.id);
  S.revealed = false;
  if (g === 0) S.queue.push(c.id); // see it again at the end of this session
  S.idx++;
  await store.put('card', { ...c, srs: schedule(c.srs, g) });
  rerender();
}
function free(known) {
  const id = S.queue[S.idx];
  S.seen.add(id);
  if (known) S.known++; else S.queue.push(id);
  S.revealed = false;
  S.idx++;
  rerender();
}
function choose(opt) {
  const q = store.get(Q.items[Q.idx].id);
  Q.chosen = opt;
  if (opt === q.answer) Q.correct++; else Q.wrong.push(q.id);
  rerender();
}
function next() { Q.idx++; Q.chosen = null; rerender(); }

registerActions({
  'study-scope': (el) => navigate(`#/study?scope=${encodeURIComponent(el.value)}`),
  'quiz-start': (el) => {
    const n = +document.getElementById('quiz-n')?.value || 10;
    Q = null;
    navigate(`#/study/quiz?scope=${encodeURIComponent(el.dataset.scope)}&n=${n}`);
  },
  'card-reveal': () => reveal(),
  'card-grade': (el) => grade(+el.dataset.grade),
  'card-free': (el) => free(el.dataset.known === '1'),
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
export function resetSessions() { S = null; Q = null; }
