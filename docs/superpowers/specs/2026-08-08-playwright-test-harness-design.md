# Playwright Test Harness for MEJ

**Date:** 2026-08-08
**Status:** Approved (design), pending implementation plan
**Problem:** Verifying fixes against live Foundry via agent-driven Playwright MCP is glacially slow — every click/snapshot is a model round-trip, and each accessibility snapshot of a Foundry page is enormous. Multi-hour verification passes for a handful of checks, worsened by 8GB RAM (Foundry node + headed Chromium + Claude Code competing).

**Goal:** Scripted checks that run in seconds via one `node` command, serving both in-session fix verification (throwaway scripts) and a durable regression suite that accretes over time. Both share the same helper library.

**Non-goals:** No `@playwright/test` runner, no CI integration (nothing to run it on), no Quench/in-Foundry test module, no world snapshot/reset machinery. MCP browsing remains available for exploratory work only, under batched-`browser_evaluate` / no-full-snapshot discipline.

## Environment (fixed constraints)

- Foundry v14 (build 14.365) at `~/FoundryVTT-14/`, launched via `start-foundry.command`, serves http://localhost:30000, pid in `Data/.pid`, logs in `Data/Logs/stdout.log`.
- Module symlinked into `~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal`.
- Test worlds: `world-a` (dnd5e, primary) plus 7 system worlds (pf2e, dsa5, dcc, dnd4e, wfrp4e, sfrpg, fallout). All users (Gamemaster, User 1, User 2) have blank passwords.
- Hardware: M2 MacBook Air, 8GB RAM → headless only, single Chromium instance, no parallel workers.

## Layout

```
test/
  package.json      — sole dependency: playwright; test/node_modules gitignored
  helpers/
    foundry.js      — server/world/login/session plumbing
    mej.js          — MEJ-specific helpers (open sheets, entities, flags)
  specs/            — durable regression specs, one file per flow
  scratch/          — throwaway fix-session scripts (gitignored)
  screenshots/      — failure artifacts (gitignored)
  run.mjs           — runs all specs or a glob, prints pass/fail summary, exit code
  README.md         — usage; directs future agents here instead of MCP
```

Plain `node` scripts using the Playwright **library** (not the test runner): one mental model for scratch scripts and specs, trivially agent-generatable, and runner parallelism is useless at 1 worker anyway.

## Helper API

`helpers/foundry.js`:

- `ensureServer()` — probe port 30000; if down, launch `start-foundry.command` and wait for readiness.
- `ensureWorld(worldId)` — if a different world (or none) is active: navigate to `/setup` (no admin password is set), shut down the active world if any, launch the target world, wait for the join screen.
- `connect({ world, users })` — ensureServer + ensureWorld, then launch one headless Chromium with **one browser context per user**. Each context logs in through the join screen (blank password) and waits for `game.ready`. Returns `{ pages: { 'Gamemaster': page, 'User 1': page }, close() }`. Dual contexts give real websocket traffic in both directions — GM+player flows (shop purchase/sell requests, socket messages) run in a single script.
- Console capture: from creation, every page buffers console messages and page errors; specs can assert "no errors" and failures dump the buffer.

`helpers/mej.js` (built on `page.evaluate` against Foundry's own API — the default way to act; DOM clicks only when UI wiring itself is under test):

- `openEntry(page, name)` — open the MEJ sheet for a journal entry by name, wait for render.
- `createEntity(page, type, data)` / `cleanup(page, runId)` — fixture management (see below).
- `getFlag` / `setFlag`, `clickIn(page, sheetSelector, targetSelector)`, `snap(page, label)` (screenshot to `test/screenshots/`).

## Fixtures and world state

- Specs never depend on hand-made entries (`Baseline Test`, `T-*` etc. stay untouched).
- Each run generates a run id; entities are named `TT-<runid>-...` and deleted in a `finally` block.
- A crashed run leaves identifiable `TT-*` litter; `run.mjs` starts with a sweep that deletes any leftover `TT-*` entities.
- No world copies or resets — fast runs, World A stays intact.

## Failure output

On assertion failure: assertion message, screenshot of each open page, buffered console log, nonzero exit. All waits/timeouts ≤15s (localhost — hangs should fail fast). `run.mjs` prints a one-line-per-spec summary and exits nonzero if any spec failed.

## Release/PR hygiene

- Release zips are hand-built (`module.json` + `module.zip` uploaded to `bularzik/monks-enhanced-journal` releases; no CI workflow). The canonical zip command goes in `test/README.md` and must exclude `test/` (`zip ... -x 'test/*'`).
- Harness work goes in dedicated commits touching only `test/`, so upstream PR branches can drop them wholesale (same filtering pattern as `.planning/` noise).
- Gitignored: `test/node_modules/`, `test/scratch/`, `test/screenshots/`.

## Seed regression specs (~6 files, each runs in seconds)

1. `smoke-sheets` — every MEJ sheet type opens in World A with zero console errors.
2. `shop-purchase` — dual-client: player requests purchase, GM approves, item transfers, currency deducted.
3. `quest-objectives` — reorder objectives, close/reopen, order persisted.
4. `currency` — add/spend currency math on a shop/loot sheet.
5. `relationships` — person relationship add cascades to the counterpart entry.
6. `loot-drop` — item dropped on loot sheet lands with correct quantity.

## Agent workflow integration

- `test/README.md` + a memory entry (`mej-playwright-harness`) make future sessions default to writing/running scripts here; MCP browsing is reserved for exploratory looks, batched via `browser_evaluate`, never full snapshots.
- Verification of the harness itself: implementation is done when `node test/run.mjs specs/smoke-sheets.mjs` passes end-to-end against World A from a cold start (server down).
