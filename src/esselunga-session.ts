import { readFile, writeFile } from 'node:fs/promises';

const ORIGIN = 'https://spesaonline.esselunga.it';
const LOGIN_URL = `${ORIGIN}/commerce/login/spesaonline`;

type StoredSession = {
  cookies: Record<string, string>;
  refreshedAt: string;
};

type BrowserCookie = {
  name: string;
  value: string;
};

export class EsselungaSession {
  private readonly cookies = new Map<string, string>();
  private initialized = false;

  constructor(
    private readonly stateFile: string,
    initialCookie: string | undefined,
  ) {
    this.importCookieHeader(initialCookie);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    await this.initialize();
    let response = await this.request(path, init);
    if (response.status === 401) {
      await this.refresh();
      response = await this.request(path, init);
    }
    return response;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.load();
    await this.refresh();
    this.initialized = true;
  }

  async bootstrapFromBrowser(cookies: BrowserCookie[]): Promise<void> {
    for (const cookie of cookies) this.cookies.set(cookie.name, cookie.value);
    await this.refresh();
    this.initialized = true;
  }

  private async refresh(): Promise<void> {
    if (this.cookies.size === 0) {
      throw new Error('Manca una sessione iniziale. Imposta ESSELUNGA_COOKIE una sola volta nel file .env.');
    }

    let url = LOGIN_URL;
    for (let hop = 0; hop < 10; hop += 1) {
      const response = await fetch(url, {
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36',
          cookie: this.cookieHeader(),
        },
      });
      this.applySetCookies(response.headers.getSetCookie());
      const location = response.headers.get('location');
      if (!location || response.status < 300 || response.status >= 400) break;
      url = new URL(location, url).href;
    }

    await this.save();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', headers.get('accept') ?? 'application/json, text/plain, */*');
    headers.set('cookie', this.cookieHeader());
    headers.set('x-page-path', headers.get('x-page-path') ?? 'drive');
    const xsrfToken = this.cookies.get('XSRF-ECOM-TOKEN');
    if (xsrfToken) headers.set('x-xsrf-token', xsrfToken);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json;charset=UTF-8');

    const response = await fetch(new URL(path, ORIGIN), { ...init, headers });
    this.applySetCookies(response.headers.getSetCookie());
    await this.save();
    return response;
  }

  private importCookieHeader(cookieHeader: string | undefined): void {
    if (!cookieHeader) return;
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name && rest.length) this.cookies.set(name, rest.join('='));
    }
  }

  private applySetCookies(values: string[]): void {
    for (const value of values) {
      const [pair] = value.split(';');
      const [name, ...rest] = pair.split('=');
      if (name && rest.length) this.cookies.set(name.trim(), rest.join('='));
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8')) as StoredSession;
      for (const [name, value] of Object.entries(saved.cookies)) this.cookies.set(name, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async save(): Promise<void> {
    const data: StoredSession = {
      cookies: Object.fromEntries(this.cookies),
      refreshedAt: new Date().toISOString(),
    };
    await writeFile(this.stateFile, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  }
}
