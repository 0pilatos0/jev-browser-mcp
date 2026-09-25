export type ElementKind = "click" | "type" | "select";

export type Operation =
  | "CLICK"
  | "TYPE"
  | "SELECT"
  | "PRESS_ENTER"
  | "SCROLL_UP"
  | "SCROLL_DOWN"
  | "BACK"
  | "WAIT"
  | "DONE"
  | "BLOCKED";

export const OPERATIONS: readonly Operation[] = [
  "CLICK",
  "TYPE",
  "SELECT",
  "PRESS_ENTER",
  "SCROLL_UP",
  "SCROLL_DOWN",
  "BACK",
  "WAIT",
  "DONE",
  "BLOCKED",
];

export interface PageElement {
  ref: string;
  kind: ElementKind;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  inViewport: boolean;
  /** For search fields: a TYPE action should also press Enter. */
  submitOnType?: boolean;
}

export interface ChallengeInfo {
  kind: "challenge" | "block";
  evidence: string[];
}

export interface Snapshot {
  url: string;
  title: string;
  /** Visible page text, whitespace-collapsed and capped. */
  text: string;
  elements: PageElement[];
  elementCount: number;
  truncatedElements: number;
  hiddenPasswordFields: number;
  challenge: ChallengeInfo | null;
  canGoBack: boolean;
}

export interface StepRecord {
  step: number;
  operation: Operation | "ERROR";
  targetRef?: string;
  detail: string;
  confidence?: number;
  goalMet?: number;
  stuck?: number;
  error?: string;
}

export interface UsageTotals {
  jev_calls: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

export interface Decision {
  operation: Operation;
  operationConfidence?: number;
  targetRef?: string;
  targetConfidence?: number;
  goalMet?: number;
  stuck?: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export type RunStatus =
  | "done"
  | "goal_achieved"
  | "stuck"
  | "needs_text"
  | "needs_value"
  | "max_steps"
  | "timeout"
  | "blocked"
  | "error";

export const GOAL_THRESHOLD = 0.85;
export const STUCK_THRESHOLD = 0.85;
/** USD per input token for jev-1.13.0 ($42 per billion tokens); output is free. */
export const USD_PER_INPUT_TOKEN = 42 / 1e9;
