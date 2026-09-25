#!/usr/bin/env node
import { loadDotEnv } from "./env.js";
import { startServer } from "./server.js";

loadDotEnv();

startServer().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[jev-browser-mcp] fatal: ${message}`);
  process.exit(1);
});
