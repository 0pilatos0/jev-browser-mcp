/**
 * Spawns the MCP server over stdio, lists tools, and drives the local fixture
 * through the protocol (open → observe → click). No API key needed.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(import.meta.dirname, "..");
const entry = resolve(projectRoot, "dist/index.js");
const fixture = pathToFileURL(resolve(projectRoot, "fixtures/form.html")).href;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});

const client = new Client({ name: "mcp-check", version: "0.1.0" });

try {
  await client.connect(transport);
  console.log("connected");

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((tool) => tool.name).join(", "));

  const open = await client.callTool({ name: "browser_open", arguments: { url: fixture } });
  console.log("browser_open:", textOf(open).slice(0, 240).replace(/\n/g, " "));

  const observe = await client.callTool({ name: "browser_observe", arguments: {} });
  const page = JSON.parse(textOf(observe)) as {
    elements: Array<{ ref: string; name: string }>;
    hidden_password_fields: number;
  };
  console.log(
    "browser_observe:",
    `${page.elements.length} elements,`,
    `${page.hidden_password_fields} hidden password field(s)`,
  );

  const details = page.elements.find((element) => element.name === "Show details");
  if (!details) throw new Error("expected element 'Show details' not found");
  const click = await client.callTool({
    name: "browser_click",
    arguments: { ref: details.ref },
  });
  console.log("browser_click:", textOf(click).slice(0, 160).replace(/\n/g, " "));

  console.log("MCP check: PASS");
} catch (error) {
  console.error("MCP check: FAIL", error);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
