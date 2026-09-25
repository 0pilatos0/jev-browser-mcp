import type { Locator, Page } from "playwright";
import { ensurePageHelpers } from "./snapshot.js";
import type { PageElement } from "./types.js";

export interface ActionResult {
  ok: boolean;
  detail: string;
  error?: string;
}

type TargetCheck = { ok: true } | { ok: false; reason: string };

function shorten(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 200) ?? "unknown error";
}

async function occlusion(
  locator: Locator,
): Promise<{ visible: boolean; covered: boolean; occluder?: string }> {
  return locator
    .evaluate((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return { visible: false, covered: false };
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        const label = (top.getAttribute("aria-label") || top.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        return {
          visible: true,
          covered: true,
          occluder: `${top.tagName.toLowerCase()}${label ? ` "${label}"` : ""}`,
        };
      }
      return { visible: true, covered: false };
    })
    .catch(() => ({ visible: false, covered: false }));
}

/** Re-checks that a ref still points at a single, visible, unobstructed element. */
async function verifyTarget(page: Page, ref: string): Promise<TargetCheck> {
  await ensurePageHelpers(page);
  const locator = page.locator(`[data-jev-ref="${ref}"]`);
  if ((await locator.count()) !== 1) return { ok: false, reason: "stale reference" };
  const state = await occlusion(locator);
  if (!state.visible) return { ok: false, reason: "element is not visible" };
  if (state.covered) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    let recheck = await occlusion(locator);
    if (!recheck.visible) return { ok: false, reason: "element is not visible" };
    if (recheck.covered) {
      // Autocomplete lists, menus, and popups overlay the target. Dismiss them
      // with Escape and re-check before giving up.
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(120);
      recheck = await occlusion(locator);
      if (!recheck.visible) return { ok: false, reason: "element is not visible" };
      if (recheck.covered) {
        return {
          ok: false,
          reason: `element is covered by ${recheck.occluder ?? "another element"}`,
        };
      }
    }
  }
  return { ok: true };
}

export async function clickRef(
  page: Page,
  ref: string,
  element?: PageElement,
): Promise<ActionResult> {
  const check = await verifyTarget(page, ref);
  if (!check.ok) return { ok: false, detail: `click ${ref}`, error: check.reason };
  const label = element?.name ? ` "${element.name}"` : "";
  const locator = page.locator(`[data-jev-ref="${ref}"]`);
  // Center first: scrollIntoViewIfNeeded can park the element under a sticky header.
  await locator
    .evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }))
    .catch(() => {});
  try {
    await locator.click({ timeout: 5000 });
    return { ok: true, detail: `click ${ref}${label}` };
  } catch (firstError) {
    try {
      await locator.evaluate((el) => (el as HTMLElement).click());
      return { ok: true, detail: `click ${ref}${label} (DOM click fallback)` };
    } catch {
      return { ok: false, detail: `click ${ref}${label}`, error: shorten(firstError) };
    }
  }
}

export async function typeRef(
  page: Page,
  ref: string,
  text: string,
  submit: boolean,
  element?: PageElement,
): Promise<ActionResult> {
  const check = await verifyTarget(page, ref);
  if (!check.ok) return { ok: false, detail: `type ${ref}`, error: check.reason };
  const label = element?.name ? ` "${element.name}"` : "";
  const preview = text.replace(/\s+/g, " ").slice(0, 40);
  const locator = page.locator(`[data-jev-ref="${ref}"]`);
  try {
    await locator.fill(text, { timeout: 5000 });
    if (submit) await locator.press("Enter", { timeout: 3000 });
    return {
      ok: true,
      detail: `type "${preview}" into ${ref}${label}${submit ? " + Enter" : ""}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `type "${preview}" into ${ref}${label}`,
      error: shorten(error),
    };
  }
}

export async function readOptionLabels(page: Page, ref: string): Promise<string[]> {
  await ensurePageHelpers(page);
  const locator = page.locator(`[data-jev-ref="${ref}"]`);
  if ((await locator.count()) !== 1) return [];
  return locator
    .evaluate((el) =>
      Array.from((el as HTMLSelectElement).options ?? []).map((option) =>
        (option.label || option.text || "").trim(),
      ),
    )
    .catch(() => []);
}

export async function selectRef(
  page: Page,
  ref: string,
  optionLabel: string,
  element?: PageElement,
): Promise<ActionResult> {
  const check = await verifyTarget(page, ref);
  if (!check.ok) return { ok: false, detail: `select ${ref}`, error: check.reason };
  const locator = page.locator(`[data-jev-ref="${ref}"]`);
  const labels = await readOptionLabels(page, ref);
  const wanted = optionLabel.trim().toLowerCase();
  let index = labels.findIndex((label) => label.toLowerCase() === wanted);
  if (index === -1) index = labels.findIndex((label) => label.toLowerCase().includes(wanted));
  if (index === -1) {
    return {
      ok: false,
      detail: `select "${optionLabel}" in ${ref}`,
      error: `option not found (have: ${labels.slice(0, 8).join(", ")})`,
    };
  }
  const label = element?.name ? ` "${element.name}"` : "";
  try {
    await locator.selectOption({ index }, { timeout: 5000 });
    return { ok: true, detail: `select "${labels[index]}" in ${ref}${label}` };
  } catch (error) {
    return {
      ok: false,
      detail: `select "${optionLabel}" in ${ref}${label}`,
      error: shorten(error),
    };
  }
}

export async function scroll(page: Page, direction: "SCROLL_UP" | "SCROLL_DOWN"): Promise<ActionResult> {
  const delta = direction === "SCROLL_DOWN" ? 650 : -650;
  try {
    await page.evaluate((dy) => window.scrollBy(0, dy), delta);
    return { ok: true, detail: direction === "SCROLL_DOWN" ? "scroll down" : "scroll up" };
  } catch (error) {
    return { ok: false, detail: "scroll", error: shorten(error) };
  }
}

export async function goBack(page: Page): Promise<ActionResult> {
  try {
    const response = await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
    if (!response) return { ok: false, detail: "go back", error: "no previous page in history" };
    return { ok: true, detail: "go back" };
  } catch (error) {
    return { ok: false, detail: "go back", error: shorten(error) };
  }
}

export async function waitBriefly(page: Page, ms = 500): Promise<ActionResult> {
  try {
    await page.waitForTimeout(ms);
    return { ok: true, detail: `wait ${ms}ms` };
  } catch (error) {
    return { ok: false, detail: "wait", error: shorten(error) };
  }
}

export async function pressKey(page: Page, key: string): Promise<ActionResult> {
  try {
    await page.keyboard.press(key);
    return { ok: true, detail: `press ${key}` };
  } catch (error) {
    return { ok: false, detail: `press ${key}`, error: shorten(error) };
  }
}
