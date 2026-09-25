# jev-browser-mcp

An MCP server that lets an LLM drive a real browser **quickly and cheaply**: [Jev](https://typesafe.ai) (TypeSafe's System One decision model) picks each step, code validates and executes it, and the calling LLM keeps the goal, the wording, and the judgment.

No screenshots in the loop. No DOM dumps into the model. One small Jev request per action (~150–500 ms, ~$0.0002), a Playwright browser underneath, and typed hand-backs when the caller needs to supply something (like text for a field).

## Why

The expensive part of an LLM browser agent is not deciding — it is *how many times you have to ask*. A normal agent loop sends a page snapshot (or screenshot) to a frontier model on every step. This server inverts that: the page becomes an indexed table of actionable elements, and one Jev request returns both **which operation** (click / type / select / scroll / back / wait / stop) and **which element**. A generative model is only involved when text genuinely must be written — and then it is *you*, the calling LLM, via a `needs_text` hand-back.

## How a step works

```
page ──► snapshot (one atomic DOM read, no model)
          → numbered elements e1..eN  (only visible, actionable, non-password)
          → visible text, title, URL, bot-check flags
              │
              ▼
   one Jev system_one call — questions evaluated in parallel:
       operation      Choice: CLICK | TYPE | SELECT | SCROLL_* | BACK | WAIT | DONE | BLOCKED
       click_target   Choice: only clickable refs     ┐
       type_target    Choice: only typeable refs      ├ one round trip
       select_target  Choice: only dropdown refs      ┘
       goal_met       Noul   independent "are we done?" check
       stuck          Noul   loop / wall detection
              │
              ▼
   code re-validates the chosen ref (visible, not covered), executes it
   stop gates in code: DONE · goal ≥ 0.85 · stuck ≥ 0.85 · budgets
```

## Tools

| Tool | Model call? | What it does |
| --- | --- | --- |
| `browser_open` | no | Open a URL, return a compact page summary. |
| `browser_observe` | no | Full deterministic read: URL, text, numbered elements with refs. |
| `browser_act` | Jev | One decided step toward a one-sentence instruction. |
| `browser_run` | Jev | Pursue a full goal autonomously with a step trace and stop reasons. |
| `browser_click` | no | Click an element by ref. |
| `browser_type` | no | Type into a field by ref (optional Enter). |
| `browser_select` | no | Choose a dropdown option by ref. |
| `browser_press` | no | Press a key (Enter, Escape, Tab, PageDown, ...). |
| `browser_find` | no | Find elements by name anywhere on the page (even outside the snapshot window); returns refs. |
| `browser_extract` | no | Return text / links / HTML, optionally scoped by CSS selector. |
| `browser_close` | no | Close the browser. |

`browser_act` and `browser_run` accept `values` — a `{field name → text}` map. Matching is deterministic and local: **value contents are never sent to Jev**. If nothing matches, the call returns `needs_text` / `needs_value` with the element ref, and you fill it with `browser_type` / `browser_select` and continue.

Password fields are never exposed as refs, never offered to Jev, and never typed by the server.

## Setup

```bash
npm install
npx playwright install chromium   # if not already cached
cp .env.example .env              # add TYPESAFE_API_KEY (console.typesafe.ai/settings/keys)
npm run smoke                     # one Jev call to prove the key works
npm run inspect                   # element table for the local fixture (no key needed)
npm run e2e                       # full loop against the local fixture
npm run e2e -- --live             # full loop against Wikipedia
npm run e2e -- --headed           # watch it
npm run build                     # compile to dist/
```

## MCP registration

OpenCode V2 exposes a server's tools grouped under its configured name — with the name `jev`, Code Mode gives you `tools.jev.browser_run(...)`. Rebuild after code changes with `npm run build`.

OpenCode V2 (`opencode.json` / `opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "jev": {
        "type": "local",
        "command": ["node", "/absolute/path/to/jev-browser-mcp/dist/index.js"]
      }
    }
  }
}
```

Or via the CLI, which preserves unrelated config:

```sh
opencode mcp add jev --global -- node /absolute/path/to/jev-browser-mcp/dist/index.js
opencode mcp list
```

The server finds its own `.env` next to the project root, so no `cwd` or `environment` entry is needed.
For development without rebuilding, point the command at `npx tsx /absolute/path/to/jev-browser-mcp/src/index.ts`.

Claude Code:

```bash
claude mcp add jev -- node /absolute/path/to/jev-browser-mcp/dist/index.js
```

## Typical agent flow

1. `browser_open {url}` → summary.
2. `browser_run {goal, values}` → executes and returns `status`, `steps[]` (operation, target, confidence, goal/stuck probabilities), token usage, cost, and the final page text.
3. On `needs_text`: `browser_type {ref, text}` → `browser_run {goal}` again (the page and session persist).
4. On `stuck` / `blocked`: read `steps[]`, call `browser_observe`, and decide yourself — deterministic tools are always available.

## Costs

Jev 1.13 bills **$42 per billion input tokens** ($0.042 / Mtok); output tokens are free. A typical step sends 2–8k tokens, so a step costs roughly **$0.0001–0.0003**, and a multi-step run a few tenths of a cent. `browser_run` reports `usage.est_cost_usd`. Deterministic tools (`observe`, `click`, `type`, `extract`, ...) cost nothing.

## Status and limits

- Single shared page per MCP session, launched headless by default (`JEV_BROWSER_HEADED=1` or `browser_open {headed:true}` to watch).
- No iframes, shadow DOM, canvas, uploads, or file inputs yet.
- Dense pages: the action pool keeps up to 1,200 refs (deduped, article-first, noise-filtered). When more than 240 links are clickable, Jev chooses in two stages (per-segment picks in one parallel request, then a final pick). Displayed snapshots cap at 250.
- A `DONE` verdict is not independent proof of success — verify with `browser_extract` when it matters.
- Page text and element labels are sent to the TypeSafe API on every Jev call. Do not use `browser_act` / `browser_run` on pages whose content must not leave your machine.

## Development

```
src/snapshot.ts   in-page extraction → indexed elements + text
src/decide.ts     Jev questions (fan-out) and answer parsing
src/actions.ts    validated execution: click / type / select / scroll / back / wait
src/loop.ts       one-step and full-run loops, stop gates, typed hand-backs
src/server.ts     MCP tool registration
scripts/          smoke, snapshot inspector, e2e, run (ad-hoc), challenges (headed suite)
```

MIT. The loop design borrows from `browser-use/jev-ultrafast` and `jkudish/jev-browser` (both MIT).
