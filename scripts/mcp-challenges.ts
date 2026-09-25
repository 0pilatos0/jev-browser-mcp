/**
 * Complex challenges driven through the real MCP server over stdio —
 * the same command OpenCode spawns (node dist/index.js), same tools.
 *
 *   npm run mcp-challenges
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotEnv } from "../src/env.js";

loadDotEnv();

const projectRoot = resolve(import.meta.dirname, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(projectRoot, "dist/index.js")],
  env: { ...process.env } as Record<string, string>,
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
const client = new Client({ name: "mcp-challenges", version: "0.1.0" });

type Json = Record<string, any>;

async function call(name: string, args: Json): Promise<Json> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result as Json).content ?? [])
    .filter((item: Json) => item.type === "text")
    .map((item: Json) => item.text ?? "")
    .join("\n");
  return JSON.parse(text) as Json;
}

interface Challenge {
  name: string;
  start: string;
  goal: string;
  values?: Record<string, string>;
  maxSteps?: number;
  verify: (run: Json, observe: Json | null) => boolean;
  verifyLabel: string;
  observe?: boolean;
}

const challenges: Challenge[] = [
  {
    name: "wikipedia-link-hop",
    start: "https://en.wikipedia.org/wiki/Espresso",
    goal: "Click the link in the article that leads to the Wikipedia article 'Ristretto'. Stop when the Ristretto article is open.",
    verify: (run) => /\/wiki\/Ristretto$/i.test(run.url),
    verifyLabel: "on /wiki/Ristretto",
  },
  {
    name: "wikipedia-fact",
    start: "https://en.wikipedia.org/wiki/Ristretto",
    goal: "Find the volume in millilitres of a ristretto and stop when that number is visible on the page.",
    verify: (run) => /20 ml/i.test(run.text),
    verifyLabel: "text contains '20 ml'",
  },
  {
    name: "mdn-search",
    start: "https://developer.mozilla.org/en-US/",
    goal: "Search MDN for 'AbortController' and open the AbortController interface documentation. Stop when the article is visible.",
    values: { Search: "AbortController" },
    verify: (run) => /\/docs\/Web\/API\/AbortController/i.test(run.url),
    verifyLabel: "url is /docs/Web/API/AbortController",
  },
  {
    name: "httpbin-form",
    start: "https://httpbin.org/forms/post",
    goal: "Fill the customer name, telephone, e-mail and comments fields with the supplied values. Do not submit the form. Stop when all four fields are filled.",
    values: {
      "Customer name": "Paul Test",
      Telephone: "0612345678",
      "E-mail": "paul@example.com",
      "Delivery instructions": "Filled by the Jev browser MCP (test run).",
    },
    verify: (run, observe) => {
      const values = (observe?.elements ?? [])
        .filter((element: Json) => element.kind === "type")
        .map((element: Json) => String(element.value ?? ""));
      const expected = [
        "Paul Test",
        "0612345678",
        "paul@example.com",
        "Filled by the Jev browser MCP",
      ];
      const hasAll = expected.every((wanted) =>
        values.some((value: string) => value.includes(wanted)),
      );
      const stillOnForm = /\/forms\/post$/.test(run.url);
      return hasAll && stillOnForm;
    },
    verifyLabel: "four values present and form not submitted",
    observe: true,
  },
  {
    name: "guardian-consent",
    start: "https://www.theguardian.com/international",
    goal: "Dismiss any cookie or consent banner, then open the top headline news story. Stop when the article body is visible.",
    verify: (run) => /theguardian\.com\/[a-z-]+\/20\d\d\//i.test(run.url),
    verifyLabel: "guardian article url",
  },
];

let passed = 0;
await client.connect(transport);
try {
  const first = challenges[0]!;
  await call("browser_open", { url: first.start, headed: true });

  for (const challenge of challenges) {
    console.log(`\n=== ${challenge.name} ===`);
    try {
      const startedAt = Date.now();
      const run = await call("browser_run", {
        url: challenge.start,
        goal: challenge.goal,
        ...(challenge.values ? { values: challenge.values } : {}),
        max_steps: challenge.maxSteps ?? 15,
        max_seconds: 150,
        max_chars: 4000,
      });
      const observe = challenge.observe
        ? await call("browser_observe", { max_chars: 1200, max_elements: 100 })
        : null;
      const ok = challenge.verify(run, observe);
      if (ok) passed += 1;
      console.log(
        `result: ${run.status} | verified: ${ok ? "PASS" : "FAIL"} (${challenge.verifyLabel}) | ` +
          `${((Date.now() - startedAt) / 1000).toFixed(1)}s | $${Number(run.usage?.est_cost_usd ?? 0).toFixed(6)} | ${run.steps?.length ?? 0} steps`,
      );
      for (const step of run.steps ?? []) {
        console.log(
          `  #${step.step} ${step.operation}${step.targetRef ? " " + step.targetRef : ""} | ${String(step.detail).slice(0, 110)} | conf:${step.confidence ?? "-"}`,
        );
      }
      console.log(`  final: ${run.url}`);
      if (!ok) console.log(`  text tail: ${String(run.text ?? "").slice(-250).replace(/\n/g, " | ")}`);
    } catch (error) {
      console.log(`result: RUN ERROR | ${String(error).slice(0, 200)}`);
    }
  }
} finally {
  await client.close().catch(() => {});
}

console.log(`\nSUMMARY: ${passed}/${challenges.length} passed (via MCP stdio)`);
process.exitCode = passed === challenges.length ? 0 : 1;
