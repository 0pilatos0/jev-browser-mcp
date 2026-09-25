/**
 * Guided wikirace: Netherlands -> microchip (via Philips), through the MCP server.
 * Demonstrates the planner-above pattern: the caller plans hops, the executor
 * (browser_find + browser_click) performs them deterministically.
 *
 *   npm run wikirace
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotEnv } from "../src/env.js";

loadDotEnv();

type Json = Record<string, any>;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, "../dist/index.js")],
  env: { ...process.env } as Record<string, string>,
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
const client = new Client({ name: "wikirace", version: "0.1.0" });

async function call(name: string, args: Json): Promise<Json> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result as Json).content ?? [])
    .filter((item: Json) => item.type === "text")
    .map((item: Json) => item.text ?? "")
    .join("\n");
  return JSON.parse(text) as Json;
}

const TARGET = /\/wiki\/(Integrated_circuit|Microchip)/i;

await client.connect(transport);
try {
  await call("browser_open", { url: "https://en.wikipedia.org/wiki/Netherlands", headed: true });

  // Hop 1: Netherlands -> Philips
  let found = await call("browser_find", { query: "Philips", max_results: 5 });
  console.log("find 'Philips':", found.match_count, "match(es)", JSON.stringify(found.matches?.slice(0, 3).map((m: Json) => `${m.ref}:${m.name}`)));
  let clicked = await call("browser_click", { ref: found.matches[0].ref });
  console.log("click:", clicked.detail, "| ok:", clicked.ok, "| →", clicked.page?.url);

  // Hop 2: Philips -> integrated circuit / semiconductor
  for (const query of ["Integrated circuit", "Semiconductor", "Microchip"]) {
    if (TARGET.test((clicked.page?.url as string) ?? "")) break;
    found = await call("browser_find", { query, max_results: 5 });
    if (!found.match_count) {
      console.log(`find '${query}': no match`);
      continue;
    }
    console.log(`find '${query}':`, JSON.stringify(found.matches.slice(0, 3).map((m: Json) => `${m.ref}:${m.name}`)));
    clicked = await call("browser_click", { ref: found.matches[0].ref });
    console.log("click:", clicked.detail, "| ok:", clicked.ok, "| →", clicked.page?.url);
  }

  const finalUrl = clicked.page?.url as string;
  const reached = TARGET.test(finalUrl);
  console.log(reached ? `\nWIKIRACE: PASS (${finalUrl})` : `\nWIKIRACE: FAIL (${finalUrl})`);
  process.exitCode = reached ? 0 : 1;
} finally {
  await client.close().catch(() => {});
}
