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
const xsrfCookieValue = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('XSRF-ECOM-TOKEN='))?.slice('XSRF-ECOM-TOKEN='.length);
const xsrfToken = process.env.ESSELUNGA_XSRF_TOKEN || xsrfCookieValue;
const browserProfileDir = path.resolve(process.cwd(), process.env.ESSELUNGA_BROWSER_PROFILE_DIR || '.esselunga-browser');
const browserHeadless = process.env.ESSELUNGA_BROWSER_HEADLESS === 'true';
const sessionStateFile = path.resolve(process.cwd(), process.env.ESSELUNGA_SESSION_FILE || '.esselunga-session.json');
const session = new EsselungaSession(sessionStateFile, cookie);
const configured = Boolean(pagePath);
let browserContext: BrowserContext | undefined;
let browserPage: Page | undefined;
let browserIsHeadless: boolean | undefined;

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

const server = new McpServer({ name: 'esselunga-mcp', version: '0.3.0' });

server.registerTool(
  'server_status',
  {
    title: 'Stato del server Esselunga',
    description: 'Mostra lo stato del server MCP e della configurazione locale Esselunga.',
    inputSchema: {},
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
    },
  },
  async ({ query, start, length, promotion }) => {
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
    if (cookie) headers.cookie = cookie;
    if (xsrfToken) headers['x-xsrf-token'] = xsrfToken;

    const response = await fetch(`${ORIGIN}/commerce/resources/search/facet`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        start,
        length,
        isLargeQuerySearch: !promotion,
        filters: promotion ? [{ type: 'MSF_PROMO', ids: [promotion] }] : [],
        rmtCookieAllowed: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Ricerca Esselunga non riuscita (HTTP ${response.status}). La sessione potrebbe essere scaduta o il percorso pagina non valido.` }],
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Esselunga ha restituito una risposta non JSON.' }] };
    }

    const data = payload as {
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

    const products = displayables.entities.map((product) => ({
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
      promotions: product.promotionsDetail,
      imageURL: product.imageURL,
      canBeAddedToShoppingList: product.canBeAddedToShoppingList,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query,
          total: displayables.rowCount,
          range: displayables.range,
          products,
        }, null, 2),
      }],
    };
  },
);

server.registerTool(
  'open_browser_session',
  {
    title: 'Apri sessione browser Esselunga',
    description: 'Apre Chrome con un profilo locale dedicato. Accedi manualmente a Esselunga nella finestra aperta, poi usa get_cart.',
    inputSchema: {},
  },
  async () => {
    const page = await getBrowserPage();
    return {
      content: [{
        type: 'text',
        text: browserHeadless
          ? `Sessione browser headless avviata su ${page.url()}. Se il profilo non è già autenticato, imposta ESSELUNGA_BROWSER_HEADLESS=false, riavvia il server e completa l'accesso manualmente.`
          : `Sessione browser aperta su ${page.url()}. Completa manualmente l'accesso Esselunga in questa finestra; il profilo locale è ${browserProfileDir}.`,
      }],
    };
  },
);

server.registerTool(
  'start_auth_wizard',
  {
    title: 'Avvia configurazione Esselunga',
    description: 'Apre il login Esselunga per il bootstrap iniziale. Completa manualmente accesso e 2FA nella finestra, poi usa complete_auth_wizard.',
    inputSchema: {},
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
    inputSchema: {},
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
        text: `Configurazione completata. La sessione HTTP è salvata in ${sessionStateFile}; il browser è stato chiuso e il server ora lavora in background senza finestre.`,
      }],
    };
  },
);

server.registerTool(
  'get_cart',
  {
    title: 'Leggi carrello Esselunga',
    description: 'Legge il carrello dalla sessione Esselunga presente nel browser locale. Non modifica il carrello.',
    inputSchema: {},
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

    const items = trolley.trolleyItems.map((item) => {
      const interval = item.productInterval as Record<string, unknown> | null | undefined;
      const ums = interval?.ums as Record<string, unknown> | null | undefined;
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
      };
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          storeId: trolley.storeId,
          totalQuantity: trolley.totalQuantity,
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
    description: 'Aggiunge un prodotto, imposta una quantità o rimuove una riga nel carrello della sessione browser. Non può effettuare checkout.',
    inputSchema: {
      action: z.enum(['add', 'set_quantity', 'remove']).describe('Operazione da eseguire sul carrello'),
      productCode: z.string().trim().min(1).optional().describe('Codice prodotto Esselunga, necessario per add; è il campo code restituito da search_products'),
      trolleyItemId: z.number().int().positive().optional().describe('Identificativo riga carrello, necessario per set_quantity e remove'),
      quantity: z.number().int().min(1).max(99).optional().describe('Quantità desiderata, necessaria per add e set_quantity'),
      confirm: z.boolean().default(false).describe('Imposta true solo per eseguire realmente la modifica'),
    },
  },
  async ({ action, productCode, trolleyItemId, quantity, confirm }) => {
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
            } else if (product.variableWeight === true || (Array.isArray(product.attributes) && product.attributes.length > 0)) {
              result = { phase: 'validation', status: 422, message: 'Prodotto a peso variabile o con scelte obbligatorie: non gestito da update_cart.' };
            } else {
              result = { phase: 'ready', status: 200 };
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
