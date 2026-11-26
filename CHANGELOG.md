# Changelog

## Non pubblicato

### Aggiunto

- Aggiunta al carrello di prodotti a peso variabile tramite `productIntervalId`.
- Tool `get_product_details` per leggere intervalli di peso e attributi selezionabili.
- Foto prodotto nelle chat MCP compatibili: anteprime opzionali in `search_products` e tool `get_product_image`.
- Ricerca prodotti con sessione autenticata, per usare il listino del punto vendita associato all'account.
- Prezzi, sconti, promozioni e totale effettivi nel risultato di `get_cart`.
- Corrette le righe a peso variabile: prezzo pieno, prezzo scontato e sconto calcolato non dipendono dal campo checkout ambiguo `quantityAwarePrice`.
- Promozioni e disponibilità per riga in `get_cart`, ottenute dal dettaglio prodotto autenticato.
- `totalPromoDiscount` calcolato dalle differenze effettive di prezzo; aggiunto il valore grezzo del backend come `reportedPromoDiscount`.
- Corretto il calcolo dei prezzi di riga: gli articoli a pezzo moltiplicano il prezzo per la quantità, mentre quelli a peso mantengono il prezzo della pezzatura Esselunga.
- Valore normalizzato nelle promo a valore nullo: per una sola promo di riga viene esposto lo sconto calcolato negativo.
- Tool `get_delivery_slots` per consultare in sola lettura date, orari, prezzi e disponibilità di consegna/ritiro.

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
- Gli endpoint Esselunga sono interni e possono cambiare senza preavviso.
