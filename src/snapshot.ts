import type { Page } from "playwright";
import type { ChallengeInfo, ElementKind, PageElement, Snapshot } from "./types.js";

export interface SnapshotOptions {
  maxText?: number;
  /** Set to 0 to skip element extraction entirely. */
  maxElements?: number;
  canGoBack?: boolean;
}

const SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=searchbox]",
  "[role=combobox]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[contenteditable=true]",
  "[contenteditable='']",
].join(",");

interface Classification {
  kind: ElementKind;
  role: string;
  submitOnType: boolean;
}

interface Candidate {
  el: Element;
  kind: ElementKind;
  role: string;
  name: string;
  value: string;
  disabled: boolean;
  inViewport: boolean;
  submitOnType: boolean;
  href: string;
  inRoot: boolean;
  top: number;
  left: number;
}

/**
 * tsx/esbuild rewrites named functions with a `__name(...)` helper. Functions
 * serialized into the page would reference it, so make sure it exists there.
 */
export async function ensurePageHelpers(page: Page): Promise<void> {
  await page
    .evaluate(
      "(() => { const w = window; if (!w.__name) { w.__name = (target, value) => { try { Object.defineProperty(target, 'name', { value, configurable: true }); } catch {} return target; }; } return true; })()",
    )
    .catch(() => {});
}

/**
 * Deterministic name search across the whole page, independent of the snapshot
 * window. Match elements get fresh refs usable with browser_click / browser_type.
 */
export async function findElements(
  page: Page,
  query: string,
  options: { maxResults?: number } = {},
): Promise<PageElement[]> {
  const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 50);
  await ensurePageHelpers(page);
  return page.evaluate(
    ({ query, maxResults, selector }) => {
      for (const el of Array.from(document.querySelectorAll("[data-jev-ref]"))) {
        el.removeAttribute("data-jev-ref");
      }
      const needle = query.toLowerCase();
      const collapse = (input: string | null | undefined, cap = 110): string =>
        (input ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
      const isVisible = (el: Element): boolean => {
        if ((el as HTMLElement).hidden) return false;
        const style = getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2;
      };
      const labelFor = (el: Element): string => {
        const he = el as HTMLElement;
        const aria = he.getAttribute("aria-label");
        if (aria) return collapse(aria);
        const text = he.innerText || he.textContent || "";
        if (text.trim()) return collapse(text, 100);
        const placeholder = he.getAttribute("placeholder");
        if (placeholder) return collapse(placeholder);
        const value = (he as HTMLInputElement).value;
        if (value) return collapse(String(value), 60);
        return "";
      };

      const inViewport = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        return (
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        );
      };

      const results: PageElement[] = [];
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (results.length >= maxResults) break;
        const tag = el.tagName.toLowerCase();
        const type = ((el as HTMLInputElement).type || "").toLowerCase();
        if (tag === "input" && (type === "password" || type === "hidden")) continue;
        if (!isVisible(el)) continue;
        const name = labelFor(el);
        if (!name || !name.toLowerCase().includes(needle)) continue;

        let kind: "click" | "type" | "select" = "click";
        let role = (el.getAttribute("role") || "").toLowerCase() || (tag === "a" ? "link" : "button");
        if (tag === "select") {
          kind = "select";
          role = "combobox";
        } else if (
          tag === "textarea" ||
          (tag === "input" && !["submit", "button", "reset", "checkbox", "radio"].includes(type))
        ) {
          kind = "type";
          role = role || "textbox";
        }

        const ref = `f${results.length + 1}`;
        el.setAttribute("data-jev-ref", ref);
        const record: PageElement = {
          ref,
          kind,
          role,
          name,
          inViewport: inViewport(el),
        };
        const value = tag === "select"
          ? collapse((el as HTMLSelectElement).selectedOptions[0]?.text ?? "", 60)
          : collapse((el as HTMLInputElement).value ?? "", 60);
        if (value) record.value = value;
        results.push(record);
      }
      return results;
    },
    { query, maxResults, selector: SELECTOR },
  );
}

/**
 * Reads the page atomically: indexed interactive elements (refs e1..eN), visible text,
 * and basic bot-check detection. No model call, no screenshots.
 */
export async function takeSnapshot(
  page: Page,
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const maxText = options.maxText ?? 6000;
  const maxElements = options.maxElements ?? 250;

  await ensurePageHelpers(page);

  const data = await page.evaluate(
    ({ maxText, maxElements, selector }) => {
      for (const el of Array.from(document.querySelectorAll("[data-jev-ref]"))) {
        el.removeAttribute("data-jev-ref");
      }

      const collapse = (input: string | null | undefined, cap = 110): string =>
        (input ?? "").replace(/\s+/g, " ").trim().slice(0, cap);

      const isVisible = (el: Element): boolean => {
        const he = el as HTMLElement;
        if (he.hidden) return false;
        const style = getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        ) {
          return false;
        }
        if (parseFloat(style.opacity || "1") < 0.05) return false;
        if (style.pointerEvents === "none") return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        return true;
      };

      const inViewport = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        return (
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        );
      };

      const labelFor = (el: Element): string => {
        const he = el as HTMLElement;
        const aria = he.getAttribute("aria-label");
        if (aria) return collapse(aria);
        const labelledBy = he.getAttribute("aria-labelledby");
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          if (parts.trim()) return collapse(parts);
        }
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        ) {
          const id = el.id;
          if (id) {
            const lab = Array.from(document.querySelectorAll("label[for]")).find(
              (l) => l.getAttribute("for") === id,
            );
            if (lab?.textContent) return collapse(lab.textContent);
          }
          const wrap = el.closest("label");
          if (wrap?.textContent) return collapse(wrap.textContent);
        }
        const placeholder = he.getAttribute("placeholder");
        if (placeholder) return collapse(placeholder);
        const alt = he.getAttribute("alt");
        if (alt) return collapse(alt);
        const title = he.getAttribute("title");
        if (title) return collapse(title);
        const text = he.innerText || he.textContent || "";
        if (text.trim()) return collapse(text, 100);
        const value = (he as HTMLInputElement).value;
        if (value) return collapse(String(value), 60);
        const name = he.getAttribute("name");
        if (name) return collapse(name, 60);
        return "";
      };

      const kindFor = (
        el: Element,
      ): Classification | { kind: "password" } | { kind: "skip" } => {
        const tag = el.tagName.toLowerCase();
        const roleAttr = (el.getAttribute("role") || "").toLowerCase();
        if (tag === "option") return { kind: "skip" };
        if (tag === "select") {
          return { kind: "select", role: "combobox", submitOnType: false };
        }
        if (tag === "textarea") {
          return { kind: "type", role: "textbox", submitOnType: false };
        }
        if (tag === "input") {
          const type = ((el as HTMLInputElement).type || "text").toLowerCase();
          if (type === "password") return { kind: "password" };
          if (type === "file" || type === "hidden" || type === "image") {
            return { kind: "skip" };
          }
          if (type === "submit" || type === "button" || type === "reset") {
            return { kind: "click", role: "button", submitOnType: false };
          }
          if (type === "checkbox" || type === "radio") {
            return { kind: "click", role: type, submitOnType: false };
          }
          if (type === "search" || roleAttr === "searchbox") {
            return { kind: "type", role: "searchbox", submitOnType: true };
          }
          return { kind: "type", role: "textbox", submitOnType: false };
        }
        if (
          el.getAttribute("contenteditable") === "true" ||
          el.getAttribute("contenteditable") === ""
        ) {
          return { kind: "type", role: "textbox", submitOnType: false };
        }
        if (roleAttr === "textbox" || roleAttr === "searchbox") {
          return { kind: "type", role: roleAttr, submitOnType: roleAttr === "searchbox" };
        }
        if (roleAttr === "combobox") {
          // Synthetic dropdown: click it open, then click the revealed option.
          return { kind: "click", role: "combobox", submitOnType: false };
        }
        if (
          tag === "a" ||
          tag === "button" ||
          tag === "summary" ||
          roleAttr === "button" ||
          roleAttr === "link" ||
          roleAttr === "tab" ||
          roleAttr === "menuitem" ||
          roleAttr === "option" ||
          roleAttr === "switch" ||
          roleAttr === "checkbox" ||
          roleAttr === "radio"
        ) {
          return {
            kind: "click",
            role: roleAttr || (tag === "a" ? "link" : "button"),
            submitOnType: false,
          };
        }
        return { kind: "skip" };
      };

      const valueFor = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        if (tag === "select") {
          return collapse((el as HTMLSelectElement).selectedOptions[0]?.text ?? "", 60);
        }
        if (tag === "input") {
          const input = el as HTMLInputElement;
          if (input.type === "checkbox" || input.type === "radio") {
            return input.checked ? "checked" : "unchecked";
          }
          return collapse(input.value, 60);
        }
        if (tag === "textarea") {
          return collapse((el as HTMLTextAreaElement).value, 60);
        }
        return "";
      };

      const isNested = (el: Element): boolean => {
        const parent = el.parentElement;
        return !!parent?.closest(selector);
      };

      const isAriaHidden = (el: Element): boolean =>
        !!el.closest('[aria-hidden="true"]');

      const contentRoots = ["#mw-content-text", "article", "main", "[role=main]"];
      let contentRoot: HTMLElement | null = null;
      for (const rootSelector of contentRoots) {
        const candidate = document.querySelector(rootSelector) as HTMLElement | null;
        if (candidate && (candidate.innerText ?? "").trim().length > 200) {
          contentRoot = candidate;
          break;
        }
      }

      const NOISE_SELECTOR = [
        ".reflist",
        ".references",
        ".navbox",
        ".navbox-styles",
        ".catlinks",
        ".mw-editsection",
        ".vector-toc",
        ".mw-portlet",
        ".vector-menu",
        ".mw-footer",
        ".printfooter",
        ".sistersitebox",
        ".interlanguage-link",
        "footer",
      ].join(",");

      let hiddenPasswordFields = 0;
      const candidates: Candidate[] = [];
      let total = 0;

      if (maxElements > 0) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          if (isAriaHidden(el) || isNested(el) || !isVisible(el)) continue;
          if (el.closest(NOISE_SELECTOR)) continue;
          const classified = kindFor(el);
          if (classified.kind === "password") {
            hiddenPasswordFields += 1;
            continue;
          }
          if (classified.kind === "skip") continue;
          const rect = el.getBoundingClientRect();
          const name = labelFor(el);
          const submitOnType =
            classified.submitOnType ||
            (classified.kind === "type" &&
              /search|zoek|suche|recherche|buscar/i.test(name));
          candidates.push({
            el,
            kind: classified.kind,
            role: classified.role,
            name,
            value: valueFor(el),
            disabled:
              (el as HTMLInputElement).disabled === true ||
              el.getAttribute("aria-disabled") === "true",
            inViewport: inViewport(el),
            submitOnType,
            href: el instanceof HTMLAnchorElement ? el.href : "",
            inRoot: !!contentRoot && contentRoot.contains(el),
            top: rect.top,
            left: rect.left,
          });
        }

        // Article content outranks browser chrome: in-content and in-viewport first,
        // then content (document order), then remaining visible chrome.
        const priority = (candidate: Candidate): number =>
          candidate.inRoot && candidate.inViewport
            ? 0
            : candidate.inRoot
              ? 1
              : candidate.inViewport
                ? 2
                : 3;
        candidates.sort((a, b) => {
          const priorityA = priority(a);
          const priorityB = priority(b);
          if (priorityA !== priorityB) return priorityA - priorityB;
          if (a.top !== b.top) return a.top - b.top;
          return a.left - b.left;
        });

        // Collapse repeated destinations: big articles link the same href many times.
        const seenHrefs = new Set<string>();
        const deduped: Candidate[] = [];
        for (const candidate of candidates) {
          if (candidate.kind === "click" && candidate.href) {
            if (seenHrefs.has(candidate.href)) continue;
            seenHrefs.add(candidate.href);
          }
          deduped.push(candidate);
        }
        total = deduped.length;
        deduped.splice(maxElements);
        candidates.length = 0;
        candidates.push(...deduped);
      }

      const elements: PageElement[] = candidates.map((c, index) => {
        const ref = `e${index + 1}`;
        c.el.setAttribute("data-jev-ref", ref);
        const record: PageElement = {
          ref,
          kind: c.kind,
          role: c.role,
          name: c.name,
          inViewport: c.inViewport,
        };
        if (c.value) record.value = c.value;
        if (c.disabled) record.disabled = true;
        if (c.submitOnType) record.submitOnType = true;
        return record;
      });

      const rawText = (contentRoot?.innerText ?? document.body?.innerText ?? "")
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
      const text = rawText.slice(0, maxText);

      const title = document.title || "";
      const headText = (document.body?.innerText ?? "").slice(0, 4000);
      const evidence: string[] = [];
      if (/just a moment|attention required|checking your browser/i.test(title)) {
        evidence.push(`title: ${title}`);
      }
      if (/verify you are human|enable javascript and cookies|cf-chl|ray id/i.test(headText)) {
        evidence.push("body: cloudflare-style challenge markers");
      }
      const challenge =
        evidence.length > 0
          ? {
              kind: /just a moment|checking your browser/i.test(title)
                ? ("challenge" as const)
                : ("block" as const),
              evidence,
            }
          : null;

      return {
        url: location.href,
        title,
        text,
        elements,
        elementCount: elements.length,
        truncatedElements: Math.max(0, total - elements.length),
        hiddenPasswordFields,
        challenge,
      };
    },
    { maxText, maxElements, selector: SELECTOR },
  );

  return {
    ...data,
    challenge: data.challenge as ChallengeInfo | null,
    canGoBack: options.canGoBack ?? false,
  };
}
