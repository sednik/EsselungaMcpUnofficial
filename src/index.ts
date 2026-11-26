import 'dotenv/config';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { chromium, type BrowserContext, type Page } from 'playwright';
import * as z from 'zod/v4';
import { EsselungaSession } from './esselunga-session.js';

const ORIGIN = 'https://spesaonline.esselunga.it';
const LOGIN_URL = `${ORIGIN}/commerce/login/spesaonline`;
const pagePath = process.env.ESSELUNGA_PAGE_PATH;
const cookie = process.env.ESSELUNGA_COOKIE;
const browserProfileDir = path.resolve(process.cwd(), process.env.ESSELUNGA_BROWSER_PROFILE_DIR || '.esselunga-browser');
const browserHeadless = process.env.ESSELUNGA_BROWSER_HEADLESS === 'true';
const sessionStateFile = path.resolve(process.cwd(), process.env.ESSELUNGA_SESSION_FILE || '.esselunga-session.json');
const session = new EsselungaSession(sessionStateFile, cookie);
const configured = Boolean(pagePath);
let browserContext: BrowserContext | undefined;
let browserPage: Page | undefined;
let browserIsHeadless: boolean | undefined;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function intervalCandidates(product: JsonObject): JsonObject[] {
  const candidates = [
    product.productInterval,
    ...(Array.isArray(product.productIntervals) ? product.productIntervals : []),
    ...(Array.isArray(product.intervals) ? product.intervals : []),
  ];
  return candidates.map(asObject).filter((value): value is JsonObject => Boolean(value));
}

function attributeIds(product: JsonObject): number[] {
  return (Array.isArray(product.attributes) ? product.attributes : [])
    .map(asObject)
    .map((attribute) => attribute?.productAttributeId ?? attribute?.id)
    .filter((id): id is number => typeof id === 'number');
}

function publicProduct(product: JsonObject): JsonObject {
  const intervals = intervalCandidates(product).map((interval) => ({
    id: interval.id,
    value: interval.value,
    ratio: interval.ratio,
    ums: interval.ums,
  }));
  return {
    productId: product.productId ?? product.id,
    code: product.code,
    description: product.description,
    brand: product.brand,
    price: product.price,
    discountedPrice: product.discountedPrice,
    label: product.label,
    unitText: product.unitText,
    unitValue: product.unitValue,
    outOfStock: product.outOfStock,
    variableWeight: product.variableWeight === true,
    productIntervals: intervals,
    productAttributeIds: attributeIds(product),
    promotions: product.promotionsDetail,
    imageURL: product.imageURL,
    canBeAddedToShoppingList: product.canBeAddedToShoppingList,
  };
}

function imageUrlIsAllowed(imageURL: string): boolean {
  try {
    const url = new URL(imageURL);
    return url.protocol === 'https:' && (url.hostname === 'esselunga.it' || url.hostname.endsWith('.esselunga.it'));
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function getBrowserPage(headless = browserHeadless): Promise<Page> {
  if (browserContext && browserIsHeadless !== headless) {
    await browserContext.close();
    browserContext = undefined;
    browserPage = undefined;
  }
  if (!browserContext) {
    browserContext = await chromium.launchPersistentContext(browserProfileDir, {
      channel: 'chrome',
      headless,
      viewport: { width: 1280, height: 900 },
    });
    browserIsHeadless = headless;
  }
  browserPage = browserPage && !browserPage.isClosed() ? browserPage : browserContext.pages()[0] ?? await browserContext.newPage();
  if (browserPage.url() === 'about:blank') {
    await browserPage.goto(`${ORIGIN}/commerce/nav/supermercato/`, { waitUntil: 'domcontentloaded' });
  }
  return browserPage;
}

async function requestJson(path: string, init: RequestInit = {}): Promise<{ status: number; payload: unknown }> {
  const response = await session.fetch(path, init);
  const text = await response.text();
  try {
    return { status: response.status, payload: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, payload: text };
  }
}

const server = new McpServer({ name: 'esselunga-mcp', version: '1.0.0' });

server.registerTool(
  'server_status',
  {
    title: 'Stato del server Esselunga',
    description: 'Mostra lo stato del server MCP e della configurazione locale Esselunga.',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        server: 'esselunga-mcp',
        status: 'running',
        catalogSearch: configured ? 'configured' : 'needs_local_session_config',
        offers: pagePath ? 'available_as_product_search_filter' : 'needs_page_path',
        cart: 'available_via_persistent_http_session',
      }, null, 2),
    }],
  }),
);

server.registerTool(
  'search_products',
  {
    title: 'Cerca prodotti Esselunga',
    description: 'Cerca nel catalogo Esselunga; puoi filtrare per una promozione. Operazione di sola lettura.',
    inputSchema: {
      query: z.string().trim().min(1).describe('Testo da cercare, per esempio latte'),
      start: z.number().int().min(0).default(0).describe('Indice del primo risultato'),
      length: z.number().int().min(1).max(50).default(20).describe('Numero massimo di risultati'),
      promotion: z.string().trim().min(1).optional().describe('Filtro promozione, per esempio SCONTO FIDATY o PREZZI CORTI'),
      includeImages: z.boolean().default(false).describe('Se true, allega fino a quattro foto prodotto alla risposta per le chat che visualizzano immagini MCP'),
    },
  },
  async ({ query, start, length, promotion, includeImages }) => {
    if (!pagePath) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'Configura ESSELUNGA_PAGE_PATH nel file .env locale.',
        }],
      };
    }

    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      origin: ORIGIN,
      referer: `${ORIGIN}/commerce/nav/supermercato/`,
      'x-page-path': pagePath,
    };
    const body = JSON.stringify({
      query,
      start,
      length,
      isLargeQuerySearch: !promotion,
      filters: promotion ? [{ type: 'MSF_PROMO', ids: [promotion] }] : [],
      rmtCookieAllowed: false,
    });

    let searchResult: { status: number; payload: unknown };
    let priceContext: 'authenticated_store' | 'public_fallback';
    try {
      searchResult = await requestJson('/commerce/resources/search/facet', { method: 'POST', headers, body });
      priceContext = 'authenticated_store';
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('Manca una sessione iniziale')) throw error;
      const response = await fetch(`${ORIGIN}/commerce/resources/search/facet`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const responseText = await response.text();
      searchResult = {
        status: response.status,
        payload: responseText ? JSON.parse(responseText) : null,
      };
      priceContext = 'public_fallback';
    }

    if (searchResult.status < 200 || searchResult.status >= 300) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Ricerca Esselunga non riuscita (HTTP ${searchResult.status}). La sessione potrebbe essere scaduta o il percorso pagina non valido.` }],
      };
    }

    const data = searchResult.payload as {
      displayables?: {
        entities?: Array<Record<string, unknown>>;
        rowCount?: number;
        range?: { start?: number; length?: number };
      };
    };
    const displayables = data.displayables;
    if (!displayables || !Array.isArray(displayables.entities)) {
      return { isError: true, content: [{ type: 'text', text: 'La risposta Esselunga non contiene displayables.entities come atteso.' }] };
    }

    const products = displayables.entities.map(publicProduct);
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{
      type: 'text',
      text: JSON.stringify({
        query,
        priceContext,
        total: displayables.rowCount,
        range: displayables.range,
        products,
      }, null, 2),
    }];

    if (includeImages) {
      const imageProducts = products
        .filter((product) => typeof product.imageURL === 'string' && imageUrlIsAllowed(product.imageURL))
        .slice(0, 4);
      for (const product of imageProducts) {
        try {
          const imageResponse = await fetch(product.imageURL as string, { signal: AbortSignal.timeout(15_000) });
          const mimeType = imageResponse.headers.get('content-type')?.split(';')[0] ?? '';
          const bytes = new Uint8Array(await imageResponse.arrayBuffer());
          if (!imageResponse.ok || !mimeType.startsWith('image/') || bytes.byteLength > 5_000_000) continue;
          content.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType });
        } catch {
          // Un'anteprima non disponibile non deve rendere inutilizzabile la ricerca.
        }
      }
    }

    return {
      content,
    };
  },
);

server.registerTool(
  'get_product_image',
  {
    title: 'Mostra foto prodotto Esselunga',
    description: 'Restituisce la foto di un prodotto come immagine MCP, visualizzabile nelle chat LLM compatibili. Usa imageURL ottenuto da search_products o get_product_details.',
    inputSchema: {
      imageURL: z.string().url().describe('URL immagine restituito dal catalogo Esselunga'),
    },
  },
  async ({ imageURL }) => {
    if (!imageUrlIsAllowed(imageURL)) {
      return { isError: true, content: [{ type: 'text', text: 'imageURL deve essere un URL HTTPS del catalogo Esselunga.' }] };
    }
    try {
      const response = await fetch(imageURL, { signal: AbortSignal.timeout(15_000) });
      const mimeType = response.headers.get('content-type')?.split(';')[0] ?? '';
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok || !mimeType.startsWith('image/')) {
        return { isError: true, content: [{ type: 'text', text: `Immagine non disponibile (HTTP ${response.status}).` }] };
      }
      if (bytes.byteLength > 5_000_000) {
        return { isError: true, content: [{ type: 'text', text: 'Immagine troppo grande per essere allegata alla risposta MCP.' }] };
      }
      return { content: [{ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Impossibile scaricare l’immagine del prodotto.' }] };
    }
  },
);

server.registerTool(
  'get_product_details',
  {
    title: 'Leggi dettaglio prodotto Esselunga',
    description: 'Legge i dettagli necessari per aggiungere un prodotto al carrello, inclusi intervalli di peso e attributi selezionabili.',
    inputSchema: {
      productCode: z.string().trim().min(1).describe('Campo code restituito da search_products'),
    },
  },
  async ({ productCode }) => {
    try {
      const detail = await requestJson(`/commerce/resources/displayable/detail/code/${encodeURIComponent(productCode)}`);
      const payload = asObject(detail.payload);
      const product = asObject(payload?.displayableProduct) ?? asObject(detail.payload);
      if (detail.status !== 200 || !product) {
        return { isError: true, content: [{ type: 'text', text: `Prodotto non trovato o dettaglio non disponibile (HTTP ${detail.status}).` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(publicProduct(product), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Impossibile leggere il dettaglio prodotto.' }] };
    }
  },
);

server.registerTool(
  'get_delivery_slots',
  {
    title: 'Leggi date e orari di consegna',
    description: 'Mostra gli slot di consegna o ritiro disponibili per il profilo Esselunga e il carrello correnti. È una lettura: non prenota né modifica lo slot.',
    inputSchema: {
      availableOnly: z.boolean().default(true).describe('Se true, mostra solo gli slot prenotabili'),
      limit: z.number().int().min(1).max(200).default(50).describe('Numero massimo di slot da restituire'),
    },
  },
  async ({ availableOnly, limit }) => {
    try {
      const statusResult = await requestJson('/commerce/resources/auth/slot/status');
      const firstAvailableResult = await requestJson('/commerce/resources/auth/slot/firstAvailable');
      if (statusResult.status !== 200) {
        return { isError: true, content: [{ type: 'text', text: `Disponibilità consegne non disponibile (HTTP ${statusResult.status}).` }] };
      }
      const status = asObject(statusResult.payload);
      const slots = (Array.isArray(status?.slots) ? status.slots : []).map(asObject)
        .filter((slot): slot is Record<string, unknown> => Boolean(slot))
        .map((slot) => ({
          startTime: slot.startTime,
          endTime: slot.endTime,
          price: slot.price,
          status: slot.status,
          statusDescription: slot.statusDescription,
          available: slot.active === true && slot.disabled !== true,
          disabled: slot.disabled === true,
          reactivable: slot.reactivable === true,
          eco: slot.eco === true,
          fast: slot.fast === true,
          cutOffInsertTime: slot.cutOffInsertTime,
          uniqueTimeId: slot.uniqueTimeId,
        }))
        .filter((slot) => !availableOnly || slot.available)
        .slice(0, limit);
      const firstAvailable = asObject(firstAvailableResult.payload);
      const reservation = asObject(status?.slotReservation);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            availableOnly,
            totalReturned: slots.length,
            firstAvailable: firstAvailableResult.status === 200 ? {
              startTime: firstAvailable?.startTime,
              endTime: firstAvailable?.endTime,
              price: firstAvailable?.price,
              status: firstAvailable?.status,
              statusDescription: firstAvailable?.statusDescription,
            } : null,
            currentReservation: reservation ? {
              startTime: reservation.startTime,
              endTime: reservation.endTime,
              reservationDate: reservation.reservationDate,
              reservationTime: reservation.reservationTime,
            } : null,
            slots,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Impossibile leggere gli slot disponibili.' }] };
    }
  },
);

server.registerTool(
  'open_browser_session',
  {
    title: 'Apri sessione browser Esselunga',
    description: 'Apre Chrome con un profilo locale dedicato. Accedi manualmente a Esselunga nella finestra aperta, poi usa get_cart.',
    inputSchema: z.object({}),
  },
  async () => {
    const page = await getBrowserPage();
    return {
      content: [{
        type: 'text',
        text: browserHeadless
          ? `Sessione browser headless avviata su ${page.url()}. Se il profilo non è già autenticato, imposta ESSELUNGA_BROWSER_HEADLESS=false, riavvia il server e completa l'accesso manualmente.`
          : `Sessione browser aperta su ${page.url()}. Completa manualmente l'accesso Esselunga in questa finestra; il profilo locale sarà riutilizzato dal wizard.`,
      }],
    };
  },
);

server.registerTool(
  'start_auth_wizard',
  {
    title: 'Avvia configurazione Esselunga',
    description: 'Apre il login Esselunga per il bootstrap iniziale. Completa manualmente accesso e 2FA nella finestra, poi usa complete_auth_wizard.',
    inputSchema: z.object({}),
  },
  async () => {
    const page = await getBrowserPage(false);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    return {
      content: [{
        type: 'text',
        text: 'Finestra di login aperta. Inserisci manualmente le credenziali Esselunga e completa eventuali verifiche; quando sei tornato su Spesa Online, chiama complete_auth_wizard.',
      }],
    };
  },
);

server.registerTool(
  'complete_auth_wizard',
  {
    title: 'Completa configurazione Esselunga',
    description: 'Importa la sessione autenticata dal browser e salva lo stato HTTP per i successivi avvii in background.',
    inputSchema: z.object({}),
  },
  async () => {
    if (!browserContext) {
      return { isError: true, content: [{ type: 'text', text: 'Il wizard non è stato avviato. Chiama prima start_auth_wizard.' }] };
    }
    const cookies = await browserContext.cookies([ORIGIN, 'https://account.esselunga.it']);
    try {
      await session.bootstrapFromBrowser(cookies.map(({ name, value }) => ({ name, value })));
      const cart = await requestJson('/commerce/resources/auth/trolley');
      if (cart.status !== 200) {
        return { isError: true, content: [{ type: 'text', text: `La sessione è stata importata ma il carrello non è disponibile (HTTP ${cart.status}). Verifica di aver completato il login prima di riprovare.` }] };
      }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Impossibile salvare la sessione Esselunga.' }] };
    }
    await browserContext.close();
    browserContext = undefined;
    browserPage = undefined;
    browserIsHeadless = undefined;
    return {
      content: [{
        type: 'text',
        text: 'Configurazione completata. La sessione HTTP è stata salvata; il browser è stato chiuso e il server ora lavora in background senza finestre.',
      }],
    };
  },
);

server.registerTool(
  'get_cart',
  {
    title: 'Leggi carrello Esselunga',
    description: 'Legge il carrello dalla sessione HTTP Esselunga rinnovata automaticamente. Non modifica il carrello.',
    inputSchema: z.object({}),
  },
  async () => {
    let result: { status: number; payload: unknown };
    try {
      result = await requestJson('/commerce/resources/auth/trolley');
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Impossibile inizializzare la sessione Esselunga.' }] };
    }
    if (result.status === 401) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'La sessione Esselunga non è autenticata dopo il rinnovo SSO.' }],
      };
    }
    if (result.status < 200 || result.status >= 300) {
      return { isError: true, content: [{ type: 'text', text: `Lettura carrello non riuscita (HTTP ${result.status}).` }] };
    }

    const trolley = result.payload as { storeId?: number; totalQuantity?: number; trolleyItems?: Array<Record<string, unknown>>; deletedItems?: Record<string, unknown> };
    if (!Array.isArray(trolley.trolleyItems)) {
      return { isError: true, content: [{ type: 'text', text: 'La risposta Esselunga non contiene trolleyItems come atteso.' }] };
    }

    let pricingItems = new Map<number, Record<string, unknown>>();
    let transaction: Record<string, unknown> | undefined;
    let pricingStatus: number | undefined;
    try {
      const checkout = await requestJson('/commerce/resources/auth/checkout/cart');
      pricingStatus = checkout.status;
      const checkoutData = asObject(checkout.payload);
      const cartData = asObject(checkoutData?.cart);
      const receipt = asObject(cartData?.checkoutReceipt);
      transaction = asObject(checkoutData?.transaction);
      const receiptItems = Array.isArray(receipt?.checkoutReceiptItems) ? receipt.checkoutReceiptItems : [];
      pricingItems = new Map(receiptItems.map(asObject)
        .map((item) => {
          const trolleyItem = asObject(item?.trolleyItem);
          return typeof trolleyItem?.trolleyItemId === 'number' && item ? [trolleyItem.trolleyItemId, item] as const : undefined;
        })
        .filter((entry): entry is readonly [number, Record<string, unknown>] => Boolean(entry)));
    } catch {
      // Il carrello base rimane disponibile anche se il riepilogo prezzi non lo è.
    }

    const productDetails = new Map<string, Record<string, unknown>>();
    for (const item of trolley.trolleyItems) {
      if (typeof item.productCode !== 'string' || productDetails.has(item.productCode)) continue;
      try {
        const detail = await requestJson(`/commerce/resources/displayable/detail/code/${encodeURIComponent(item.productCode)}`);
        const detailPayload = asObject(detail.payload);
        const product = asObject(detailPayload?.displayableProduct) ?? asObject(detail.payload);
        if (detail.status === 200 && product) productDetails.set(item.productCode, product);
      } catch {
        // Stato e promozioni di una singola riga non devono impedire la lettura del carrello.
      }
    }

    const items = trolley.trolleyItems.map((item) => {
      const interval = item.productInterval as Record<string, unknown> | null | undefined;
      const ums = interval?.ums as Record<string, unknown> | null | undefined;
      const pricing = typeof item.trolleyItemId === 'number' ? pricingItems.get(item.trolleyItemId) : undefined;
      const detail = typeof item.productCode === 'string' ? productDetails.get(item.productCode) : undefined;
      const fullUnitPrice = finiteNumber(pricing?.unitPrice) ?? finiteNumber(pricing?.quantityAwarePrice);
      const rawDiscountedUnitPrice = finiteNumber(pricing?.discountedUnitPrice);
      const effectiveUnitPrice = rawDiscountedUnitPrice ?? fullUnitPrice;
      const quantity = finiteNumber(item.quantity);
      const isWeightBased = ums?.umsType === 'WEIGHT';
      const quantityMultiplier = isWeightBased ? 1 : quantity ?? 1;
      const quantityAwarePrice = fullUnitPrice === undefined ? undefined : money(fullUnitPrice * quantityMultiplier);
      const discountedQuantityAwarePrice = rawDiscountedUnitPrice === undefined
        ? undefined
        : money(rawDiscountedUnitPrice * quantityMultiplier);
      const effectiveQuantityAwarePrice = effectiveUnitPrice === undefined
        ? undefined
        : money(effectiveUnitPrice * quantityMultiplier);
      const computedProductDiscount = fullUnitPrice !== undefined && effectiveUnitPrice !== undefined && quantity !== undefined
        ? money(Math.max(0, fullUnitPrice - effectiveUnitPrice) * quantity)
        : undefined;
      const checkoutPromotions = Array.isArray(pricing?.promotionsDetail) ? pricing.promotionsDetail : [];
      const detailPromotions = Array.isArray(detail?.promotionsDetail) ? detail.promotionsDetail : [];
      const sourcePromotions = checkoutPromotions.length > 0 ? checkoutPromotions : detailPromotions;
      const promotions = sourcePromotions.map(asObject).map((promotion) => {
        if (!promotion || sourcePromotions.length !== 1 || promotion.value !== null || computedProductDiscount === undefined) {
          return promotion;
        }
        return { ...promotion, value: -computedProductDiscount };
      }).filter((promotion): promotion is Record<string, unknown> => Boolean(promotion));
      return {
        trolleyItemId: item.trolleyItemId,
        productId: item.productId,
        productCode: item.productCode,
        description: item.description,
        brand: item.brand,
        quantity: item.quantity,
        unit: ums?.customName ?? ums?.name,
        unitRatio: interval?.ratio,
        unitValue: interval?.value,
        productType: item.productType,
        quantityDisabled: item.quantityDisabled,
        unitPrice: fullUnitPrice,
        discountedUnitPrice: rawDiscountedUnitPrice,
        effectiveUnitPrice,
        quantityAwarePrice,
        discountedQuantityAwarePrice,
        effectiveQuantityAwarePrice,
        computedProductDiscount,
        promotions,
        outOfStock: detail?.outOfStock ?? null,
        availability: detail ? (detail.outOfStock === true ? 'out_of_stock' : 'available') : 'unknown',
        imageURL: pricing?.imageURL,
      };
    });
    const computedProductDiscount = money(items.reduce((total, item) => total + (finiteNumber(item.computedProductDiscount) ?? 0), 0));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          storeId: trolley.storeId,
          totalQuantity: trolley.totalQuantity,
          pricing: pricingItems.size > 0 ? {
            source: 'authenticated_checkout',
            totalAmount: transaction?.totalAmount,
            transactionAmount: transaction?.transactionAmount,
            deliveryAmount: transaction?.deliveryAmount,
            totalPromoDiscount: computedProductDiscount,
            reportedPromoDiscount: transaction?.totalDiscountFromPromoTotals,
            totalCouponDiscount: transaction?.totalDiscountFromFidatyCouponTotals,
          } : {
            source: 'unavailable',
            checkoutStatus: pricingStatus,
          },
          items,
          deletedItemGroups: trolley.deletedItems ? Object.fromEntries(Object.entries(trolley.deletedItems).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])) : {},
        }, null, 2),
      }],
    };
  },
);

server.registerTool(
  'update_cart',
  {
    title: 'Modifica carrello Esselunga',
    description: 'Aggiunge un prodotto, anche a peso variabile, imposta una quantità o rimuove una riga nel carrello della sessione autenticata. Non può effettuare checkout.',
    inputSchema: {
      action: z.enum(['add', 'set_quantity', 'remove']).describe('Operazione da eseguire sul carrello'),
      productCode: z.string().trim().min(1).optional().describe('Codice prodotto Esselunga, necessario per add; è il campo code restituito da search_products'),
      productIntervalId: z.number().int().positive().optional().describe('Intervallo di peso/pezzatura da get_product_details; per un prodotto a peso variabile è scelto automaticamente se ce n’è uno solo'),
      productAttributeIds: z.array(z.number().int().positive()).max(20).default([]).describe('Eventuali attributi obbligatori scelti da get_product_details'),
      trolleyItemId: z.number().int().positive().optional().describe('Identificativo riga carrello, necessario per set_quantity e remove'),
      quantity: z.number().int().min(1).max(99).optional().describe('Quantità desiderata, necessaria per add e set_quantity'),
      confirm: z.boolean().default(false).describe('Imposta true solo per eseguire realmente la modifica'),
    },
  },
  async ({ action, productCode, productIntervalId, productAttributeIds, trolleyItemId, quantity, confirm }) => {
    if (action === 'add' && (!productCode || quantity === undefined)) {
      return { isError: true, content: [{ type: 'text', text: 'Per action add servono productCode e quantity.' }] };
    }
    if (action === 'set_quantity' && (!trolleyItemId || quantity === undefined)) {
      return { isError: true, content: [{ type: 'text', text: 'Per action set_quantity servono trolleyItemId e quantity.' }] };
    }
    if (action === 'remove' && !trolleyItemId) {
      return { isError: true, content: [{ type: 'text', text: 'Per action remove serve trolleyItemId.' }] };
    }
    if (!confirm) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            willModifyCart: true,
            action,
            productCode,
            productIntervalId,
            productAttributeIds,
            trolleyItemId,
            quantity,
            nextStep: 'Ripeti la stessa chiamata con confirm: true per applicare la modifica.',
          }, null, 2),
        }],
      };
    }

    let result: { phase: string; status: number; payload?: unknown; message?: string };
    try {
      const cartBefore = await requestJson('/commerce/resources/auth/trolley');
      if (cartBefore.status !== 200 || !cartBefore.payload || typeof cartBefore.payload !== 'object') {
        result = { phase: 'cart', ...cartBefore };
      } else {
        const cart = cartBefore.payload as { trolleyItems?: Array<Record<string, unknown>> };
        if (!Array.isArray(cart.trolleyItems)) {
          result = { phase: 'cart_shape', status: 500 };
        } else if (action === 'remove') {
          const exists = cart.trolleyItems.some((item) => item.trolleyItemId === trolleyItemId);
          result = exists
            ? { phase: 'mutation', ...(await requestJson(`/commerce/resources/auth/trolley/item/${trolleyItemId}`, { method: 'DELETE' })) }
            : { phase: 'validation', status: 404, message: 'Riga carrello non trovata.' };
        } else {
          let product: Record<string, unknown> | undefined;
          if (action === 'add') {
            const detail = await requestJson(`/commerce/resources/displayable/detail/code/${encodeURIComponent(productCode!)}`);
            product = (detail.payload as { displayableProduct?: Record<string, unknown> } | null)?.displayableProduct;
            if (detail.status !== 200 || !product) {
              result = { phase: 'product', status: detail.status, message: 'Prodotto non trovato.' };
            } else if (product.outOfStock === true) {
              result = { phase: 'validation', status: 409, message: 'Prodotto non disponibile.' };
            } else {
              const intervals = intervalCandidates(product);
              const selectedInterval = productIntervalId === undefined
                ? (intervals.length === 1 ? intervals[0] : undefined)
                : intervals.find((interval) => interval.id === productIntervalId);
              const requiresInterval = product.variableWeight === true || intervals.length > 0;
              if (requiresInterval && !selectedInterval) {
                result = {
                  phase: 'validation',
                  status: 422,
                  message: 'Per questo prodotto seleziona productIntervalId usando get_product_details; non è possibile dedurre in sicurezza una pezzatura tra più alternative.',
                };
              } else {
                product = {
                  ...product,
                  productIntervalId: selectedInterval?.id ?? null,
                  productAttributeIds,
                };
                result = { phase: 'ready', status: 200 };
              }
            }
          } else {
            const item = cart.trolleyItems.find((row) => row.trolleyItemId === trolleyItemId);
            if (!item) {
              result = { phase: 'validation', status: 404, message: 'Riga carrello non trovata.' };
            } else {
              const interval = item.productInterval as Record<string, unknown> | null | undefined;
              const attributes = Array.isArray(item.attributes) ? item.attributes as Array<Record<string, unknown>> : [];
              product = {
                id: item.productId,
                productIntervalId: interval?.id ?? null,
                productAttributeIds: attributes.map((attribute) => attribute.productAttributeId).filter((id): id is number => typeof id === 'number'),
              };
              result = { phase: 'ready', status: 200 };
            }
          }

          if (result.phase === 'ready' && product) {
            const body = {
              productId: product.id,
              quantity,
              productIntervalId: product.productIntervalId ?? null,
              productAttributeIds: product.productAttributeIds ?? [],
              productOrigin: null,
              forced: false,
            };
            result = { phase: 'mutation', ...(await requestJson('/commerce/resources/auth/trolley/item', { method: 'POST', body: JSON.stringify(body) })) };
          }
        }
      }
    } catch (error) {
      result = { phase: 'session', status: 500, message: error instanceof Error ? error.message : 'Errore di sessione Esselunga.' };
    }

    if (result.status < 200 || result.status >= 300) {
      const apiMessage = typeof result.payload === 'object' && result.payload !== null && 'message' in result.payload
        ? String((result.payload as { message?: unknown }).message)
        : result.message ?? 'Esselunga non ha accettato la modifica.';
      const phaseMessage = result.phase === 'product'
        ? 'Il prodotto non è stato trovato. Per add usa il campo code restituito da search_products, non productId.'
        : result.phase === 'validation'
          ? 'Il prodotto o la riga carrello non supera i controlli del server.'
          : result.phase === 'cart'
            ? 'La sessione browser non ha restituito il carrello.'
            : 'La modifica del carrello non è stata accettata.';
      return { isError: true, content: [{ type: 'text', text: `${phaseMessage} Fase: ${result.phase}. Dettaglio: ${apiMessage} (HTTP ${result.status}).` }] };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ updated: true, action, productCode, trolleyItemId, quantity, nextStep: 'Chiama get_cart per leggere lo stato aggiornato del carrello.' }, null, 2),
      }],
    };
  },
);

void serveStdio(() => server);
console.error('esselunga-mcp avviato su stdio');
