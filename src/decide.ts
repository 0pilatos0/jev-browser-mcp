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
}

/** One Jev request decides the next operation *and* the target element. */
export async function decide(args: DecideArgs): Promise<Decision> {
  const { snapshot } = args;

  const clickables = snapshot.elements.filter(
    (e) => e.kind === "click" && !e.disabled,
  );
  const typeables = snapshot.elements.filter(
    (e) => e.kind === "type" && !e.disabled,
  );
  const selects = snapshot.elements.filter(
    (e) => e.kind === "select" && !e.disabled,
  );

  const operationCriteria: Record<string, string> = {
    CLICK: "Click one of the clickable elements.",
  };
  if (typeables.length > 0) {
    operationCriteria.TYPE = "Fill one of the text fields.";
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
    questions.type_target = choice(
      "IF the chosen operation is TYPE, which field should be filled? If TYPE was not chosen, pick any field.",
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
