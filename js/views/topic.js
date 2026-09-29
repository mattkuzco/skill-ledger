import * as store from '../store.js';
import { esc, today, relDue, plural, toast, debounce, stageLabel, stageVar, fmtDate } from '../util.js';
import { newCardSrs, isCardDue, TOPIC_LADDER, describe } from '../srs.js';
import { renderMarkdown, excerpt } from '../md.js';
import {
  registerActions, openModal, closeModal, modalError, areaChip, confDots, notesOf, cardsOf, questionsOf,
  emptyState, confirmButton, isModalOpen,
} from '../ui.js';
import { openTopicModal } from './areas.js';
import { navigate } from '../router.js';
import * as ai from '../ai.js';
import * as att from '../attachments.js';
import * as inkMod from '../ink.js';
import * as board from '../board.js';
import { openPdf } from '../pdfdoc.js';

const TABS = [['notes', 'Note'], ['files', 'Allegati'], ['cards', 'Flashcard'], ['quiz', 'Quiz']];

/* ---------- topic page ---------- */
export function renderTopic(id, params) {
  const t = store.get(id);
  if (!t) return emptyState('Argomento non trovato', 'Forse è stato eliminato.', '<a class="btn" href="#/areas">Torna alle aree</a>');
  const a = store.get(t.areaId);
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'notes';
  const notes = notesOf(id);
  const cards = cardsOf(id);
  const qs = questionsOf(id);
  const due = cards.filter(isCardDue).length;
  const resIsUrl = /^https?:\/\//.test(t.resource || '');

  const counts = { notes: notes.length, files: att.topicAttachments(id).length, cards: cards.length, quiz: qs.length };
  return `
  <nav class="crumbs"><a href="#/areas">Aree</a><span>/</span>${a ? `<a href="#/area/${a.id}">${esc(a.name)}</a><span>/</span>` : ''}<span>${esc(t.title)}</span></nav>
  <header class="topic-head">
    <div class="row between wrap gap">
      <div class="grow">
        <span class="eyebrow stage-eyebrow"><i style="background:var(${stageVar(t.stage)})"></i>${stageLabel(t.stage)}</span>
        <h1>${esc(t.title)}</h1>
        <div class="meta big">
          ${areaChip(t.areaId, { link: true })}
          ${confDots(t.confidence)}
          ${t.stage !== 'queued' && t.nextReview ? `<span class="${t.nextReview <= today() ? 'warn' : ''}">Ripasso ${relDue(t.nextReview)}</span>` : ''}
          ${t.resource ? (resIsUrl ? `<a href="${esc(t.resource)}" target="_blank" rel="noopener">Apri risorsa ↗</a>` : `<span>${esc(t.resource)}</span>`) : ''}
        </div>
      </div>
      <div class="btn-group">
        <a class="btn" href="#/study/cards?scope=topic:${id}">Ripassa ${due ? `<b class="pill">${due}</b>` : ''}</a>
        <a class="btn" href="#/study/quiz?scope=topic:${id}">Quiz</a>
        <button class="btn" data-action="topic-edit" data-id="${id}">Modifica</button>
      </div>
    </div>
  </header>

  ${boardCard(t)}

  <div class="tabs" role="tablist">
    ${TABS.map(([k, l]) => `<a role="tab" aria-selected="${k === tab}" class="tab" href="#/topic/${id}?tab=${k}">${l} <span class="mono n">${counts[k]}</span></a>`).join('')}
  </div>

  ${tab === 'notes' ? notesTab(t, notes) : tab === 'files' ? filesTab(t) : tab === 'cards' ? cardsTab(t, cards) : quizTab(t, qs)}`;
}

function boardCard(t) {
  const thumb = board.thumbnail(t.id, 720, 260);
  const n = board.strokeTotal(t.id);
  const imgs = board.boardImagesOf(t.id).length;
  const last = board.lastEdit(t.id);
  const stats = n || imgs
    ? [n ? plural(n, 'tratto', 'tratti') : '', imgs ? plural(imgs, 'foto', 'foto') : '', last ? 'modificato ' + fmtDate(new Date(last).toISOString().slice(0, 10)) : ''].filter(Boolean).join(' · ')
    : 'Un foglio senza bordi per scrivere a mano con la penna, come in OneNote. Scorri con un dito, ingrandisci con due.';
  return `<a class="board-card" href="#/board/${t.id}">
    <span class="board-thumb${board.isDark(t.id) ? ' dark' : ''}">${thumb ? `<img src="${thumb}" alt="Anteprima del quaderno">` : '<span class="board-empty"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>Foglio vuoto</span>'}</span>
    <span class="board-card-body">
      <span class="label">Quaderno</span>
      <b class="board-card-title">${n || imgs ? 'I tuoi appunti a mano' : 'Inizia a scrivere a mano'}</b>
      <span class="muted small">${stats}</span>
      <span class="btn primary">Apri il quaderno</span>
    </span>
  </a>`;
}

function newNoteButtons(t) {
  return `<button class="btn primary" data-action="note-new" data-topic="${t.id}">+ Nota di testo</button>`;
}

function filesTab(t) {
  const body = att.attachmentsSections(t.id);
  return `<section class="files-tab" data-drop-topic="${t.id}">
    <div class="sec-head"><h2>Allegati</h2><div class="btn-group">${att.addButtons(t.id)}</div></div>
    ${body || emptyState('Nessun allegato', 'Qui raccogli tutto quello che non scrivi tu: foto del quaderno o della lavagna, registrazioni della lezione, video e dispense PDF. Puoi anche trascinare i file qui.', att.addButtons(t.id))}
  </section>`;
}

function noteCard(n) {
  const atts = att.attachmentsOf(n.id);
  const firstImg = atts.find((a) => a.mime.startsWith('image/'));
  const isInk = n.type === 'ink';
  const pagesN = isInk ? (n.ink?.pages || []).filter((p) => p.s.length).length : 0;
  const thumb = isInk ? `<img class="note-thumb ink" src="${inkMod.thumbnail(n)}" alt="">`
    : firstImg && !(n.body || '').trim() ? `<img class="note-thumb" data-att-src="${firstImg.id}" alt="">` : '';
  const badges = [
    isInk ? `<span class="badge">A mano${pagesN > 1 ? ` · ${pagesN} pagine` : ''}</span>` : '',
    atts.length ? `<span class="badge">${plural(atts.length, 'allegato', 'allegati')}</span>` : '',
  ].join('');
  return `<a class="note-card ${thumb ? 'has-thumb' : ''}" href="#/note/${n.id}">
    ${thumb}
    <h3>${esc(n.title || (isInk ? 'Appunti a mano' : 'Nota senza titolo'))}</h3>
    ${thumb ? '' : `<p>${esc(excerpt(n.body, 180)) || '<span class="muted">Vuota</span>'}</p>`}
    <span class="note-foot"><span class="small muted mono">${fmtDate(new Date(n.updated_at).toISOString().slice(0, 10))}</span>${badges}</span>
  </a>`;
}

function notesTab(t, notes) {
  return `<section>
    <div class="sec-head"><h2>Note</h2><div class="btn-group">${newNoteButtons(t)}</div></div>
    ${notes.length ? `<div class="note-grid">${notes.map(noteCard).join('')}</div>`
      : emptyState('Nessuna nota', 'Scrivi quello che impari con parole tue: è il modo più veloce per capire cosa non ti è chiaro. Per scrivere a mano usa il Quaderno qui sopra; foto, audio e video vanno negli Allegati.', newNoteButtons(t))}
  </section>`;
}

function cardsTab(t, cards) {
  const sorted = cards.slice().sort((a, b) => (a.srs?.due || '').localeCompare(b.srs?.due || ''));
  return `<section>
    <div class="sec-head"><h2>Flashcard</h2><div class="btn-group"><button class="btn" data-action="ai-open" data-topic="${t.id}" data-mode="cards">✦ Genera con AI</button><button class="btn primary" data-action="card-new" data-topic="${t.id}">+ Flashcard</button></div></div>
    ${sorted.length ? `<div class="list">${sorted.map((c) => `
      <button class="list-row fc-row" data-action="card-edit" data-id="${c.id}">
        <span class="fc-front">${esc(c.front)}</span>
        <span class="fc-back muted">${esc(c.back)}</span>
        <span class="small mono ${isCardDue(c) ? 'warn' : 'muted'}">${isCardDue(c) ? 'da ripassare' : relDue(c.srs.due)}</span>
      </button>`).join('')}</div>`
      : emptyState('Nessuna flashcard', 'Una flashcard è una domanda su un lato e la risposta sull\'altro. Scrivila tu o generala dalle tue note.', `<button class="btn primary" data-action="card-new" data-topic="${t.id}">+ Flashcard</button><button class="btn" data-action="ai-open" data-topic="${t.id}" data-mode="cards">✦ Genera con AI</button>`)}
  </section>`;
}

function quizTab(t, qs) {
  const attempts = store.all('attempt').filter((a) => a.scope === 'topic:' + t.id).sort((a, b) => b.updated_at - a.updated_at).slice(0, 3);
  return `<section>
    <div class="sec-head"><h2>Domande del quiz</h2><div class="btn-group"><button class="btn" data-action="ai-open" data-topic="${t.id}" data-mode="quiz">✦ Genera con AI</button><button class="btn primary" data-action="question-new" data-topic="${t.id}">+ Domanda</button></div></div>
    ${attempts.length ? `<p class="muted small">Ultimi risultati: ${attempts.map((a) => `<b class="mono">${a.score}/${a.total}</b> (${fmtDate(a.date)})`).join(' · ')}</p>` : ''}
    ${qs.length ? `<div class="list">${qs.map((q, i) => `
      <button class="list-row q-row" data-action="question-edit" data-id="${q.id}">
        <span class="mono muted">${i + 1}</span>
        <span class="grow">${esc(q.question)}<span class="small muted block">Risposta: ${esc(q.options[q.answer] || '')}</span></span>
      </button>`).join('')}</div>
      <div class="row gap top-gap"><a class="btn primary" href="#/study/quiz?scope=topic:${t.id}">Avvia quiz (${plural(qs.length, 'domanda', 'domande')})</a></div>`
      : emptyState('Nessuna domanda', 'Le domande a scelta multipla ti dicono subito se hai capito davvero. Scrivile tu o generale dalle note.', `<button class="btn primary" data-action="question-new" data-topic="${t.id}">+ Domanda</button><button class="btn" data-action="ai-open" data-topic="${t.id}" data-mode="quiz">✦ Genera con AI</button>`)}
  </section>`;
}

/* ---------- note editor (text or handwritten) ---------- */
let noteMode = 'edit';
let editor = null;        // active ink editor
let pendingInk = null;    // unsaved ink data

export function renderNote(id) {
  const n = store.get(id);
  if (!n) return emptyState('Nota non trovata', 'Forse è stata eliminata.', '<a class="btn" href="#/areas">Torna alle aree</a>');
  return n.type === 'ink' ? renderInkNote(n) : renderTextNote(n);
}

function noteBar(n, extra = '') {
  const t = store.get(n.topicId);
  const hasMedia = n.type === 'ink' || att.attachmentsOf(n.id).some((a) => a.mime.startsWith('image/'));
  return `<div class="note-bar">
      <a class="btn ghost" href="#/topic/${n.topicId}">← ${t ? esc(t.title) : 'Argomento'}</a>
      ${extra}
      <span class="small muted" id="note-saved">Salvata</span>
      <div class="btn-group push">
        ${hasMedia ? `<button class="btn" data-action="ai-transcribe" data-note="${n.id}" id="btn-transcribe">✦ Trascrivi</button>` : ''}
        <button class="btn" data-action="ai-open" data-topic="${n.topicId}" data-note="${n.id}" data-mode="both">✦ Crea flashcard e quiz</button>
        ${confirmButton('Elimina', 'note-delete', `data-id="${n.id}"`)}
      </div>
    </div>`;
}

function attachSection(n) {
  const g = att.gallery(n.id);
  if (!g) return '';
  return `<section class="att-section">
    <div class="sec-head"><h3>File di questa nota</h3><a class="link" href="#/topic/${n.topicId}?tab=files">Tutti gli allegati →</a></div>
    ${g}
  </section>`;
}

function renderTextNote(n) {
  const photosFirst = !(n.body || '').trim() && att.attachmentsOf(n.id).length > 0;
  return `
  <div class="note-editor mode-${noteMode} ${photosFirst ? 'photos-first' : ''}">
    ${noteBar(n, `<div class="seg compact" role="tablist">
        <button role="tab" aria-selected="${noteMode === 'edit'}" data-action="note-mode" data-mode="edit">Scrivi</button>
        <button role="tab" aria-selected="${noteMode === 'preview'}" data-action="note-mode" data-mode="preview">Anteprima</button>
      </div>`)}
    <input id="note-title" class="note-title" type="text" value="${esc(n.title || '')}" placeholder="Titolo della nota" data-note="${n.id}" autocomplete="off">
    <div class="note-panes">
      <textarea id="note-body" class="note-body" data-note="${n.id}" placeholder="Scrivi qui. Markdown: # titolo, **grassetto**, *corsivo*, - elenco, \`codice\`, \`\`\` blocco \`\`\`">${esc(n.body || '')}</textarea>
      <article class="note-preview md" id="note-preview">${renderMarkdown(n.body) || '<p class="muted">L\'anteprima appare qui.</p>'}</article>
    </div>
    ${attachSection(n)}
  </div>`;
}

function renderInkNote(n) {
  const hasText = !!(n.body || '').trim();
  return `
  <div class="note-editor ink-editor">
    ${noteBar(n)}
    <input id="note-title" class="note-title" type="text" value="${esc(n.title || '')}" placeholder="Titolo degli appunti" data-note="${n.id}" autocomplete="off">
    <div class="ink-bar" data-ink-bar></div>
    <div class="ink-pages" data-ink-pages></div>
    <button class="add-card ink-addpage" data-ink-addpage type="button">+ Aggiungi pagina</button>
    <details class="transcript" id="transcript" ${hasText ? 'open' : ''}>
      <summary>Trascrizione in testo <span class="hint">${hasText ? 'modificabile' : 'premi "Trascrivi" per crearla con l\'AI'}</span></summary>
      <textarea id="note-body" class="note-body short" data-note="${n.id}" placeholder="Il testo degli appunti, per cercarli e per creare flashcard.">${esc(n.body || '')}</textarea>
    </details>
    ${attachSection(n)}
  </div>`;
}

async function saveNoteNow(id) {
  const n = store.get(id);
  if (!n) return;
  const title = document.getElementById('note-title')?.value ?? n.title;
  const body = document.getElementById('note-body')?.value ?? n.body;
  const ink = pendingInk && pendingInk.id === id ? pendingInk.ink : null;
  if (title === n.title && body === n.body && !ink) return;
  await store.put('note', { ...n, title, body, ...(ink ? { ink: structuredClone(ink) } : {}) });
  if (ink) pendingInk = null;
  const s = document.getElementById('note-saved');
  if (s) s.textContent = 'Salvata';
}
const saveNote = debounce(saveNoteNow, 700);

export function mountNote(id) {
  const n = store.get(id);
  if (!n) return;
  const title = document.getElementById('note-title');
  const body = document.getElementById('note-body');
  const preview = document.getElementById('note-preview');
  const dirty = () => { const s = document.getElementById('note-saved'); if (s) s.textContent = 'Salvataggio…'; saveNote(id); };
  const onInput = () => {
    if (preview) preview.innerHTML = renderMarkdown(body.value) || '<p class="muted">L\'anteprima appare qui.</p>';
    dirty();
  };
  title?.addEventListener('input', onInput);
  body?.addEventListener('input', onInput);
  body?.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { // indent instead of leaving the field
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = body;
      body.value = value.slice(0, s) + '  ' + value.slice(en);
      body.selectionStart = body.selectionEnd = s + 2;
      onInput();
    }
  });
  // Paste or drop files: they go to the topic's Allegati.
  const root = document.querySelector('.note-editor');
  const addToTopic = async (files) => {
    const k = await att.addFiles({ topicId: n.topicId }, files);
    if (k) toast(`${plural(k, 'file aggiunto', 'file aggiunti')} agli Allegati`);
  };
  root.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    await addToTopic(files);
  });
  root.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  root.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    await addToTopic([...e.dataTransfer.files]);
  });

  if (n.type === 'ink') {
    editor?.destroy();
    editor = inkMod.mountEditor(root, n, {
      onChange: (ink) => { pendingInk = { id, ink }; dirty(); },
    });
  } else if (!n.title && !n.body) title.focus();
  att.hydrate(root);
}

function refreshAttachments(id) {
  const sec = document.querySelector('.att-section');
  const n = store.get(id);
  if (!sec || !n) return;
  const html = attachSection(n);
  if (!html) { sec.remove(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  sec.replaceWith(tmp.firstElementChild);
  att.hydrate(document.querySelector('.att-section'));
}

// Called by the router when leaving a note: flush pending save, drop empty notes.
export async function leaveNote(id) {
  const n = store.get(id);
  editor?.destroy(); editor = null;
  if (!n) return;
  await saveNoteNow(id);
  const cur = store.get(id);
  const empty = !(cur.title || '').trim() && !(cur.body || '').trim()
    && !inkMod.strokeCount(cur.ink) && !att.attachmentsOf(id).length;
  if (empty) await store.remove(id);
}

/* ---------- AI helpers for notes ---------- */
// Build the media blocks for a set of notes. Handwritten pages are skipped when the
// note already has a transcription (the text is cheaper and just as good).
async function noteMedia(notes, { forTranscription = false } = {}) {
  const media = [];
  for (const n of notes) {
    const label = `Da "${n.title || 'nota'}":`;
    if (n.type === 'ink' && (forTranscription || !(n.body || '').trim())) {
      const ink = pendingInk?.id === n.id ? pendingInk.ink : n.ink;
      for (let i = 0; i < (ink?.pages || []).length; i++) {
        if (!ink.pages[i].s.length) continue;
        media.push(await ai.imageToMedia(await inkMod.pageBlob(ink, i), `${label} pagina ${i + 1} scritta a mano`));
      }
    }
    for (const a of att.attachmentsOf(n.id)) {
      if (forTranscription && !a.mime.startsWith('image/')) continue;
      const blob = await att.getBlob(a.id);
      if (!blob) continue;
      media.push(a.mime === 'application/pdf' ? await ai.pdfToMedia(blob, `${label} ${a.name}`) : await ai.imageToMedia(blob, `${label} foto ${a.name}`));
    }
  }
  return media;
}

/* ---------- card & question modals ---------- */
function openCardModal(c, topicId) {
  const isNew = !c;
  c = c || { front: '', back: '', topicId };
  openModal(`
    <form data-form="card-save" data-id="${c.id || ''}" data-topic="${c.topicId}">
      <h2>${isNew ? 'Nuova flashcard' : 'Modifica flashcard'}</h2>
      <div class="field"><label for="c-front">Fronte (domanda)</label><textarea id="c-front" name="front" rows="3" required>${esc(c.front)}</textarea></div>
      <div class="field"><label for="c-back">Retro (risposta)</label><textarea id="c-back" name="back" rows="4" required>${esc(c.back)}</textarea></div>
      ${(() => { const m = !isNew && describe(c.srs); return m ? `<div class="fsrs-info"><span>Prossimo ripasso <b>${relDue(m.due)}</b></span><span>Ricordo oggi <b>${Math.round(m.recall * 100)}%</b></span><span>Stabilità <b>${m.stability < 1 ? '<1' : Math.round(m.stability)} g</b></span><span>Difficoltà <b>${m.difficulty.toFixed(1).replace('.', ',')}/10</b></span><span>Ripassi <b>${m.reps}</b> · errori <b>${m.lapses}</b></span></div>` : (!isNew ? '<p class="hint">Carta nuova: non l\'hai ancora ripassata.</p>' : ''); })()}
      <p class="error" data-error hidden></p>
      <div class="modal-foot">
        ${isNew ? '<label class="check"><input type="checkbox" name="another" checked> Aggiungine un\'altra</label>' : confirmButton('Elimina', 'card-delete', `data-id="${c.id}"`)}
        <div class="row gap push"><button type="button" class="btn" data-action="close-modal">Chiudi</button><button class="btn primary" type="submit">${isNew ? 'Aggiungi' : 'Salva'}</button></div>
      </div>
    </form>`);
}

function openQuestionModal(q, topicId) {
  const isNew = !q;
  q = q || { question: '', options: ['', '', '', ''], answer: 0, explanation: '', topicId };
  const opts = [...q.options, '', '', '', ''].slice(0, Math.max(4, q.options.length));
  openModal(`
    <form data-form="question-save" data-id="${q.id || ''}" data-topic="${q.topicId}">
      <h2>${isNew ? 'Nuova domanda' : 'Modifica domanda'}</h2>
      <div class="field"><label for="q-q">Domanda</label><textarea id="q-q" name="question" rows="2" required>${esc(q.question)}</textarea></div>
      <fieldset class="field"><legend>Risposte <span class="hint">seleziona quella corretta</span></legend>
        ${opts.map((o, i) => `<div class="opt-row"><input type="radio" name="answer" value="${i}" ${i === q.answer ? 'checked' : ''} aria-label="Risposta ${i + 1} corretta"><input type="text" name="opt${i}" value="${esc(o)}" placeholder="Risposta ${i + 1}${i >= 2 ? ' (facoltativa)' : ''}"></div>`).join('')}
      </fieldset>
      <div class="field"><label for="q-exp">Spiegazione (facoltativa)</label><textarea id="q-exp" name="explanation" rows="2">${esc(q.explanation || '')}</textarea></div>
      <p class="error" data-error hidden></p>
      <div class="modal-foot">
        ${isNew ? '<label class="check"><input type="checkbox" name="another" checked> Aggiungine un\'altra</label>' : confirmButton('Elimina', 'question-delete', `data-id="${q.id}"`)}
        <div class="row gap push"><button type="button" class="btn" data-action="close-modal">Chiudi</button><button class="btn primary" type="submit">${isNew ? 'Aggiungi' : 'Salva'}</button></div>
      </div>
    </form>`);
}

/* ---------- AI modal ---------- */
let aiAbort = null;
let aiResult = null;

function needKeyModal() {
  openModal(`<h2>Serve una chiave API</h2>
    <p>Per usare l'AI (trascrizione, flashcard e quiz) serve una chiave API Anthropic. Si crea su console.anthropic.com e resta salvata solo su questo dispositivo.</p>
    <div class="modal-foot"><div class="row gap push"><button class="btn" data-action="close-modal">Chiudi</button><a class="btn primary" href="#/settings" data-action="close-modal">Vai alle Impostazioni</a></div></div>`);
}

function noteSummary(n) {
  const parts = [];
  const words = (n.body || '').split(/\s+/).filter(Boolean).length;
  if (words) parts.push(plural(words, 'parola', 'parole'));
  if (n.type === 'ink') { const pg = (n.ink?.pages || []).filter((p) => p.s.length).length; if (pg) parts.push(plural(pg, 'pagina a mano', 'pagine a mano')); }
  const na = att.attachmentsOf(n.id).length;
  if (na) parts.push(plural(na, 'allegato', 'allegati'));
  return parts.join(' · ') || 'vuota';
}

function openAiModal(topicId, mode = 'both', noteId = '', { fromBoard = false } = {}) {
  const t = store.get(topicId);
  const notes = notesOf(topicId);
  if (!ai.hasKey()) { needKeyModal(); return; }
  const nc = mode === 'quiz' ? 0 : 8;
  const nq = mode === 'cards' ? 0 : 5;
  openModal(`
    <form data-form="ai-generate" data-topic="${topicId}">
      <h2>Genera con AI</h2>
      <p class="muted">Da <b>${esc(t.title)}</b>. Potrai scegliere cosa tenere prima di salvare.</p>
      ${board.hasContent(topicId) ? `<fieldset class="field"><legend>Quaderno</legend><label class="check"><input type="checkbox" name="board" value="1" ${fromBoard || !notes.some((n) => n.boardTranscript) ? 'checked' : ''}> Appunti a mano del quaderno <span class="muted small">${plural(board.strokeTotal(topicId), 'tratto', 'tratti')}${notes.some((n) => n.boardTranscript) ? ' · c\'è già la trascrizione tra le note' : ''}</span></label></fieldset>` : ''}
      ${(() => {
        const files = att.topicAttachments(topicId).filter((a) => a.mime.startsWith('image/') || a.mime === 'application/pdf');
        if (!files.length) return '';
        const preselect = !notes.length && !board.hasContent(topicId);
        return `<fieldset class="field"><legend>Allegati (foto e PDF)</legend><div class="check-list">${files.map((a) => `<label class="check"><input type="checkbox" name="att" value="${a.id}" ${preselect ? 'checked' : ''}> ${esc(a.name)} <span class="muted small">${a.mime === 'application/pdf' ? 'PDF' : 'foto'}</span></label>`).join('')}</div><span class="hint">Audio e video non si possono ancora usare con l'AI.</span></fieldset>`;
      })()}
      ${notes.length ? `<fieldset class="field"><legend>Note da usare</legend><div class="check-list">${notes.map((n) => `<label class="check"><input type="checkbox" name="note" value="${n.id}" ${fromBoard ? (n.boardTranscript ? 'checked' : '') : !noteId || noteId === n.id ? 'checked' : ''}> ${esc(n.title || (n.type === 'ink' ? 'Appunti a mano' : 'Nota senza titolo'))} <span class="muted small">${noteSummary(n)}</span></label>`).join('')}</div></fieldset>` : ''}
      <div class="field"><label for="ai-extra">${notes.length ? 'Testo aggiuntivo (facoltativo)' : 'Incolla il materiale da studiare'}</label><textarea id="ai-extra" name="extra" rows="${notes.length ? 3 : 7}" placeholder="Appunti, un paragrafo del libro, una trascrizione…"></textarea></div>
      <div class="row2">
        <div class="field"><label for="ai-nc">Flashcard</label><input id="ai-nc" name="nc" type="number" min="0" max="30" value="${nc}"></div>
        <div class="field"><label for="ai-nq">Domande quiz</label><input id="ai-nq" name="nq" type="number" min="0" max="20" value="${nq}"></div>
      </div>
      <p class="hint">Testo, pagine scritte a mano e allegati vengono inviati all'API Anthropic con la tua chiave. Ogni richiesta ha un piccolo costo, più alto con molte immagini.</p>
      <p class="error" data-error hidden></p>
      <div class="modal-foot"><div class="row gap push"><button type="button" class="btn" data-action="ai-cancel">Annulla</button><button class="btn primary" type="submit" id="ai-go">Genera</button></div></div>
    </form>`, { wide: true, onClose: () => { aiAbort?.abort(); aiAbort = null; } });
}

function showAiResult(topicId) {
  const { flashcards, questions } = aiResult;
  const panel = document.querySelector('#modal-root .panel');
  if (!panel) return;
  panel.innerHTML = `
    <form data-form="ai-save" data-topic="${topicId}">
      <h2>Scegli cosa tenere</h2>
      <p class="muted">Deseleziona quello che non ti serve. Potrai sempre modificare tutto dopo.</p>
      ${flashcards.length ? `<fieldset class="field"><legend>${plural(flashcards.length, 'flashcard', 'flashcard')}</legend><div class="pick-list">${flashcards.map((c, i) => `
        <label class="pick"><input type="checkbox" name="card" value="${i}" checked><span><b>${esc(c.front)}</b><span class="muted block">${esc(c.back)}</span></span></label>`).join('')}</div></fieldset>` : ''}
      ${questions.length ? `<fieldset class="field"><legend>${plural(questions.length, 'domanda', 'domande')}</legend><div class="pick-list">${questions.map((q, i) => `
        <label class="pick"><input type="checkbox" name="question" value="${i}" checked><span><b>${esc(q.question)}</b><span class="block small">${q.options.map((o, j) => `<span class="${j === q.answer ? 'ok-text' : 'muted'}">${j === q.answer ? '✓ ' : ''}${esc(o)}</span>`).join(' · ')}</span></span></label>`).join('')}</div></fieldset>` : ''}
      ${!flashcards.length && !questions.length ? '<p>L\'AI non ha prodotto risultati utilizzabili. Prova con più testo.</p>' : ''}
      <div class="modal-foot"><div class="row gap push"><button type="button" class="btn" data-action="close-modal">Scarta</button><button class="btn primary" type="submit">Salva selezionati</button></div></div>
    </form>`;
}

/* ---------- Quaderno (infinite handwriting board) ---------- */
let boardEditor = null;

export function renderBoard(topicId) {
  const t = store.get(topicId);
  if (!t) return emptyState('Argomento non trovato', 'Forse è stato eliminato.', '<a class="btn" href="#/areas">Torna alle aree</a>');
  const empty = !board.hasContent(topicId);
  return `<div class="board-view">
    <div class="board-top">
      <a class="btn ghost" href="#/topic/${t.id}">← ${esc(t.title)}</a>
      <span class="small muted" data-board-saved>Salvato</span>
      <div class="btn-group push">
        <button class="btn sm" data-action="board-transcribe" data-topic="${t.id}">✦ Trascrivi</button>
        <button class="btn sm" data-action="ai-open" data-topic="${t.id}" data-mode="both" data-board="1">✦ Flashcard e quiz</button>
      </div>
    </div>
    <div class="ink-bar board-bar" data-board-bar></div>
    <div class="board-stage" data-board-stage>
      <canvas class="board-base" data-board-base></canvas>
      <canvas class="board-over" data-board-over></canvas>
      ${empty ? '<div class="board-hint" data-board-hint><b>Scrivi ovunque con la penna.</b><span>Sposta il foglio con un dito, ingrandisci con due dita. Con il mouse: rotella per scorrere, Ctrl + rotella per lo zoom.</span></div>' : ''}
    </div>
  </div>`;
}

export function mountBoardView(topicId) {
  const t = store.get(topicId);
  const root = document.querySelector('.board-view');
  if (!t || !root) return;
  boardEditor?.destroy();
  boardEditor = board.mountBoard(root, t);
  const hint = root.querySelector('[data-board-hint]');
  if (hint) root.querySelector('[data-board-stage]').addEventListener('pointerdown', () => hint.remove(), { once: true });
}

/* ---------- writing on a PDF (same pen engine as the Quaderno) ---------- */
export function renderPdf(id) {
  const a = store.get(id);
  const topicId = a?.topicId || (a?.noteId && store.get(a.noteId)?.topicId);
  if (!a || att.kindOf(a.mime) !== 'pdf' || !store.get(topicId)) return emptyState('PDF non trovato', 'Forse è stato eliminato.', '<a class="btn" href="#/areas">Torna alle aree</a>');
  const t = store.get(topicId);
  return `<div class="board-view pdf-view">
    <div class="board-top">
      <a class="btn ghost" href="#/topic/${t.id}?tab=files">← ${esc(t.title)}</a>
      <b class="pdf-title" title="${esc(a.name)}">${esc(a.name)}</b>
      <span class="small muted" data-board-saved>Salvato</span>
      <div class="btn-group push">
        <span class="pdf-page mono small" data-pdf-page></span>
        <button class="btn sm" data-action="att-open" data-id="${a.id}" title="Rinomina, apri l'originale o elimina">⋯</button>
      </div>
    </div>
    <div class="ink-bar board-bar" data-board-bar></div>
    <div class="board-stage" data-board-stage>
      <canvas class="board-base" data-board-base></canvas>
      <canvas class="board-over" data-board-over></canvas>
      <div class="board-hint" data-pdf-status><b>Apro il PDF…</b></div>
    </div>
  </div>`;
}

export async function mountPdfView(id) {
  const root = document.querySelector('.pdf-view');
  const a = store.get(id);
  if (!root || !a) return;
  const t = store.get(a.topicId || store.get(a.noteId)?.topicId);
  const status = root.querySelector('[data-pdf-status]');
  const stillHere = () => document.body.contains(root);
  boardEditor?.destroy(); boardEditor = null;
  try {
    let blob = await att.getBlob(id);
    if (!blob) throw new Error(a.remote ? 'Il PDF non è ancora scaricato su questo dispositivo: controlla la connessione e la sincronizzazione.' : 'Il PDF è solo sull\'altro dispositivo: aprilo lì e sincronizza.');
    const { doc, pages } = await openPdf(id, blob);
    blob = null;
    if (!stillHere()) { doc.destroy(); return; }
    status.remove();
    boardEditor = board.mountBoard(root, t, { pdf: { id, doc, pages } });
  } catch (e) {
    console.error(e);
    if (!stillHere()) return;
    status.innerHTML = `<b>Non riesco ad aprire questo PDF.</b><span>${esc(e.message || '')}</span>`;
    status.classList.add('error-hint');
  }
}

export async function leaveBoard() {
  if (!boardEditor) return;
  await boardEditor.saveNow();
  boardEditor.destroy();
  boardEditor = null;
}

async function transcribeBoard(el) {
  if (!ai.hasKey()) { needKeyModal(); return; }
  const topicId = el.dataset.topic;
  const label = el.textContent;
  el.disabled = true; el.textContent = 'Preparo…';
  try {
    await boardEditor?.saveNow();
    const blobs = await board.regionBlobs(topicId);
    if (!blobs.length) { toast('Il quaderno è vuoto: scrivi qualcosa prima di trascrivere.'); return; }
    const media = [];
    for (let i = 0; i < blobs.length; i++) media.push(await ai.imageToMedia(blobs[i], `Quaderno a mano, parte ${i + 1}`));
    el.textContent = `Trascrivo ${plural(media.length, 'parte', 'parti')}…`;
    const text = await ai.transcribe({ media });
    const existing = store.all('note').find((n) => n.topicId === topicId && n.boardTranscript);
    const note = await store.put('note', { ...(existing || {}), id: existing?.id, topicId, title: 'Trascrizione del quaderno', body: text, boardTranscript: true, created: existing?.created || today() });
    openModal(`<h2>Trascrizione pronta</h2>
      <p class="muted">L'ho salvata tra le note dell'argomento come "Trascrizione del quaderno". Rileggila e correggi quello che l'AI ha letto male.</p>
      <article class="md transcript-preview">${renderMarkdown(text)}</article>
      <div class="modal-foot"><div class="row gap push"><button class="btn" data-action="close-modal">Chiudi</button><a class="btn primary" href="#/note/${note.id}">Apri e correggi</a></div></div>`, { wide: true });
  } catch (e) {
    toast(e.message, 'bad');
  } finally { el.disabled = false; el.textContent = label; }
}

async function transcribePhotos(el, photos) {
  if (!ai.hasKey()) { needKeyModal(); return; }
  if (!photos.length) return;
  const label = el.textContent;
  el.disabled = true; el.textContent = 'Preparo…';
  try {
    const media = [];
    for (const a of photos.slice(0, 20)) { const b = await att.getBlob(a.id); if (b) media.push(await ai.imageToMedia(b, `Foto "${a.name}"`)); }
    if (!media.length) { toast('Le foto non sono disponibili su questo dispositivo.', 'bad'); return; }
    el.textContent = `Trascrivo ${plural(media.length, 'foto', 'foto')}…`;
    const text = await ai.transcribe({ media });
    const topicId = photos[0].topicId;
    const title = photos.length === 1 ? `Trascrizione: ${photos[0].name}` : `Trascrizione delle foto (${fmtDate(today())})`;
    const note = await store.put('note', { topicId, title, body: text, created: today() });
    closeModal();
    openModal(`<h2>Trascrizione pronta</h2>
      <p class="muted">L'ho salvata tra le Note come "${esc(title)}". Rileggila e correggi quello che l'AI ha letto male.</p>
      <article class="md transcript-preview">${renderMarkdown(text)}</article>
      <div class="modal-foot"><div class="row gap push"><button class="btn" data-action="close-modal">Chiudi</button><a class="btn primary" href="#/note/${note.id}">Apri e correggi</a></div></div>`, { wide: true });
  } catch (e) {
    toast(e.message, 'bad');
  } finally { el.disabled = false; el.textContent = label; }
}

registerActions({
  'board-transcribe': (el) => transcribeBoard(el),
  'note-new': async (el) => {
    const isInk = el.dataset.type === 'ink';
    const n = await store.put('note', { topicId: el.dataset.topic, title: '', body: '', created: today(), ...(isInk ? { type: 'ink', ink: inkMod.emptyInk() } : {}) });
    noteMode = 'edit';
    navigate(`#/note/${n.id}`);
  },
  'note-mode': (el) => {
    noteMode = el.dataset.mode;
    const ed = document.querySelector('.note-editor');
    if (ed) ed.className = `note-editor mode-${noteMode}`;
    document.querySelectorAll('[data-action="note-mode"]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === noteMode));
  },
  'note-delete': async (el) => {
    const n = store.get(el.dataset.id);
    editor?.destroy(); editor = null; pendingInk = null;
    for (const a of att.attachmentsOf(el.dataset.id)) await att.removeAttachment(a.id);
    await store.remove(el.dataset.id);
    navigate(n ? `#/topic/${n.topicId}` : '#/areas', { skipLeave: true });
    toast('Nota eliminata');
  },
  /* --- attachments --- */
  'att-add': async (input) => {
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    const topicId = input.dataset.topic || store.get(input.dataset.note)?.topicId;
    toast(files.length > 1 ? `Aggiungo ${files.length} file…` : 'Aggiungo il file…');
    const k = await att.addFiles({ topicId }, files);
    if (k) toast(plural(k, 'allegato aggiunto', 'allegati aggiunti'));
  },
  'rec-open': (el) => att.openRecorder(el.dataset.topic),
  'link-new': (el) => att.openLinkModal({ topicId: el.dataset.topic }),
  'link-edit': (el) => att.openLinkModal({ id: el.dataset.id }),
  'link-save': async (form) => {
    const fd = new FormData(form);
    const topicId = String(fd.get('topicId') || form.dataset.topic || '');
    const r = await att.saveLink({ id: form.dataset.id, topicId, url: fd.get('url'), title: fd.get('title'), desc: fd.get('desc') });
    if (r.error) { modalError(r.error); return; }
    closeModal();
    const here = location.hash.startsWith(`#/topic/${topicId}`);
    toast(form.dataset.id ? 'Link aggiornato' : here ? 'Link aggiunto agli Allegati' : `Link salvato in "${store.get(topicId)?.title || 'argomento'}"`);
    if (!form.dataset.id && here && !location.hash.includes('tab=files')) navigate(`#/topic/${topicId}?tab=files`);
  },
  'att-open': (el) => { if (el.dataset.id) att.openViewer(el.dataset.id); },
  'att-delete': async (el) => {
    const a = store.get(el.dataset.id);
    const open = location.hash.startsWith(`#/pdf/${el.dataset.id}`);
    if (open) { boardEditor?.destroy(); boardEditor = null; } // don't save ink for a PDF being deleted
    await att.removeAttachment(el.dataset.id);
    closeModal();
    if (open) navigate(`#/topic/${a?.topicId}?tab=files`, { skipLeave: true });
    toast(att.kindOf(a?.mime) === 'link' ? 'Link eliminato' : 'Allegato eliminato');
    if (a?.noteId) refreshAttachments(a.noteId);
  },
  'ai-transcribe-photos': (el) => transcribePhotos(el, att.topicAttachments(el.dataset.topic).filter((a) => a.mime.startsWith('image/'))),
  'ai-transcribe-photo': (el) => { const a = store.get(el.dataset.id); if (a) transcribePhotos(el, [a]); },

  /* --- transcription --- */
  'ai-transcribe': async (el) => {
    if (!ai.hasKey()) { needKeyModal(); return; }
    const id = el.dataset.note;
    await saveNoteNow(id);
    const n = store.get(id);
    const label = el.textContent;
    el.disabled = true; el.textContent = 'Preparo…';
    try {
      const media = (await noteMedia([n], { forTranscription: true })).slice(0, 20);
      if (!media.length) { toast('Non c\'è niente da trascrivere: scrivi qualcosa o allega una foto.'); return; }
      el.textContent = `Trascrivo ${plural(media.length, 'immagine', 'immagini')}…`;
      const text = await ai.transcribe({ media });
      const body = document.getElementById('note-body');
      const cur = store.get(id);
      let next;
      if (cur.type === 'ink') next = text;
      else next = [(body?.value ?? cur.body ?? '').trim(), `## Trascrizione\n\n${text}`].filter(Boolean).join('\n\n');
      if (body) { body.value = next; body.dispatchEvent(new Event('input')); }
      await store.put('note', { ...store.get(id), body: next });
      const det = document.getElementById('transcript'); if (det) det.open = true;
      toast('Trascrizione pronta. Controllala e correggi se serve.');
    } catch (e) {
      toast(e.message, 'bad');
    } finally { el.disabled = false; el.textContent = label; }
  },
  'card-new': (el) => openCardModal(null, el.dataset.topic),
  'card-edit': (el) => openCardModal(store.get(el.dataset.id)),
  'card-save': async (form) => {
    const fd = new FormData(form);
    const front = String(fd.get('front') || '').trim();
    const back = String(fd.get('back') || '').trim();
    if (!front || !back) { modalError('Compila entrambi i lati.'); return; }
    const id = form.dataset.id;
    const prev = id ? store.get(id) : null;
    const topicId = form.dataset.topic;
    await store.put('card', { ...(prev || {}), id: id || undefined, topicId, areaId: store.get(topicId)?.areaId, front, back, srs: prev?.srs || newCardSrs(), created: prev?.created || today() });
    if (!id && fd.get('another')) {
      form.reset(); form.querySelector('[name=another]').checked = true; form.querySelector('#c-front').focus();
      toast('Flashcard aggiunta');
    } else { closeModal(); toast(id ? 'Flashcard salvata' : 'Flashcard aggiunta'); }
  },
  'card-delete': async (el) => { await store.remove(el.dataset.id); closeModal(); toast('Flashcard eliminata'); },
  'question-new': (el) => openQuestionModal(null, el.dataset.topic),
  'question-edit': (el) => openQuestionModal(store.get(el.dataset.id)),
  'question-save': async (form) => {
    const fd = new FormData(form);
    const question = String(fd.get('question') || '').trim();
    const raw = [];
    for (let i = 0; i < 8; i++) if (fd.has('opt' + i)) raw.push({ i, text: String(fd.get('opt' + i) || '').trim() });
    const answerIdx = +fd.get('answer');
    const filled = raw.filter((o) => o.text);
    if (!question) { modalError('Scrivi la domanda.'); return; }
    if (filled.length < 2) { modalError('Servono almeno due risposte.'); return; }
    const correct = filled.findIndex((o) => o.i === answerIdx);
    if (correct < 0) { modalError('La risposta segnata come corretta è vuota.'); return; }
    const id = form.dataset.id;
    const prev = id ? store.get(id) : null;
    const topicId = form.dataset.topic;
    await store.put('question', { ...(prev || {}), id: id || undefined, topicId, areaId: store.get(topicId)?.areaId, question, options: filled.map((o) => o.text), answer: correct, explanation: String(fd.get('explanation') || '').trim(), created: prev?.created || today() });
    if (!id && fd.get('another')) {
      form.reset(); form.querySelector('[name=another]').checked = true; form.querySelector('[name=answer][value="0"]').checked = true; form.querySelector('#q-q').focus();
      toast('Domanda aggiunta');
    } else { closeModal(); toast(id ? 'Domanda salvata' : 'Domanda aggiunta'); }
  },
  'question-delete': async (el) => { await store.remove(el.dataset.id); closeModal(); toast('Domanda eliminata'); },

  'ai-open': async (el) => { if (el.dataset.board) await boardEditor?.saveNow(); openAiModal(el.dataset.topic, el.dataset.mode, el.dataset.note || '', { fromBoard: !!el.dataset.board }); },
  'ai-cancel': () => { aiAbort?.abort(); closeModal(); },
  'ai-generate': async (form) => {
    const fd = new FormData(form);
    const topicId = form.dataset.topic;
    const t = store.get(topicId);
    const openNote = document.getElementById('note-title')?.dataset.note;
    if (openNote) await saveNoteNow(openNote);
    const picked = fd.getAll('note').map((id) => store.get(id)).filter(Boolean);
    const material = [...picked.filter((n) => (n.body || '').trim()).map((n) => `## ${n.title || 'Nota'}\n${n.body}`), String(fd.get('extra') || '')].join('\n\n').trim();
    const nCards = Math.max(0, Math.min(30, +fd.get('nc') || 0));
    const nQuestions = Math.max(0, Math.min(20, +fd.get('nq') || 0));
    if (!nCards && !nQuestions) { modalError('Chiedi almeno una flashcard o una domanda.'); return; }
    const btn = form.querySelector('#ai-go');
    btn.disabled = true; btn.textContent = 'Preparo gli appunti…';
    modalError('');
    aiAbort = new AbortController();
    try {
      let media = await noteMedia(picked);
      for (const aid of fd.getAll('att')) {
        const a = store.get(aid); const b = a && await att.getBlob(aid);
        if (b) media.push(a.mime === 'application/pdf' ? await ai.pdfToMedia(b, `Allegato "${a.name}"`) : await ai.imageToMedia(b, `Foto "${a.name}"`));
      }
      if (fd.get('board')) {
        const blobs = await board.regionBlobs(topicId);
        for (let i = 0; i < blobs.length; i++) media.unshift(await ai.imageToMedia(blobs[blobs.length - 1 - i], `Quaderno a mano, parte ${blobs.length - i}`));
      }
      if (material.length < 40 && !media.length) { modalError('Serve più materiale: seleziona una nota o incolla almeno qualche frase.'); btn.disabled = false; btn.textContent = 'Genera'; return; }
      if (media.length > 20) { toast('Troppi allegati: uso i primi 20'); media = media.slice(0, 20); }
      btn.textContent = 'Sto generando…';
      aiResult = await ai.generate({ material, media, topicTitle: t?.title, nCards, nQuestions, signal: aiAbort.signal });
      showAiResult(topicId);
    } catch (e) {
      if (e.name === 'AbortError') return;
      modalError(e.message);
      btn.disabled = false; btn.textContent = 'Riprova';
    } finally { aiAbort = null; }
  },
  'ai-save': async (form) => {
    const fd = new FormData(form);
    const topicId = form.dataset.topic;
    const areaId = store.get(topicId)?.areaId;
    const cards = fd.getAll('card').map((i) => aiResult.flashcards[+i]);
    const qs = fd.getAll('question').map((i) => aiResult.questions[+i]);
    if (cards.length) await store.putMany('card', cards.map((c) => ({ ...c, topicId, areaId, srs: newCardSrs(), created: today(), source: 'ai' })));
    if (qs.length) await store.putMany('question', qs.map((q) => ({ ...q, topicId, areaId, created: today(), source: 'ai' })));
    closeModal();
    aiResult = null;
    toast(`Salvati: ${plural(cards.length, 'flashcard', 'flashcard')}, ${plural(qs.length, 'domanda', 'domande')}`);
    navigate(`#/topic/${topicId}?tab=${cards.length || !qs.length ? 'cards' : 'quiz'}`);
  },
});

export { TOPIC_LADDER };

// Drag files (or a link from another browser tab) onto the Allegati tab.
const dropsSomething = (dt) => { const t = [...dt.types]; return t.includes('Files') || t.includes('text/uri-list'); };
document.addEventListener('dragover', (e) => { if (e.target.closest?.('[data-drop-topic]') && dropsSomething(e.dataTransfer)) { e.preventDefault(); e.target.closest('[data-drop-topic]').classList.add('dragging'); } });
document.addEventListener('dragleave', (e) => { const z = e.target.closest?.('[data-drop-topic]'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('dragging'); });
document.addEventListener('drop', async (e) => {
  const z = e.target.closest?.('[data-drop-topic]');
  if (!z) return;
  if (!e.dataTransfer.files.length) {
    const url = att.findUrl(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
    if (!url) return;
    e.preventDefault(); z.classList.remove('dragging');
    att.openLinkModal({ topicId: z.dataset.dropTopic, url });
    return;
  }
  e.preventDefault(); z.classList.remove('dragging');
  const k = await att.addFiles({ topicId: z.dataset.dropTopic }, [...e.dataTransfer.files]);
  if (k) toast(plural(k, 'allegato aggiunto', 'allegati aggiunti'));
});

// Paste a web address (Ctrl+V / long press → Incolla) while the Allegati tab is open: save it as a link.
document.addEventListener('paste', (e) => {
  const z = document.querySelector('[data-drop-topic]');
  if (!z || isModalOpen() || e.target.closest?.('input, textarea, [contenteditable]')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    att.addFiles({ topicId: z.dataset.dropTopic }, files).then((k) => { if (k) toast(plural(k, 'allegato aggiunto', 'allegati aggiunti')); });
    return;
  }
  const text = (e.clipboardData?.getData('text/plain') || '').trim();
  const url = att.findUrl(text) || (!/\s/.test(text) && /\.[a-z]{2,}(\/|$)/i.test(text) ? text : '');
  if (!url) return;
  e.preventDefault();
  att.openLinkModal({ topicId: z.dataset.dropTopic, url });
});
