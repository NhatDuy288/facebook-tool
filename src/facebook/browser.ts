import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import type { Config } from '../config.ts';
import type { Account } from '../types.ts';

export class BrowserSession {
  context!: BrowserContext;
  browser: Browser | null = null;
  dashboard!: Page;
  source!: Page;
  channel = '';
  private backgroundPageQueue: Promise<void> = Promise.resolve();
  async launch(config: Config, profileDir: string, controlUrl: string): Promise<void> {
    await mkdir(profileDir, { recursive: true });
    // A fixed context viewport makes Playwright resize the native window for
    // each new tab, which can restore it from minimized. Keep the native viewport.
    for (const channel of ['chrome', 'msedge']) {
      try {
        if (config.keepSession) this.context = await chromium.launchPersistentContext(channel === 'chrome' ? profileDir : profileDir + '-edge',
          { channel, headless: false, viewport: null, args: ['--window-size=1280,1000'] });
        else {
          this.browser = await chromium.launch({ channel, headless: false, args: ['--window-size=1280,1000'] });
          this.context = await this.browser.newContext({ viewport: null });
        }
        this.channel = channel; break;
      } catch (error) {
        if (error instanceof Error && /SingletonLock|ProcessSingleton|user data directory is already in use/i.test(error.message)) throw Error('BROWSER_PROFILE_BUSY');
        /* Try the other installed browser. Never reuse the user's normal Chrome profile. */
      }
    }
    if (!this.context) throw Error('BROWSER_UNAVAILABLE');
    this.context.setDefaultTimeout(10_000);
    this.dashboard = this.context.pages()[0] || await this.context.newPage();
    await this.dashboard.goto(controlUrl);
    this.source = await this.newBackgroundPage();
    // Do not fetch Facebook or send an interaction until the operator opens/login/starts.
    await this.dashboard.bringToFront();
  }
  async sourcePage(): Promise<Page> {
    if (!this.source || this.source.isClosed()) this.source = await this.newBackgroundPage();
    return this.source;
  }
  newBackgroundPage(): Promise<Page> {
    // New pages normally activate Chromium's window. All automatic tabs go through
    // this queue and explicitly request background creation, including after recovery.
    const page = this.backgroundPageQueue.then(() => this.createBackgroundPage());
    this.backgroundPageQueue = page.then(() => {}, () => {});
    return page;
  }
  private async createBackgroundPage(): Promise<Page> {
    const anchor = [this.dashboard, this.source, ...this.context.pages()].find(page => page && !page.isClosed());
    const browser = this.context.browser();
    if (!anchor || !browser) throw Error('BACKGROUND_TAB_UNAVAILABLE');
    let anchorSession: CDPSession | undefined, control: CDPSession | undefined, targetId: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined, disposed = false;
    const candidates = new Map<string, Page>();
    let accept!: (page: Page) => void;
    const createdPage = new Promise<Page>((resolve, reject) => {
      accept = resolve;
      timeout = setTimeout(() => reject(Error('BACKGROUND_TAB_UNAVAILABLE')), 10_000);
    });
    // The create command can fail before a page event arrives.
    void createdPage.catch(() => {});
    const onPage = (page: Page) => {
      void (async () => {
        let session: CDPSession | undefined;
        try {
          session = await this.context.newCDPSession(page);
          const { targetInfo } = await session.send('Target.getTargetInfo');
          if (disposed || page.isClosed()) return;
          candidates.set(targetInfo.targetId, page);
          if (targetInfo.targetId === targetId) accept(page);
        } catch { /* An unrelated/user-closed page must not be adopted. */ }
        finally { await session?.detach().catch(() => {}); }
      })();
    };
    this.context.on('page', onPage);
    try {
      anchorSession = await this.context.newCDPSession(anchor);
      const { targetInfo } = await anchorSession.send('Target.getTargetInfo');
      control = await browser.newBrowserCDPSession();
      const target = await control.send('Target.createTarget', { url: 'about:blank', newWindow: false, background: true, focus: false,
        ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}) });
      targetId = target.targetId;
      const alreadyCreated = candidates.get(targetId);
      if (alreadyCreated && !alreadyCreated.isClosed()) accept(alreadyCreated);
      return await createdPage;
    } catch {
      if (targetId) await control?.send('Target.closeTarget', { targetId }).catch(() => {});
      // Do not fall back to context.newPage(): that would foreground the browser again.
      throw Error('BACKGROUND_TAB_UNAVAILABLE');
    } finally {
      disposed = true; clearTimeout(timeout); this.context.off('page', onPage);
      await anchorSession?.detach().catch(() => {}); await control?.detach().catch(() => {});
    }
  }
  async openLogin() {
    const page = await this.sourcePage();
    if (!page.url().startsWith('https://www.facebook.com/'))
      await page.goto('https://www.facebook.com/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.bringToFront();
  }
  async close() { await this.context?.close().catch(() => {}); await this.browser?.close().catch(() => {}); }
}

export async function activeAccount(page: Page, expectedId?: string): Promise<Account> {
  if (page.isClosed()) throw Error('LOGIN_REQUIRED');
  const url = new URL(page.url());
  if (url.origin !== 'https://www.facebook.com' || /\/(?:login|checkpoint|two_step_verification|confirmemail|recover)(?:[/.?]|$)/i.test(url.pathname))
    throw Error('LOGIN_OR_CHECKPOINT');
  const account = await page.evaluate(() => {
    const loader = (globalThis as any).require;
    const load = (name: string) => { try { return loader(name); } catch { return null; } };
    const current = load('CurrentUserInitialData'), params = load('getAsyncParams')?.('POST');
    const id = String(params?.__user || '');
    const userId = current?.USER_ID ? String(current.USER_ID) : null;
    const personal = current?.ACCOUNT_ID ? String(current.ACCOUNT_ID) === id : !current?.IS_WORK_USER && !current?.IS_PAGE;
    return { id, userId, personal, name: typeof current?.NAME === 'string' ? current.NAME.slice(0, 100) : '' };
  });
  if (!/^[1-9]\d+$/.test(account.id)) throw Error('LOGIN_REQUIRED');
  if (account.userId && account.userId !== account.id || expectedId && expectedId !== account.id) throw Error('ACTOR_CHANGED');
  if (!account.personal) throw Error('PERSONAL_ACCOUNT_REQUIRED');
  return { id: account.id, name: account.name };
}
