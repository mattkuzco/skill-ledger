// Anthropic API: generate flashcards and quiz questions, transcribe handwriting.
// The API key stays on this device (meta store) and is never synced.
// Media (photos, handwritten pages, PDFs) are sent as base64 content blocks.

import * as store from './store.js';

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const aiConfig = () => store.getMeta('ai', { apiKey: '', model: DEFAULT_MODEL });
export const hasKey = () => !!aiConfig().apiKey;

const SYSTEM = `Sei un tutor che prepara materiale di ripasso a partire dagli appunti di uno studente.
Gli appunti possono essere testo, foto o pagine scritte a mano, o PDF: leggili tutti.
Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questa forma:
{"flashcards":[{"front":"...","back":"..."}],
 "questions":[{"question":"...","options":["...","...","...","..."],"answer":0,"explanation":"..."}]}
Regole:
- Scrivi nella stessa lingua degli appunti.
- Flashcard: il fronte è una domanda o un concetto preciso, il retro una risposta breve (massimo 2 frasi).
- Quiz: esattamente 4 opzioni plausibili, una sola corretta; "answer" è l'indice (0-3) di quella corretta; varia la posizione della risposta corretta; "explanation" spiega in una frase perché è corretta.
- Copri le idee più importanti, evita domande banali o duplicate, non inventare fatti che non sono negli appunti.`;

const TRANSCRIBE = `Trascrivi fedelmente gli appunti scritti a mano (o fotografati) nelle immagini in Markdown.
- Mantieni la lingua originale e l'ordine delle pagine.
- Usa # per i titoli, - per gli elenchi, **grassetto** per ciò che è sottolineato o evidenziato.
- Formule: scrivile in testo semplice o in \`codice\`. Diagrammi o disegni: descrivili in una riga tra parentesi quadre, es. [schema: grafo con nodi A, B, C].
- Se una parola è illeggibile scrivi [?].
- Rispondi solo con la trascrizione, senza commenti.`;

function extractJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('La risposta non contiene JSON.');
  return JSON.parse(body.slice(start, end + 1));
}

function clean(out) {
  const flashcards = (Array.isArray(out.flashcards) ? out.flashcards : [])
    .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string' && c.front.trim() && c.back.trim())
    .map((c) => ({ front: c.front.trim(), back: c.back.trim() }));
  const questions = (Array.isArray(out.questions) ? out.questions : [])
    .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length >= 2
      && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length)
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => String(o).trim()),
      answer: q.answer,
      explanation: String(q.explanation || '').trim(),
    }));
  return { flashcards, questions };
}

// media: [{ type: 'image' | 'document', media_type, data (base64), label? }]
function mediaBlocks(media = []) {
  const blocks = [];
  for (const m of media) {
    if (m.label) blocks.push({ type: 'text', text: m.label });
    blocks.push({ type: m.type, source: { type: 'base64', media_type: m.media_type, data: m.data } });
  }
  return blocks;
}

async function call({ system, content, maxTokens = 4096, signal }) {
  const { apiKey, model } = aiConfig();
  if (!apiKey) throw new Error('Aggiungi la tua chiave API Anthropic nelle Impostazioni.');
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: model || DEFAULT_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Impossibile contattare l\'API Anthropic. Controlla la connessione.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || `Errore ${res.status}`;
    if (res.status === 401) throw new Error('Chiave API non valida. Controllala nelle Impostazioni.');
    if (res.status === 404) throw new Error(`Modello non trovato (${model}). Cambialo nelle Impostazioni.`);
    if (res.status === 413) throw new Error('Troppi allegati o file troppo grandi. Seleziona meno note.');
    if (res.status === 429) throw new Error('Troppe richieste o credito esaurito. Riprova tra poco.');
    throw new Error(msg);
  }
  return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export async function generate({ material, media = [], topicTitle, nCards, nQuestions, signal }) {
  const text = `Argomento: ${topicTitle || 'senza titolo'}
Crea ${nCards} flashcard e ${nQuestions} domande a scelta multipla${nCards === 0 ? ' (nessuna flashcard)' : ''}${nQuestions === 0 ? ' (nessuna domanda)' : ''}.
${media.length ? `Ci sono anche ${media.length} allegati (immagini o PDF) qui sopra: fanno parte degli appunti.\n` : ''}
<appunti>
${material || '(solo allegati)'}
</appunti>`;
  const out = await call({ system: SYSTEM, content: [...mediaBlocks(media), { type: 'text', text }], signal });
  let parsed;
  try { parsed = extractJson(out); } catch { throw new Error('La risposta dell\'AI non era nel formato atteso. Riprova.'); }
  return clean(parsed);
}

export async function transcribe({ media, signal }) {
  if (!media.length) throw new Error('Non c\'è niente da trascrivere.');
  const out = await call({ system: TRANSCRIBE, content: [...mediaBlocks(media), { type: 'text', text: 'Trascrivi.' }], maxTokens: 8000, signal });
  return out.trim();
}

/* ---------- helpers to turn blobs into media blocks ---------- */
const MAX_API_SIDE = 1568;
export async function imageToMedia(blob, label) {
  // Downscale for the API: large images cost more and don't read better.
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_API_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const small = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { type: 'image', media_type: 'image/jpeg', data: await store.blobToBase64(small), label };
}
export async function pdfToMedia(blob, label) {
  return { type: 'document', media_type: 'application/pdf', data: await store.blobToBase64(blob), label };
}
