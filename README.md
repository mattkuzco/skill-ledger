# Skill Ledger

App per imparare e annotare quello che studi: aree con un obiettivo, argomenti che passano da *In coda* a *Padroneggiato*, note in Markdown o **scritte a mano con la penna del tablet**, foto e PDF allegati, flashcard con ripetizione spaziata, quiz a scelta multipla, registro delle sessioni e check-in settimanale.

È una **PWA**: si apre nel browser e si installa come app su Windows, macOS, Linux, Android e iPhone. Funziona offline e, se colleghi Supabase, sincronizza i dati tra i dispositivi. Flashcard e quiz si possono scrivere a mano o generare dalle note con l'API di Anthropic.

Non ci sono dipendenze né build: è HTML, CSS e JavaScript (moduli ES). La cartella si pubblica così com'è.

---

## 1. Provarla sul computer

Serve un piccolo server locale (i moduli ES e il service worker non funzionano aprendo il file con doppio clic).

```bash
cd skill-ledger
python3 -m http.server 8080
# oppure: npx serve .
```

Apri <http://localhost:8080>. Da *Oggi* puoi premere **Carica esempi** per vedere l'app già piena.

## 2. Pubblicarla (per usarla dal telefono)

Per installarla su altri dispositivi deve stare su un indirizzo **https**. Due modi gratuiti:

**GitHub Pages**
1. Crea un repository e carica il contenuto della cartella.
2. Repository → *Settings* → *Pages* → *Deploy from a branch* → `main`, cartella `/ (root)`.
3. Dopo un minuto l'app è su `https://<utente>.github.io/<repo>/`.

**Netlify**
1. Vai su <https://app.netlify.com/drop>.
2. Trascina la cartella `skill-ledger`. Fine.

### Installarla
- **Chrome / Edge (PC, Mac, Android):** icona "Installa" nella barra degli indirizzi, oppure menu ⋮ → *Installa app*. C'è anche un pulsante in *Impostazioni*.
- **iPhone / iPad:** apri il sito in **Safari** → Condividi → *Aggiungi alla schermata Home*.

## 3. Collegare Supabase (sincronizzazione)

1. Crea un progetto gratuito su <https://supabase.com>.
2. Apri **SQL Editor**, incolla tutto il file [`supabase/schema.sql`](supabase/schema.sql) ed eseguilo. Crea la tabella `records` e il bucket privato `attachments` per foto e PDF, con le regole di sicurezza: ogni utente vede solo i propri dati. Se avevi già eseguito una versione precedente dello schema, rieseguilo: è sicuro farlo più volte.
3. **Project Settings → API**: copia *Project URL* e la chiave **anon public**.
4. Facoltativo ma comodo: in **Authentication**, nelle impostazioni del provider **Email**, disattiva *Confirm email*, così l'account è attivo subito. Se la lasci attiva, dopo "Crea account" conferma l'email e poi premi *Accedi*.
5. Nell'app: **Impostazioni → Sincronizzazione**, incolla URL e chiave, poi *Crea account* (la prima volta) o *Accedi*.
6. Sugli altri dispositivi ripeti il punto 5 con **lo stesso account**.

Come funziona:
- Tutto viene salvato prima sul dispositivo (IndexedDB), quindi l'app funziona anche offline.
- La sincronizzazione parte da sola: all'apertura, quando torni online, qualche secondo dopo ogni modifica e ogni 5 minuti. C'è anche *Sincronizza ora*.
- Se lo stesso elemento viene modificato su due dispositivi, **vince la modifica più recente**. Il server rifiuta comunque le versioni più vecchie di quella che ha già.
- Al primo accesso i dati già presenti sul dispositivo vengono caricati sull'account.
- Foto e PDF vanno su Supabase Storage (piano gratuito: 1 GB). Sugli altri dispositivi vengono scaricati la prima volta che apri la nota, poi restano disponibili anche offline. Le foto vengono ridimensionate (lato lungo 2200 px) prima del salvataggio; i PDF possono pesare fino a 20 MB.

La chiave *anon* può stare nel browser: senza login non dà accesso a nessun dato, grazie alle regole RLS.

## 4. Il Quaderno: un foglio infinito per ogni argomento

Ogni argomento ha il suo **Quaderno**, come una pagina di OneNote senza bordi. Lo apri dal riquadro grande **"Apri il quaderno"** in cima all'argomento, oppure dall'icona della penna in basso a destra su ogni scheda argomento nell'area.

- **Scrivi** con la penna (pressione), l'evidenziatore o il mouse. **Gomma**, oppure tieni premuto il tasto laterale della penna.
- **Spostati:** con un dito (dopo che l'app ha visto la penna), con lo strumento *Sposta*, con la rotella del mouse o tenendo premuta la barra spaziatrice.
- **Zoom:** due dita, Ctrl + rotella, i pulsanti − e +. Il pulsante con la percentuale mostra tutto il contenuto.
- **Foto:** *Foto* inserisce un'immagine (fotocamera o galleria) al centro dello schermo. Con *Seleziona* la trascini, la ridimensioni dall'angolo e la elimini. Puoi anche incollarla o trascinarla sul foglio.
- **Sfondo** a quadretti, righe, puntini o bianco.
- **✦ Trascrivi** trasforma tutto il quaderno in una nota di testo ("Trascrizione del quaderno"), che puoi correggere. **✦ Flashcard e quiz** li crea direttamente dagli appunti a mano.
- Il salvataggio è automatico. I tratti sono salvati a riquadri, così la sincronizzazione è leggera. Se scrivi sullo stesso quaderno da due dispositivi non si perde niente, e le modifiche dell'altro dispositivo compaiono anche con il quaderno aperto.

## 4b. Note di testo, foto e PDF

In ogni argomento, scheda *Note*, ci sono **Nota di testo** e **Foto degli appunti**. Le vecchie note a pagine scritte a mano restano apribili, ma per scrivere a mano ora c'è il Quaderno.

**Scrivere a mano (tablet con penna)**
- Penna sensibile alla pressione, evidenziatore, gomma (anche il tasto gomma della penna, se ce l'ha), 5 colori e 3 spessori.
- Annulla e ripeti, anche con `Ctrl+Z` / `Ctrl+Shift+Z` su tastiera.
- Carta a righe, quadretti, puntini o bianca; *+ Aggiungi pagina* in fondo.
- **Rifiuto del palmo:** appena l'app vede la penna, il dito smette di scrivere e serve solo a scorrere, così puoi appoggiare la mano. Il pulsante *Dito: scrive / scorre* cambia il comportamento, per esempio su un tablet senza penna.
- Il salvataggio è automatico. I tratti sono vettoriali (leggeri da sincronizzare) e restano nitidi a ogni dimensione dello schermo.
- **Tasto laterale della penna:** tienilo premuto mentre scrivi per cancellare al volo, senza cambiare strumento.
- Durante la scrittura il menu laterale sparisce, così la pagina usa tutta la larghezza. Si torna indietro con la freccia in alto.
- Le pagine lontane dallo schermo vengono scaricate dalla memoria e ridisegnate quando ci torni, quindi anche un quaderno lungo resta fluido.

**Su un tablet Android (per esempio Lenovo Idea Tab Pro con Tab Pen Plus)**
1. Apri l'app in **Chrome** (non nel browser Lenovo) e accetta *Installa app*, oppure menu ⋮ → *Aggiungi a schermata Home* → *Installa*.
2. Aprila dall'icona: parte a schermo intero, senza barra degli indirizzi.
3. Il primo tratto con la penna attiva il rifiuto del palmo. Se preferisci scrivere col dito, premi *Dito: scorre* per cambiarlo.

**Allegare appunti di carta**
- *Foto degli appunti* crea una nota con le foto scelte; sul telefono o tablet apre la fotocamera o la galleria.
- Dentro qualsiasi nota: *Scatta foto*, *Allega file* (immagini e PDF), oppure trascina i file o incollali con `Ctrl+V`.
- Tocca un allegato per vederlo a schermo intero, scorrere gli altri o eliminarlo.

**Con l'AI (serve la chiave, vedi sotto)**
- **✦ Trascrivi** converte in testo le pagine scritte a mano e le foto degli appunti. Il testo compare sotto la nota, si può correggere e rende la nota leggibile ovunque.
- **✦ Crea flashcard e quiz** legge anche le pagine a mano, le foto e i PDF, non solo il testo. Se una nota a mano ha già la trascrizione, usa quella: costa meno.

## 5. Generare flashcard e quiz con l'AI

1. Crea una chiave su <https://console.anthropic.com> → *API Keys* (serve credito sull'account).
2. **Impostazioni → Generazione con AI**: incolla la chiave. Il modello predefinito è `claude-sonnet-5` e puoi cambiarlo.
3. In un argomento, scheda *Flashcard* o *Quiz* → **✦ Genera con AI**, oppure dentro una nota → **✦ Crea flashcard e quiz**.
4. Scegli le note da usare e quante carte e domande vuoi, poi seleziona cosa tenere.

La chiave resta **solo su quel dispositivo**: non viene sincronizzata né esportata. Il browser la invia direttamente ad Anthropic. Per un'app personale va bene; se un giorno la condividi con altri, sposta la chiamata in una *Supabase Edge Function* così la chiave non è nel browser.

## 6. Come si usa

| Sezione | Cosa fa |
|---|---|
| **Oggi** | Flashcard e argomenti da ripassare, ultime note, minuti degli ultimi 7 giorni |
| **Aree** | Una scheda per area con obiettivo e avanzamento. Dentro, gli argomenti su 4 colonne (→ per avanzare) |
| **Argomento** | Schede *Note*, *Flashcard*, *Quiz*. Note di testo in Markdown, note scritte a mano, foto e PDF |
| **Studia** | Ripasso programmato (solo le carte in scadenza), ripasso libero e quiz, su tutto o su un'area o argomento |
| **Registro** | Sessioni di studio, grafico di 2 settimane, minuti per area, check-in settimanale |
| **Impostazioni** | Sincronizzazione, chiave AI, backup JSON, tema chiaro/scuro, installazione |

**Scorciatoie da tastiera nel ripasso:** `Spazio` gira la carta, `1`–`4` = Di nuovo / Difficile / Bene / Facile. **Nel quiz:** `1`–`4` scelgono la risposta, `Invio` passa alla prossima.

**Ripetizione spaziata.** Le flashcard usano una versione semplificata di SM-2: ogni carta ha una "facilità" che cresce se la sai e cala se la sbagli, e l'intervallo si moltiplica a ogni ripasso riuscito. Sotto ogni pulsante vedi dopo quanto tornerà la carta. Gli argomenti usano la scala fissa 1, 3, 7, 14, 30, 60, 120 giorni.

## 7. Modificare l'app

```
index.html            struttura dell'app (barra laterale, tab bar mobile)
styles.css            stile; i colori sono variabili in :root (tema chiaro e scuro)
sw.js                 service worker (cache offline)
manifest.webmanifest  nome, icone e colori per l'installazione
js/app.js             avvio, router, gestione eventi
js/store.js           archivio locale (IndexedDB), export/import
js/sync.js            sincronizzazione con Supabase via REST
js/srs.js             ripetizione spaziata
js/ai.js              generazione e trascrizione con l'API Anthropic
js/board.js           il Quaderno infinito (pan, zoom, penna, gomma, foto, riquadri)
js/ink.js             disegno dei tratti e vecchie note a pagine
js/attachments.js     foto e PDF: compressione, galleria, visualizzatore
js/md.js              renderer Markdown sicuro (niente HTML dalle note)
js/views/*.js         le schermate
supabase/schema.sql   tabella, trigger e regole di sicurezza
```

**Dopo ogni modifica** aumenta `VERSION` in `sw.js` (es. `'v2'`), altrimenti le app già installate continuano a usare i file in cache. Si aggiornano alla successiva apertura.

**Modello dati.** Ogni elemento è un record `{ id, kind, updated_at, deleted, ...campi }` con `kind` tra `area`, `topic`, `note`, `card`, `question`, `attempt`, `session`, `checkin`, `attachment`. Le note a mano hanno `type: 'ink'` e i tratti in `ink.pages[].s[]` (coordinate su una pagina logica di 1000×1414). I file degli allegati stanno in IndexedDB (store `blobs`) e su Supabase Storage in `attachments/<id utente>/<id allegato>`. Sul server è una sola tabella con i campi in `data` (JSON), quindi per aggiungere un campo nuovo non serve toccare Supabase.
