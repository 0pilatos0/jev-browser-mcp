/**
 * End-to-end loop test.
 *   npm run e2e              # local fixture (needs TYPESAFE_API_KEY)
 *   npm run e2e -- --headed  # watch the browser
 *   npm run e2e -- --live    # live Wikipedia task
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserSession } from "../src/browser.js";
import { loadDotEnv } from "../src/env.js";
import { runGoal } from "../src/loop.js";

loadDotEnv();

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const headed = process.argv.includes("--headed");
const live = process.argv.includes("--live");

const startUrl = live
  ? "https://en.wikipedia.org/wiki/Main_Page"
  : pathToFileURL(resolve(import.meta.dirname, "../fixtures/form.html")).href;

const goal = live
  ? "Search Wikipedia for 'Espresso' and open the article about the coffee drink. Stop when the article is visible."
  : "Search for 'Ristretto' in the search box, submit the search, then open the result. Stop when the article text is visible.";

const values = live
  ? { "Search Wikipedia": "Espresso" }
  : { "Search products": "Ristretto" };

const session = new BrowserSession(headed);
try {
  await session.open(startUrl);
  const outcome = await runGoal(session, {
    goal,
    values,
    maxSteps: 12,
    maxSeconds: 120,
    maxChars: 3000,
  });
  console.log(JSON.stringify(outcome, null, 2));

  const passed = live
    ? /espresso/i.test(outcome.url)
    : /Article: Ristretto/.test(outcome.text);
  console.log(passed ? "\nE2E: PASS" : "\nE2E: FAIL (expected content not observed)");
  process.exitCode = passed ? 0 : 1;
} finally {
  await session.close();
}
