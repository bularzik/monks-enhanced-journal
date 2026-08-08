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
  const context = await browser.newContext();
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
