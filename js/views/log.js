import * as store from '../store.js';
import { esc, today, addDays, weekStart, fmtDate, fmtWeekday, colorVar, plural, toast } from '../util.js';
import { registerActions, openModal, closeModal, modalError, areas, areaOptions, topicOptions, areaChip, confirmButton, emptyState } from '../ui.js';

let ciWeek = null;
let ciDirty = false;

export function render() {
  const sessions = store.all('session').sort((a, b) => b.date.localeCompare(a.date) || b.updated_at - a.updated_at);
  const t = today();
  const wk = weekStart(t);
  const days = [...Array(14)].map((_, i) => addDays(t, i - 13));
  const perDay = days.map((d) => sessions.filter((s) => s.date === d).reduce((n, s) => n + (+s.minutes || 0), 0));
  const max = Math.max(60, ...perDay);
  const weekByArea = areas().map((a) => ({ a, m: sessions.filter((s) => s.areaId === a.id && weekStart(s.date) === wk).reduce((n, s) => n + (+s.minutes || 0), 0) })).filter((x) => x.m);
  const weekTotal = sessions.filter((s) => weekStart(s.date) === wk).reduce((n, s) => n + (+s.minutes || 0), 0);

  return `
  <header class="page-head">
    <div><span class="eyebrow">Quanto e cosa hai studiato</span><h1>Registro</h1></div>
    <button class="btn primary" data-action="session-new">+ Sessione</button>
  </header>

  <div class="two-col wide-left">
    <section>
      <div class="sec-head"><h2>Ultime due settimane</h2><span class="mono muted">${(weekTotal / 60).toFixed(1)} h questa settimana</span></div>
      <div class="week-chart tall" role="img" aria-label="Minuti di studio al giorno, ultime due settimane">
        ${days.map((d, i) => `<div title="${fmtDate(d)}: ${perDay[i]} min" class="${d === t ? 'today' : ''}"><span class="mono v">${perDay[i] || ''}</span><span class="b ${perDay[i] ? '' : 'zero'}" style="height:${Math.max(3, (perDay[i] / max) * 90)}px"></span><small>${fmtWeekday(d)}</small></div>`).join('')}
      </div>
      ${weekByArea.length ? `<div class="area-split">${weekByArea.map(({ a, m }) => `<div class="split-row"><span class="chip"><i style="background:${colorVar(a.color)}"></i><span>${esc(a.name)}</span></span><span class="split-bar"><span style="width:${(m / weekTotal) * 100}%;background:${colorVar(a.color)}"></span></span><span class="mono small">${m} min</span></div>`).join('')}</div>` : ''}

      <div class="sec-head top-gap"><h2>Sessioni</h2></div>
      ${sessions.length ? `<div class="list">${sessions.slice(0, 40).map((s) => {
        const tp = store.get(s.topicId);
        return `<button class="list-row log-row" data-action="session-edit" data-id="${s.id}">
          <span class="mono small muted d">${fmtDate(s.date)}</span>
          <span class="grow"><span class="block">${esc(s.note || tp?.title || 'Sessione di studio')}</span><span class="meta">${areaChip(s.areaId)}${tp && s.note ? `<span>${esc(tp.title)}</span>` : ''}</span></span>
          <span class="mono">${s.minutes} min</span>
        </button>`;
      }).join('')}</div>` : emptyState('Nessuna sessione', 'Registra ogni sessione, anche da 15 minuti. Dopo un ripasso o un quiz puoi registrarla con un tocco.', '<button class="btn primary" data-action="session-new">+ Sessione</button>')}
    </section>

    <section>
      <div class="sec-head"><h2>Check-in settimanale</h2></div>
      ${checkinForm()}
    </section>
  </div>`;
}

function checkinForm() {
  const cur = weekStart(today());
  if (!ciWeek) ciWeek = cur;
  const all = store.all('checkin');
  const weeks = [...new Set([cur, ...all.map((c) => c.week)])].sort().reverse();
  const c = all.find((x) => x.week === ciWeek) || {};
  return `<form class="checkin" data-form="checkin-save">
    <select id="ci-week" data-change="checkin-week" aria-label="Settimana">${weeks.map((w) => `<option value="${w}" ${w === ciWeek ? 'selected' : ''}>${w === cur ? 'Questa settimana' : 'Settimana del ' + fmtDate(w)}</option>`).join('')}</select>
    <div class="field"><label for="ci-wins">Cosa ho finito o capito?</label><textarea id="ci-wins" name="wins" rows="3">${esc(c.wins || '')}</textarea></div>
    <div class="field"><label for="ci-stuck">Dove mi sono bloccato?</label><textarea id="ci-stuck" name="stuck" rows="3">${esc(c.stuck || '')}</textarea></div>
    <div class="field"><label for="ci-next">Su cosa mi concentro la prossima settimana?</label><textarea id="ci-next" name="next" rows="3">${esc(c.next || '')}</textarea></div>
    <div class="row gap"><button class="btn primary" type="submit">Salva check-in</button><span class="small ok-text">${c.id ? 'Salvato' : ''}</span></div>
  </form>`;
}

function openSessionModal(s) {
  const isNew = !s;
  if (!areas().length) { toast('Crea prima un\'area'); return; }
  s = s || { date: today(), minutes: 30, areaId: areas()[0].id, topicId: '', note: '' };
  openModal(`
    <form data-form="session-save" data-id="${s.id || ''}">
      <h2>${isNew ? 'Registra una sessione' : 'Modifica sessione'}</h2>
      <div class="row2">
        <div class="field"><label for="s-date">Data</label><input id="s-date" name="date" type="date" value="${s.date}" required></div>
        <div class="field"><label for="s-min">Minuti</label><input id="s-min" name="minutes" type="number" min="1" step="5" value="${s.minutes}" required></div>
      </div>
      <div class="row2">
        <div class="field"><label for="s-area">Area</label><select id="s-area" name="areaId" data-change="session-area">${areaOptions(s.areaId)}</select></div>
        <div class="field"><label for="s-topic">Argomento</label><select id="s-topic" name="topicId">${topicOptions(s.areaId, s.topicId)}</select></div>
      </div>
      <div class="field"><label for="s-note">Cosa hai fatto?</label><input id="s-note" name="note" type="text" value="${esc(s.note || '')}" placeholder="es. Riscritto il controller del giocatore con una macchina a stati"></div>
      <p class="error" data-error hidden></p>
      <div class="modal-foot">
        ${isNew ? '' : confirmButton('Elimina', 'session-delete', `data-id="${s.id}"`)}
        <div class="row gap push"><button type="button" class="btn" data-action="close-modal">Annulla</button><button class="btn primary" type="submit">${isNew ? 'Registra' : 'Salva'}</button></div>
      </div>
    </form>`);
}

registerActions({
  'session-new': () => openSessionModal(),
  'session-edit': (el) => openSessionModal(store.get(el.dataset.id)),
  'session-area': (el) => { document.getElementById('s-topic').innerHTML = topicOptions(el.value, ''); },
  'session-save': async (form) => {
    const fd = new FormData(form);
    const minutes = Math.round(+fd.get('minutes') || 0);
    if (minutes < 1) { modalError('Indica quanti minuti.'); return; }
    const id = form.dataset.id;
    const prev = id ? store.get(id) : null;
    await store.put('session', { ...(prev || {}), id: id || undefined, date: fd.get('date') || today(), minutes, areaId: fd.get('areaId'), topicId: fd.get('topicId') || '', note: String(fd.get('note') || '').trim() });
    closeModal();
    toast(id ? 'Sessione salvata' : 'Sessione registrata');
  },
  'session-delete': async (el) => { await store.remove(el.dataset.id); closeModal(); toast('Sessione eliminata'); },
  'checkin-week': (el) => { ciWeek = el.value; ciDirty = false; document.dispatchEvent(new CustomEvent('rerender')); },
  'checkin-save': async (form) => {
    const fd = new FormData(form);
    const prev = store.all('checkin').find((x) => x.week === ciWeek);
    await store.put('checkin', { ...(prev || {}), id: prev?.id, week: ciWeek, wins: String(fd.get('wins') || '').trim(), stuck: String(fd.get('stuck') || '').trim(), next: String(fd.get('next') || '').trim() });
    ciDirty = false;
    toast('Check-in salvato');
  },
});
