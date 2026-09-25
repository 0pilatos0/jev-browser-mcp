import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Project-root .env, regardless of the client's working directory. */
function defaultEnvPath(): string {
  try {
    return fileURLToPath(new URL("../.env", import.meta.url));
  } catch {
    return resolve(process.cwd(), ".env");
  }
}

/**
 * Minimal .env loader: fills process.env for keys that are not already set.
 * Values are never logged.
 */
export function loadDotEnv(path: string = defaultEnvPath()): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function envFlag(name: string): boolean {
  const v = process.env[name];
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}
