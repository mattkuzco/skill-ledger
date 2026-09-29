// "Opzioni di studio": edit a preset (like Anki's deck options) and choose which preset an
// area or topic uses. Every change is saved at once.

import * as store from '../store.js';
import { esc, toast, plural } from '../util.js';
import { registerActions, emptyState, confirmButton } from '../ui.js';
import { navigate } from '../router.js';
import {
  DEFAULT_ID, CARD_DEFAULTS, QUIZ_DEFAULTS, getPreset, presets, usage, savePreset, createPreset, deletePreset,
  parseSteps, formatSteps, areaPresetId,
} from '../presets.js';

const sel = (name, value, opts) => `<select name="${name}" data-change="preset-field">${opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const num = (name, value, min, max, unit = '') => `<span class="num-wrap"><input type="number" inputmode="numeric" name="${name}" value="${value}" min="${min}" max="${max}" step="1" data-change="preset-field">${unit ? `<span class="unit">${unit}</span>` : ''}</span>`;
const check = (name, value, label) => `<label class="check"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} data-change="preset-field"> ${label}</label>`;
const row = (label, control, hint = '') => `<div class="opt-row"><div class="opt-label"><b>${label}</b>${hint ? `<span class="hint">${hint}</span>` : ''}</div><div class="opt-control">${control}</div></div>`;

function assignBox(forScope, p) {
  const [k, id] = forScope.split(':');
  const target = store.get(id);
  if (!target) return '';
  const list = presets();
  if (k === 'topic') {
    const area = store.get(target.areaId);
    const inherit = getPreset(areaPresetId(target.areaId));
    const current = target.presetId && store.get(target.presetId) ? target.presetId : '';
    return `<div class="assign-box"><span>Argomento <b>${esc(target.title)}</b> usa</span>
      <select data-change="options-assign" data-for="${esc(forScope)}">
        <option value="" ${current ? '' : 'selected'}>Come l'area${area ? ` "${esc(area.name)}"` : ''} (${esc(inherit.name)})</option>
        ${list.map((x) => `<option value="${x.id}" ${current === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select></div>`;
  }
  return `<div class="assign-box"><span>Area <b>${esc(target.name)}</b> usa</span>
    <select data-change="options-assign" data-for="${esc(forScope)}">${list.map((x) => `<option value="${x.id}" ${areaPresetId(id) === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <span class="hint">Vale per tutti i suoi argomenti, tranne quelli con un preset proprio.</span></div>`;
}

export function render(presetId, params) {
  const forScope = params.get('for') || '';
  if (presetId !== DEFAULT_ID && !store.get(presetId)) return emptyState('Preset non trovato', 'Forse è stato eliminato.', `<a class="btn" href="#/options/${DEFAULT_ID}">Apri il predefinito</a>`);
  const p = getPreset(presetId);
  const c = p.cards; const q = p.quiz;
  const u = usage(p.id);
  const usedBy = [u.areas.length ? plural(u.areas.length, 'area', 'aree') : '', u.topics.length ? plural(u.topics.length, 'argomento', 'argomenti') : ''].filter(Boolean).join(' e ');
  const back = forScope ? `#/${forScope.replace(':', '/')}` : '#/settings';
  return `
  <nav class="crumbs"><a href="${back}">← ${forScope ? 'Indietro' : 'Impostazioni'}</a></nav>
  <header class="page-head"><div><span class="eyebrow">Flashcard e quiz</span><h1>Opzioni di studio</h1></div><span class="small muted" data-opt-saved></span></header>
  ${forScope ? assignBox(forScope, p) : ''}
  <form class="options-form" data-preset="${p.id}" onsubmit="return false">
    <div class="preset-bar">
      <label class="field grow"><span class="label">Preset</span>
        ${p.isDefault ? '<input type="text" value="Predefinito" disabled>' : `<input type="text" name="name" value="${esc(p.name)}" data-change="preset-field" maxlength="60">`}</label>
      <div class="btn-group">
        <select data-change="options-switch" aria-label="Modifica un altro preset" data-for="${esc(forScope)}">${presets().map((x) => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <button type="button" class="btn" data-action="preset-new" data-from="${p.id}" data-for="${esc(forScope)}">+ Nuovo preset</button>
        ${p.isDefault ? '' : confirmButton('Elimina', 'preset-delete', `data-id="${p.id}" data-for="${esc(forScope)}"`)}
      </div>
    </div>
    <p class="hint">${usedBy ? `Usato da ${usedBy}.` : p.isDefault ? 'Vale per tutte le aree e gli argomenti che non hanno un preset proprio.' : 'Non è ancora usato: sceglilo da un\'area o da un argomento.'} Le modifiche valgono per tutti quelli che lo usano e si sincronizzano sugli altri dispositivi.</p>

    <section class="opt-section"><h2>Limiti giornalieri</h2>
      ${row('Nuove carte al giorno', num('cards.newPerDay', c.newPerDay, 0, 9999), 'Quante carte mai viste inizi a studiare ogni giorno, per argomento. Nelle aree vale anche come tetto complessivo.')}
      ${row('Ripassi massimi al giorno', num('cards.reviewsPerDay', c.reviewsPerDay, 0, 99999), 'Oltre questo numero i ripassi slittano al giorno dopo. Tienilo alto: i ripassi arretrati si accumulano.')}
    </section>

    <section class="opt-section"><h2>Nuove carte</h2>
      ${row('Passi di apprendimento', `<input type="text" name="cards.learnSteps" value="${esc(formatSteps(c.learnSteps))}" placeholder="1m 10m" data-change="preset-field" autocomplete="off"><span class="field-error" data-err="cards.learnSteps"></span>`, 'Dopo quanto rivedi una carta nuova la prima volta: m minuti, h ore, g giorni, separati da spazi. Con "Bene" si passa al successivo; dopo l\'ultimo la carta va in ripasso. Vuoto = nessun passo.')}
      ${row('Ordine delle nuove', sel('cards.newOrder', c.newOrder, [['created', 'Nell\'ordine in cui le hai aggiunte'], ['random', 'Casuale']]))}
    </section>

    <section class="opt-section"><h2>Errori</h2>
      ${row('Passi di riapprendimento', `<input type="text" name="cards.relearnSteps" value="${esc(formatSteps(c.relearnSteps))}" placeholder="10m" data-change="preset-field" autocomplete="off"><span class="field-error" data-err="cards.relearnSteps"></span>`, 'Quando dimentichi una carta in ripasso, dopo quanto la rivedi prima di rimetterla in ripasso.')}
      ${row('Soglia sanguisuga', num('cards.leechThreshold', c.leechThreshold, 1, 99, 'errori'), 'Una carta dimenticata così tante volte è una "sanguisuga": ti fa perdere tempo e di solito va riscritta.')}
      ${row('Cosa fare con le sanguisughe', sel('cards.leechAction', c.leechAction, [['tag', 'Solo contrassegnarle'], ['suspend', 'Sospenderle']]))}
    </section>

    <section class="opt-section"><h2>Ordine di visualizzazione</h2>
      ${row('Nuove e ripassi', sel('cards.mix', c.mix, [['mix', 'Mescolate'], ['reviewsFirst', 'Prima i ripassi'], ['newFirst', 'Prima le nuove']]), 'Le carte in apprendimento compaiono sempre appena tocca a loro.')}
      ${row('Ordine dei ripassi', sel('cards.reviewOrder', c.reviewOrder, [['due', 'Per scadenza (le più arretrate prima)'], ['difficulty', 'Prima quelle che rischi di più di dimenticare'], ['random', 'Casuale']]))}
    </section>

    <section class="opt-section"><h2>FSRS</h2>
      ${row('Memoria desiderata', num('cards.retention', Math.round(c.retention * 100), 70, 99, '%'), 'La probabilità di ricordare una carta quando te la ripropone. 90% è il valore consigliato; con 95% i ripassi quasi raddoppiano, con 80% sono circa la metà.')}
      ${row('Intervallo massimo', num('cards.maxInterval', c.maxInterval, 1, 36500, 'giorni'), 'Una carta non aspetta mai più di così tra un ripasso e l\'altro.')}
    </section>

    <section class="opt-section"><h2>Durante il ripasso</h2>
      ${row('Pulsanti', check('cards.showIntervals', c.showIntervals, 'Mostra quando tornerà la carta sotto ogni pulsante'))}
      ${row('Cronometro', check('cards.showTimer', c.showTimer, 'Mostra da quanto tempo stai guardando la carta'))}
      <p class="hint">Scorciatoie: Spazio gira la carta, 1-4 rispondono, Z annulla, - rimanda a domani, @ sospende.</p>
    </section>

    <section class="opt-section"><h2>Quiz</h2>
      ${row('Domande per quiz', num('quiz.count', q.count, 0, 999), '0 = tutte le domande dell\'argomento o dell\'area.')}
      ${row('Ordine delle domande', sel('quiz.order', q.order, [['random', 'Casuale'], ['sequential', 'Nell\'ordine in cui le hai aggiunte']]))}
      ${row('Precedenza', check('quiz.weakFirst', q.weakFirst, 'Prima le domande sbagliate di recente'), 'Solo con l\'ordine casuale.')}
      ${row('Risposte', check('quiz.shuffleOptions', q.shuffleOptions, 'Mescola l\'ordine delle risposte'))}
      ${row('Spiegazioni', sel('quiz.feedback', q.feedback, [['each', 'Subito, dopo ogni risposta'], ['end', 'Alla fine, come in un esame']]))}
      ${row('Tempo per domanda', sel('quiz.timeLimit', q.timeLimit, [[0, 'Nessun limite'], [15, '15 secondi'], [30, '30 secondi'], [45, '45 secondi'], [60, '1 minuto'], [90, '1 minuto e mezzo'], [120, '2 minuti'], [180, '3 minuti']]), 'Allo scadere la domanda conta come sbagliata.')}
      ${row('Errori', check('quiz.retryWrong', q.retryWrong, 'Riproponi le domande sbagliate alla fine del quiz'), 'Non cambiano il punteggio: servono a rivedere subito la risposta giusta.')}
    </section>

    <div class="row gap wrap opt-foot">${confirmButton('Ripristina i valori predefiniti', 'preset-reset', `data-id="${p.id}"`)}</div>
  </form>`;
}

function setSaved(msg = 'Salvato') {
  const el = document.querySelector('[data-opt-saved]');
  if (el) { el.textContent = msg; clearTimeout(setSaved.t); setSaved.t = setTimeout(() => { el.textContent = ''; }, 1800); }
}

registerActions({
  'preset-field': async (el) => {
    const form = el.closest('[data-preset]');
    const p = getPreset(form.dataset.preset);
    const name = el.name;
    if (name === 'name') { p.name = el.value.trim() || 'Preset'; await savePreset(p); setSaved(); return; }
    const [group, key] = name.split('.');
    const defs = group === 'cards' ? CARD_DEFAULTS : QUIZ_DEFAULTS;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (key === 'learnSteps' || key === 'relearnSteps') {
      const steps = parseSteps(el.value);
      const err = form.querySelector(`[data-err="${name}"]`);
      if (!steps) { if (err) err.textContent = 'Scrivi durate come 1m 10m 1h 1g'; return; }
      if (err) err.textContent = '';
      v = steps; el.value = formatSteps(steps);
    } else if (el.type === 'number') {
      const n = Math.round(+el.value);
      const min = +el.min; const max = +el.max;
      if (!Number.isFinite(n)) { el.value = key === 'retention' ? Math.round(p.cards.retention * 100) : p[group][key]; return; }
      v = Math.min(max, Math.max(min, n));
      el.value = v;
      if (key === 'retention') v /= 100;
    } else v = typeof defs[key] === 'number' ? +el.value : el.value;
    p[group] = { ...p[group], [key]: v };
    await savePreset(p);
    setSaved();
  },
  'options-switch': (el) => navigate(`#/options/${el.value}${el.dataset.for ? `?for=${el.dataset.for}` : ''}`),
  'options-assign': async (el) => {
    const [k, id] = el.dataset.for.split(':');
    const rec = store.get(id);
    if (!rec) return;
    await store.put(k, { ...rec, presetId: el.value });
    const shown = el.value || areaPresetId(rec.areaId);
    toast('Preset assegnato');
    navigate(`#/options/${shown}?for=${el.dataset.for}`);
  },
  'preset-new': async (el) => {
    const n = presets().length;
    const rec = await createPreset(`Preset ${n}`, el.dataset.from);
    // when opened from an area or topic, the new preset is assigned to it right away
    if (el.dataset.for) {
      const [k, id] = el.dataset.for.split(':');
      const target = store.get(id);
      if (target) await store.put(k, { ...target, presetId: rec.id });
    }
    toast(el.dataset.for ? 'Nuovo preset creato e assegnato: dagli un nome' : 'Nuovo preset creato: dagli un nome');
    navigate(`#/options/${rec.id}${el.dataset.for ? `?for=${el.dataset.for}` : ''}`);
    setTimeout(() => { const i = document.querySelector('.options-form input[name=name]'); i?.focus(); i?.select(); }, 60);
  },
  'preset-delete': async (el) => {
    await deletePreset(el.dataset.id);
    toast('Preset eliminato: chi lo usava torna al predefinito');
    navigate(`#/options/${DEFAULT_ID}${el.dataset.for ? `?for=${el.dataset.for}` : ''}`);
  },
  'preset-reset': async (el) => {
    const p = getPreset(el.dataset.id);
    await savePreset({ ...p, cards: { ...CARD_DEFAULTS }, quiz: { ...QUIZ_DEFAULTS } });
    toast('Valori predefiniti ripristinati');
    document.dispatchEvent(new CustomEvent('rerender'));
  },
});
