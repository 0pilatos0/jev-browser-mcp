/**
 * Guided shoelace wikirace: Netherlands -> clogs -> footwear/shoe -> Shoelaces,
 * through the MCP server. Planner-above pattern: ordered candidate hops, each
 * executed deterministically with browser_find (exact first, then substring)
 * and browser_click (tries each match until one clicks).
 *
 *   npm run shoelace
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotEnv } from "../src/env.js";

loadDotEnv();

type Json = Record<string, any>;

const HOP_STAGES = [["clog"], ["footwear", "shoe"], ["shoelace", "shoe"], ["shoelace"]];
const TARGET = /\/wiki\/Shoelaces?$/i;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(import.meta.dirname, "../dist/index.js")],
  env: { ...process.env } as Record<string, string>,
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
const client = new Client({ name: "shoelace", version: "0.1.0" });

async function call(name: string, args: Json): Promise<Json> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result as Json).content ?? [])
    .filter((item: Json) => item.type === "text")
    .map((item: Json) => item.text ?? "")
    .join("\n");
  return JSON.parse(text) as Json;
}

async function findAndClick(query: string): Promise<Json | null> {
  for (const exact of [true, false]) {
    const found = await call("browser_find", {
      query,
      max_results: 8,
      ...(exact ? { exact: true } : {}),
    });
    if (!found.match_count) continue;
    console.log(
      `find '${query}'${exact ? " (exact)" : ""}:`,
      JSON.stringify(found.matches.slice(0, 5).map((m: Json) => `${m.ref}:${String(m.name).slice(0, 45)}`)),
    );
    for (const match of found.matches) {
      const clicked = await call("browser_click", { ref: match.ref });
      console.log(
        `  click ${match.ref} → ok:${clicked.ok}${clicked.ok ? "" : " err:" + (clicked.error ?? "?")} → ${clicked.page?.url}`,
      );
      if (clicked.ok) return clicked;
    }
  }
  return null;
}

await client.connect(transport);
try {
  await call("browser_open", { url: "https://en.wikipedia.org/wiki/Netherlands", headed: true });
  let currentUrl = "https://en.wikipedia.org/wiki/Netherlands";

  for (const stage of HOP_STAGES) {
    if (TARGET.test(currentUrl)) break;
    let advanced = false;
    for (const query of stage) {
      const clicked = await findAndClick(query);
      if (clicked) {
        currentUrl = (clicked.page?.url as string) ?? currentUrl;
        advanced = true;
        break;
      }
      console.log(`no usable match for '${query}'`);
    }
    if (!advanced) break;
  }

  const reached = TARGET.test(currentUrl);
  console.log(reached ? `\nSHOELACE RACE: PASS (${currentUrl})` : `\nSHOELACE RACE: FAIL (${currentUrl})`);
  process.exitCode = reached ? 0 : 1;
} finally {
  await client.close().catch(() => {});
}
