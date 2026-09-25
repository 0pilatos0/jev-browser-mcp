/**
 * Headed challenge suite: six varied browser tasks with automatic verification.
 *
 *   npm run challenges              # all
 *   npm run challenges -- turing hn # filter by name substring
 *
 * Runs sequentially against the persistent Chrome profile.
 */
import { BrowserSession } from "../src/browser.js";
import { loadDotEnv } from "../src/env.js";
import { runGoal } from "../src/loop.js";

loadDotEnv();

interface Challenge {
  name: string;
  start: string;
  goal: string;
  values?: Record<string, string>;
  maxSteps?: number;
  maxSeconds?: number;
  verify: (finalUrl: string, text: string) => boolean;
  verifyLabel: string;
}

const challenges: Challenge[] = [
  {
    name: "wikipedia-search",
    start: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "Search Wikipedia for 'Alan Turing' and open his biography article. Stop when the article is visible.",
    values: { "Search Wikipedia": "Alan Turing" },
    verify: (url) => /\/wiki\/Alan_Turing$/i.test(url),
    verifyLabel: "url ends /wiki/Alan_Turing",
  },
  {
    name: "wikipedia-multihop",
    start: "https://en.wikipedia.org/wiki/Coffee",
    goal: "Navigate to the Wikipedia article 'Espresso' by clicking links inside the article (do not use search). Stop when the Espresso article is visible.",
    verify: (url) => /\/wiki\/Espresso$/i.test(url),
    verifyLabel: "url ends /wiki/Espresso",
  },
  {
    name: "wikipedia-fact",
    start: "https://en.wikipedia.org/wiki/Ristretto",
    goal: "Find the sentence that defines a ristretto as a \"short shot\" of a highly concentrated espresso. Stop when that sentence is visible on the page.",
    verify: (_url, text) => /short shot.{0,40}espresso/i.test(text),
    verifyLabel: "text contains the definition sentence",
  },
  {
    name: "hackernews-top",
    start: "https://news.ycombinator.com",
    goal: "Open the comments page of the top story on the front page. Stop when the comments are visible.",
    verify: (url) => /item\?id=\d+/.test(url),
    verifyLabel: "url contains item?id=",
  },
  {
    name: "books-cheapest",
    start: "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
    goal: "Find the cheapest book in this Travel category. Open its detail page and stop when its price is visible.",
    verify: (url, text) => /\/catalogue\/.+\/index\.html/.test(url) && /£\d+\.\d\d/.test(text),
    verifyLabel: "book detail page with a price",
  },
  {
    name: "bbc-cookie-wall",
    start: "https://www.bbc.com/news",
    goal: "Dismiss any cookie or consent banner if present, then open the top headline story. Stop when the article text is visible.",
    verify: (url) => /bbc\.(com|co\.uk)\/(news|sport)\//.test(url),
    verifyLabel: "bbc.com/co.uk news or sport article",
  },
];

const filters = process.argv.slice(2);
const session = new BrowserSession(true);
let passed = 0;
let attempted = 0;

try {
  for (const challenge of challenges) {
    if (filters.length > 0 && !filters.some((filter) => challenge.name.includes(filter))) {
      continue;
    }
    attempted += 1;
    console.log(`\n=== ${challenge.name} ===`);
    try {
      await session.open(challenge.start);
      const startedAt = Date.now();
      const outcome = await runGoal(session, {
        goal: challenge.goal,
        values: challenge.values,
        maxSteps: challenge.maxSteps ?? 15,
        maxSeconds: challenge.maxSeconds ?? 150,
        maxChars: 4000,
      });
      const ok = challenge.verify(outcome.url, outcome.text);
      if (ok) passed += 1;
      console.log(
        `result: ${outcome.status} | verified: ${ok ? "PASS" : "FAIL"} (${challenge.verifyLabel}) | ` +
          `${((Date.now() - startedAt) / 1000).toFixed(1)}s | $${outcome.usage.est_cost_usd.toFixed(6)} | ${outcome.steps.length} steps`,
      );
      for (const step of outcome.steps) {
        console.log(
          `  #${step.step} ${step.operation}${step.targetRef ? " " + step.targetRef : ""} | ${step.detail.slice(0, 110)} | conf:${step.confidence ?? "-"}`,
        );
      }
      console.log(`  final: ${outcome.url}`);
      if (!ok) {
        console.log(`  text tail: ${outcome.text.slice(-250).replace(/\n/g, " | ")}`);
      }
    } catch (error) {
      console.log(`result: RUN ERROR | ${String(error).slice(0, 200)}`);
    }
  }
} finally {
  await session.close();
}

console.log(`\nSUMMARY: ${passed}/${attempted} passed`);
process.exitCode = passed === attempted ? 0 : 1;
