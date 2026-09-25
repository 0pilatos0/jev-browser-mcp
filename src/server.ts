import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as actions from "./actions.js";
import { BrowserSession } from "./browser.js";
import { envFlag } from "./env.js";
import { runGoal, stepOnce } from "./loop.js";
import { takeSnapshot, ensurePageHelpers } from "./snapshot.js";
import { USD_PER_INPUT_TOKEN, type PageElement, type Snapshot } from "./types.js";

const session = new BrowserSession(envFlag("JEV_BROWSER_HEADED"));

function ok(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) },
    ],
    isError: true,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elementView(element: PageElement) {
  return {
    ref: element.ref,
    kind: element.kind,
    role: element.role,
    ...(element.name ? { name: element.name } : {}),
    ...(element.value ? { value: element.value } : {}),
    ...(element.disabled ? { disabled: true } : {}),
    ...(element.inViewport ? {} : { offscreen: true }),
  };
}

function observeView(snapshot: Snapshot, maxElements = 200) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    can_go_back: snapshot.canGoBack,
    challenge: snapshot.challenge,
    hidden_password_fields: snapshot.hiddenPasswordFields,
    element_count: snapshot.elementCount,
    truncated_elements: snapshot.truncatedElements,
    text: snapshot.text,
    elements: snapshot.elements.slice(0, maxElements).map(elementView),
  };
}

function pageSummary(snapshot: Snapshot, maxElements = 20) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    challenge: snapshot.challenge,
    element_count: snapshot.elementCount,
    text: snapshot.text.slice(0, 1500),
    elements: snapshot.elements.slice(0, maxElements).map(elementView),
  };
}

function withCost(usage: { input_tokens: number; output_tokens: number }) {
  return { ...usage, est_cost_usd: Number((usage.input_tokens * USD_PER_INPUT_TOKEN).toFixed(6)) };
}

async function currentSnapshot(maxText = 6000) {
  const page = await session.getPage();
  return takeSnapshot(page, { maxText, canGoBack: session.canGoBack });
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "browser_open",
    {
      title: "Open URL",
      description:
        "Open a URL in the shared browser page and return a compact summary (title, visible text excerpt, first elements). Deterministic: no model call, no API cost. Call this before browser_act/browser_run unless a page is already open. Use browser_observe for the full element list.",
      inputSchema: {
        url: z.string().describe("Absolute URL, or a host like example.com (https:// assumed)."),
        headed: z
          .boolean()
          .optional()
          .describe("Show the browser window. Only takes effect before the browser is first launched."),
      },
    },
    async ({ url, headed }) => {
      try {
        if (headed !== undefined) session.setHeaded(headed);
        const page = await session.open(url);
        const snapshot = await takeSnapshot(page, { maxText: 1500, canGoBack: session.canGoBack });
        return ok(pageSummary(snapshot));
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_observe",
    {
      title: "Observe page",
      description:
        "Read the current page deterministically (no model call, no cost): URL, title, visible text, and numbered interactive elements (refs e1, e2, ...). Use this when you want to decide and act yourself via browser_click / browser_type / browser_select. Offscreen elements are marked.",
      inputSchema: {
        max_chars: z.number().int().min(200).max(20000).optional().describe("Cap on visible text (default 6000)."),
        max_elements: z.number().int().min(0).max(200).optional().describe("Cap on elements (default 200)."),
      },
    },
    async ({ max_chars, max_elements }) => {
      try {
        const page = await session.getPage();
        const snapshot = await takeSnapshot(page, {
          maxText: max_chars ?? 6000,
          maxElements: max_elements ?? 200,
          canGoBack: session.canGoBack,
        });
        return ok(observeView(snapshot));
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_act",
    {
      title: "One Jev-decided step",
      description:
        "Pursue a one-sentence instruction with exactly one browser action, chosen by Jev (click, type, select, scroll, back, wait, or stop). Fast and cheap (~$0.0002). If a text field must be filled and no value is supplied, returns status 'needs_text' with the ref to fill via browser_type. Pass values as a name→text map for fields, e.g. {\"Search\": \"espresso\"}. Value contents are never sent to Jev.",
      inputSchema: {
        instruction: z.string().describe("One sentence: what should happen next."),
        values: z
          .record(z.string(), z.string())
          .optional()
          .describe("Field name or label → text to type. Example: {\"Full name\": \"Ada Lovelace\"}."),
      },
    },
    async ({ instruction, values }) => {
      try {
        const outcome = await stepOnce(session, {
          goal: instruction,
          instruction,
          values,
          stepNumber: 1,
          maxText: 6000,
        });
        return ok({
          status: outcome.status,
          step: outcome.step,
          usage: withCost(outcome.usage),
          ...(outcome.needs ? { needs: outcome.needs } : {}),
          observation: observeView(outcome.snapshot, 60),
        });
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_run",
    {
      title: "Run a goal autonomously",
      description:
        "Pursue a full browser goal autonomously: Jev decides each step, code executes and verifies it. Stops on done / goal_achieved / needs_text / needs_value / stuck / blocked / max_steps / timeout. Returns a per-step trace with confidences and token cost, plus the final page text. Fastest option for multi-step tasks; supply values for any fields it must fill.",
      inputSchema: {
        goal: z.string().describe("What to accomplish, in one or two sentences."),
        url: z.string().optional().describe("Optional URL to open first."),
        values: z
          .record(z.string(), z.string())
          .optional()
          .describe("Field name or label → text to type, for any fields the goal needs."),
        max_steps: z.number().int().min(1).max(60).optional().describe("Default 20."),
        max_seconds: z.number().int().min(5).max(600).optional().describe("Default 120."),
        max_chars: z.number().int().min(500).max(50000).optional().describe("Cap on returned page text (default 6000)."),
      },
    },
    async ({ goal, url, values, max_steps, max_seconds, max_chars }) => {
      try {
        if (url) await session.open(url);
        const outcome = await runGoal(session, {
          goal,
          values,
          maxSteps: max_steps ?? 20,
          maxSeconds: max_seconds ?? 120,
          maxChars: max_chars ?? 6000,
        });
        return ok({
          status: outcome.status,
          url: outcome.url,
          title: outcome.title,
          steps: outcome.steps,
          usage: withCost(outcome.usage),
          ...(outcome.needs ? { needs: outcome.needs } : {}),
          text: outcome.text,
        });
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click element by ref",
      description:
        "Click one element by ref from browser_observe/browser_open (e.g. \"e7\"). Deterministic: no model call, no cost. The ref is re-validated as visible and unobstructed before clicking.",
      inputSchema: {
        ref: z.string().describe("Element ref, e.g. \"e7\"."),
      },
    },
    async ({ ref }) => {
      try {
        const page = await session.getPage();
        const result = await actions.clickRef(page, ref);
        await session.settle();
        session.noteNavigation();
        const snapshot = await currentSnapshot(1200);
        return ok({ ...result, page: pageSummary(snapshot) });
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type into element by ref",
      description:
        "Type text into one field by ref from browser_observe (e.g. \"e3\"). Deterministic: no model call, no cost. Search fields submitted with submit=true press Enter after filling. Never use for passwords: password fields are never exposed as refs.",
      inputSchema: {
        ref: z.string().describe("Element ref, e.g. \"e3\"."),
        text: z.string().describe("Text to type."),
        submit: z.boolean().optional().describe("Press Enter after typing (default false)."),
      },
    },
    async ({ ref, text, submit }) => {
      try {
        const page = await session.getPage();
        const result = await actions.typeRef(page, ref, text, submit ?? false);
        await session.settle();
        session.noteNavigation();
        const snapshot = await currentSnapshot(1200);
        return ok({ ...result, page: pageSummary(snapshot) });
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_select",
    {
      title: "Select dropdown option by ref",
      description:
        "Choose an option in a native dropdown by ref from browser_observe. Deterministic: no model call, no cost. The option is matched case-insensitively, with a substring fallback.",
      inputSchema: {
        ref: z.string().describe("Ref of the <select> element."),
        option: z.string().describe("Option label to choose."),
      },
    },
    async ({ ref, option }) => {
      try {
        const page = await session.getPage();
        const result = await actions.selectRef(page, ref, option);
        await session.settle();
        session.noteNavigation();
        const snapshot = await currentSnapshot(1200);
        return ok({ ...result, page: pageSummary(snapshot) });
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_press",
    {
      title: "Press a key",
      description:
        "Press a keyboard key on the page, e.g. Enter, Escape, Tab, PageDown, ArrowDown. Deterministic: no model call, no cost. Useful to submit a form after browser_type or to dismiss overlays.",
      inputSchema: {
        key: z.string().describe("Playwright key name, e.g. Enter, Escape, Tab, PageDown."),
      },
    },
    async ({ key }) => {
      try {
        const page = await session.getPage();
        const result = await actions.pressKey(page, key);
        await session.settle();
        session.noteNavigation();
        const snapshot = await currentSnapshot(1200);
        return ok({ ...result, page: pageSummary(snapshot) });
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_extract",
    {
      title: "Extract page content",
      description:
        "Return page content deterministically (no model call, no cost): visible text (default), links, or raw HTML, optionally scoped to a CSS selector. Use this when you need the page's data rather than its actions.",
      inputSchema: {
        mode: z.enum(["text", "links", "html"]).optional().describe("Default \"text\"."),
        selector: z.string().optional().describe("Optional CSS selector to scope the extraction."),
        max_chars: z.number().int().min(200).max(200000).optional().describe("Cap on returned characters (default 20000; HTML 100000)."),
      },
    },
    async ({ mode, selector, max_chars }) => {
      try {
        const page = await session.getPage();
        const extractMode = mode ?? "text";
        const cap = max_chars ?? (extractMode === "html" ? 100000 : 20000);
        await ensurePageHelpers(page);
        const data = await page.evaluate(
          (args: { mode: string; cap: number; selector: string | null }) => {
            let element: Element | null = null;
            if (args.selector) {
              try {
                element = document.querySelector(args.selector);
              } catch {
                return { error: "invalid selector" as const };
              }
            } else {
              element = document.body;
            }
            if (!element) return { error: "selector not found" as const };

            if (args.mode === "links") {
              const links = Array.from(element.querySelectorAll("a[href]"))
                .slice(0, 300)
                .map((anchor) => ({
                  text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
                  href: (anchor as HTMLAnchorElement).href,
                }));
              return { mode: "links" as const, links };
            }
            if (args.mode === "html") {
              return { mode: "html" as const, html: element.outerHTML.slice(0, args.cap) };
            }
            const text = (element as HTMLElement).innerText ?? element.textContent ?? "";
            const collapsed = text
              .split("\n")
              .map((line) => line.replace(/\s+/g, " ").trim())
              .filter(Boolean)
              .join("\n");
            return { mode: "text" as const, text: collapsed.slice(0, args.cap) };
          },
          { mode: extractMode, cap, selector: selector ?? null },
        );
        if ("error" in data) return fail(`${data.error}${selector ? `: ${selector}` : ""}`);
        return ok(data);
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close browser",
      description: "Close the shared browser and free its resources. It relaunches automatically on the next browser_open.",
      inputSchema: {},
    },
    async () => {
      try {
        await session.close();
        return ok({ closed: true });
      } catch (error) {
        return fail(message(error));
      }
    },
  );
}

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: "jev-browser", version: "0.1.0" });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[jev-browser-mcp] ready (stdio)");

  const shutdown = async () => {
    await session.close().catch(() => {});
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}
