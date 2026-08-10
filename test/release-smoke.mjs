#!/usr/bin/env node
// release-smoke.mjs — pre-release smoke test for a PUBLISHED (or locally built)
// MEJ artifact, installed the way a user installs it.
//
//   node release-smoke.mjs https://github.com/<owner>/<repo>/releases/download/<tag>/module.json
//   node release-smoke.mjs /tmp/mej-release/14.04b-test/module.json      (uses module.zip beside it)
//
// It is deliberately NOT a spec: `run.mjs` only discovers `specs/*.mjs`, and this
// script hits the network, stops/starts the Foundry server, swaps the live module
// directory and creates a throwaway world. Never run it while anyone is connected.
//
// What it does, in order:
//   1. pre-flight  — /api/status must report users: 0
//   2. guard+park  — the live module dir (normally a symlink to the dev checkout)
//                    is renamed aside, never deleted
//   3. install     — manifest -> download URL -> unzip into the live module dir
//   4. restart     — stop + start Foundry so it re-reads the module
//   5. fresh world — created through Foundry's own POST /create setup endpoint
//   6. enable      — monks-enhanced-journal + lib-wrapper, nothing else
//   7. assert      — the sidebar create path really opens MEJ's own sheet (A1-A9)
//   8. restore     — ALWAYS, in a finally: module dir put back, world deleted,
//                    Foundry restarted on the normal world
//
// Exit 0 = release is good to upload. Exit 1 = do not upload. Exit 2 = usage error.
// Full JSON result goes to $SMOKE_OUT (default /tmp/mej-release-smoke.json).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, apiStatus, BASE } from './helpers/foundry.js';
import { snap } from './helpers/mej.js';

// ---------------------------------------------------------------------------
// CONFIG — every hardcoded path/id for this machine lives in this one block.
// ---------------------------------------------------------------------------
const CONFIG = {
  moduleId: 'monks-enhanced-journal',
  enableModules: ['monks-enhanced-journal', 'lib-wrapper'],
  foundryHome: `${os.homedir()}/FoundryVTT-14`,
  dataPath: `${os.homedir()}/FoundryVTT-14/Data`,
  smokeWorldId: 'tt-release-smoke',
  smokeWorldTitle: 'TT Release Smoke',
  smokeWorldSystem: 'dnd5e',
  restoreWorld: 'world-a', // world to leave active when the run is over
  serverStopTimeoutMs: 30_000,
  serverBootTimeoutMs: 90_000,
  worldRestartTimeoutMs: 90_000,
};

const LAUNCHER = `${CONFIG.foundryHome}/start-foundry.command`;
const PID_FILE = path.join(CONFIG.dataPath, '.pid');
const MOD_DIR = path.join(CONFIG.dataPath, 'Data', 'modules', CONFIG.moduleId);
const PARKED_DIR = `${MOD_DIR}.devlink`;
const WORLD_DIR = path.join(CONFIG.dataPath, 'Data', 'worlds', CONFIG.smokeWorldId);
const OUT = process.env.SMOKE_OUT ?? path.join(os.tmpdir(), 'mej-release-smoke.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { config: CONFIG, steps: [] };
const fails = [];
const log = (...a) => { console.log(...a); R.steps.push(a.join(' ')); };

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------
const ARG = process.argv[2];
if (!ARG || ['-h', '--help', 'help'].includes(ARG)) {
  console.error(
    'usage: node release-smoke.mjs <manifest-url | path/to/module.json>\n\n' +
    '  Installs the artifact that manifest points at into the live Foundry data\n' +
    '  dir, verifies the sidebar create path in a throwaway world, then restores\n' +
    '  the module dir, deletes the world and restarts Foundry.\n\n' +
    '  A local module.json uses a module.zip sitting beside it when present,\n' +
    "  otherwise it falls back to the manifest's own download URL.\n\n" +
    '  Requires: nobody connected (/api/status users: 0). Never run two harness\n' +
    '  processes at once.'
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// server control
// ---------------------------------------------------------------------------
async function stopFoundry() {
  let pid = null;
  try { pid = parseInt((await fs.readFile(PID_FILE, 'utf8')).trim(), 10); } catch {}
  if (!Number.isInteger(pid)) {
    try {
      pid = parseInt(execFileSync('pgrep', ['-f', `main.js --dataPath=${CONFIG.dataPath}`])
        .toString().trim().split('\n')[0], 10);
    } catch {}
  }
  if (Number.isInteger(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await fs.rm(PID_FILE, { force: true });
  const deadline = Date.now() + CONFIG.serverStopTimeoutMs;
  while (Date.now() < deadline) {
    if (!(await apiStatus())) { log(`  foundry stopped (pid ${pid})`); return; }
    await sleep(500);
  }
  throw new Error(`Foundry still answering on ${BASE} after ${CONFIG.serverStopTimeoutMs}ms`);
}

async function startFoundry() {
  spawn(LAUNCHER, [], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + CONFIG.serverBootTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const s = await apiStatus();
    if (s) { log(`  foundry up: ${JSON.stringify(s)}`); return s; }
  }
  throw new Error(`Foundry did not come up on ${BASE} within ${CONFIG.serverBootTimeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------
async function readManifest(arg) {
  if (/^https?:\/\//.test(arg)) {
    const r = await fetch(arg, { redirect: 'follow' });
    if (!r.ok) throw new Error(`manifest fetch failed: ${r.status} ${arg}`);
    return { manifest: await r.json(), localDir: null };
  }
  const abs = path.resolve(arg);
  return { manifest: JSON.parse(await fs.readFile(abs, 'utf8')), localDir: path.dirname(abs) };
}

async function fetchZip(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`download failed: ${r.status} ${url}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

// Unzip into MOD_DIR, flattening a single wrapping top-level directory if the
// zip has one (module.json must end up at the root of the module dir).
async function installZip(zip) {
  await fs.mkdir(MOD_DIR, { recursive: true });
  execFileSync('unzip', ['-oq', zip, '-d', MOD_DIR]);
  if (!fsSync.existsSync(path.join(MOD_DIR, 'module.json'))) {
    const entries = await fs.readdir(MOD_DIR, { withFileTypes: true });
    const inner = entries.find((e) => e.isDirectory()
      && fsSync.existsSync(path.join(MOD_DIR, e.name, 'module.json')));
    if (!inner) throw new Error('installed artifact has no module.json at any usable depth');
    const from = path.join(MOD_DIR, inner.name);
    for (const f of await fs.readdir(from)) await fs.rename(path.join(from, f), path.join(MOD_DIR, f));
    await fs.rm(from, { recursive: true, force: true });
  }
  return JSON.parse(await fs.readFile(path.join(MOD_DIR, 'module.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// world lifecycle (Foundry's own setup endpoint — same call the Create World form makes)
// ---------------------------------------------------------------------------
async function createSmokeWorld() {
  if (fsSync.existsSync(WORLD_DIR)) {
    throw new Error(`world dir ${WORLD_DIR} already exists — remove it before running`);
  }
  const r = await fetch(`${BASE}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'createWorld',
      id: CONFIG.smokeWorldId,
      title: CONFIG.smokeWorldTitle,
      system: CONFIG.smokeWorldSystem,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(`createWorld failed (${r.status}): ${body.error ?? ''}`);
  if (!fsSync.existsSync(WORLD_DIR)) throw new Error(`createWorld reported success but ${WORLD_DIR} is missing`);
  return body;
}

// Enabling modules makes Foundry restart the world; wait for it to come back.
async function enableModules() {
  const session = await connect({ world: CONFIG.smokeWorldId, users: ['Gamemaster'] });
  const gm = session.pages['Gamemaster'];
  const before = await gm.evaluate(() => ({
    world: game.world.id,
    system: `${game.system.id}@${game.system.version}`,
    core: game.version,
  }));
  await gm.evaluate(async (ids) => {
    const cfg = foundry.utils.duplicate(game.settings.get('core', 'moduleConfiguration') ?? {});
    for (const id of ids) cfg[id] = true;
    await game.settings.set('core', 'moduleConfiguration', cfg);
  }, CONFIG.enableModules).catch(() => { /* world restarts mid-call; expected */ });
  await session.close();
  const deadline = Date.now() + CONFIG.worldRestartTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if ((await apiStatus())?.world === CONFIG.smokeWorldId) return before;
  }
  throw new Error(`world ${CONFIG.smokeWorldId} did not come back after enabling modules`);
}

// ---------------------------------------------------------------------------
// the assertions — the real user path: sidebar -> Create Journal Entry ->
// MEJ's injected type select -> Shop -> OK.  Ported from the Task 4 fix check.
// ---------------------------------------------------------------------------
const CREATE_BTN =
  '#journal [data-action="createEntry"], .tab[data-tab="journal"] [data-action="createEntry"]';

// `ctx.phase` is stamped onto every captured console error, so a stray error in
// an otherwise green run can be attributed to the assertion that caused it
// instead of guessed at. Errors are expected in the A9 fallback phase: the core
// sheet throws in its own `_renderPageView` when asked to render an MEJ page.
async function runChecks(gm, consoleErrors, ctx) {
  const NAME = 'TT-smoke-shop';
  const phase = (p) => { ctx.phase = p; };

  async function createViaSidebar(name, pagetype) {
    await gm.evaluate(async () => {
      for (const a of Array.from(foundry.applications.instances.values()))
        if (a.constructor.name === 'EnhancedJournal' || a.constructor.name.startsWith('JournalEntrySheet'))
          await a.close();
      ui.sidebar.expand();
      ui.sidebar.changeTab('journal', 'primary');
    });
    await gm.waitForSelector(CREATE_BTN, { timeout: 15_000 });
    await gm.locator(CREATE_BTN).first().click();
    await gm.waitForSelector('dialog input[name="name"]', { timeout: 15_000 });
    const dialog = await gm.evaluate(() => {
      const sel = document.querySelector('dialog select[name="flags.monks-enhanced-journal.pagetype"]');
      return { present: !!sel, options: sel ? Array.from(sel.options).map((o) => o.value) : null };
    });
    if (!dialog.present) throw new Error('MEJ type select missing from create dialog');
    await gm.fill('dialog input[name="name"]', name);
    await gm.selectOption('dialog select[name="flags.monks-enhanced-journal.pagetype"]', pagetype);
    await gm.locator('dialog button[data-action="ok"], dialog button[type="submit"]').first().click();
    await gm.waitForTimeout(4000);
    return { dialog, state: await gm.evaluate((n) => {
      const e = game.journal.getName(n);
      const p = e?.pages?.contents?.[0];
      return {
        entryCreated: !!e,
        pageCount: e?.pages?.size ?? null,
        inMemoryPageType: p?.type ?? null,
        sourcePageType: p?._source?.type ?? null,
        pageFlags: p?.flags?.['monks-enhanced-journal'] ?? null,
        openApps: Array.from(foundry.applications.instances.values()).map((a) => a.constructor.name),
        mejDom: !!document.querySelector('.monks-enhanced-journal'),
        shopDom: !!document.querySelector('.monks-enhanced-journal .shop-items, .monks-enhanced-journal [data-tab="items"]'),
      };
    }, name) };
  }

  function assertOpenedInMEJ(tag, s) {
    if (!s.entryCreated) fails.push(`${tag} entry was not created at all`);
    if (!s.openApps.includes('EnhancedJournal'))
      fails.push(`${tag}a UI-path creation did not open the EnhancedJournal (openApps=${s.openApps.join(',')})`);
    if (s.openApps.some((a) => a.startsWith('JournalEntrySheet')))
      fails.push(`${tag}b UI-path creation opened Foundry's plain journal sheet (openApps=${s.openApps.join(',')})`);
    if (!s.shopDom) fails.push(`${tag}c shop sheet body did not render on creation`);
  }

  // Registration health — the module actually loaded and registered its sheets.
  phase('A0-registration');
  R.registration = await gm.evaluate((id) => {
    const m = game.modules.get(id);
    return {
      active: !!m?.active,
      version: m?.version ?? null,
      libWrapperActive: !!game.modules.get('lib-wrapper')?.active,
      gameMEJ: !!game.MonksEnhancedJournal,
      journalEntryPageTypes: Array.from(game.documentTypes.JournalEntryPage ?? []),
      shopSheetRegistered: !!CONFIG.JournalEntryPage.sheetClasses?.['monks-enhanced-journal.shop'],
      shopSheetClassName: Object.values(
        CONFIG.JournalEntryPage.sheetClasses?.['monks-enhanced-journal.shop'] ?? {})[0]?.cls?.name ?? null,
    };
  }, CONFIG.moduleId);
  log(`  registration: ${JSON.stringify(R.registration)}`);
  if (!R.registration.active) fails.push(`A0 module ${CONFIG.moduleId} is not active`);
  if (!R.registration.gameMEJ) fails.push('A0 game.MonksEnhancedJournal is missing');
  if (!R.registration.shopSheetRegistered) fails.push('A0 ShopSheet is not registered');

  // A1/A2 — first sidebar creation.
  phase('A1-A2-first-create');
  const first = await createViaSidebar(NAME, 'shop');
  R.dialog = first.dialog;
  R.afterCreate = first.state;
  await snap(gm, 'release-smoke-aftercreate');
  if (!R.afterCreate.entryCreated) fails.push('A1 entry was not created');

  // A3 — SECOND creation in the SAME session. Catches a libWrapper WRAPPER that
  // does not chain: lib-wrapper unregisters it after the first swallow, so only
  // creation #2 shows the regression.
  phase('A3-second-create');
  const second = await createViaSidebar('TT-smoke-shop-2', 'shop');
  R.afterCreate2 = second.state;
  R.libWrapperErrors = consoleErrors.filter((e) => /libwrapper|did not chain/i.test(e.text));
  await snap(gm, 'release-smoke-aftercreate2');

  assertOpenedInMEJ('A2', R.afterCreate);
  assertOpenedInMEJ('A3', R.afterCreate2);
  if (R.libWrapperErrors.length)
    fails.push(`A3d libWrapper reported an API violation: ${R.libWrapperErrors[0].text.slice(0, 300)}`);

  // A4 — the PERSISTED page type, read off the server's copy after a full reload.
  phase('A4-A6-reload-and-reopen');
  await gm.reload();
  await gm.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
  await gm.waitForTimeout(2500);
  R.persisted = await gm.evaluate((name) => {
    const e = game.journal.getName(name);
    const p = e?.pages?.contents?.[0];
    return {
      found: !!p,
      persistedPageType: p?._source?.type ?? null,
      pageFlags: p?.flags?.['monks-enhanced-journal'] ?? null,
      typeIsRegistered: (game.documentTypes.JournalEntryPage ?? []).includes(p?._source?.type),
    };
  }, NAME);
  if (!R.persisted.typeIsRegistered)
    fails.push(`A4 persisted page type "${R.persisted.persistedPageType}" is not a registered JournalEntryPage type`);

  // A5/A6 — after the reload the entry still opens in MEJ as a ShopSheet.
  R.reopen = await gm.evaluate(async (name) => ({
    openJournalEntryReturned: await game.MonksEnhancedJournal.openJournalEntry(game.journal.getName(name)),
  }), NAME);
  await gm.waitForTimeout(3000);
  R.reopenDom = await gm.evaluate(() => ({
    mejDom: !!document.querySelector('.monks-enhanced-journal'),
    shopDom: !!document.querySelector('.monks-enhanced-journal .shop-items, .monks-enhanced-journal [data-tab="items"]'),
    subsheetClass: game.MonksEnhancedJournal?.journal?.subsheet?.constructor?.name ?? null,
    openApps: Array.from(foundry.applications.instances.values()).map((a) => a.constructor.name),
  }));
  await snap(gm, 'release-smoke-reopen');
  if (!R.reopenDom.mejDom)
    fails.push(`A5 after reload the entry does not open in MEJ (openApps=${R.reopenDom.openApps.join(',')})`);
  if (R.reopenDom.subsheetClass !== 'ShopSheet')
    fails.push(`A6 after reload subsheet is ${R.reopenDom.subsheetClass}, expected ShopSheet`);

  // A7 — bug-era / legacy shape: a bare "text" page carrying MEJ flags still opens.
  phase('A7-legacy-shape');
  R.legacy = await gm.evaluate(async () => {
    const e = await JournalEntry.create({
      name: 'TT-smoke-legacy-textshop',
      flags: { 'monks-enhanced-journal': { img: 'modules/monks-enhanced-journal/assets/shop.png' } },
      pages: [{
        name: 'TT-smoke-legacy-textshop', type: 'text',
        flags: { 'monks-enhanced-journal': { type: 'shop', state: 'open' } },
      }],
    }, { renderSheet: false });
    return { created: !!e, openJournalEntryReturned: await game.MonksEnhancedJournal.openJournalEntry(e) };
  });
  await gm.waitForTimeout(2500);
  R.legacyDom = await gm.evaluate(() => ({
    mejDom: !!document.querySelector('.monks-enhanced-journal'),
    subsheetClass: game.MonksEnhancedJournal?.journal?.subsheet?.constructor?.name ?? null,
  }));
  if (R.legacyDom.subsheetClass !== 'ShopSheet')
    fails.push(`A7 legacy text+flags page opened as ${R.legacyDom.subsheetClass}, expected ShopSheet`);

  // A8 — regression guard: a plain Text entry from the same dialog must still
  // open Foundry's own journal sheet.
  phase('A8-plain-text');
  await gm.evaluate(async () => {
    for (const a of Array.from(foundry.applications.instances.values()))
      if (a.constructor.name === 'EnhancedJournal' || a.constructor.name.startsWith('JournalEntrySheet'))
        await a.close();
    ui.sidebar.expand();
    ui.sidebar.changeTab('journal', 'primary');
  });
  await gm.waitForTimeout(500);
  await gm.locator(CREATE_BTN).first().click();
  await gm.waitForSelector('dialog input[name="name"]', { timeout: 15_000 });
  await gm.fill('dialog input[name="name"]', 'TT-smoke-plain-text');
  await gm.selectOption('dialog select[name="flags.monks-enhanced-journal.pagetype"]', 'text');
  await gm.locator('dialog button[data-action="ok"], dialog button[type="submit"]').first().click();
  await gm.waitForTimeout(3500);
  R.plainText = await gm.evaluate(() => ({
    openApps: Array.from(foundry.applications.instances.values()).map((a) => a.constructor.name),
    coreSheetOpen: Array.from(foundry.applications.instances.values())
      .some((a) => a.constructor.name.startsWith('JournalEntrySheet')),
  }));
  if (!R.plainText.coreSheetOpen)
    fails.push(`A8 plain Text entry no longer opens the core journal sheet (openApps=${R.plainText.openApps.join(',')})`);

  // A9 — fallback guard: when MEJ declines the open (display-mode modules,
  // conversation-hud, a third-party `openJournalEntry` hook veto), the swallowed
  // core render must come back so the user is not left with nothing open.
  phase('A9-veto-fallback');
  await gm.evaluate(async () => {
    for (const a of Array.from(foundry.applications.instances.values()))
      if (a.constructor.name === 'EnhancedJournal' || a.constructor.name.startsWith('JournalEntrySheet'))
        await a.close();
    window.__vetoHook = Hooks.on('openJournalEntry', () => false);
  });
  const declined = await createViaSidebar('TT-smoke-declined-shop', 'shop');
  R.declined = declined.state;
  await gm.evaluate(() => Hooks.off('openJournalEntry', window.__vetoHook));
  await snap(gm, 'release-smoke-declined');
  if (!R.declined.openApps.some((a) => a.startsWith('JournalEntrySheet')))
    fails.push(`A9 MEJ declined the open and nothing fell back to the core sheet (openApps=${R.declined.openApps.join(',')})`);
  phase('teardown');

  // A10 — the happy path must be console-clean. Errors are tolerated ONLY in the
  // A9 fallback phase, where the core sheet is deliberately made to render an MEJ
  // page and throws inside its own `_renderPageView`; that is core Foundry
  // behaviour on MEJ's storage shape, not something this release introduced.
  R.unexpectedConsoleErrors = consoleErrors.filter((e) => e.phase !== 'A9-veto-fallback');
  if (R.unexpectedConsoleErrors.length)
    fails.push(`A10 ${R.unexpectedConsoleErrors.length} console error(s) outside the A9 fallback phase: ` +
      R.unexpectedConsoleErrors.map((e) => `[${e.phase}] ${e.text.slice(0, 200)}`).join(' | '));
}

// ---------------------------------------------------------------------------
// main — everything after the park is wrapped so restore ALWAYS runs
// ---------------------------------------------------------------------------
let parked = false;
let session = null;

// 1. pre-flight ------------------------------------------------------------
const pre = await apiStatus();
R.preflight = pre;
log(`pre-flight /api/status: ${JSON.stringify(pre)}`);
if (pre && pre.users !== 0) {
  console.error(`ABORT: ${pre.users} user(s) connected — refusing to swap the live module dir.`);
  process.exit(2);
}

// 2. guard + park ----------------------------------------------------------
let modStat;
try { modStat = await fs.lstat(MOD_DIR); } catch {
  console.error(`ABORT: ${MOD_DIR} does not exist — nothing to park.`);
  process.exit(2);
}
if (!modStat.isSymbolicLink() && !modStat.isDirectory()) {
  console.error(`ABORT: ${MOD_DIR} is neither a symlink nor a directory — refusing to touch it.`);
  process.exit(2);
}
R.modDirWas = modStat.isSymbolicLink()
  ? { kind: 'symlink', target: await fs.readlink(MOD_DIR) }
  : { kind: 'directory' };
log(`live module dir: ${MOD_DIR} -> ${JSON.stringify(R.modDirWas)}`);
if (fsSync.existsSync(PARKED_DIR)) {
  console.error(`ABORT: ${PARKED_DIR} already exists — a previous run did not restore. Fix by hand.`);
  process.exit(2);
}

try {
  log('[1/7] stopping foundry');
  await stopFoundry();

  log('[2/7] parking the live module dir');
  await fs.rename(MOD_DIR, PARKED_DIR);
  parked = true;

  log(`[3/7] installing from ${ARG}`);
  const { manifest, localDir } = await readManifest(ARG);
  let zip = localDir ? path.join(localDir, 'module.zip') : null;
  if (zip && !fsSync.existsSync(zip)) zip = null;
  if (!zip) {
    if (!manifest.download) throw new Error('manifest has no download URL and no module.zip beside it');
    zip = await fetchZip(manifest.download, path.join(os.tmpdir(), 'mej-release-smoke.zip'));
    log(`  downloaded ${manifest.download}`);
  } else {
    log(`  using local zip ${zip}`);
  }
  const installed = await installZip(zip);
  R.installed = { version: installed.version, id: installed.id, compatibility: installed.compatibility };
  log(`  installed ${installed.id} version ${installed.version}`);
  if (installed.id !== CONFIG.moduleId)
    throw new Error(`manifest id "${installed.id}" != expected "${CONFIG.moduleId}"`);
  if (manifest.version && installed.version !== manifest.version)
    fails.push(`A0 installed version ${installed.version} != manifest version ${manifest.version}`);

  log('[4/7] starting foundry');
  await startFoundry();

  log(`[5/7] creating throwaway world ${CONFIG.smokeWorldId}`);
  await createSmokeWorld();
  R.enabledFrom = await enableModules();
  log(`  modules enabled: ${CONFIG.enableModules.join(', ')}`);

  log('[6/7] running assertions');
  session = await connect({ world: CONFIG.smokeWorldId, users: ['Gamemaster'] });
  const gm = session.pages['Gamemaster'];
  const ctx = { phase: 'startup' };
  const consoleErrors = [];
  const capture = (text) => consoleErrors.push({ phase: ctx.phase, text });
  gm.on('console', (m) => { if (m.type() === 'error') capture(m.text()); });
  gm.on('pageerror', (e) => capture(`[pageerror] ${e.message}`));
  await gm.evaluate(async () => {
    for (const t of (game.tours?.contents ?? [])) { try { await t.exit(); } catch {} }
  }).catch(() => {});
  await runChecks(gm, consoleErrors, ctx);
  R.consoleErrors = consoleErrors;
} catch (e) {
  fails.push(`EXCEPTION ${e.message}`);
  R.exception = `${e.message}\n${e.stack}`;
  if (session) await snap(session.pages['Gamemaster'], 'release-smoke-error').catch(() => {});
} finally {
  // 7. restore — unconditional. Runs even if an assertion threw mid-world.
  log('[7/7] restoring environment');
  try { if (session) await session.close(); } catch (e) { console.error(`restore: session.close failed: ${e.message}`); }
  const restore = {};
  try {
    await stopFoundry().catch((e) => { restore.stopError = e.message; });
    if (parked) {
      await fs.rm(MOD_DIR, { recursive: true, force: true });   // the installed artifact
      await fs.rename(PARKED_DIR, MOD_DIR);                     // the original, untouched
      parked = false;
    }
    await fs.rm(WORLD_DIR, { recursive: true, force: true });
    restore.worldDeleted = !fsSync.existsSync(WORLD_DIR);
    const st = await fs.lstat(MOD_DIR);
    restore.modDirNow = st.isSymbolicLink()
      ? { kind: 'symlink', target: await fs.readlink(MOD_DIR) }
      : { kind: 'directory' };
    restore.parkedGone = !fsSync.existsSync(PARKED_DIR);
    await startFoundry();
    // Leave the normal world active so the next harness run finds it.
    const back = await connect({ world: CONFIG.restoreWorld, users: [] });
    await back.close();
    restore.status = await apiStatus();
  } catch (e) {
    restore.error = `${e.message}\n${e.stack}`;
  }
  R.restore = restore;
  log(`  restore: ${JSON.stringify(restore)}`);
  if (restore.error || parked
      || restore.modDirNow?.target !== R.modDirWas?.target
      || restore.worldDeleted === false) {
    fails.push(`RESTORE the environment was not fully restored: ${JSON.stringify(restore)}`);
  }
}

R.fails = fails;
await fs.writeFile(OUT, JSON.stringify(R, null, 2));
console.log(`\nresult JSON: ${OUT}`);
console.log(fails.length ? `SMOKE FAILED (${fails.length}):\n- ${fails.join('\n- ')}` : 'SMOKE PASSED');
process.exit(fails.length ? 1 : 0);
