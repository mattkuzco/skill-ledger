// Import flashcards and quiz questions from Excel (.xlsx), CSV/TSV (also Quizlet and Anki text
// exports) and JSON, with no libraries: .xlsx is a zip of XML files, read with the browser's
// DecompressionStream and DOMParser.
//
// Result: { cards: [{front, back}], questions: [{question, options, answer, explanation}],
//           skipped: [{where, reason}], format }
// Columns are recognised by name in Italian or English (Fronte/Retro, Domanda/Risposta A…/Corretta).

const MAX_ITEMS = 5000;
const MAX_LEN = 4000;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim().slice(0, MAX_LEN);

const KEYS = {
  front: ['fronte', 'front', 'domanda', 'question', 'q', 'term', 'termine', 'parola', 'concetto', 'prompt', 'recto', 'word', 'voce'],
  back: ['retro', 'back', 'risposta', 'answer', 'a', 'definition', 'definizione', 'significato', 'verso', 'meaning', 'traduzione', 'translation'],
  question: ['domanda', 'question', 'quesito', 'testo', 'text', 'prompt', 'testo domanda'],
  options: ['options', 'opzioni', 'risposte', 'answers', 'choices', 'scelte', 'alternative', 'alternatives'],
  correct: ['corretta', 'correct', 'risposta corretta', 'risposta giusta', 'giusta', 'esatta', 'risposta esatta', 'soluzione', 'solution', 'correct answer', 'correctanswer', 'right answer', 'correct index', 'correctindex', 'answer index', 'answerindex', 'correct option', 'chiave'],
  explanation: ['spiegazione', 'explanation', 'motivazione', 'perche', 'note', 'nota', 'commento', 'feedback', 'why', 'rationale'],
};
const OPTION_RE = /^(?:risposta|opzione|option|answer|scelta|choice|alternativa|risp|opz|opt)\s*([a-h]|[1-8])$|^([a-h])$/;
const optionLabel = (h) => { const m = norm(h).match(OPTION_RE); return m ? (m[1] || m[2]) : null; };
const labelIndex = (l) => (/^\d$/.test(l) ? +l - 1 : l.charCodeAt(0) - 97);

/* ---------- entry point ---------- */
export async function parseFile(file) {
  const name = (file.name || '').toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  const out = { cards: [], questions: [], skipped: [], format: '' };
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw new Error('Questo è un file Excel vecchio (.xls). In Excel usa File → Salva con nome → Cartella di lavoro Excel (.xlsx), poi riprova.');
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    if (name.endsWith('.ods')) throw new Error('I file .ods non sono supportati: salvalo come .xlsx o .csv.');
    out.format = 'Excel';
    const sheets = await readXlsx(buf);
    for (const sh of sheets) fromTable(sh.rows, sh.name, out, sheets.length > 1);
  } else {
    const text = decodeText(buf);
    const t = text.trimStart();
    if (name.endsWith('.json') || t.startsWith('{') || t.startsWith('[')) {
      out.format = 'JSON';
      let data;
      try { data = JSON.parse(t); } catch (e) { throw new Error(`Il JSON non è valido: ${e.message}`); }
      fromJson(data, out);
    } else {
      const { rows, delim } = parseDelimited(text);
      out.format = delim === '\t' ? 'testo (Quizlet/Anki)' : 'CSV';
      fromTable(rows, '', out, false);
    }
  }
  if (out.cards.length + out.questions.length > MAX_ITEMS) throw new Error(`Il file contiene più di ${MAX_ITEMS} elementi: dividilo in più file.`);
  return out;
}

function decodeText(buf) {
  let b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1252').decode(b); } // CSV saved by older Excel on Windows
}

/* ---------- quiz answers ---------- */
// Which option is correct. Letters (A, B…) and texts are unambiguous; numbers count from 1 in
// spreadsheets and from 0 in JSON (the app's own format), unless that is out of range.
function resolveAnswer(v, labels, texts, { zeroBased = false } = {}) {
  if (v === null || v === undefined || v === '') return -1;
  if (typeof v === 'boolean') return -1;
  const n = labels.length;
  if (typeof v === 'number' || /^\d+(\.0+)?$/.test(String(v).trim())) {
    const x = Math.round(Number(v));
    if (zeroBased) return x >= 0 && x < n ? x : x === n ? n - 1 : -1;
    // 3 means the third column (C), even if an earlier answer cell was left empty
    const byLabel = x >= 1 && x <= 8 ? labels.indexOf(String.fromCharCode(96 + x)) : -1;
    if (byLabel >= 0) return byLabel;
    return x >= 1 && x <= n ? x - 1 : x === 0 ? 0 : -1;
  }
  const s = norm(v);
  const lab = s.match(/^(?:risposta|opzione|option|answer|scelta|choice|lettera)?\s*([a-h])$/);
  if (lab) { const i = labels.indexOf(lab[1]); if (i >= 0) return i; }
  const byText = texts.findIndex((t) => norm(t) === s);
  if (byText >= 0) return byText;
  const num = s.match(/^(?:risposta|opzione|option|answer|scelta|choice)\s*(\d)$/);
  if (num) { const i = +num[1] - 1; if (i >= 0 && i < n) return i; }
  return -1;
}

function addQuestion(out, where, question, pairs, correctRaw, explanation, opts) {
  // pairs: [[label, text]] in column order; empty options are dropped after resolving the answer
  const q = clean(question);
  const filled = pairs.map(([l, t]) => [l, clean(t)]).filter(([, t]) => t);
  if (!q) { out.skipped.push({ where, reason: 'manca il testo della domanda' }); return; }
  if (filled.length < 2) { out.skipped.push({ where, reason: 'servono almeno due risposte' }); return; }
  const idx = resolveAnswer(typeof correctRaw === 'string' ? clean(correctRaw) : correctRaw, filled.map(([l]) => l), filled.map(([, t]) => t), opts);
  if (idx < 0) { out.skipped.push({ where, reason: correctRaw === '' || correctRaw == null ? 'manca la risposta corretta' : `risposta corretta "${String(correctRaw).slice(0, 40)}" non riconosciuta` }); return; }
  out.questions.push({ question: q, options: filled.map(([, t]) => t), answer: idx, explanation: clean(explanation) });
}
function addCard(out, where, front, back) {
  const f = clean(front); const b = clean(back);
  if (!f && !b) return; // empty row
  if (!f || !b) { out.skipped.push({ where, reason: f ? 'manca il retro' : 'manca il fronte' }); return; }
  out.cards.push({ front: f, back: b });
}

/* ---------- tables (Excel sheets, CSV) ---------- */
function roleOf(h) {
  const n = norm(h);
  if (!n) return null;
  if (KEYS.correct.includes(n)) return { role: 'correct' };
  const lab = optionLabel(h);
  if (lab) return { role: 'option', label: /^\d$/.test(lab) ? String.fromCharCode(96 + +lab) : lab };
  if (KEYS.explanation.includes(n)) return { role: 'expl' };
  if (KEYS.question.includes(n) || KEYS.front.includes(n)) return { role: 'q' };
  if (KEYS.back.includes(n)) return { role: 'back' };
  return null;
}

// rows: [{ n: row number, cells: [...] }]
function fromTable(rows, sheetName, out, many) {
  const place = (n) => `${many && sheetName ? `Foglio "${sheetName}", ` : ''}riga ${n}`;
  if (/istruzion|legenda|help|leggimi|readme/i.test(sheetName)) return;
  const data = rows.filter((r) => r.cells.some((c) => clean(c)));
  if (!data.length) return;
  // header: one of the first 5 rows that names at least two known columns
  let head = -1; let roles = [];
  for (let i = 0; i < Math.min(5, data.length); i++) {
    const rr = data[i].cells.map(roleOf);
    const kinds = rr.filter(Boolean).map((r) => r.role);
    const opts = kinds.filter((k) => k === 'option').length;
    if ((kinds.includes('q') && (kinds.includes('back') || opts >= 2)) || (opts >= 2 && kinds.includes('correct'))) { head = i; roles = rr; break; }
  }
  if (head < 0) {
    // no header: two filled columns = flashcards (e.g. a Quizlet export)
    const two = data.filter((r) => r.cells.filter((c) => clean(c)).length === 2).length;
    if (two >= data.length * 0.6) {
      for (const r of data) { const [a, b] = r.cells.filter((c) => clean(c)); addCard(out, place(r.n), a, b); }
      return;
    }
    out.skipped.push({ where: sheetName ? `Foglio "${sheetName}"` : 'File', reason: 'non trovo le intestazioni delle colonne (per esempio Fronte e Retro, oppure Domanda, Risposta A, Risposta B, Corretta)' });
    return;
  }
  const col = (role) => roles.findIndex((r) => r?.role === role);
  const options = roles.map((r, i) => (r?.role === 'option' ? [r.label, i] : null)).filter(Boolean);
  const isQuiz = options.length >= 2;
  const qCol = col('q'); const backCol = col('back'); const corrCol = col('correct') >= 0 ? col('correct') : backCol; const explCol = col('expl');
  for (const r of data.slice(head + 1)) {
    const c = (i) => (i >= 0 ? r.cells[i] ?? '' : '');
    if (isQuiz) {
      if (![qCol, ...options.map(([, i]) => i)].some((i) => clean(c(i)))) continue;
      addQuestion(out, place(r.n), c(qCol), options.map(([l, i]) => [l, c(i)]), c(corrCol), c(explCol));
    } else addCard(out, place(r.n), c(qCol), c(backCol));
  }
}

function parseDelimited(text) {
  const lines = text.split(/\r?\n/);
  // Anki text exports start with "#separator:tab", "#html:true", "#tags column:3"…
  let skip = 0; let html = false; const drop = [];
  while (skip < lines.length && /^#[\w ]+:/.test(lines[skip])) {
    if (/^#html:true/i.test(lines[skip])) html = true;
    const m = lines[skip].match(/^#(?:tags|deck|notetype|guid) column:(\d+)/i); // not part of the card
    if (m) drop.push(+m[1] - 1);
    skip++;
  }
  const body = lines.slice(skip).join('\n');
  const first = lines.slice(skip).find((l) => l.trim()) || '';
  const count = (ch) => first.split(ch).length - 1;
  const delim = count('\t') ? '\t' : count(';') >= count(',') && count(';') ? ';' : ',';
  // row numbers as a spreadsheet shows them: a cell spanning several lines is still one row
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) {
      if (ch === '"') { if (body[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell); rows.push({ n: rows.length + 1, cells: row }); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push({ n: rows.length + 1, cells: row }); }
  if (drop.length) for (const r of rows) r.cells = r.cells.filter((_, i) => !drop.includes(i));
  if (html || rows.some((r) => r.cells.some((c) => /<(br|div|b|i|span|p)\b|&nbsp;/i.test(c)))) {
    for (const r of rows) r.cells = r.cells.map(stripHtml);
  }
  return { rows, delim };
}
function stripHtml(s) {
  if (!/[<&]/.test(s)) return s;
  const withBreaks = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n');
  const doc = new DOMParser().parseFromString(`<body>${withBreaks}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n');
}

/* ---------- JSON ---------- */
function lookup(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const map = new Map(Object.keys(obj).map((k) => [norm(k), obj[k]]));
  for (const k of keys) if (map.has(k) && map.get(k) !== undefined && map.get(k) !== null) return map.get(k);
  return undefined;
}
function fromJson(data, out) {
  if (data && data.app === 'skill-ledger' && Array.isArray(data.records)) {
    // a Skill Ledger backup: take its flashcards and quiz questions
    data = { flashcards: data.records.filter((r) => r.kind === 'card' && !r.deleted), questions: data.records.filter((r) => r.kind === 'question' && !r.deleted) };
  }
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === 'object') {
    const cards = lookup(data, ['flashcards', 'flashcard', 'cards', 'carte', 'schede', 'deck', 'notes']);
    const qs = lookup(data, ['questions', 'quiz', 'domande', 'quesiti', 'quizzes', 'test', 'items']);
    if (Array.isArray(cards)) items.push(...cards.map((c) => ({ __card: true, ...c })));
    if (Array.isArray(qs)) items.push(...qs);
    if (!items.length) {
      const arrays = Object.values(data).filter(Array.isArray);
      if (arrays.length === 1) items = arrays[0];
    }
  }
  if (!items.length) { out.skipped.push({ where: 'File', reason: 'non trovo flashcard o domande: vedi il modello JSON' }); return; }
  items.forEach((it, i) => {
    const where = `elemento ${i + 1}`;
    if (typeof it !== 'object' || !it) { out.skipped.push({ where, reason: 'non è un oggetto' }); return; }
    const rawOpts = lookup(it, KEYS.options);
    if (!it.__card && rawOpts !== undefined) {
      let pairs = [];
      let correct = lookup(it, KEYS.correct.concat(['answer', 'risposta']));
      if (Array.isArray(rawOpts)) {
        pairs = rawOpts.map((o, j) => {
          const label = String.fromCharCode(97 + j);
          if (o && typeof o === 'object') {
            if ((o.correct ?? o.corretta ?? o.isCorrect ?? o.giusta) === true) correct = label;
            return [label, o.text ?? o.testo ?? o.label ?? o.value ?? ''];
          }
          return [label, o];
        });
      } else if (rawOpts && typeof rawOpts === 'object') {
        pairs = Object.entries(rawOpts).map(([k, v], j) => [/^[a-h]$/i.test(k) ? k.toLowerCase() : String.fromCharCode(97 + j), v]);
      }
      addQuestion(out, where, lookup(it, KEYS.question) ?? '', pairs, correct, lookup(it, KEYS.explanation) ?? '', { zeroBased: true });
    } else {
      addCard(out, where, lookup(it, KEYS.front) ?? '', lookup(it, KEYS.back) ?? lookup(it, ['spiegazione', 'explanation']) ?? '');
    }
  });
}

/* ---------- .xlsx ---------- */
async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
}
function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Il file Excel sembra danneggiato.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const nlen = dv.getUint16(p + 28, true); const elen = dv.getUint16(p + 30, true); const clen = dv.getUint16(p + 32, true);
    files.set(dec.decode(buf.subarray(p + 46, p + 46 + nlen)), { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) });
    p += 46 + nlen + elen + clen;
  }
  return async (name) => {
    const e = files.get(name);
    if (!e) return null;
    const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new Error('Compressione del file Excel non supportata.');
  };
}
const byTag = (node, tag) => [...node.getElementsByTagNameNS('*', tag)];
const textOf = (node) => byTag(node, 't').filter((t) => !t.closest?.('rPh')).map((t) => t.textContent).join('');
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
async function readXlsx(buf) {
  const read = unzip(buf);
  const dec = new TextDecoder();
  const xml = async (name) => { const b = await read(name); return b ? new DOMParser().parseFromString(dec.decode(b), 'application/xml') : null; };
  const wb = await xml('xl/workbook.xml');
  if (!wb) throw new Error('Non sembra un file Excel (.xlsx).');
  const rels = await xml('xl/_rels/workbook.xml.rels');
  const target = new Map((rels ? byTag(rels, 'Relationship') : []).map((r) => {
    const t = r.getAttribute('Target') || '';
    return [r.getAttribute('Id'), t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '')];
  }));
  const ssDoc = await xml('xl/sharedStrings.xml');
  const shared = ssDoc ? byTag(ssDoc, 'si').map(textOf) : [];
  const sheets = [];
  for (const s of byTag(wb, 'sheet')) {
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const doc = await xml(target.get(rid) || '');
    if (!doc) continue;
    const rows = byTag(doc, 'row').map((row, i) => {
      const cells = [];
      for (const c of byTag(row, 'c')) {
        const idx = colIndex(c.getAttribute('r'));
        const t = c.getAttribute('t'); const v = byTag(c, 'v')[0]?.textContent ?? '';
        const val = t === 's' ? shared[+v] ?? '' : t === 'inlineStr' ? textOf(byTag(c, 'is')[0] || c) : t === 'b' ? (v === '1' ? 'VERO' : 'FALSO') : v;
        cells[idx >= 0 ? idx : cells.length] = val;
      }
      for (let k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = '';
      return { n: +row.getAttribute('r') || i + 1, cells };
    });
    sheets.push({ name: s.getAttribute('name') || '', rows });
  }
  return sheets;
}

// Drop items already in the topic (same front / same question, ignoring case and spaces).
export function splitDuplicates(result, existingCards, existingQuestions) {
  const seenC = new Set(existingCards.map((c) => norm(c.front)));
  const seenQ = new Set(existingQuestions.map((q) => norm(q.question)));
  const fresh = { cards: [], questions: [] }; let dups = 0;
  for (const c of result.cards) { const k = norm(c.front); if (seenC.has(k)) dups++; else { seenC.add(k); fresh.cards.push(c); } }
  for (const q of result.questions) { const k = norm(q.question); if (seenQ.has(k)) dups++; else { seenQ.add(k); fresh.questions.push(q); } }
  return { ...fresh, dups };
}
