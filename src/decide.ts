import {
  choice,
  noul,
  TypeSafeClient,
  type EntryType,
  type Question,
} from "@typesafe-ai/sdk";
import { loadDotEnv } from "./env.js";
import {
  OPERATIONS,
  type Decision,
  type Operation,
  type PageElement,
  type Snapshot,
} from "./types.js";

let client: TypeSafeClient | null = null;

function getClient(): TypeSafeClient {
  if (!client) {
    if (!process.env.TYPESAFE_API_KEY) {
      // Pick up a key added to .env while the server was already running.
      loadDotEnv();
    }
    if (!process.env.TYPESAFE_API_KEY) {
      throw new Error(
        "TYPESAFE_API_KEY is not set. Put it in .env (see .env.example) or in the MCP server environment.",
      );
    }
    client = new TypeSafeClient();
  }
  return client;
}

function modelOption(): { model?: string } {
  const model = process.env.JEV_MODEL;
  return model ? { model } : {};
}

type AnyAnswer = {
  choice?: string;
  confidence?: number;
  noul?: number;
};

export interface DecideArgs {
  goal: string;
  instruction?: string;
  snapshot: Snapshot;
  history: { operation: string; detail: string }[];
  /** Keys of caller-supplied values (never the contents). */
  valueKeys?: string[];
  /** Element refs to omit from the action space (e.g. fields that already rejected a value). */
  excludeRefs?: string[];
  /** Operations to omit for this decision (e.g. scrolling after too many scrolls). */
  excludeOps?: string[];
}

/** One Jev request decides the next operation *and* the target element. */
export async function decide(args: DecideArgs): Promise<Decision> {
  const { snapshot } = args;

  const excluded = new Set(args.excludeRefs ?? []);
  const clickables = snapshot.elements.filter(
    (e) => e.kind === "click" && !e.disabled && !excluded.has(e.ref),
  );
  const typeables = snapshot.elements.filter(
    (e) => e.kind === "type" && !e.disabled && !excluded.has(e.ref),
  );
  const selects = snapshot.elements.filter(
    (e) => e.kind === "select" && !e.disabled && !excluded.has(e.ref),
  );

  const operationCriteria: Record<string, string> = {
    CLICK: "Click one of the clickable elements.",
  };
  if (typeables.length > 0) {
    operationCriteria.TYPE = "Fill one of the text fields.";
    operationCriteria.PRESS_ENTER =
      "Press Enter, e.g. to submit a search field that was just filled.";
  }
  if (selects.length > 0) {
    operationCriteria.SELECT = "Choose an option in one of the dropdowns.";
  }
  operationCriteria.SCROLL_DOWN = "Scroll down to reveal more content.";
  operationCriteria.SCROLL_UP = "Scroll up to reveal content.";
  if (snapshot.canGoBack) {
    operationCriteria.BACK = "Go back to the previous page.";
  }
  operationCriteria.WAIT = "Wait briefly for the page to update.";
  operationCriteria.DONE =
    "The goal is already satisfied, or cannot be improved by any further action; stop.";
  if (snapshot.challenge) {
    operationCriteria.BLOCKED =
      "The page is a bot check or hard block; stop and report it instead of guessing.";
  }
  for (const excludedOperation of args.excludeOps ?? []) {
    delete operationCriteria[excludedOperation];
  }

  const criteriaFor = (elements: PageElement[]): Record<string, string> =>
    Object.fromEntries(
      elements.map((el) => [
        el.ref,
        [
          el.ref,
          `· ${el.role}`,
          el.name ? `"${el.name}"` : "",
          el.value ? `value="${el.value}"` : "",
          el.disabled ? "· disabled" : "",
          el.inViewport ? "" : "· offscreen",
        ]
          .filter(Boolean)
          .join(" "),
      ]),
    );

  const questions: Record<string, Question> = {
    operation: choice(
      "Which single operation should be performed next, given the goal and the current page?",
      operationCriteria,
    ),
    goal_met: noul(
      "Given the page state, is the goal already fully satisfied? Answer only from evidence present in the state; do not assume unseen content.",
    ),
    stuck: noul(
      "Is the agent stuck: the current page cannot make useful progress toward the goal (hard block, login wall, missing information, or a loop)?",
    ),
  };

  if (clickables.length > 0) {
    questions.click_target = choice(
      "IF the chosen operation is CLICK, which element should be clicked? If CLICK was not chosen, pick any element.",
      criteriaFor(clickables),
    );
  }
  if (typeables.length > 0) {
    const labelHint =
      args.valueKeys && args.valueKeys.length > 0
        ? ` Available supplied value labels: ${args.valueKeys.map((key) => `"${key}"`).join(", ")}.`
        : "";
    questions.type_target = choice(
      `IF the chosen operation is TYPE, which field should be filled? Prefer a field that matches the goal and the supplied value labels.${labelHint} If TYPE was not chosen, pick any field.`,
      criteriaFor(typeables),
    );
  }
  if (selects.length > 0) {
    questions.select_target = choice(
      "IF the chosen operation is SELECT, which dropdown should be changed? If SELECT was not chosen, pick any dropdown.",
      criteriaFor(selects),
    );
  }

  const state: EntryType = {
    goal: args.goal,
    ...(args.instruction ? { instruction: args.instruction } : {}),
    ...(args.valueKeys && args.valueKeys.length > 0
      ? { supplied_value_labels: args.valueKeys }
      : {}),
    page: {
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
    },
    recent_actions:
      args.history.length > 0
        ? args.history.slice(-4).map((h) => `${h.operation}: ${h.detail}`)
        : ["none yet"],
  };

  const response = await getClient().systemOne({
    state,
    questions,
    ...modelOption(),
  });

  const answers = response.answers as unknown as Record<string, AnyAnswer>;
  const operation = answers.operation?.choice as Operation | undefined;
  if (!operation || !OPERATIONS.includes(operation)) {
    throw new Error(
      `Jev returned an unexpected operation: ${String(answers.operation?.choice)}`,
    );
  }

  const targetHead = `${operation.toLowerCase()}_target`;
  const target = answers[targetHead];

  return {
    operation,
    operationConfidence: answers.operation?.confidence,
    targetRef: target?.choice,
    targetConfidence: target?.confidence,
    goalMet: answers.goal_met?.noul,
    stuck: answers.stuck?.noul,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}

export interface SelectChoice {
  label?: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/**
 * Second-stage decision used only when a supplied value does not match the
 * field by name. The model sees the value *labels* (caller-chosen keys), never
 * the contents.
 */
export async function chooseValueKey(args: {
  goal: string;
  instruction?: string;
  field: PageElement;
  keys: string[];
}): Promise<{ key?: string; inputTokens: number; outputTokens: number }> {
  const criteria: Record<string, string> = {};
  args.keys.slice(0, 50).forEach((key) => {
    criteria[key] = key;
  });
  criteria.__none__ = "None of these values belongs in this field.";

  const questions: Record<string, Question> = {
    value: choice(
      "Which supplied value, if any, should be typed into this field? Choose __none__ if no supplied value belongs here.",
      criteria,
    ),
  };
  const state: EntryType = {
    goal: args.goal,
    ...(args.instruction ? { instruction: args.instruction } : {}),
    field: {
      label: args.field.name,
      role: args.field.role,
      current: args.field.value ?? "",
    },
  };

  const response = await getClient().systemOne({
    state,
    questions,
    ...modelOption(),
  });
  const answers = response.answers as unknown as Record<string, AnyAnswer>;
  const picked = answers.value?.choice;
  return {
    key: picked && picked !== "__none__" ? picked : undefined,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/** Second-stage decision used only when a SELECT has no caller-supplied value. */
export async function chooseSelectOption(args: {
  goal: string;
  instruction?: string;
  field: PageElement;
  options: string[];
}): Promise<SelectChoice> {
  const criteria: Record<string, string> = {};
  args.options.slice(0, 200).forEach((label, index) => {
    criteria[String(index)] = label.slice(0, 100) || `(option ${index + 1})`;
  });
  criteria.__none__ = "None of these / leave the dropdown unchanged.";

  const questions: Record<string, Question> = {
    option: choice(
      "Which option should be selected to pursue the goal? Choose __none__ if no option fits or the choice is ambiguous.",
      criteria,
    ),
  };

  const state: EntryType = {
    goal: args.goal,
    ...(args.instruction ? { instruction: args.instruction } : {}),
    dropdown: { label: args.field.name, current: args.field.value ?? "" },
  };

  const response = await getClient().systemOne({
    state,
    questions,
    ...modelOption(),
  });
  const answers = response.answers as unknown as Record<string, AnyAnswer>;
  const picked = answers.option?.choice;
  const label =
    picked && picked !== "__none__" ? args.options[Number(picked)] : undefined;

  return {
    label,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}
