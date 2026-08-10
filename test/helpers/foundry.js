// Plumbing for driving live local Foundry v14 with Playwright.
// Server: ~/FoundryVTT-14/start-foundry.command → http://localhost:30000
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import os from 'node:os';

export const BASE = process.env.FOUNDRY_URL ?? 'http://localhost:30000';
export const TIMEOUT = 15_000;
const LAUNCHER = `${os.homedir()}/FoundryVTT-14/start-foundry.command`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Observed v14 /api/status shape (world-a, server already running):
// {"active":true,"version":"14.365","world":"world-a","system":"dnd5e",
//  "systemVersion":"5.3.3","users":1,"uptime":5165439}
// The "world" field still carries the active world id, same as v11-v13 — no
// rename in v14. It is absent/null when no world is active (setup screen).
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
// Join page: templates/views/join.hbs. Setup page world tiles: [data-package-id]
// with a.control.play[data-action="worldLaunch"] (templates/setup/parts/package-tiles.hbs:18).
// Foundry refuses to run properly (and logs a console.error on every load)
// below this resolution — keep every context at least this large so specs
// that assert a clean console aren't tripped up by an unrelated warning.
const VIEWPORT = { width: 1366, height: 768 };

// Return to the setup screen from a running world. The obvious UI path — the
// /join page's "Return to Setup" form (input[name="adminPassword"]) — 403s
// with ERROR.InvalidAdminKey on this dev box: dist/server/views/join.mjs
// JoinView.handlePost's "shutdown" case explicitly requires a server admin
// password to be CONFIGURED at all (`if(!t.adminPassword) return 403`), and
// this box has none (no Config/admin.txt). That gate exists independent of
// what password value you submit — blank or otherwise, it always 403s here.
// The real in-game "Return to Setup" affordance goes through a different
// route instead: POST /setup {shutdown:true} from a session already logged
// in as a world user. dist/server/views/setup.mjs SetupView.handlePost, when
// a world is active, special-cases `body.shutdown` before the admin-only
// switch below it, and dist/packages/world.mjs World#deactivate only needs
// `e.user` to resolve to a GAMEMASTER-role user (or an already-admin
// session) — no adminPassword involved. So: join as Gamemaster, then fire
// that POST from the authenticated page.
async function returnToSetup(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  try {
    await page.goto(`${BASE}/join`);
    await page.waitForSelector('select[name="userid"]');
    const found = await page.evaluate(() => {
      const select = document.querySelector('select[name="userid"]');
      const option = Array.from(select.options).find((o) => o.textContent.trim() === 'Gamemaster');
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    if (!found) throw new Error('returnToSetup: no Gamemaster user option on /join');
    await page.click('button[name="join"]');
    await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
    await page.evaluate(async () => {
      await fetch('/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shutdown: true }),
      });
    });
  } finally {
    await context.close();
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await apiStatus())?.world) return;
    await sleep(500);
  }
  throw new Error('returnToSetup: world still active 30s after shutdown request');
}

async function ensureWorld(browser, worldId) {
  const status = await apiStatus();
  if (status?.world === worldId) return;
  if (status?.world) await returnToSetup(browser);
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  try {
    await page.goto(`${BASE}/setup`);
    // A first-run "welcome tour" (e.g. "Backups Overview") can render a
    // full-page overlay on /setup that intercepts every click, and the
    // world tile's own play icon is `visibility:hidden` until the tile is
    // hovered — so wait for the tile, dismiss any tour, hover, then click.
    const tile = `[data-package-id="${worldId}"]`;
    await page.waitForSelector(tile, { timeout: 30_000 });
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.tour-center-step [data-action="exit"]').first()
      .click({ timeout: 2_000 }).catch(() => {});
    await page.locator(tile).hover();
    await page.click(`${tile} [data-action="worldLaunch"]`);
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
//
// Correction (recorded from a live DOM dump): the server marks a user's <option>
// disabled while that user already has a connection open (e.g. a session left
// over from earlier manual testing). Playwright's selectOption() honors that
// native disabled state and times out. The server itself does NOT enforce it —
// logging in as that user from a fresh context succeeds and silently replaces
// the old session — so we select via direct DOM manipulation (set .value +
// dispatch 'change') instead of selectOption(), which works regardless of the
// disabled flag.
async function join(browser, session, userName) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  // Boot this client in "no canvas" mode: MEJ tests only exercise journal
  // sheets (plain DOM), never the scene canvas, but Foundry still
  // software-rasterizes the full PIXI/WebGL canvas per logged-in headless
  // context by default — that's what shows up in failure screenshots as
  // "hardware acceleration disabled", 527ms latency, and 2 FPS, and it's
  // what pushes an 8GB test box into swap. core.noCanvas skips canvas
  // initialization entirely (client/canvas/board.mjs: Canvas#initialize()
  // returns immediately when `game.settings.get("core","noCanvas")` is
  // true, before touching WebGL or PIXI).
  //
  // Client-scope settings live in localStorage under "<namespace>.<key>",
  // JSON-encoded — client/helpers/client-settings.mjs
  // ClientSettings#storage (client scope -> window.localStorage) and
  // #cleanJSON()/#setClient() (`storage.setItem(doc.key, JSON.stringify(value))`).
  // For the boolean core.noCanvas that stringifies to the 4-char literal
  // "true" (parsed back through a JSONField on read: common/documents/setting.mjs
  // `value: new fields.JSONField(...)`). Seed it with addInitScript so it's
  // in place before game.mjs registers the setting and boots /game, on
  // every navigation this context makes (not just the first).
  await context.addInitScript(() => {
    window.localStorage.setItem('core.noCanvas', 'true');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const log = [];
  session.logs.set(page, log);
  page.on('console', (m) => { if (m.type() === 'error') log.push(`[console.error] ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/join`);
  await page.waitForSelector('select[name="userid"]');
  const found = await page.evaluate((label) => {
    const select = document.querySelector('select[name="userid"]');
    const option = Array.from(select.options).find((o) => o.textContent.trim() === label);
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, userName);
  if (!found) throw new Error(`No user option labeled "${userName}" on join screen`);
  await page.click('button[name="join"]');
  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
  // Guard against a storage-format mistake silently reverting the
  // optimization and running the full canvas anyway.
  const noCanvas = await page.evaluate(() => ({
    setting: game.settings.get('core', 'noCanvas'),
    canvasReady: game.canvas?.ready ?? null,
  }));
  if (noCanvas.setting !== true || noCanvas.canvasReady) {
    throw new Error(
      `core.noCanvas did not take effect for "${userName}" ` +
      `(setting=${noCanvas.setting}, canvas.ready=${noCanvas.canvasReady}) — ` +
      `check the localStorage key/value format in join()`
    );
  }
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
