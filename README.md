# Esselunga MCP

Server MCP locale per cercare prodotti Esselunga, filtrare offerte e leggere o aggiornare il carrello. È scritto in TypeScript e comunica via `stdio`.

Il catalogo è interrogato in sola lettura. Il carrello usa una sessione HTTP locale rinnovata automaticamente; il server non può completare checkout o pagamento.

## Uso personale e privacy

Questo progetto è non ufficiale ed è pensato esclusivamente per uso personale e privato, sul proprio account Esselunga. Non è affiliato, approvato né supportato da Esselunga e non intende arrecare danno, offesa o pregiudizio a Esselunga, ai suoi servizi o ai suoi utenti. Usa esclusivamente dati e credenziali del proprietario dell'account, non raccoglie né condivide informazioni di terzi e non deve essere usato per aggirare controlli, limitazioni o misure di sicurezza del sito.

## Requisiti

- Windows
- Node.js 20 o successivo
- Google Chrome installato, solo per la configurazione iniziale della sessione

## Installazione

Apri PowerShell nella cartella del progetto:

```powershell
# dalla cartella in cui hai clonato il repository
npm install
Copy-Item .env.example .env
```

Il file `.env` è già escluso da Git. Non inserire né condividere password, cookie, token o il file della sessione.

## Configurazione iniziale: una sola volta

Esegui:

```powershell
npm run setup
```

Lo script apre Chrome e aspetta fino a dieci minuti. Nella finestra:

1. Accedi a Esselunga.
2. Completa l’eventuale verifica a due fattori.
3. Attendi la chiusura automatica della finestra.

Al termine viene creato `.esselunga-session.json`. Contiene i cookie rinnovabili della sessione e viene ignorato da Git.

Non devi copiare cookie dal browser né cambiare valori in `.env` durante il normale utilizzo.

Se Esselunga revoca la sessione o chiede una nuova verifica, ripeti `npm run setup`.

## Avvio del server

```powershell
npm start
```

Il processo aspetta le richieste MCP su standard input. Non scrivere messaggi aggiuntivi su standard output: è riservato al protocollo.

Per provare il server con MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector node_modules/tsx/dist/cli.mjs src/index.ts
```

Nella pagina di Inspector premi **Connect**, poi apri **Tools**.

## Strumenti MCP

### `server_status`

Mostra lo stato del server e delle integrazioni configurate.

### `search_products`

Cerca nel catalogo Esselunga. Esempio:

```json
{
  "query": "latte",
  "length": 10
}
```

Puoi filtrare un tipo di promozione:

```json
{
  "query": "latte",
  "promotion": "SCONTO FIDATY"
}
```

Il risultato include `code`, `productId`, prezzo, prezzo scontato, disponibilità e promozioni. Per aggiungere un prodotto al carrello serve il valore `code`, non `productId`.

### `get_cart`

Legge il carrello senza modificarlo. Restituisce `trolleyItemId`, `productCode`, quantità e descrizione degli articoli.

### `update_cart`

Modifica il carrello e richiede sempre `confirm: true` per eseguire l’azione. Prima puoi fare un’anteprima con `confirm: false`.

Aggiunta di un prodotto:

```json
{
  "action": "add",
  "productCode": "302050",
  "quantity": 1,
  "confirm": false
}
```

Ripeti la stessa richiesta con `"confirm": true` per applicarla.

Modifica quantità di una riga esistente:

```json
{
  "action": "set_quantity",
  "trolleyItemId": 123456,
  "quantity": 2,
  "confirm": true
}
```

Rimozione di una riga:

```json
{
  "action": "remove",
  "trolleyItemId": 123456,
  "confirm": true
}
```

`update_cart` gestisce prodotti confezionati standard. I prodotti a peso variabile o con opzioni obbligatorie vengono bloccati perché richiedono ulteriori dati.

### `start_auth_wizard` e `complete_auth_wizard`

Sono l’alternativa MCP a `npm run setup`. Usali in questa sequenza:

1. Chiama `start_auth_wizard`.
2. Completa il login manualmente nella finestra Chrome.
3. Chiama `complete_auth_wizard`.

## Gestione della sessione

Il server conserva la sessione HTTP in `.esselunga-session.json` e tenta il rinnovo SSO in automatico all’avvio e dopo una risposta `401`.

Il login iniziale non viene automatizzato con username e password perché Esselunga usa SSO, reCAPTCHA e può richiedere 2FA. Il wizard è necessario solo quando la sessione non è più rinnovabile.

## Limiti attuali

- Nessun checkout, pagamento o invio ordine.
- Le offerte richiedono una query di ricerca; l’elenco completo senza query non è implementato.
- Gli endpoint Esselunga sono interni e possono cambiare senza preavviso.

Vedi [docs/esselunga-api-study.md](docs/esselunga-api-study.md) per gli appunti tecnici sugli endpoint osservati.
