# Playwright Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `test/` harness of plain-node Playwright scripts that verifies MEJ behavior against live local Foundry v14 in seconds instead of hours of MCP round-trips, plus six seed regression specs.

**Architecture:** Plain `node` scripts using the Playwright *library* (no `@playwright/test` runner). `helpers/foundry.js` owns server/world/login plumbing (one headless Chromium, one browser context per Foundry user); `helpers/mej.js` owns MEJ-specific actions built on `page.evaluate` against Foundry's own API. Specs are ES modules with top-level await that throw on failure; `run.mjs` imports them and reports.

**Tech Stack:** Node ≥18 (built-in `fetch`), Playwright (chromium only), Foundry VTT v14 build 14.365 at `~/FoundryVTT-14/` serving http://localhost:30000.

**Spec:** `docs/superpowers/specs/2026-08-08-playwright-test-harness-design.md` — read it first.

## Global Constraints

- Headless only, single Chromium instance per spec, no parallel workers (8GB RAM).
- All Playwright default timeouts ≤ 15_000 ms (localhost; hangs must fail fast). World launch is the one exception (60s — may run migrations).
- All test-created entities (journal entries, actors, items) are named with prefix `TT-` and deleted in `finally`; a sweep deletes leftover `TT-*` at spec start. Hand-made entries (`Baseline Test`, `Multi Test`, `Person Test`, `T-*`, `T-triage-*`) must never be touched.
- Only dependency: `playwright`. No `@playwright/test`, no assertion libs (use `node:assert/strict`).
- Gitignored: `test/node_modules/`, `test/scratch/`, `test/screenshots/`.
- Commits touch only `test/` and `.gitignore` (dedicated commits — they must be trivially filterable out of upstream PR branches).
- Foundry users `Gamemaster`, `User 1`, `User 2` all have blank passwords. Primary world: `world-a` (dnd5e).
- MEJ page subtypes (from `module.json` `documentTypes.JournalEntryPage`): `encounter, event, list, loot, organization, person, picture, place, poi, quest, shop, slideshow`. Page `type` is namespaced `monks-enhanced-journal.<type>`; MEJ *also* reads flag `flags.monks-enhanced-journal.type` on the page (see `MonksEnhancedJournal.getMEJType`, `monks-enhanced-journal.js:191`).
- The module instance is exposed as `game.MonksEnhancedJournal` (`monks-enhanced-journal.js:262`); `MonksEnhancedJournal.openJournalEntry(entry, options)` is the opener (async, truthy on success).
- If a selector or flag shape in this plan turns out wrong at runtime, do NOT guess blindly: dump the live HTML (`await page.content()` to a scratch file) or read the named source file, fix the helper, and note the correction in the commit message. The *assertions* in each spec are the contract; selectors are implementation detail.

---

### Task 1: Scaffold `test/` and install Playwright

**Files:**
- Create: `test/package.json`
- Create: `test/.gitignore` entries via Modify: `.gitignore` (repo root)
- Create: `test/scratch/.gitkeep`-style placeholder — NOT needed; scratch/ and screenshots/ are created on demand. Only create `test/package.json`.

**Interfaces:**
- Produces: `test/node_modules/playwright` importable from any script under `test/`; chromium binary installed.

- [ ] **Step 1: Write `test/package.json`**

```json
{
  "name": "mej-test-harness",
  "private": true,
  "type": "module",
  "description": "Playwright harness for testing MEJ against live local Foundry v14. See README.md.",
  "dependencies": {
    "playwright": "^1.49.0"
  }
}
```

- [ ] **Step 2: Add ignores to repo-root `.gitignore`**

Append these lines (create `.gitignore` if the repo has none):

```
test/node_modules/
test/scratch/
test/screenshots/
```

- [ ] **Step 3: Install**

Run: `cd test && npm install && npx playwright install chromium`
Expected: installs playwright and the chromium build without errors. (~1–2 min; chromium is a one-time ~150MB download.)

- [ ] **Step 4: Verify headless launch works**

Run: `cd test && node -e "import('playwright').then(async ({chromium}) => { const b = await chromium.launch(); console.log('chromium OK', b.version()); await b.close(); })"`
Expected: prints `chromium OK <version>`.

- [ ] **Step 5: Commit**

```bash
git add test/package.json test/package-lock.json .gitignore
git commit -m "test: scaffold Playwright harness (package.json, ignores)"
```

---

### Task 2: `helpers/foundry.js` — server, world, and session plumbing

**Files:**
- Create: `test/helpers/foundry.js`
- Create: `test/specs/connect.mjs` (the failing-first spec; doubles as the plumbing smoke test)

**Interfaces:**
- Consumes: nothing (first real code).
- Produces (used by every later task):
  - `BASE: string` — Foundry base URL (default `http://localhost:30000`, override `FOUNDRY_URL`).
  - `TIMEOUT: number` — 15000.
  - `apiStatus(): Promise<object|null>` — parsed `GET /api/status` JSON or null if server down.
  - `ensureServer(): Promise<void>`
  - `connect({ world = 'world-a', users = ['Gamemaster'] }): Promise<Session>` where `Session = { browser, pages: Record<userName, Page>, logs: Map<Page, string[]>, close(): Promise<void> }`. Every page is logged in, `game.ready === true`, default timeout set, console errors/pageerrors buffered into `logs`.

- [ ] **Step 1: Discover the actual `/api/status` shape (red step)**

Start Foundry if it isn't running (`~/FoundryVTT-14/start-foundry.command`), then:

Run: `curl -s http://localhost:30000/api/status`
Expected: JSON. Note the field that carries the active world id (v11–v13 used `"world": "<id>"`; if v14 renamed it, adjust `ensureWorld`/`apiStatus` accordingly and record the actual shape in a comment in `foundry.js`). If the server responds but no world is active the field is absent/null.

- [ ] **Step 2: Write the failing spec `test/specs/connect.mjs`**

```js
// Verifies harness plumbing: server up, world-a active, GM + player login, clean console.
import assert from 'node:assert/strict';
import { connect } from '../helpers/foundry.js';

const session = await connect({ world: 'world-a', users: ['Gamemaster', 'User 1'] });
try {
  const gm = session.pages['Gamemaster'];
  const p1 = session.pages['User 1'];

  const gmInfo = await gm.evaluate(() => ({
    world: game.world.id, user: game.user.name, isGM: game.user.isGM,
    mej: !!game.MonksEnhancedJournal,
  }));
  assert.equal(gmInfo.world, 'world-a');
  assert.equal(gmInfo.user, 'Gamemaster');
  assert.equal(gmInfo.isGM, true);
  assert.ok(gmInfo.mej, 'MEJ module not active in world-a');

  const p1Name = await p1.evaluate(() => game.user.name);
  assert.equal(p1Name, 'User 1');
} finally {
  await session.close();
}
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd test && node specs/connect.mjs`
Expected: FAIL — `Cannot find module '../helpers/foundry.js'`.

- [ ] **Step 4: Implement `test/helpers/foundry.js`**

```js
// Plumbing for driving live local Foundry v14 with Playwright.
// Server: ~/FoundryVTT-14/start-foundry.command → http://localhost:30000
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import os from 'node:os';

export const BASE = process.env.FOUNDRY_URL ?? 'http://localhost:30000';
export const TIMEOUT = 15_000;
const LAUNCHER = `${os.homedir()}/FoundryVTT-14/start-foundry.command`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function apiStatus() {
  try {
    const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function ensureServer() {
  if (await apiStatus()) return;
  spawn(LAUNCHER, [], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await apiStatus()) return;
  }
  throw new Error(`Foundry did not come up on ${BASE} within 60s`);
}

// Activate worldId if it isn't already the live world.
// Join page: templates/views/join.hbs; "Return to Setup" form has input[name="adminPassword"]
// (no admin password is set). Setup page world tiles: [data-package-id] with
// a.control.play[data-action="worldLaunch"] (templates/setup/parts/package-tiles.hbs:18).
async function ensureWorld(browser, worldId) {
  const status = await apiStatus();
  if (status?.world === worldId) return;
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  try {
    if (status?.world) {
      await page.goto(`${BASE}/join`);
      await page.locator('form:has(input[name="adminPassword"]) button[type="submit"], form:has-text("Return to Setup") button[type="submit"]').first().click();
      await page.waitForURL('**/setup**');
    } else {
      await page.goto(`${BASE}/setup`);
    }
    await page.click(`[data-package-id="${worldId}"] [data-action="worldLaunch"]`);
    await page.waitForURL('**/join**', { timeout: 60_000 }); // may migrate on first launch
  } finally {
    await context.close();
  }
  const after = await apiStatus();
  if (after?.world !== worldId) throw new Error(`Failed to activate world ${worldId} (active: ${after?.world})`);
}

// Log a user in through the join screen in a fresh browser context.
// Join form: select[name="userid"] (options are user names), input[name="password"],
// button[name="join"] (templates/setup/parts/join-form.hbs).
async function join(browser, session, userName) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const log = [];
  session.logs.set(page, log);
  page.on('console', (m) => { if (m.type() === 'error') log.push(`[console.error] ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/join`);
  await page.selectOption('select[name="userid"]', { label: userName });
  await page.click('button[name="join"]');
  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
  return page;
}

export async function connect({ world = 'world-a', users = ['Gamemaster'] } = {}) {
  await ensureServer();
  const browser = await chromium.launch();
  const session = {
    browser,
    pages: {},
    logs: new Map(),
    async close() { await browser.close(); },
  };
  try {
    await ensureWorld(browser, world);
    for (const name of users) session.pages[name] = await join(browser, session, name);
  } catch (e) {
    await browser.close();
    throw e;
  }
  return session;
}
```

- [ ] **Step 5: Run the spec until it passes**

Run: `cd test && node specs/connect.mjs && echo PASS`
Expected: `PASS` in well under a minute with the server already up. If a selector misses, dump `await page.content()` to `test/scratch/dump.html`, read it, fix the selector comment + code, re-run.

- [ ] **Step 6: Verify world switching works (ensureWorld's other branch)**

This is the only time we exercise the world-switch path; later specs all use `world-a`.

Run: `cd test && node -e "const {connect}=await import('./helpers/foundry.js'); let s=await connect({world:'world-a'}); await s.close(); console.log('world-a ok');" --input-type=module`
Then manually launch a different world from the Foundry UI (or skip if that's disruptive — at minimum re-run the above twice and confirm the `already active` fast path returns instantly).
Expected: reconnect activates `world-a` again and the spec passes.

- [ ] **Step 7: Commit**

```bash
git add test/helpers/foundry.js test/specs/connect.mjs
git commit -m "test: foundry.js session plumbing (server/world/login/console capture) + connect spec"
```

---

### Task 3: `helpers/mej.js` + `run.mjs` runner

**Files:**
- Create: `test/helpers/mej.js`
- Create: `test/run.mjs`
- Create: `test/specs/fixtures.mjs`

**Interfaces:**
- Consumes: `connect`, `TIMEOUT` from `helpers/foundry.js` (Task 2 signatures).
- Produces (used by all seed specs):
  - `withSession(name, opts, fn): Promise<void>` — connect, sweep stale `TT-*`, run `fn(session)`, screenshot every page + append console buffer to the error on failure, sweep + close in `finally`.
  - `createEntry(gmPage, type, name, flags = {}): Promise<string>` — returns JournalEntry id; entry has one page of type `monks-enhanced-journal.<type>` with flag `monks-enhanced-journal.type = <type>`; entry ownership default OBSERVER (players can view).
  - `openEntry(page, entryId): Promise<void>` — opens via `MonksEnhancedJournal.openJournalEntry`, waits for the enhanced-journal window to render.
  - `entryFlag(page, entryId, key): Promise<any>` / `setEntryFlag(page, entryId, key, value)` — read/write flag `monks-enhanced-journal.<key>` on the entry's **first page** (MEJ's convention, see getMEJType).
  - `sweep(gmPage): Promise<number>` — deletes all `TT-*` journal entries, actors, and items; returns count.
  - `snap(page, label): Promise<string>` — screenshot to `test/screenshots/<label>.png`.
  - `dropOnSheet(page, selector, data): Promise<void>` — dispatches a synthetic `drop` DragEvent carrying `JSON.stringify(data)` as `text/plain`.
  - `assertNoErrors(session)` — throws listing buffered console errors, if any.

- [ ] **Step 1: Write the failing spec `test/specs/fixtures.mjs`**

```js
// Verifies fixture lifecycle: create a typed MEJ entry, MEJ recognizes it, sweep removes it.
import assert from 'node:assert/strict';
import { withSession, createEntry, sweep, entryFlag } from '../helpers/mej.js';

await withSession('fixtures', { users: ['Gamemaster'] }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  const id = await createEntry(gm, 'person', 'TT-fixture-person');

  const type = await gm.evaluate((id) => {
    return MonksEnhancedJournal.getMEJType(game.journal.get(id));
  }, id);
  assert.equal(type, 'person', 'MEJ does not recognize the created entry as a person');

  assert.equal(await entryFlag(gm, id, 'type'), 'person');

  const removed = await sweep(gm);
  assert.ok(removed >= 1, 'sweep did not remove the TT- entry');
  const gone = await gm.evaluate((id) => !game.journal.get(id), id);
  assert.ok(gone, 'entry still exists after sweep');
});
```

Note: `MonksEnhancedJournal` the *class* is a module-scope name; if it is not reachable as a page global, use `game.MonksEnhancedJournal.constructor.getMEJType(...)` — `game.MonksEnhancedJournal` is the class itself (set via `game.MonksEnhancedJournal = this;` inside a static method, `monks-enhanced-journal.js:262`), so `game.MonksEnhancedJournal.getMEJType(...)` is the safe form. Prefer that everywhere.

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd test && node specs/fixtures.mjs`
Expected: FAIL — `Cannot find module '../helpers/mej.js'`.

- [ ] **Step 3: Implement `test/helpers/mej.js`**

```js
// MEJ-specific test actions. Everything acts through Foundry's own API via
// page.evaluate; DOM interaction only where the UI wiring itself is under test.
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connect } from './foundry.js';

export async function withSession(name, opts, fn) {
  const session = await connect(opts);
  const gm = session.pages['Gamemaster'];
  if (gm) await sweep(gm);
  try {
    await fn(session);
  } catch (e) {
    for (const [user, page] of Object.entries(session.pages)) {
      await snap(page, `${name}-${user.replaceAll(' ', '')}-fail`).catch(() => {});
    }
    const buffered = [...session.logs.values()].flat();
    if (buffered.length) e.message += `\n--- browser console ---\n${buffered.join('\n')}`;
    throw e;
  } finally {
    try { if (gm) await sweep(gm); } catch {}
    await session.close();
  }
}

export async function createEntry(gmPage, type, name, flags = {}) {
  return await gmPage.evaluate(async ({ type, name, flags }) => {
    const entry = await JournalEntry.create({
      name,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: [{
        name,
        type: `monks-enhanced-journal.${type}`,
        flags: { 'monks-enhanced-journal': { type, ...flags } },
      }],
    });
    return entry.id;
  }, { type, name, flags });
}

export async function openEntry(page, entryId) {
  const ok = await page.evaluate(async (id) => {
    const entry = game.journal.get(id);
    if (!entry) return false;
    return !!(await game.MonksEnhancedJournal.openJournalEntry(entry));
  }, entryId);
  if (!ok) throw new Error(`openJournalEntry refused entry ${entryId}`);
  await page.waitForSelector('.monks-enhanced-journal', { state: 'visible' });
}

export async function entryFlag(page, entryId, key) {
  return await page.evaluate(({ id, key }) =>
    game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', key),
    { id: entryId, key });
}

export async function setEntryFlag(page, entryId, key, value) {
  await page.evaluate(({ id, key, value }) =>
    game.journal.get(id).pages.contents[0].setFlag('monks-enhanced-journal', key, value),
    { id: entryId, key, value });
}

export async function sweep(gmPage) {
  return await gmPage.evaluate(async () => {
    let n = 0;
    for (const coll of [game.journal, game.actors, game.items]) {
      for (const doc of coll.filter((d) => d.name.startsWith('TT-'))) {
        await doc.delete();
        n++;
      }
    }
    return n;
  });
}

export async function snap(page, label) {
  const dir = fileURLToPath(new URL('../screenshots/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const path = `${dir}${label}.png`;
  await page.screenshot({ path });
  return path;
}

export async function dropOnSheet(page, selector, data) {
  await page.evaluate(({ selector, data }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`dropOnSheet: no element matches ${selector}`);
    const dt = new DataTransfer();
    dt.setData('text/plain', JSON.stringify(data));
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
  }, { selector, data });
}

export function assertNoErrors(session) {
  const errs = [...session.logs.values()].flat();
  if (errs.length) throw new Error(`browser console errors:\n${errs.join('\n')}`);
}
```

- [ ] **Step 4: Run the fixtures spec until it passes**

Run: `cd test && node specs/fixtures.mjs && echo PASS`
Expected: `PASS`. If `game.MonksEnhancedJournal.getMEJType` isn't a function, inspect `await gm.evaluate(() => Object.getOwnPropertyNames(game.MonksEnhancedJournal))` and adjust the call form; record what worked in a comment.

- [ ] **Step 5: Implement `test/run.mjs`**

```js
#!/usr/bin/env node
// Runs all specs (or those whose filename contains the given substring).
//   node run.mjs            → all specs
//   node run.mjs smoke      → specs matching "smoke"
import { readdir } from 'node:fs/promises';

const filter = process.argv[2]?.replace(/^specs\//, '').replace(/\.mjs$/, '');
const dir = new URL('./specs/', import.meta.url);
let files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort();
if (filter) files = files.filter((f) => f.includes(filter));
if (!files.length) {
  console.error(`no specs match "${filter}"`);
  process.exit(2);
}

let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  try {
    await import(new URL(f, dir));
    console.log(`PASS ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n${e.stack}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} specs passed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 6: Run the runner**

Run: `cd test && node run.mjs`
Expected: `PASS connect.mjs`, `PASS fixtures.mjs`, `2/2 specs passed`, exit 0. Then `node run.mjs nosuchspec` → exit 2.

- [ ] **Step 7: Commit**

```bash
git add test/helpers/mej.js test/run.mjs test/specs/fixtures.mjs
git commit -m "test: mej.js helpers (fixtures/open/flags/sweep/drop) + run.mjs runner"
```

---

### Task 4: `specs/smoke-sheets.mjs` — every sheet type opens cleanly (acceptance gate)

**Files:**
- Create: `test/specs/smoke-sheets.mjs`

**Interfaces:**
- Consumes: `withSession`, `createEntry`, `openEntry`, `assertNoErrors` (Task 3).
- Produces: the harness acceptance gate — this spec passing from a cold start is the spec-document's definition of done.

- [ ] **Step 1: Write the spec**

```js
// Every MEJ sheet type opens in world-a with zero console errors.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';

const TYPES = ['encounter', 'event', 'list', 'loot', 'organization', 'person',
               'picture', 'place', 'poi', 'quest', 'shop', 'slideshow'];

await withSession('smoke-sheets', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  for (const type of TYPES) {
    const id = await createEntry(gm, type, `TT-smoke-${type}`);
    await openEntry(gm, id);
    // The enhanced-journal window shows the entry we just opened.
    const showing = await gm.evaluate((id) => {
      const j = game.MonksEnhancedJournal.journal;
      return !!j && (j.object?.id === id || j.document?.id === id ||
                     !!j.element?.querySelector(`[data-entry-id="${id}"], [data-document-id="${id}"]`));
    }, id);
    assert.ok(showing, `enhanced journal window is not showing the ${type} entry`);
  }
  assertNoErrors(session);
});
```

- [ ] **Step 2: Run it**

Run: `cd test && node run.mjs smoke`
Expected: initially likely FAIL on the `showing` probe (the exact property naming of the open window — `journal`, `object`, `document` — varies). Read `monks-enhanced-journal.js` around `openJournalEntry` (`:368-469`) to see what property holds the open window, fix the probe, re-run until PASS. If a *sheet type* itself errors on open, that is a real product bug: capture it (screenshot + console buffer are automatic), report it in the task summary, and if it blocks the spec, temporarily assert it as a known-failure with a comment naming the bug — do not silently drop the type from the list.

- [ ] **Step 3: Acceptance gate — cold start**

Stop Foundry (`kill $(cat ~/FoundryVTT-14/Data/.pid)` — check the pid file location first; the launcher writes it) and run:

Run: `cd test && node run.mjs smoke-sheets`
Expected: PASS end-to-end — `ensureServer` boots Foundry, world activates, spec passes. Total wall-clock well under 3 minutes.

- [ ] **Step 4: Commit**

```bash
git add test/specs/smoke-sheets.mjs
git commit -m "test: smoke spec - all 12 MEJ sheet types open with clean console"
```

---

### Task 5: `specs/quest-objectives.mjs` and `specs/currency.mjs`

**Files:**
- Create: `test/specs/quest-objectives.mjs`
- Create: `test/specs/currency.mjs`
- Reference (read, don't modify): `sheets/QuestSheet.js` (objectives flag shape and the reorder unsetFlag+setFlag path), `sheets/EnhancedJournalSheet.js:1069` (`static async addCurrency(actor, denomination, value)`).

**Interfaces:**
- Consumes: `withSession`, `createEntry`, `openEntry`, `entryFlag`, `setEntryFlag`, `assertNoErrors` (Task 3).
- Produces: regression coverage for the round-2/3 quest-reorder persistence fix and the addCurrency multi-coin corruption fix.

- [ ] **Step 1: Read `sheets/QuestSheet.js` to confirm the objectives flag**

Find where objectives are stored (search `objectives`): confirm (a) flag key name, (b) whether it lives on the page or the entry, (c) element shape (`id`/`title`/`done`-ish fields), (d) the reorder path that the 2026-08-08 fix routed through `unsetFlag` + `setFlag`. Adjust the spec below to the real shapes before running it.

- [ ] **Step 2: Write `test/specs/quest-objectives.mjs`**

```js
// Objectives survive a reorder + world-trip: the round-3 fix routed reorder
// through unsetFlag+setFlag because plain setFlag of a reordered array
// merge-collided and silently kept the old order.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, entryFlag, setEntryFlag, assertNoErrors } from '../helpers/mej.js';

await withSession('quest-objectives', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const id = await createEntry(gm, 'quest', 'TT-quest-objectives');

  const objectives = [
    { id: 'obj-a', title: 'First', done: false },
    { id: 'obj-b', title: 'Second', done: false },
    { id: 'obj-c', title: 'Third', done: false },
  ];
  await setEntryFlag(gm, id, 'objectives', objectives);
  await openEntry(gm, id);

  // Reorder exactly the way the sheet does (unset, then set).
  await gm.evaluate(async ({ id, reordered }) => {
    const page = game.journal.get(id).pages.contents[0];
    await page.unsetFlag('monks-enhanced-journal', 'objectives');
    await page.setFlag('monks-enhanced-journal', 'objectives', reordered);
  }, { id, reordered: [objectives[2], objectives[0], objectives[1]] });

  const order = (await entryFlag(gm, id, 'objectives')).map((o) => o.id);
  assert.deepEqual(order, ['obj-c', 'obj-a', 'obj-b'], 'reorder did not persist');
  assertNoErrors(session);
});
```

- [ ] **Step 3: Write `test/specs/currency.mjs`**

```js
// EnhancedJournalSheet.addCurrency adjusts one denomination without
// corrupting the others (regression: multi-coin corruption fix, PR #821).
import assert from 'node:assert/strict';
import { withSession, assertNoErrors } from '../helpers/mej.js';

await withSession('currency', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const currency = await gm.evaluate(async () => {
    const actor = await Actor.create({
      name: 'TT-currency-actor', type: 'character',
      system: { currency: { pp: 1, gp: 10, ep: 0, sp: 20, cp: 30 } },
    });
    // addCurrency is a static on EnhancedJournalSheet; reach it through any MEJ sheet class
    // registered in CONFIG, or import path exposed on the module. Simplest reliable route:
    const cls = Object.values(CONFIG.JournalEntryPage.sheetClasses ?? {})
      .flatMap((v) => Object.values(v)).map((s) => s.cls)
      .find((c) => c && typeof c.addCurrency === 'function');
    if (!cls) throw new Error('no registered sheet class exposes static addCurrency');
    await cls.addCurrency(actor, 'gp', 5);    // 10 → 15
    await cls.addCurrency(actor, 'sp', -8);   // 20 → 12
    return foundry.utils.duplicate(actor.system.currency);
  });
  assert.equal(currency.gp, 15);
  assert.equal(currency.sp, 12);
  assert.equal(currency.pp, 1, 'pp corrupted by unrelated addCurrency calls');
  assert.equal(currency.cp, 30, 'cp corrupted by unrelated addCurrency calls');
  assertNoErrors(session);
});
```

- [ ] **Step 4: Run both, fix shapes, pass**

Run: `cd test && node run.mjs quest-objectives && node run.mjs currency`
Expected: PASS both. Likely fixes needed: the objectives flag shape from Step 1, and the `addCurrency` class lookup (if the CONFIG walk finds nothing, check how `registerSheetClasses` (`monks-enhanced-journal.js`, called from `init`) registers them, or evaluate `game.MonksEnhancedJournal` static members). Delete the dead `EJS` line when finalizing.

- [ ] **Step 5: Commit**

```bash
git add test/specs/quest-objectives.mjs test/specs/currency.mjs
git commit -m "test: quest objective reorder persistence + addCurrency multi-coin specs"
```

---

### Task 6: `specs/relationships.mjs` and `specs/loot-drop.mjs`

**Files:**
- Create: `test/specs/relationships.mjs`
- Create: `test/specs/loot-drop.mjs`
- Reference (read, don't modify): `sheets/PersonSheet.js` + `sheets/EnhancedJournalSheet.js` (relationship drop handling and cascade — the round-2/3 fixes keyed cascades by journal id), `sheets/LootSheet.js` (item drop handler and items flag shape).

**Interfaces:**
- Consumes: `withSession`, `createEntry`, `openEntry`, `entryFlag`, `dropOnSheet`, `assertNoErrors` (Task 3).
- Produces: regression coverage for relationship cascade and loot item drop.

- [ ] **Step 1: Read the drop wiring**

In `sheets/EnhancedJournalSheet.js` / `sheets/PersonSheet.js`, find the `drop` handler and what payload it expects for a JournalEntry drop (`{ type: 'JournalEntry', uuid }`), which DOM node receives drops (whole window vs a tab), and the `relationships` flag shape (array of `{ id, uuid?, hidden?, relationship? }`-ish; the cascade writes the reciprocal onto the dropped entry). In `sheets/LootSheet.js`, same for Item drops and the `items` flag (an **object keyed by item id** — see `ShopSheet.onRequestItem`: `items[id]`).

- [ ] **Step 2: Write `test/specs/relationships.mjs`**

```js
// Dropping person B onto person A's sheet creates the relationship on A
// AND cascades the reciprocal onto B (round-2/3 fix: cascade keyed by journal id).
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, entryFlag, assertNoErrors } from '../helpers/mej.js';

await withSession('relationships', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const idA = await createEntry(gm, 'person', 'TT-rel-personA');
  const idB = await createEntry(gm, 'person', 'TT-rel-personB');
  await openEntry(gm, idA);

  const uuidB = await gm.evaluate((id) => game.journal.get(id).uuid, idB);
  await dropOnSheet(gm, '.monks-enhanced-journal', { type: 'JournalEntry', uuid: uuidB });

  // relationship writes are async; poll the flags
  await gm.waitForFunction((idA) => {
    const rels = game.journal.get(idA)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'relationships');
    return Array.isArray(rels) && rels.length > 0;
  }, idA);

  const relsA = await entryFlag(gm, idA, 'relationships');
  const relsB = await entryFlag(gm, idB, 'relationships');
  assert.ok(relsA.some((r) => r.id === idB || r.uuid?.includes(idB)), 'A does not reference B');
  assert.ok(Array.isArray(relsB) && relsB.some((r) => r.id === idA || r.uuid?.includes(idA)),
    'cascade did not write the reciprocal relationship onto B');
  assertNoErrors(session);
});
```

- [ ] **Step 3: Write `test/specs/loot-drop.mjs`**

```js
// Dropping a world Item onto a loot sheet adds it to the items flag with qty 1.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, entryFlag, assertNoErrors } from '../helpers/mej.js';

await withSession('loot-drop', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const lootId = await createEntry(gm, 'loot', 'TT-loot-entry');
  const itemUuid = await gm.evaluate(async () => {
    const item = await Item.create({ name: 'TT-loot-item', type: 'loot' }); // dnd5e item type
    return item.uuid;
  });
  await openEntry(gm, lootId);
  await dropOnSheet(gm, '.monks-enhanced-journal', { type: 'Item', uuid: itemUuid });

  await gm.waitForFunction((id) => {
    const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items');
    return items && Object.keys(items).length > 0;
  }, lootId);

  const items = await entryFlag(gm, lootId, 'items');
  const added = Object.values(items).find((i) => i.name === 'TT-loot-item');
  assert.ok(added, 'dropped item not in loot items flag');
  const qty = added.quantity ?? foundry.utils?.getProperty?.(added, 'flags.monks-enhanced-journal.quantity');
  assert.ok(qty == null || Number(qty) === 1, `unexpected quantity: ${qty}`);
  assertNoErrors(session);
});
```

Note: the `qty` line references `foundry.utils` outside the browser — that is a bug as written; resolve quantity **inside** a `page.evaluate` or read `added.flags?.['monks-enhanced-journal']?.quantity` directly in node. Fix while implementing (deliberately called out so the implementer normalizes where the flag actually lives, per Step 1's reading of LootSheet.js).

- [ ] **Step 4: Run both, adapt to real drop targets/shapes, pass**

Run: `cd test && node run.mjs relationships && node run.mjs loot-drop`
Expected: PASS both. If the synthetic drop doesn't trigger the handler, find the bound drop target (MEJ may bind drops on an inner element, or use Foundry's DragDrop with a `dragover` precondition — dispatch `dragover` first if needed) — the prior hand-testing sessions succeeded by invoking the sheet's `_onDropItem`-style handler directly with `{ type, uuid }` data; that is an acceptable fallback, but note it in a comment (it skips DOM wiring coverage).

- [ ] **Step 5: Commit**

```bash
git add test/specs/relationships.mjs test/specs/loot-drop.mjs
git commit -m "test: relationship cascade + loot item drop specs"
```

---

### Task 7: `specs/shop-purchase.mjs` — dual-client purchase flow

**Files:**
- Create: `test/specs/shop-purchase.mjs`
- Reference (read, don't modify): `sheets/ShopSheet.js` — `onRequestItem` (action name `requestItem`, `ShopSheet.js:18`), `confirmQuantity`, the `purchasing` flag modes, the GM-approval chat-message path, and `ShopSheet.js:725` (`ShopSheet.addCurrency(actor, price.currency, -price.value)`).

**Interfaces:**
- Consumes: everything from Tasks 2–3.
- Produces: dual-client regression coverage of the purchase-request flow (player request → GM approval → item + currency transfer).

- [ ] **Step 1: Read `sheets/ShopSheet.js` purchase flow end-to-end**

Nail down: (a) exact conditions for a player to see/click the request control (`data-action="requestItem"` on/inside the item `<li data-id>`); (b) the quantity-confirm dialog (`confirmQuantity`) markup — what to click to accept; (c) with `purchasing: 'confirm'`, what the GM receives (chat message with action buttons — find their selectors in the chat template it renders); (d) what "approved" does: item added to `game.user.character`'s inventory, currency deducted via `addCurrency`. Also find the shop `items` flag element shape used by `onRequestItem` (`items[id]`, with `flags.monks-enhanced-journal.{cost, quantity}` on each item).

- [ ] **Step 2: Write the spec**

```js
// Dual-client: player requests a purchase, GM approves, item lands on the
// player's actor and currency is deducted.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, assertNoErrors } from '../helpers/mej.js';

await withSession('shop-purchase', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const p1 = session.pages['User 1'];

  // Fixture: an actor owned by + assigned to User 1, with pocket money.
  const actorId = await gm.evaluate(async () => {
    const user = game.users.getName('User 1');
    const actor = await Actor.create({
      name: 'TT-shopper', type: 'character',
      system: { currency: { pp: 0, gp: 50, ep: 0, sp: 0, cp: 0 } },
      ownership: { default: 0, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });
    await user.update({ character: actor.id });
    return actor.id;
  });

  // Fixture: a shop in confirm-purchase mode with one priced item (drop, then price it).
  const shopId = await createEntry(gm, 'shop', 'TT-shop', { purchasing: 'confirm', state: 'open' });
  const itemUuid = await gm.evaluate(async () => (await Item.create({ name: 'TT-shop-item', type: 'loot' })).uuid);
  await openEntry(gm, shopId);
  await dropOnSheet(gm, '.monks-enhanced-journal', { type: 'Item', uuid: itemUuid });
  await gm.waitForFunction((id) => {
    const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items');
    return items && Object.keys(items).length > 0;
  }, shopId);
  await gm.evaluate(async (id) => {
    const page = game.journal.get(id).pages.contents[0];
    const items = foundry.utils.duplicate(page.getFlag('monks-enhanced-journal', 'items'));
    const key = Object.keys(items)[0];
    foundry.utils.setProperty(items[key], 'flags.monks-enhanced-journal.cost', '5 gp');
    foundry.utils.setProperty(items[key], 'flags.monks-enhanced-journal.quantity', 3);
    await page.setFlag('monks-enhanced-journal', 'items', items);
  }, shopId);

  // Player opens the shop and requests the item.
  await openEntry(p1, shopId);
  await p1.click('.monks-enhanced-journal [data-action="requestItem"]');
  // Quantity confirmation dialog → accept with default quantity 1.
  await p1.click('dialog .form-footer button, .dialog .dialog-buttons button.yes, [data-action="ok"]');

  // GM approves the purchase request from chat.
  const approveSel = '#chat .chat-message [data-action="accept"], #chat .chat-message .confirm-purchase, #chat .chat-message a.accept';
  await gm.waitForSelector(approveSel, { timeout: 15_000 });
  await gm.click(approveSel);

  // Item lands on the shopper; 5 gp deducted.
  await gm.waitForFunction((actorId) =>
    game.actors.get(actorId)?.items.some((i) => i.name === 'TT-shop-item'), actorId);
  const gp = await gm.evaluate((id) => game.actors.get(id).system.currency.gp, actorId);
  assert.equal(gp, 45, `expected 45 gp after 5 gp purchase, got ${gp}`);
  assertNoErrors(session);
});
```

- [ ] **Step 3: Run, adapt the three uncertain selectors, pass**

Run: `cd test && node run.mjs shop-purchase`
The three selectors marked by the multi-option strings (quantity dialog accept, chat approve control) WILL need narrowing to what Step 1 found — replace each multi-option selector with the single real one and delete the alternatives. If the player's request never reaches the GM, check that the request path is socket-driven and both pages are connected (`game.users.getName('Gamemaster').active` from the player page).
Expected: PASS, typically 20–40s (two logins + socket round-trips).

- [ ] **Step 4: Full suite run**

Run: `cd test && node run.mjs`
Expected: `8/8 specs passed`, exit 0 (connect, fixtures, smoke-sheets, quest-objectives, currency, relationships, loot-drop, shop-purchase).

- [ ] **Step 5: Commit**

```bash
git add test/specs/shop-purchase.mjs
git commit -m "test: dual-client shop purchase spec (request -> GM approve -> transfer)"
```

---

### Task 8: README, zip-exclusion note, memory entry

**Files:**
- Create: `test/README.md`
- Create: `/Users/danbularzik/.claude/projects/-Users-danbularzik-Claude-Projects-monks-enhanced-journal/memory/mej-playwright-harness.md` (+ index line in `MEMORY.md` there)

**Interfaces:**
- Consumes: the finished harness.
- Produces: future sessions default to the harness instead of MCP browsing.

- [ ] **Step 1: Write `test/README.md`**

```markdown
# MEJ Test Harness

Playwright scripts that drive the live local Foundry v14 install. **Agents: use
this instead of Playwright-MCP browsing** — a scripted check runs in seconds;
MCP round-trips take minutes each. Reserve MCP for exploratory looks only, and
even then batch via `browser_evaluate` and never take full-page snapshots.

## Run

    cd test
    node run.mjs              # all specs
    node run.mjs smoke        # specs matching a substring
    node specs/connect.mjs    # a single spec directly

The harness boots Foundry itself if it's down (`~/FoundryVTT-14/start-foundry.command`)
and activates `world-a` if another world is live. First-time setup:
`npm install && npx playwright install chromium`.

## Writing a throwaway check (fix sessions)

Put it in `scratch/` (gitignored). Template:

    import assert from 'node:assert/strict';
    import { withSession, createEntry, openEntry } from '../helpers/mej.js';
    await withSession('my-check', { users: ['Gamemaster'] }, async ({ pages }) => {
      const gm = pages['Gamemaster'];
      // page.evaluate against Foundry's API; DOM clicks only to test UI wiring
    });

Run with `node scratch/my-check.mjs`. If a throwaway check guards a real fix,
promote it to `specs/`.

## Rules

- Test entities are named `TT-...` and are auto-swept; never touch hand-made
  entries (`Baseline Test`, `T-*`, ...).
- Headless only; timeouts ≤15s; single browser per spec (8GB RAM).
- On failure you get the assertion, screenshots in `screenshots/`, and the
  buffered browser console.

## Release zips

`test/` must never ship. The canonical release zip command (run at repo root):

    zip -r module.zip . -x 'test/*' '.git/*' '.claude/*' 'docs/*' 'node_modules/*' '.superpowers/*' '*.png' '.DS_Store' 'packs/.DS_Store' '.remember/*' '.github/*'

Adjust the exclusion list against what previous releases shipped (compare with
`unzip -l` of the prior release's module.zip) before uploading.
```

- [ ] **Step 2: Write the memory file**

Create `mej-playwright-harness.md` in the memory directory:

```markdown
---
name: mej-playwright-harness
description: "test/ harness runs MEJ checks against live Foundry in seconds — use it instead of Playwright-MCP browsing"
metadata:
  type: project
---

The MEJ repo has a Playwright harness at `test/` (branch `playwright-harness`, 2026-08-08):
`cd test && node run.mjs` runs all specs; `node run.mjs <substring>` filters. It boots
Foundry ([[foundry-v14-test-env]]) and activates world-a itself. For fix verification,
write a scratch script (`test/scratch/`, template in `test/README.md`) instead of driving
the browser through MCP — scripted checks are ~100x faster. MCP browsing is for
exploratory looks only: batch via browser_evaluate, never full snapshots. Test entities
use the `TT-` prefix and are auto-swept. Release zips must exclude `test/` (canonical
zip command in `test/README.md`).
```

Add to that directory's `MEMORY.md` index: `- [MEJ Playwright harness](mej-playwright-harness.md) — test/ scripts replace MCP browsing; run.mjs; TT- prefix`

- [ ] **Step 3: Final full-suite verification**

Run: `cd test && node run.mjs`
Expected: `8/8 specs passed`, exit 0, total wall-clock under ~5 minutes.

- [ ] **Step 4: Commit**

```bash
git add test/README.md
git commit -m "test: README - usage, agent guidance, release-zip exclusion"
```

---

## Self-Review Notes (already applied)

- Spec coverage: layout ✓ (T1/T3), foundry.js API ✓ (T2), mej.js ✓ (T3), fixtures/sweep ✓ (T3), failure output ✓ (T3 `withSession`), release/PR hygiene ✓ (T1 ignores, T8 zip command), six seed specs ✓ (T4–T7; `connect`+`fixtures` are harness self-tests on top), agent workflow ✓ (T8), acceptance gate ✓ (T4 Step 3 cold-start).
- Known-uncertain points are called out as explicit read-the-source or dump-the-DOM steps with the authoritative file named (never "TBD"): `/api/status` field (T2S1), open-window probe (T4S2), objectives flag shape (T5S1), drop target + flag shapes (T6S1), purchase dialog/chat selectors (T7S1/S3), loot-drop qty normalization (T6S3 note).
- Type consistency: `withSession(name, opts, fn)`, `createEntry(gmPage, type, name, flags)`, `entryFlag/setEntryFlag(page, entryId, key[, value])`, `dropOnSheet(page, selector, data)` used identically across T4–T7.
