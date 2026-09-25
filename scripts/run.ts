/**
 * Ad-hoc runner for the loop, without the MCP layer.
 *
 *   npm run run -- --url https://google.com --goal "Find X" --value "Search=query" \
 *     [--max-steps 12] [--seconds 120] [--chars 3000] [--headed]
 */
import { BrowserSession } from "../src/browser.js";
import { loadDotEnv } from "../src/env.js";
import { runGoal } from "../src/loop.js";

loadDotEnv();

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function argAll(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((token, index) => {
    if (token === `--${name}`) values.push(process.argv[index + 1] ?? "");
  });
  return values;
}

const url = arg("url");
const goal = arg("goal");
if (!url || !goal) {
  console.error(
    'usage: npm run run -- --url <url> --goal "<goal>" [--value "Key=Text"]... [--max-steps N] [--seconds N] [--chars N] [--headed]',
  );
  process.exit(2);
}

const values: Record<string, string> = {};
for (const pair of argAll("value")) {
  const eq = pair.indexOf("=");
  if (eq > 0) values[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const session = new BrowserSession(process.argv.includes("--headed"));
try {
  await session.open(url);
  const outcome = await runGoal(session, {
    goal,
    values,
    maxSteps: Number(arg("max-steps") ?? 12),
    maxSeconds: Number(arg("seconds") ?? 120),
    maxChars: Number(arg("chars") ?? 3000),
  });
  console.log(JSON.stringify(outcome, null, 2));
  process.exitCode =
    outcome.status === "done" || outcome.status === "goal_achieved" ? 0 : 1;
} finally {
  await session.close();
}
