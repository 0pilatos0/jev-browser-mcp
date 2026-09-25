import { chooseSelectOption, chooseValueKey, decide } from "./decide.js";
import * as actions from "./actions.js";
import type { BrowserSession } from "./browser.js";
import { takeSnapshot } from "./snapshot.js";
import {
  GOAL_THRESHOLD,
  STUCK_THRESHOLD,
  USD_PER_INPUT_TOKEN,
  type PageElement,
  type RunStatus,
  type Snapshot,
  type StepRecord,
  type UsageTotals,
} from "./types.js";

export interface NeedsInfo {
  ref: string;
  kind: "text" | "option";
  field: { label: string; role: string; value?: string };
  provided_values?: string[];
  options?: string[];
  hint: string;
}

export type StepStatus =
  | "executed"
  | "done"
  | "goal_achieved"
  | "stuck"
  | "blocked"
  | "needs_text"
  | "needs_value"
  | "rejected"
  | "stale"
  | "error";

export interface StepOutcome {
  status: StepStatus;
  step: StepRecord;
  usage: { input_tokens: number; output_tokens: number };
  snapshot: Snapshot;
  needs?: NeedsInfo;
}

export interface StepOptions {
  goal: string;
  instruction?: string;
  values?: Record<string, string>;
  history?: StepRecord[];
  stepNumber?: number;
  maxText?: number;
  /** Reuse the latest observation to avoid a second DOM read per step. */
  snapshot?: Snapshot;
  /** "reject" lets an autonomous run retry a different action instead of stopping. */
  onMissingValue?: "needs_text" | "reject";
  /** Refs to hide from the action space for this decision. */
  excludeRefs?: string[];
  /** Operations to hide for this decision (e.g. scrolling after too many scrolls). */
  excludeOps?: string[];
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Matches caller-supplied values to a field by name. Value *contents* are never
 * sent to Jev; only this deterministic matching happens locally.
 */
export function resolveText(
  field: PageElement,
  values?: Record<string, string>,
): { text?: string; via?: string } {
  if (!values) return {};
  const entries = Object.entries(values).filter(([, value]) => value.length > 0);
  if (entries.length === 0) return {};
  const target = normalize(field.name);
  for (const [key, value] of entries) {
    const candidate = normalize(key);
    if (candidate && candidate === target) return { text: value, via: `"${key}"` };
  }
  for (const [key, value] of entries) {
    const candidate = normalize(key);
    if (candidate && target && (target.includes(candidate) || candidate.includes(target))) {
      return { text: value, via: `"${key}"` };
    }
  }
  return {};
}

function matchValueToOption(
  options: string[],
  values: Record<string, string>,
): string | undefined {
  const normalized = options.map((option) => ({ raw: option, norm: option.trim().toLowerCase() }));
  for (const value of Object.values(values)) {
    const wanted = value.trim().toLowerCase();
    if (!wanted) continue;
    const exact = normalized.find((option) => option.norm === wanted);
    if (exact) return exact.raw;
  }
  for (const value of Object.values(values)) {
    const wanted = value.trim().toLowerCase();
    if (wanted.length < 3) continue;
    const partial = normalized.find(
      (option) => option.norm.includes(wanted) || wanted.includes(option.norm),
    );
    if (partial) return partial.raw;
  }
  return undefined;
}

function errorOutcome(
  stepNumber: number,
  snapshot: Snapshot,
  detail: string,
  error: unknown,
): StepOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "error",
    step: {
      step: stepNumber,
      operation: "ERROR",
      detail,
      error: message.slice(0, 300),
    },
    usage: { input_tokens: 0, output_tokens: 0 },
    snapshot,
  };
}

/** One observe → decide → execute cycle. */
export async function stepOnce(
  session: BrowserSession,
  options: StepOptions,
): Promise<StepOutcome> {
  const stepNumber = options.stepNumber ?? 1;
  const maxText = options.maxText ?? 6000;
  const page = await session.getPage();
  const snapshot =
    options.snapshot ??
    (await takeSnapshot(page, { maxText, canGoBack: session.canGoBack }));

  let decision;
  try {
    decision = await decide({
      goal: options.goal,
      instruction: options.instruction,
      snapshot,
      history: (options.history ?? []).map((record) => ({
        operation: record.operation,
        detail: record.detail,
      })),
      valueKeys: options.values ? Object.keys(options.values) : undefined,
      excludeRefs: options.excludeRefs,
      excludeOps: options.excludeOps,
    });
  } catch (error) {
    return errorOutcome(stepNumber, snapshot, "decision failed", error);
  }

  const usage = {
    input_tokens: decision.inputTokens,
    output_tokens: decision.outputTokens,
  };
  const step: StepRecord = {
    step: stepNumber,
    operation: decision.operation,
    detail: "",
    ...(decision.targetRef ? { targetRef: decision.targetRef } : {}),
    ...(decision.operationConfidence !== undefined
      ? { confidence: decision.operationConfidence }
      : {}),
    ...(decision.goalMet !== undefined ? { goalMet: decision.goalMet } : {}),
    ...(decision.stuck !== undefined ? { stuck: decision.stuck } : {}),
  };

  if (decision.operation === "BLOCKED") {
    step.detail = snapshot.challenge
      ? `bot check detected (${snapshot.challenge.evidence[0] ?? "unknown"})`
      : "model reported the page as blocked";
    return { status: "blocked", step, usage, snapshot };
  }
  if (decision.operation === "DONE") {
    step.detail = "model chose DONE";
    return { status: "done", step, usage, snapshot };
  }
  if (decision.goalMet !== undefined && decision.goalMet >= GOAL_THRESHOLD) {
    step.detail = `goal judged satisfied (probability ${decision.goalMet})`;
    return { status: "goal_achieved", step, usage, snapshot };
  }
  if (decision.stuck !== undefined && decision.stuck >= STUCK_THRESHOLD) {
    step.detail = `model reported the agent is stuck (probability ${decision.stuck})`;
    return { status: "stuck", step, usage, snapshot };
  }

  const needsTarget =
    decision.operation === "CLICK" ||
    decision.operation === "TYPE" ||
    decision.operation === "SELECT";
  const field = decision.targetRef
    ? snapshot.elements.find((element) => element.ref === decision.targetRef)
    : undefined;
  if (needsTarget && !field) {
    step.detail = "model chose an unknown target";
    step.error = "unknown target reference";
    return { status: "stale", step, usage, snapshot };
  }

  const beforeUrl = page.url();
  let result: actions.ActionResult;

  if (decision.operation === "BACK" && (decision.operationConfidence ?? 1) < 0.5) {
    // Going back destroys progress; never do it on a guess.
    step.operation = "WAIT";
    step.detail = `low-confidence BACK (${decision.operationConfidence ?? "?"}) replaced with a wait`;
    step.error = undefined;
    result = await actions.waitBriefly(page, 700);
  } else
  try {
    switch (decision.operation) {
      case "CLICK": {
        result = await actions.clickRef(page, field!.ref, field);
        break;
      }
      case "TYPE": {
        const resolved = resolveText(field!, options.values);
        let text = resolved.text;
        if (!text && options.values) {
          const keys = Object.keys(options.values);
          if (keys.length > 0) {
            const chosen = await chooseValueKey({
              goal: options.goal,
              instruction: options.instruction,
              field: field!,
              keys,
            });
            usage.input_tokens += chosen.inputTokens;
            usage.output_tokens += chosen.outputTokens;
            if (chosen.key) text = options.values[chosen.key];
          }
        }
        if (!text) {
          step.detail = `skipped ${field!.ref} "${field!.name}": no supplied value belongs there`;
          return {
            status: options.onMissingValue === "reject" ? "rejected" : "needs_text",
            step,
            usage,
            snapshot,
            needs: {
              ref: field!.ref,
              kind: "text",
              field: {
                label: field!.name,
                role: field!.role,
                ...(field!.value ? { value: field!.value } : {}),
              },
              provided_values: Object.keys(options.values ?? {}),
              hint: `Call browser_type with ref "${field!.ref}" and the text, then continue with browser_act or browser_run.`,
            },
          };
        }
        const currentValue = (field!.value ?? "").trim();
        if (
          currentValue &&
          (currentValue === text.trim() || text.trim().startsWith(currentValue))
        ) {
          result = { ok: true, detail: `${field!.ref} already contains the intended text` };
          break;
        }
        result = await actions.typeRef(
          page,
          field!.ref,
          text,
          field!.submitOnType === true,
          field,
        );
        if (result.ok && resolved.via) result.detail += ` (via ${resolved.via})`;
        break;
      }      case "SELECT": {
        const labels = await actions.readOptionLabels(page, field!.ref);
        let choice: string | undefined;
        if (options.values) {
          choice = matchValueToOption(labels, options.values);
        }
        if (!choice && labels.length > 0 && labels.length <= 200) {
          const decided = await chooseSelectOption({
            goal: options.goal,
            instruction: options.instruction,
            field: field!,
            options: labels,
          });
          usage.input_tokens += decided.inputTokens;
          usage.output_tokens += decided.outputTokens;
          choice = decided.label;
        }
        if (!choice) {
          step.detail = `needs an option for ${field!.ref} "${field!.name}"`;
          return {
            status: "needs_value",
            step,
            usage,
            snapshot,
            needs: {
              ref: field!.ref,
              kind: "option",
              field: { label: field!.name, role: field!.role },
              options: labels.slice(0, 30),
              hint: `Call browser_select with ref "${field!.ref}" and one of the options, or pass values to browser_act/browser_run.`,
            },
          };
        }
        result = await actions.selectRef(page, field!.ref, choice, field);
        break;
      }
      case "SCROLL_UP":
      case "SCROLL_DOWN": {
        result = await actions.scroll(page, decision.operation);
        break;
      }
      case "PRESS_ENTER": {
        result = await actions.pressKey(page, "Enter");
        break;
      }
      case "BACK": {
        result = await actions.goBack(page);
        break;
      }
      case "WAIT": {
        result = await actions.waitBriefly(page);
        break;
      }
      default: {
        result = { ok: false, detail: "unsupported operation", error: decision.operation };
      }
    }
  } catch (error) {
    return errorOutcome(stepNumber, snapshot, `${decision.operation} failed`, error);
  }

  step.detail = result.ok
    ? result.detail
    : `${result.detail} (failed: ${result.error ?? "unknown"})`;
  if (!result.ok) step.error = result.error;

  const stale =
    !result.ok &&
    !!result.error &&
    /stale|not visible|covered|unknown target/i.test(result.error);

  const settled = await session.settle();
  session.noteNavigation();
  if (settled.url() !== beforeUrl) {
    // A navigation happened: give client-rendered pages a moment to paint.
    await settled.waitForTimeout(500).catch(() => {});
  }
  const after = await takeSnapshot(settled, { maxText, canGoBack: session.canGoBack });

  return {
    status: stale ? "stale" : "executed",
    step,
    usage,
    snapshot: after,
  };
}

export interface RunOptions {
  goal: string;
  values?: Record<string, string>;
  maxSteps: number;
  maxSeconds: number;
  maxChars: number;
}

export interface RunOutcome {
  status: RunStatus;
  url: string;
  title: string;
  text: string;
  steps: StepRecord[];
  usage: UsageTotals;
  needs?: NeedsInfo;
}

/** True when the tail of the step sequence repeats a cycle of period 1-3 three times. */
function detectLoop(signatures: string[]): boolean {
  const count = signatures.length;
  for (const period of [1, 2, 3] as const) {
    const need = period * 3;
    if (count < need) continue;
    const tail = signatures.slice(count - need);
    let repeats = true;
    for (let index = period; index < need; index += 1) {
      if (tail[index] !== tail[index % period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

/** Drives the shared page toward a goal, one Jev decision per step. */
export async function runGoal(
  session: BrowserSession,
  options: RunOptions,
): Promise<RunOutcome> {
  const startedAt = Date.now();
  const steps: StepRecord[] = [];
  const signatures: string[] = [];
  const usage: UsageTotals = {
    jev_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    est_cost_usd: 0,
  };
  let status: RunStatus = "max_steps";
  let needs: NeedsInfo | undefined;
  let snapshot: Snapshot | undefined;
  let consecutiveStale = 0;
  let consecutiveScrolls = 0;
  const rejectedRefs = new Set<string>();

  for (let stepNumber = 1; stepNumber <= options.maxSteps; stepNumber += 1) {
    if (Date.now() - startedAt > options.maxSeconds * 1000) {
      status = "timeout";
      break;
    }

    const outcome = await stepOnce(session, {
      goal: options.goal,
      values: options.values,
      history: steps,
      stepNumber,
      snapshot,
      onMissingValue: "reject",
      excludeRefs: [...rejectedRefs],
      excludeOps: consecutiveScrolls >= 4 ? ["SCROLL_UP", "SCROLL_DOWN"] : [],
    });

    steps.push(outcome.step);
    if (outcome.step.operation === "SCROLL_UP" || outcome.step.operation === "SCROLL_DOWN") {
      consecutiveScrolls += 1;
    } else {
      consecutiveScrolls = 0;
    }
    const consequential = new Set([
      "CLICK",
      "TYPE",
      "SELECT",
      "PRESS_ENTER",
      "BACK",
    ]);
    if (consequential.has(outcome.step.operation)) {
      signatures.push(`${outcome.step.operation}:${outcome.step.targetRef ?? "-"}`);
    }
    usage.jev_calls += 1;
    usage.input_tokens += outcome.usage.input_tokens;
    usage.output_tokens += outcome.usage.output_tokens;
    usage.est_cost_usd = usage.input_tokens * USD_PER_INPUT_TOKEN;
    snapshot = outcome.snapshot;

    if (consequential.has(outcome.step.operation) && detectLoop(signatures)) {
      steps.push({
        step: stepNumber + 1,
        operation: "ERROR",
        detail: `loop detected (${signatures.slice(-6).join(" ")}); stopping`,
        error: "loop",
      });
      status = "stuck";
      break;
    }

    if (outcome.status === "executed") {
      consecutiveStale = 0;
      continue;
    }
    if (outcome.status === "stale" || outcome.status === "rejected") {
      if (outcome.status === "rejected" && outcome.step.targetRef) {
        rejectedRefs.add(outcome.step.targetRef);
      }
      consecutiveStale += 1;
      if (consecutiveStale <= 2) continue;
      status = outcome.status === "rejected" ? "needs_text" : "error";
      needs = outcome.needs;
      break;
    }
    if (outcome.status === "error") {
      status = "error";
      break;
    }

    status = outcome.status as RunStatus;
    needs = outcome.needs;
    break;
  }

  const page = await session.getPage();
  const finalSnapshot = await takeSnapshot(page, {
    maxText: options.maxChars,
    maxElements: 0,
    canGoBack: session.canGoBack,
  });

  const outcome: RunOutcome = {
    status,
    url: finalSnapshot.url,
    title: finalSnapshot.title,
    text: finalSnapshot.text,
    steps,
    usage,
  };
  if (needs) outcome.needs = needs;
  return outcome;
}
