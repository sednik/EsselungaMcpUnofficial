# Changelog

## 1.0.0 — 2026-11-25

Prima release del server MCP Esselunga.

### Aggiunto

- Ricerca prodotti nel catalogo Esselunga con paginazione.
- Filtro prodotti per promozione, inclusi `SCONTO FIDATY` e `PREZZI CORTI`.
- Lettura del carrello tramite sessione HTTP Esselunga.
- Aggiornamento del carrello: aggiunta di prodotti confezionati, modifica quantità e rimozione righe.
- Conferma esplicita `confirm: true` prima di ogni modifica al carrello.
- Rinnovo automatico della sessione SSO dopo una risposta `401`.
- Wizard di configurazione con `npm run setup` per creare la sessione iniziale senza copiare cookie manualmente.
- Documentazione di installazione, configurazione e uso MCP.

### Limiti noti

- Checkout, pagamento e invio ordini non sono supportati.
- I prodotti a peso variabile o con opzioni obbligatorie non possono essere modificati dal tool `update_cart`.
- Gli endpoint Esselunga sono interni e possono cambiare senza preavviso.
