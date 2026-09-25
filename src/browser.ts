import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/** One shared page per MCP session, launched lazily on first use. */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private historyDepth = 0;
  private lastUrl = "";
  private headed: boolean;

  constructor(headed = false) {
    this.headed = headed;
  }

  get canGoBack(): boolean {
    return this.historyDepth > 0;
  }

  get isLaunched(): boolean {
    return this.browser !== null;
  }

  /** Only takes effect before the browser is launched. */
  setHeaded(headed: boolean): void {
    if (!this.browser) this.headed = headed;
  }

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: !this.headed });
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
    }
    this.page = await this.context!.newPage();
    return this.page;
  }

  async open(url: string): Promise<Page> {
    const page = await this.getPage();
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.settle();
    this.noteNavigation();
    return this.page!;
  }

  /** Waits for the page to settle and adopts a popup/new tab if one opened. */
  async settle(extraMs = 250): Promise<Page> {
    const page = await this.getPage();
    try {
      await page.waitForLoadState("networkidle", { timeout: 1200 });
    } catch {
      // networkidle is best-effort; dynamic pages never reach it
    }
    if (extraMs > 0) await page.waitForTimeout(extraMs);
    const pages = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
    const newest = pages[pages.length - 1];
    if (newest && newest !== page) this.page = newest;
    return this.page!;
  }

  /** Tracks history so BACK is only offered when a navigation happened. */
  noteNavigation(): void {
    const page = this.page;
    if (!page || page.isClosed()) return;
    const url = page.url();
    if (url && url !== "about:blank" && url !== this.lastUrl) {
      this.historyDepth += 1;
      this.lastUrl = url;
    }
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.historyDepth = 0;
    this.lastUrl = "";
  }
}
