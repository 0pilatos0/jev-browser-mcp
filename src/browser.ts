import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal automation-hygiene patches plus a shim for the `__name` helper that
 * tsx/esbuild injects into serialized functions (compiled builds don't need it).
 */
const STEALTH_INIT = `(() => {
  try { if (!window.__name) { window.__name = (target, value) => { try { Object.defineProperty(target, "name", { value, configurable: true }); } catch {} return target; }; } } catch {}
  try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {}
  try { if (!window.chrome) { window.chrome = { runtime: {} }; } } catch {}
  try { Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] }); } catch {}
})();`;

function chromeChannel(): "chrome" | "msedge" | undefined {
  const override = process.env.JEV_BROWSER_CHANNEL;
  if (override === "chromium") return undefined;
  if (override === "chrome" || override === "msedge") return override;
  return existsSync("/Applications/Google Chrome.app") ? "chrome" : undefined;
}

function profileDir(): string {
  return (
    process.env.JEV_BROWSER_PROFILE ??
    join(homedir(), ".jev-browser-mcp", "chrome-profile")
  );
}

/** One shared page per MCP session, launched lazily on first use. */
export class BrowserSession {
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
    return this.context !== null;
  }

  /** Only takes effect before the browser is launched. */
  setHeaded(headed: boolean): void {
    if (!this.context) this.headed = headed;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const dir = profileDir();
    mkdirSync(dir, { recursive: true });
    const channel = chromeChannel();
    const common: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: !this.headed,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      ignoreDefaultArgs: ["--enable-automation"],
    };
    try {
      this.context = await chromium.launchPersistentContext(dir, {
        ...common,
        channel,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
    } catch (error) {
      if (!channel) throw error;
      // Branded browser unavailable or failed: fall back to bundled Chromium.
      this.context = await chromium.launchPersistentContext(dir, {
        ...common,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    }
    await this.context.addInitScript(STEALTH_INIT).catch(() => {});
    for (const existing of this.context.pages()) {
      await existing.addInitScript(STEALTH_INIT).catch(() => {});
    }
    return this.context;
  }

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const context = await this.ensureContext();
    const open = context.pages().filter((candidate) => !candidate.isClosed());
    this.page = open[open.length - 1] ?? (await context.newPage());
    await this.page.addInitScript(STEALTH_INIT).catch(() => {});
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
    const pages = (this.context?.pages() ?? []).filter((candidate) => !candidate.isClosed());
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
      await this.context?.close();
    } catch {
      // ignore
    }
    this.context = null;
    this.page = null;
    this.historyDepth = 0;
    this.lastUrl = "";
  }
}
