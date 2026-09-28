import * as store from '../store.js';
import { esc, colorVar, COLORS, STAGES, today, addDays, relDue, plural, toast } from '../util.js';
import { isCardDue } from '../srs.js';
import {
  registerActions, openModal, closeModal, modalError, areas, topicsOf, stageBar, confDots,
  emptyState, confirmButton, areaOptions, dueCards,
} from '../ui.js';
import { navigate } from '../router.js';
import { removeAttachment } from '../attachments.js';

/* ---------- list ---------- */
export function renderList(params) {
  if (params.get('new') === '1') {
    params.delete('new');
    setTimeout(() => { history.replaceState(null, '', '#/areas'); openAreaModal(); }, 0);
  }
  const list = areas();
  return `
  <header class="page-head">
    <div><span class="eyebrow">Tutto quello che stai imparando</span><h1>Aree</h1></div>
    <button class="btn primary" data-action="area-new">+ Nuova area</button>
  </header>
  ${list.length ? `<div class="area-grid">${list.map((a) => {
    const topics = topicsOf(a.id);
    const ids = new Set(topics.map((t) => t.id));
    const cards = store.all('card').filter((c) => ids.has(c.topicId));
    const due = cards.filter(isCardDue).length;
    const notes = store.all('note').filter((n) => ids.has(n.topicId)).length;
    return `<a class="area-card" href="#/area/${a.id}" style="--area:${colorVar(a.color)}">
      <div class="area-card-head"><span class="swatch"></span><span class="status ${a.status || 'active'}">${statusLabel(a.status)}</span></div>
      <h3>${esc(a.name)}</h3>
      <p class="goal-line">${a.goal ? esc(a.goal) : '<span class="muted">Nessun obiettivo</span>'}</p>
      ${stageBar(topics, { legend: false })}
      <div class="area-card-foot mono">
        <span>${plural(topics.length, 'argomento', 'argomenti')}</span>
        <span>${plural(notes, 'nota', 'note')}</span>
        <span>${plural(cards.length, 'carta', 'carte')}${due ? ` · <b class="warn">${due} da ripassare</b>` : ''}</span>
      </div>
    </a>`;
  }).join('')}</div>`
    : emptyState('Nessuna area', 'Crea un\'area per ogni cosa che stai imparando, con un obiettivo concreto.', '<button class="btn primary" data-action="area-new">+ Nuova area</button>')}`;
}
const statusLabel = (s) => ({ active: 'Attiva', paused: 'In pausa', done: 'Completata' }[s || 'active']);

/* ---------- detail ---------- */
export function renderDetail(id) {
  const a = store.get(id);
  if (!a) return emptyState('Area non trovata', 'Forse è stata eliminata.', '<a class="btn" href="#/areas">Torna alle aree</a>');
  const topics = topicsOf(id);
  const due = dueCards('area:' + id).length;
  const qn = store.all('question').filter((q) => topics.some((t) => t.id === q.topicId)).length;
  return `
  <nav class="crumbs"><a href="#/areas">Aree</a><span>/</span><span>${esc(a.name)}</span></nav>
  <header class="area-hero" style="--area:${colorVar(a.color)}">
    <div class="row between wrap gap">
      <div class="grow">
        <span class="eyebrow"><i class="swatch sm"></i>${statusLabel(a.status)}</span>
        <h1>${esc(a.name)}</h1>
        <p class="goal">${a.goal ? `<b>Obiettivo:</b> ${esc(a.goal)}` : 'Nessun obiettivo. Aggiungine uno per sapere quando hai finito.'}</p>
      </div>
      <div class="btn-group">
        <a class="btn" href="#/study/cards?scope=area:${id}">Ripassa ${due ? `<b class="pill">${due}</b>` : ''}</a>
        <a class="btn" href="#/study/quiz?scope=area:${id}" ${qn ? '' : 'aria-disabled="true" data-disabled'}>Quiz</a>
        <button class="btn" data-action="area-edit" data-id="${id}">Modifica</button>
      </div>
    </div>
    <div class="progress">${stageBar(topics)}</div>
  </header>

  <section>
    <div class="sec-head"><h2>Argomenti</h2><button class="btn primary" data-action="topic-new" data-area="${id}">+ Argomento</button></div>
    <div class="board">
      ${STAGES.map(([k, l, v], i) => {
        const items = topics.filter((t) => t.stage === k).sort((x, y) => (x.nextReview || '9').localeCompare(y.nextReview || '9') || x.title.localeCompare(y.title));
        return `<div class="col">
          <div class="col-head"><span class="label"><i style="background:var(${v})"></i>${l}</span><span class="n mono">${items.length}</span></div>
          ${items.map((t) => {
            const nc = store.all('card').filter((c) => c.topicId === t.id).length;
            const nn = store.all('note').filter((n) => n.topicId === t.id).length;
            return `<div class="card-wrap"><a class="card-item" href="#/topic/${t.id}">
              <span class="title">${esc(t.title)}</span>
              <span class="foot">${confDots(t.confidence)}<span class="mono small" title="${nn} note, ${nc} flashcard">${nn} note · ${nc} carte</span>${t.stage !== 'queued' && t.nextReview ? `<span class="small ${t.nextReview <= today() ? 'warn' : ''}">${relDue(t.nextReview)}</span>` : ''}</span>
            </a><a class="card-pen" href="#/board/${t.id}" title="Apri il quaderno" aria-label="Apri il quaderno di ${esc(t.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg></a>${i < 3 ? `<button class="adv" data-action="topic-advance" data-id="${t.id}" title="Sposta in ${STAGES[i + 1][1]}" aria-label="Sposta in ${STAGES[i + 1][1]}">→</button>` : ''}</div>`;
          }).join('')}
          ${k === 'queued' ? `<button class="add-card" data-action="topic-new" data-area="${id}">+ Aggiungi argomento</button>` : ''}
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

/* ---------- area modal ---------- */
export function openAreaModal(a) {
  const isNew = !a;
  a = a || { name: '', goal: '', color: COLORS[areas().length % COLORS.length], status: 'active' };
  openModal(`
    <form data-form="area-save" data-id="${a.id || ''}">
      <h2>${isNew ? 'Nuova area' : 'Modifica area'}</h2>
      <div class="field"><label for="a-name">Nome</label><input id="a-name" name="name" type="text" required value="${esc(a.name)}" placeholder="es. Godot 4, Sistemi operativi, Giapponese"></div>
      <div class="field"><label for="a-goal">Obiettivo: cosa saprai fare alla fine?</label><textarea id="a-goal" name="goal" rows="2" placeholder="es. Pubblicare un piccolo platform 3D con salvataggi">${esc(a.goal || '')}</textarea><span class="hint">Un risultato concreto funziona meglio di "imparare X".</span></div>
      <div class="row2">
        <div class="field"><label>Colore</label><div class="swatches">${COLORS.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}" ${c === a.color ? 'checked' : ''}><span style="background:${colorVar(c)}"></span><span class="sr">${c}</span></label>`).join('')}</div></div>
        <div class="field"><label for="a-status">Stato</label><select id="a-status" name="status">${[['active', 'Attiva'], ['paused', 'In pausa'], ['done', 'Completata']].map(([k, l]) => `<option value="${k}" ${k === (a.status || 'active') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <p class="error" data-error hidden></p>
      <div class="modal-foot">
        ${isNew ? '' : confirmButton('Elimina area', 'area-delete', `data-id="${a.id}"`)}
        <div class="row gap push"><button type="button" class="btn" data-action="close-modal">Annulla</button><button class="btn primary" type="submit">${isNew ? 'Crea area' : 'Salva'}</button></div>
      </div>
    </form>`);
}

/* ---------- topic modal ---------- */
export function openTopicModal(t, areaId) {
  const isNew = !t;
  if (!areas().length) { openAreaModal(); toast('Crea prima un\'area'); return; }
  t = t || { title: '', areaId: areaId || areas()[0].id, stage: 'queued', confidence: 1, resource: '', nextReview: '' };
  openModal(`
    <form data-form="topic-save" data-id="${t.id || ''}">
      <h2>${isNew ? 'Nuovo argomento' : 'Modifica argomento'}</h2>
      <div class="field"><label for="t-title">Argomento</label><input id="t-title" name="title" type="text" required value="${esc(t.title)}" placeholder="es. Segnali in Godot"></div>
      <div class="row2">
        <div class="field"><label for="t-area">Area</label><select id="t-area" name="areaId">${areaOptions(t.areaId)}</select></div>
        <div class="field"><label for="t-stage">Fase</label><select id="t-stage" name="stage">${STAGES.map(([k, l]) => `<option value="${k}" ${k === t.stage ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="t-res">Risorsa</label><input id="t-res" name="resource" type="text" value="${esc(t.resource || '')}" placeholder="Link, capitolo del libro, lezione…"></div>
      <div class="row2">
        <div class="field"><label>Sicurezza</label><div class="seg">${[1, 2, 3, 4, 5].map((i) => `<label><input type="radio" name="confidence" value="${i}" ${i === (+t.confidence || 1) ? 'checked' : ''}><span>${i}</span></label>`).join('')}</div><span class="hint">1 = appena sentito · 5 = saprei spiegarlo</span></div>
        <div class="field"><label for="t-next">Prossimo ripasso</label><input id="t-next" name="nextReview" type="date" value="${esc(t.nextReview || '')}"><span class="hint">Si imposta da solo quando inizi a studiarlo.</span></div>
      </div>
      <p class="error" data-error hidden></p>
      <div class="modal-foot">
        ${isNew ? '' : confirmButton('Elimina argomento', 'topic-delete', `data-id="${t.id}"`)}
        <div class="row gap push"><button type="button" class="btn" data-action="close-modal">Annulla</button><button class="btn primary" type="submit">${isNew ? 'Crea argomento' : 'Salva'}</button></div>
      </div>
    </form>`);
}

// Delete a topic and everything that hangs off it.
export async function deleteTopicCascade(id) {
  for (const a of store.all('attachment').filter((x) => x.topicId === id)) await removeAttachment(a.id);
  const ids = [id,
    ...store.all('note').filter((n) => n.topicId === id).map((n) => n.id),
    ...store.all('card').filter((c) => c.topicId === id).map((c) => c.id),
    ...store.all('question').filter((q) => q.topicId === id).map((q) => q.id),
    ...store.all('tile').filter((x) => x.topicId === id).map((x) => x.id),
  ];
  await store.remove(ids);
}

registerActions({
  'area-new': () => openAreaModal(),
  'area-edit': (el) => openAreaModal(store.get(el.dataset.id)),
  'area-save': async (form) => {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) { modalError('Dai un nome all\'area.'); return; }
    const id = form.dataset.id;
    const prev = id ? store.get(id) : null;
    const rec = await store.put('area', {
      ...(prev || {}), id: id || undefined, name, goal: String(fd.get('goal') || '').trim(),
      color: fd.get('color') || 'cobalt', status: fd.get('status') || 'active',
      order: prev?.order ?? areas().reduce((m, x) => Math.max(m, x.order || 0), 0) + 1,
      created: prev?.created || today(),
    });
    closeModal();
    toast(id ? 'Area salvata' : 'Area creata');
    if (!id) navigate(`#/area/${rec.id}`);
  },
  'area-delete': async (el) => {
    const id = el.dataset.id;
    for (const t of topicsOf(id)) await deleteTopicCascade(t.id);
    await store.remove([id, ...store.all('session').filter((s) => s.areaId === id).map((s) => s.id)]);
    closeModal();
    navigate('#/areas');
    toast('Area eliminata');
  },
  'topic-new': (el) => openTopicModal(null, el.dataset.area),
  'topic-edit': (el) => openTopicModal(store.get(el.dataset.id)),
  'topic-save': async (form) => {
    const fd = new FormData(form);
    const title = String(fd.get('title') || '').trim();
    if (!title) { modalError('Dai un nome all\'argomento.'); return; }
    const id = form.dataset.id;
    const prev = id ? store.get(id) : null;
    const stage = fd.get('stage');
    let nextReview = String(fd.get('nextReview') || '');
    if (stage !== 'queued' && !nextReview) nextReview = addDays(today(), 1);
    const rec = await store.put('topic', {
      ...(prev || {}), id: id || undefined, title, areaId: fd.get('areaId'), stage,
      resource: String(fd.get('resource') || '').trim(), confidence: +fd.get('confidence') || 1,
      nextReview, reviewStep: prev?.reviewStep || 0, created: prev?.created || today(),
    });
    // Keep denormalised areaId on cards/questions in sync if the topic moved.
    if (prev && prev.areaId !== rec.areaId) {
      const kids = [...store.all('card'), ...store.all('question')].filter((x) => x.topicId === rec.id);
      for (const k of kids) await store.put(k.kind, { ...k, areaId: rec.areaId });
    }
    closeModal();
    toast(id ? 'Argomento salvato' : 'Argomento creato');
    if (!id) navigate(`#/topic/${rec.id}`);
  },
  'topic-delete': async (el) => {
    const t = store.get(el.dataset.id);
    await deleteTopicCascade(el.dataset.id);
    closeModal();
    navigate(t ? `#/area/${t.areaId}` : '#/areas');
    toast('Argomento eliminato');
  },
  'topic-advance': async (el) => {
    const t = store.get(el.dataset.id);
    const i = STAGES.findIndex((s) => s[0] === t.stage);
    if (i < 0 || i >= 3) return;
    const patch = { stage: STAGES[i + 1][0] };
    if (t.stage === 'queued' && !t.nextReview) { patch.nextReview = addDays(today(), 1); patch.reviewStep = 0; }
    await store.put('topic', { ...t, ...patch });
    toast(`Spostato in "${STAGES[i + 1][1]}"`);
  },
});
