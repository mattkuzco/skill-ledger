// Example data so a new user can see how everything fits together.
import * as store from './store.js';
import { uid, today, addDays } from './util.js';
import { newCardSrs } from './srs.js';

export async function loadSample() {
  const t0 = today();
  const A1 = uid(), A2 = uid();
  await store.putMany('area', [
    { id: A1, name: 'Shader (esempio)', goal: 'Scrivere shader d\'acqua stilizzata e toon shading in Godot', color: 'cobalt', status: 'active', order: 1, created: addDays(t0, -8), example: true },
    { id: A2, name: 'Algoritmi (esempio)', goal: 'Risolvere con sicurezza problemi medi su grafi e programmazione dinamica all\'esame', color: 'amber', status: 'active', order: 2, created: addDays(t0, -8), example: true },
  ]);

  const T = { uv: uid(), noise: uid(), vf: uid(), toon: uid(), dij: uid(), dp: uid(), uf: uid(), bigo: uid() };
  await store.putMany('topic', [
    { id: T.vf, areaId: A1, title: 'Vertex e fragment shader', stage: 'mastered', confidence: 5, resource: 'https://thebookofshaders.com', nextReview: addDays(t0, 22), reviewStep: 4 },
    { id: T.uv, areaId: A1, title: 'UV e campionamento delle texture', stage: 'practicing', confidence: 3, resource: 'https://thebookofshaders.com', nextReview: t0, reviewStep: 2 },
    { id: T.noise, areaId: A1, title: 'Funzioni di rumore (value, Perlin)', stage: 'learning', confidence: 2, resource: '', nextReview: addDays(t0, 1), reviewStep: 0 },
    { id: T.toon, areaId: A1, title: 'Toon shading con ramp texture', stage: 'queued', confidence: 1, resource: '', nextReview: '', reviewStep: 0 },
    { id: T.dij, areaId: A2, title: 'Algoritmo di Dijkstra', stage: 'practicing', confidence: 3, resource: 'CLRS cap. 22', nextReview: addDays(t0, -1), reviewStep: 1 },
    { id: T.dp, areaId: A2, title: 'Programmazione dinamica: memoization e tabulation', stage: 'learning', confidence: 2, resource: '', nextReview: t0, reviewStep: 0 },
    { id: T.uf, areaId: A2, title: 'Union-Find', stage: 'queued', confidence: 1, resource: '', nextReview: '', reviewStep: 0 },
    { id: T.bigo, areaId: A2, title: 'Complessità delle operazioni comuni', stage: 'mastered', confidence: 4, resource: '', nextReview: addDays(t0, 14), reviewStep: 3 },
  ]);

  await store.putMany('note', [
    { topicId: T.dij, title: 'Idea di base', body: `# Dijkstra\n\nTrova i **cammini minimi** da una sorgente in un grafo con pesi **non negativi**.\n\n- Tiene una coda di priorità ordinata per distanza provvisoria\n- Estrae sempre il nodo più vicino non ancora fissato\n- *Rilassa* gli archi uscenti: se \`d[u] + w(u,v) < d[v]\` aggiorna \`d[v]\`\n\n> Con pesi negativi non funziona: serve Bellman-Ford.\n\nComplessità con heap binario: \`O((V + E) log V)\`.` },
    { topicId: T.uv, title: 'Coordinate UV', body: `Le **UV** mappano ogni vertice a un punto della texture, in \`[0, 1]\`.\n\n\`\`\`glsl\nvoid fragment() {\n  vec2 uv = UV + vec2(TIME * 0.05, 0.0);\n  ALBEDO = texture(TEXTURE, uv).rgb;\n}\n\`\`\`\n\nSpostare le UV nel tempo fa "scorrere" la texture: base per l'acqua.` },
    { topicId: T.dp, title: 'Top-down vs bottom-up', body: `- **Memoization** (top-down): ricorsione + cache dei risultati\n- **Tabulation** (bottom-up): riempio una tabella dai casi base in su\n\nStessa complessità di solito; la tabulation evita lo stack della ricorsione.` },
  ].map((n) => ({ ...n, created: t0 })));

  const card = (topicId, areaId, front, back, due) => ({ topicId, areaId, front, back, created: t0, srs: { ...newCardSrs(), due: due ?? t0 } });
  await store.putMany('card', [
    card(T.dij, A2, 'Quale vincolo sui pesi richiede Dijkstra?', 'Pesi non negativi. Con pesi negativi serve Bellman-Ford.'),
    card(T.dij, A2, 'Complessità di Dijkstra con heap binario?', 'O((V + E) log V).'),
    card(T.dij, A2, 'Cosa significa "rilassare" un arco (u, v)?', 'Se d[u] + w(u,v) < d[v], aggiorno d[v] e il predecessore di v.'),
    card(T.uv, A1, 'In che intervallo stanno le coordinate UV?', 'Da 0 a 1 su entrambi gli assi.'),
    card(T.uv, A1, 'Come fai scorrere una texture nel tempo?', 'Aggiungi alle UV un offset proporzionale a TIME.'),
    card(T.dp, A2, 'Differenza tra memoization e tabulation?', 'Memoization: ricorsione top-down con cache. Tabulation: tabella riempita bottom-up dai casi base.', addDays(t0, 2)),
    card(T.bigo, A2, 'Costo medio di una ricerca in una hash table?', 'O(1) in media, O(n) nel caso peggiore.', addDays(t0, 10)),
  ]);

  const q = (topicId, areaId, question, options, answer, explanation) => ({ topicId, areaId, question, options, answer, explanation, created: t0 });
  await store.putMany('question', [
    q(T.dij, A2, 'Quale struttura dati rende efficiente Dijkstra?', ['Coda di priorità (heap)', 'Pila', 'Coda FIFO', 'Lista concatenata'], 0, 'Serve estrarre ogni volta il nodo con distanza minima.'),
    q(T.dij, A2, 'Su quale grafo Dijkstra può dare risultati sbagliati?', ['Grafo non orientato', 'Grafo con archi di peso negativo', 'Grafo denso', 'Grafo aciclico'], 1, 'Un arco negativo può migliorare un nodo già fissato.'),
    q(T.dp, A2, 'Quale approccio evita la ricorsione?', ['Memoization', 'Divide et impera', 'Tabulation', 'Backtracking'], 2, 'La tabulation riempie una tabella in modo iterativo dai casi base.'),
    q(T.uv, A1, 'Cosa succede se sommi 0.5 alla coordinata U?', ['La texture si scurisce', 'La texture si sposta di mezza larghezza', 'La texture ruota di 90°', 'Nulla'], 1, 'Le UV sono normalizzate: 0.5 è metà della texture.'),
    q(T.bigo, A2, 'Complessità della ricerca binaria su un array ordinato?', ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'], 1, 'Ogni passo dimezza l\'intervallo di ricerca.'),
  ]);

  await store.putMany('session', [
    { date: addDays(t0, -3), minutes: 45, areaId: A1, topicId: T.uv, note: 'The Book of Shaders cap. 5–6' },
    { date: addDays(t0, -2), minutes: 60, areaId: A2, topicId: T.dij, note: 'Dijkstra a mano su 3 grafi' },
    { date: addDays(t0, -1), minutes: 30, areaId: A1, topicId: T.noise, note: 'Esperimenti con il rumore in Godot' },
  ]);
}
