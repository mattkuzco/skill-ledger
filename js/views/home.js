import * as store from '../store.js';
import { esc, today, addDays, fmtDateLong, fmtWeekday, relDue, plural, toast } from '../util.js';
import { reviewTopic } from '../srs.js';
import { excerpt } from '../md.js';
import { registerActions, dueCards, dueTopics, areaChip, minutesThisWeek, streakDays, emptyState } from '../ui.js';
import { loadSample } from '../seed.js';

export function render() {
  if (store.isEmpty()) {
    return `<header class="page-head"><div><span class="eyebrow">${fmtDateLong(today())}</span><h1>Benvenuto in Skill Ledger</h1></div></header>
    ${emptyState('Inizia da un\'area',
      'Un\'area è qualsiasi cosa tu stia imparando: un esame, un motore di gioco, una lingua. Dentro ci metti argomenti, note, flashcard e quiz. Se vuoi prima vedere come funziona, carica i dati di esempio.',
      `<a class="btn primary" href="#/areas?new=1">+ Crea un'area</a><button class="btn" data-action="load-sample">Carica esempi</button>`)}`;
  }

  const cards = dueCards('all');
  const topics = dueTopics();
  const mins = minutesThisWeek();
  const streak = streakDays();
  const notes = store.all('note').sort((a, b) => b.updated_at - a.updated_at).slice(0, 4);
  const qCount = store.all('question').length;

  const days = [...Array(7)].map((_, i) => addDays(today(), i - 6));
  const perDay = days.map((d) => store.all('session').filter((s) => s.date === d).reduce((n, s) => n + (+s.minutes || 0), 0));
  const max = Math.max(60, ...perDay);

  return `
  <header class="page-head">
    <div><span class="eyebrow">${fmtDateLong(today())}</span><h1>Oggi</h1></div>
  </header>

  <section class="stats">
    <div class="stat ${cards.length ? 'hot' : ''}"><span class="label">Flashcard da ripassare</span><b>${cards.length}</b></div>
    <div class="stat ${topics.length ? 'hot' : ''}"><span class="label">Argomenti da ripassare</span><b>${topics.length}</b></div>
    <div class="stat"><span class="label">Questa settimana</span><b>${(mins / 60).toFixed(1)} h</b></div>
    <div class="stat"><span class="label">Serie</span><b>${plural(streak, 'giorno', 'giorni')}</b></div>
  </section>

  <section class="cta-row">
    <a class="cta ${cards.length ? '' : 'muted'}" href="#/study/cards?scope=all">
      <span class="cta-k">Flashcard</span>
      <span class="cta-t">${cards.length ? `Ripassa ${plural(cards.length, 'carta', 'carte')}` : 'Niente in scadenza'}</span>
      <span class="cta-s">${cards.length ? 'Circa ' + Math.max(1, Math.round(cards.length * 0.3)) + ' min' : 'Puoi fare un ripasso libero'}</span>
    </a>
    <a class="cta ${qCount ? '' : 'muted'}" href="#/study">
      <span class="cta-k">Quiz</span>
      <span class="cta-t">${qCount ? 'Mettiti alla prova' : 'Nessuna domanda ancora'}</span>
      <span class="cta-s">${qCount ? plural(qCount, 'domanda disponibile', 'domande disponibili') : 'Creale da un argomento'}</span>
    </a>
  </section>

  <section>
    <div class="sec-head"><h2>Argomenti da ripassare</h2><span class="hint">Rileggi le note, poi scegli come è andata</span></div>
    ${topics.length ? `<div class="list">${topics.map((t) => `
      <div class="list-row">
        <div class="grow">
          <a class="title-link" href="#/topic/${t.id}">${esc(t.title)}</a>
          <div class="meta">${areaChip(t.areaId)}<span class="${t.nextReview < today() ? 'warn' : ''}">${relDue(t.nextReview)}</span></div>
        </div>
        <div class="btn-group">
          <button class="btn sm" data-action="topic-review" data-id="${t.id}" data-grade="again">Di nuovo</button>
          <button class="btn sm" data-action="topic-review" data-id="${t.id}" data-grade="good">Bene</button>
          <button class="btn sm" data-action="topic-review" data-id="${t.id}" data-grade="easy">Facile</button>
        </div>
      </div>`).join('')}</div>`
      : `<p class="muted pad">Nessun argomento in scadenza. Gli argomenti che stai studiando tornano qui alla data di ripasso.</p>`}
  </section>

  <div class="two-col">
    <section>
      <div class="sec-head"><h2>Ultime note</h2><a class="link" href="#/areas">Tutte le aree</a></div>
      ${notes.length ? `<div class="list">${notes.map((n) => {
        const t = store.get(n.topicId);
        return `<a class="list-row link-row" href="#/note/${n.id}"><div class="grow"><div class="title-link">${esc(n.title || 'Nota senza titolo')}</div><div class="meta">${t ? esc(t.title) + ' · ' : ''}${esc(excerpt(n.body, 90))}</div></div></a>`;
      }).join('')}</div>` : `<p class="muted pad">Ancora nessuna nota.</p>`}
    </section>
    <section>
      <div class="sec-head"><h2>Ultimi 7 giorni</h2><a class="link" href="#/log">Registro</a></div>
      <div class="week-chart" role="img" aria-label="Minuti di studio negli ultimi 7 giorni">
        ${days.map((d, i) => `<div title="${perDay[i]} min"><span class="mono v">${perDay[i] || ''}</span><span class="b ${perDay[i] ? '' : 'zero'}" style="height:${Math.max(3, (perDay[i] / max) * 70)}px"></span><small>${fmtWeekday(d)}</small></div>`).join('')}
      </div>
    </section>
  </div>`;
}

registerActions({
  'topic-review': async (el) => {
    const t = store.get(el.dataset.id);
    if (!t) return;
    const patch = reviewTopic(t, el.dataset.grade);
    await store.put('topic', { ...t, ...patch });
    toast(`Prossimo ripasso: ${relDue(patch.nextReview)}`);
  },
  'load-sample': async () => { await loadSample(); toast('Esempi caricati'); },
});
