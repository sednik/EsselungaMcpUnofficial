# Studio API Esselunga Spesa Online

Aggiornato: 2026-11-25

## Quadro iniziale

Non ho trovato documentazione ufficiale per sviluppatori né uno schema OpenAPI pubblico. Il sito `spesaonline.esselunga.it` è una SPA Angular; le chiamate elencate qui sotto sono state ricavate dal bundle frontend `ng-app/shell.min.js` (revisione `b20261013547`). Sono endpoint interni del sito, quindi possono cambiare e non sono un contratto stabile.

Fonti osservate:

- [Spesa Online Esselunga](https://spesaonline.esselunga.it/commerce/nav/supermercato/)
- [FAQ Esselunga](https://www.esselunga.it/it-it/servizio-clienti/faq.html)

## Ricerca prodotto: richiesta e risposta osservate

La richiesta usata dal sito per cercare `latte` è:

```json
{
  "query": "latte",
  "start": 0,
  "length": 20,
  "isLargeQuerySearch": true,
  "filters": [],
  "rmtCookieAllowed": false
}
```

L'endpoint è `POST /commerce/resources/search/facet`. La risposta ha `displayables.entities` con i prodotti, `displayables.rowCount` col totale e `displayables.range` con i limiti della pagina. Tra i campi prodotto utili: `productId`, `code`, `description`, `brand`, `price`, `discountedPrice`, `label`, `unitText`, `unitValue`, `outOfStock`, `promotionsDetail`, `imageURL` e `canBeAddedToShoppingList`. I filtri sono sotto `filterManagers`.

Il tool MCP `search_products` usa questo schema e riduce i risultati a campi prodotto essenziali. Una ripetizione anonima della richiesta con `X-PAGE-PATH: drive` ha restituito HTTP 200 e gli stessi campi `displayables.entities`, quindi la ricerca pubblica non ha bisogno del cookie. Il cookie è facoltativo e serve solo per eventuali funzioni personalizzate autenticate. L'implementazione non restituisce né registra cookie o token.

## Filtro promozione

Dal browser è stato acquisito questo corpo per filtrare `SCONTO FIDATY`:

```json
{
  "query": "latte",
  "start": 0,
  "length": 20,
  "isLargeQuerySearch": false,
  "filters": [{"type": "MSF_PROMO", "ids": ["SCONTO FIDATY"]}],
  "rmtCookieAllowed": true
}
```

La stessa ricerca con `rmtCookieAllowed: false` ha restituito HTTP 200 e 17 prodotti, tutti con `promotionsDetail` valorizzato. Senza testo di ricerca (query vuota o spazio) l'endpoint ha risposto HTTP 204: non è sufficiente per costruire un elenco generale di offerte.

Il tool MCP `search_products` ora accetta un parametro facoltativo `promotion`; in presenza del filtro invia `isLargeQuerySearch: false` e un filtro `MSF_PROMO`. Mantiene `rmtCookieAllowed: false` per non abilitare il tracciamento retail media.

Confronto della query `latte`, `start: 0`, `length: 20`: struttura JSON uguale, ma i dati non coincidono. La risposta loggata aveva `rowCount: 314`, quella anonima `rowCount: 346`; 13 ID prodotto erano comuni nella prima pagina e 10 avevano gli stessi prezzi. Su tre prodotti comuni il prezzo differiva (Parmalat 1 L: 1,69 vs 1,99; Zymil 500 ml: 0,99 vs 1,19; Granarolo Accadì 1 L: 1,69 vs 2,29). Questo mostra una differenza di contesto/sessione, ma da solo non stabilisce se dipenda dal login o dal negozio/area associata.

## Altri endpoint individuati nel frontend

| Area | Metodo e percorso | Stato iniziale |
|---|---|---|
| Menu/categorie | `GET /commerce/resources/menu/{id}` | Il frontend lo usa per caricare una voce di menu. Richiede contesto pagina. |
| Dettaglio prodotto | `GET /commerce/resources/displayable/detail/code/{productId}` | Percorso di dettaglio prodotto presente nel frontend. |
| Carrello | `GET /commerce/resources/auth/trolley` | Autenticato; una richiesta anonima ha restituito HTTP 401. |
| Modifica carrello | `POST /commerce/resources/auth/trolley/item` | Il frontend invia una struttura prodotto/quantità; schema da ricostruire. |
| Svuota carrello | `DELETE /commerce/resources/auth/trolley/item` | Presente nel frontend; non provato. |
| Promozioni account | `GET /commerce/resources/auth/promotions` | Autenticato. |
| Coupon account | `GET /commerce/resources/auth/promotions/coupon` | Autenticato. |
| Promozioni MUI | `GET /commerce/resources/auth/promotion/mui/v1/{id}/allPromo` | Autenticato; richiede anche header `x-cardcode`. |
| Selezione negozio consegna | `PUT /commerce/resources/auth/checkout/deliverystore` | Il bundle invia `deliveryStorePhysicalCode` e `deliveryStoreCompany`; autenticato. È un indizio che il contesto del punto vendita può influire sui dati. |

## Lettura carrello

La risposta osservata dal browser contiene `storeId`, `totalQuantity`, `trolleyItems` e `deletedItems`. Ogni articolo espone identificativo riga/prodotto, codice prodotto, descrizione, marca, quantità, tipo e un eventuale `productInterval` con unità e rapporto peso/quantità. La risposta contiene identificativi e contenuto del carrello, quindi nel repository è documentata solo la forma dei campi, senza valori personali.

Il server MCP espone `get_cart`, che legge `GET /commerce/resources/auth/trolley` usando `ESSELUNGA_COOKIE` dal `.env` locale. La tool riduce la risposta ai campi utili e non modifica il carrello. Non è stata provata con la sessione dell'utente.

La sessione HTTP esportata dal browser ha ricevuto HTTP 401 anche con il cookie e il token XSRF della richiesta; `open_browser_session` crea quindi un profilo Chrome locale `.esselunga-browser` ignorato da Git, e `get_cart` esegue la stessa chiamata dal browser già autenticato. Il profilo e i cookie restano in locale.

Il profilo può essere riutilizzato senza finestra con `ESSELUNGA_BROWSER_HEADLESS=true`. Il frontend configura il login tramite l’URL SSO `https://spesaonline.esselunga.it/commerce/login/spesaonline` e dichiara reCAPTCHA v3; la FAQ ufficiale indica inoltre che può essere richiesta una verifica in due passaggi. Il server non prova a bypassare queste verifiche: alla loro richiesta, il profilo va riaperto temporaneamente in modalità visibile per l’accesso manuale.

## Login HTTP del sito

Il percorso `GET /commerce/login/spesaonline` reindirizza a `https://account.esselunga.it/area-utenti/applicationCheck` con `appName=spesaOnLine`, `daru` e `loginType=light`. La pagina di login invia un form `POST /area-utenti/loginExt` con i campi `username`, `password`, `daru`, `dare`, `appName`, `rememberme` e `login-recaptcha-v3-response`. Il token reCAPTCHA è richiesto dal sito per la creazione della sessione; non viene generato né aggirato dal server MCP.

Il cookie SSO di tipo “remember me” consente però un rinnovo silenzioso: il client HTTP ha seguito il redirect SSO, ricevuto una nuova coppia `JSESSIONID` e `XSRF-ECOM-TOKEN`, quindi letto `GET /commerce/resources/auth/trolley` con HTTP 200 senza browser. Il modulo `esselunga-session.ts` conserva i cookie aggiornati in `.esselunga-session.json` e, dopo un HTTP 401, ripete automaticamente il rinnovo SSO.

## Modifica carrello

Il frontend aggiunge o aggiorna una quantità con `POST /commerce/resources/auth/trolley/item`, inviando almeno `productId`, `quantity`, `productIntervalId`, `productAttributeIds`, `productOrigin` e `forced`. Rimuove una riga con `DELETE /commerce/resources/auth/trolley/item/{trolleyItemId}`.

Il tool `update_cart` esegue queste chiamate dalla sessione HTTP rinnovata e richiede `confirm: true`. Supporta `add` tramite il `code` restituito da `search_products`, `set_quantity` e `remove` tramite il `trolleyItemId` restituito da `get_cart`. Per i prodotti a peso variabile sceglie l’unico intervallo disponibile oppure richiede esplicitamente `productIntervalId`, ottenibile da `get_product_details`; gli eventuali attributi selezionati possono essere passati come `productAttributeIds`. Non chiama nessun endpoint di checkout.

## Contesto pagina

Il bundle frontend imposta `X-PAGE-PATH` dal percorso della pagina di navigazione corrente. Una richiesta anonima a `GET /commerce/resources/menu/600000001047181` ha restituito HTTP 401 chiedendo quell'header. Un valore indovinato ha dato "Page non trovata": il valore corretto va preso dalla richiesta riuscita del browser.

La richiesta anonima a `GET /commerce/resources/auth/trolley` ha restituito HTTP 401.

## Prossime verifiche

1. Il percorso pagina pubblico è configurato come `drive`; provare `search_products` con una query e confrontare totale, prezzi e paginazione con la risposta del browser.
2. Studiare i filtri promozione (`filterManagers` contiene `promozioni`) e verificare se la ricerca filtrata fornisce l'elenco offerte desiderato.
3. Solo dopo analizzare il carrello autenticato. Le prime prove di modifica devono limitarsi a un prodotto e non procedere a checkout o conferma ordini.
