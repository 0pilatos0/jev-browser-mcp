/** Prints the element table and text for fixtures/form.html. No API key needed. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserSession } from "../src/browser.js";
import { takeSnapshot } from "../src/snapshot.js";

const headed = process.argv.includes("--headed");
const file = pathToFileURL(resolve(import.meta.dirname, "../fixtures/form.html")).href;

const session = new BrowserSession(headed);
try {
  const page = await session.open(file);
  const snapshot = await takeSnapshot(page, {
    maxText: 4000,
    canGoBack: session.canGoBack,
  });
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await session.close();
}
