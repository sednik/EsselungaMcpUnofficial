import 'dotenv/config';
import path from 'node:path';
import { chromium } from 'playwright';
import { EsselungaSession } from './esselunga-session.js';

const origin = 'https://spesaonline.esselunga.it';
const loginUrl = `${origin}/commerce/login/spesaonline`;
const profileDir = path.resolve(process.cwd(), process.env.ESSELUNGA_BROWSER_PROFILE_DIR || '.esselunga-browser');
const sessionFile = path.resolve(process.cwd(), process.env.ESSELUNGA_SESSION_FILE || '.esselunga-session.json');
const timeoutMs = 10 * 60 * 1000;

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 900 },
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  console.error('Completa l’accesso Esselunga e l’eventuale 2FA nella finestra Chrome aperta.');

  const deadline = Date.now() + timeoutMs;
  let cookies = [] as Awaited<ReturnType<typeof context.cookies>>;
  while (Date.now() < deadline) {
    cookies = await context.cookies([origin, 'https://account.esselunga.it']);
    const loggedIn = cookies.some((cookie) => cookie.name === 'gescliweb.sso.is-logged-user');
    if (loggedIn && page.url().startsWith(origin)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (Date.now() >= deadline) {
    throw new Error('Tempo scaduto: il login Esselunga non è stato completato entro 10 minuti.');
  }

  const session = new EsselungaSession(sessionFile, undefined);
  await session.bootstrapFromBrowser(cookies.map(({ name, value }) => ({ name, value })));
  const cartResponse = await session.fetch('/commerce/resources/auth/trolley');
  if (cartResponse.status !== 200) {
    throw new Error(`La sessione è stata salvata ma il carrello non è disponibile (HTTP ${cartResponse.status}).`);
  }

  console.error(`Configurazione completata. Sessione salvata in ${sessionFile}.`);
} finally {
  await context.close();
}
