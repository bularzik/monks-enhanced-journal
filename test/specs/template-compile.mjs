// Guard for the 14.07b hotfix (2026-08-15): templates/make-offering.html was
// adopted verbatim from the maintainer's zip with an unbalanced
// {{#if}}/{{else}}/{{/if}} and a missing closing </div> (the {{#if (gt
// items.length 0)}} opened at line 38 never got its {{/if}} back after the
// {{else}} branch, and one <div> was left unclosed) — a Handlebars parse
// error that only surfaces the first time EnhancedJournalSheet's
// onMakeOffering handler actually tries to render that template, well after
// module load. Nothing at build time or module init caught it.
//
// Section 1 is the permanent net for this whole bug class: it precompiles
// EVERY template under templates/ with the live Foundry page's own bundled
// Handlebars (not a Node-side Handlebars that could parse differently), so
// any future "adopted a template with unbalanced blocks" regression fails
// loudly here instead of shipping silently. Section 2 is the exact
// user-facing repro (open a Person entry, trigger Make Offering) — kept
// alongside section 1 rather than relying on it alone, since a parse error
// is only one of several ways this dialog could fail to render.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';

// This spec file lives at <repo>/.claude/worktrees/playwright-harness/test/specs/
// — the module Foundry actually serves is symlinked from the MAIN repo
// checkout (Data/Data/modules/monks-enhanced-journal -> the repo root, NOT
// this worktree; see docs memory foundry-v14-test-env.md), so walk up to
// that same repo root's templates/ tree rather than this worktree's own
// (stale/divergent) copy, keeping this guard in sync with whatever the main
// repo actually has checked out.
const TEMPLATES_DIR = fileURLToPath(new URL('../../../../../templates/', import.meta.url));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(html|hbs)$/i.test(entry.name)) yield full;
  }
}

await withSession('template-compile', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];

  // --- 1. every template under templates/ must Handlebars.precompile() clean ---
  const files = [];
  for await (const f of walk(TEMPLATES_DIR)) files.push(f);
  // Sanity floor so a broken TEMPLATES_DIR resolution (e.g. the harness
  // relocated) fails loudly as "found almost no files" rather than silently
  // passing on an empty/near-empty set.
  assert.ok(files.length > 50,
    `expected the full templates/ tree, found only ${files.length} file(s) under ${TEMPLATES_DIR} — TEMPLATES_DIR resolution is likely broken`);

  const failures = [];
  for (const abs of files) {
    const rel = path.relative(TEMPLATES_DIR, abs);
    const source = await readFile(abs, 'utf8');
    const result = await gm.evaluate((src) => {
      try {
        Handlebars.precompile(src);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, source);
    if (!result.ok) failures.push(`${rel}: ${result.error}`);
  }

  assert.equal(failures.length, 0,
    `${failures.length}/${files.length} template(s) failed Handlebars.precompile():\n${failures.join('\n')}`);

  // --- 2. minimal repro: opening Make Offering from a Person entry must
  // actually render the dialog, not just compile clean ---
  let personId;
  try {
    personId = await createEntry(gm, 'person', 'TT-template-compile-person');
    await openEntry(gm, personId);

    // Offerings is a subsheet tab (templates/sheets/person.html); every tab
    // renders into the DOM up front with only an "active" class toggling
    // visibility (see relationships.mjs), so switch to it first rather than
    // fighting Playwright's visibility-actionability check on a hidden tab.
    await gm.waitForSelector('a[data-action="tab"][data-tab="offerings"]', { state: 'visible', timeout: 15_000 });
    await gm.click('a[data-action="tab"][data-tab="offerings"]');
    await gm.waitForSelector('[data-action="makeOffering"]', { state: 'visible', timeout: 15_000 });
    await gm.click('[data-action="makeOffering"]');

    const rendered = await gm.waitForFunction(() =>
      [...foundry.applications.instances.values()]
        .some((a) => a.constructor.name === 'MakeOffering' && a.rendered),
      null, { timeout: 10_000 },
    ).then(() => true).catch(() => false);
    assert.ok(rendered, 'Make Offering window did not render after clicking the makeOffering action (template parse error or other render failure)');
  } finally {
    if (personId) {
      await gm.evaluate((id) => {
        for (const app of foundry.applications.instances.values()) {
          if (app.constructor.name === 'MakeOffering') app.close();
        }
      }, personId).catch(() => {});
      await gm.evaluate(async (id) => { await game.journal.get(id)?.delete(); }, personId).catch(() => {});
    }
  }

  assertNoErrors(session);
});
