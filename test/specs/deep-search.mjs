// Deep search: on-demand full-text search across journal entries and MEJ flag
// fields in the MEJ browser's directory sidebar (#42, #210). Today the
// toggle-search-mode button in templates/directory.html has no click handler
// wired to it in apps/enhanced-journal.js (core's own JournalDirectory owns
// that action for its own app, not this one), so only name-mode filtering
// (core's SearchFilter, bound at enhanced-journal.js:~1793) ever did anything.
// This spec drives the wiring end to end: toggle to full-text mode, Enter
// scans page names/text and MEJ flags (attributes/role/location/objectives/
// item names/notes), shows a results panel with entry name + type icon +
// up to 3 labeled snippets, a row click opens the entry via
// MonksEnhancedJournal.openJournalEntry, and clearing the query restores the
// folder tree. Name mode must keep live-filtering exactly as before.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, setEntryFlag, assertNoErrors } from '../helpers/mej.js';

const MARKER = 'xyzqmarker';
const SEARCH_INPUT = '.directory-sidebar input[name="search"]';
const RESULTS = '.directory-sidebar .mej-search-results';
const RESULT_ROW = '.directory-sidebar .mej-search-results .mej-search-result';

async function readResults(page) {
  return page.$$eval(RESULT_ROW, (els) =>
    els.map((el) => ({
      id: el.dataset.entryId,
      name: el.querySelector('.mej-search-name')?.textContent.trim(),
      snippets: Array.from(el.querySelectorAll('.mej-search-snippet')).map((s) => s.textContent.trim()),
    })));
}

// Foundry's tooltip manager can render a floating tooltip overlay exactly over
// a header control after a prior hover (same "z-index/overlay steals the
// hit-test" reasoning documented in internal-followups.mjs) - dispatch the
// click on the element directly rather than relying on Playwright's on-screen
// geometry check.
async function dispatchClick(page, selector) {
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
}

await withSession('deep-search', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const p1 = session.pages['User 1'];

  // --- Seed three TT- entries, each hit through a different scan path -----
  // Plain page text (no MEJ type at all - a base "text" page, exercising the
  // page.text.content scan path). Not createEntry(): that forces a
  // "monks-enhanced-journal.<type>" sub-type, and "journalentry" isn't one of
  // the module's registered JournalEntryPage sub-types (module.json only
  // registers encounter/event/list/loot/organization/person/picture/place/
  // poi/quest/shop/slideshow) - MEJ's "journalentry" is a virtual type it
  // assigns in memory to plain base pages, not a real persisted sub-type.
  const pageEntryId = await gm.evaluate(async (marker) => {
    const entry = await JournalEntry.create({
      name: 'TT-deep-search-page',
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: [{
        name: 'TT-deep-search-page',
        type: 'text',
        text: { content: `<p>Old lore mentions the ${marker} artifact.</p>` },
      }],
    });
    return entry.id;
  }, MARKER);

  const personEntryId = await createEntry(gm, 'person', 'TT-deep-search-person');
  await setEntryFlag(gm, personEntryId, 'attributes', { race: MARKER });

  const questEntryId = await createEntry(gm, 'quest', 'TT-deep-search-quest');
  await setEntryFlag(gm, questEntryId, 'objectives', {
    'obj-a': { id: 'obj-a', title: `find the ${MARKER}`, available: true, status: false },
  });
  // Deny User 1 access to the quest so the OBSERVER-permission filter in
  // deepSearch has something real to exclude below.
  await gm.evaluate((id) => game.journal.get(id).update({ ownership: { default: 0 } }), questEntryId);

  // --- GM: name mode still live-filters the tree (regression) -------------
  await openEntry(gm, pageEntryId);
  await gm.waitForSelector(SEARCH_INPUT, { state: 'visible', timeout: 15_000 });
  const modeIcon = '.directory-sidebar .toggle-search-mode';
  await gm.waitForSelector(`${modeIcon}.fa-magnifying-glass`, { timeout: 15_000 }); // starts in name mode

  // A unique substring of our own fixture name only - the world also has
  // hand-made baseline entries with "person" in their name (never swept, see
  // test/README.md), so match on something only TT-deep-search-person has.
  await gm.fill(SEARCH_INPUT, 'deep-search-person');
  await gm.waitForFunction(({ show, hide1, hide2 }) => {
    const display = (id) => document.querySelector(`.directory-sidebar .directory-list .directory-item[data-entry-id="${id}"]`)?.style.display;
    return display(show) !== 'none' && display(hide1) === 'none' && display(hide2) === 'none';
  }, { show: personEntryId, hide1: pageEntryId, hide2: questEntryId }, { timeout: 15_000 });
  assert.equal(await gm.$eval(RESULTS, () => true).catch(() => false), false,
    'name mode must not render the deep-search results panel');
  await gm.fill(SEARCH_INPUT, '');

  // --- Toggle to full-text mode --------------------------------------------
  await dispatchClick(gm, modeIcon);
  await gm.waitForSelector(`${modeIcon}.fa-file-magnifying-glass`, { timeout: 15_000 });
  // Toggling re-renders the app; the search input comes back empty.
  assert.equal(await gm.inputValue(SEARCH_INPUT), '', 'search input should reset on mode toggle');

  // --- Enter with an empty query does nothing (no panel, no crash) --------
  await gm.press(SEARCH_INPUT, 'Enter');
  await gm.waitForTimeout(200);
  assert.equal(await gm.$(RESULTS), null, 'Enter on an empty query must not open a results panel');

  // --- Full-text scan: exactly 3 hits, correct names + labeled snippets ---
  await gm.fill(SEARCH_INPUT, MARKER);
  await gm.press(SEARCH_INPUT, 'Enter');
  await gm.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
  await gm.waitForSelector('.directory-sidebar .directory-list', { state: 'hidden', timeout: 15_000 });

  let rows = await readResults(gm);
  assert.equal(rows.length, 3, `expected 3 results as GM, got ${rows.length}: ${JSON.stringify(rows)}`);
  assert.deepEqual(rows.map((r) => r.name),
    ['TT-deep-search-page', 'TT-deep-search-person', 'TT-deep-search-quest']);
  assert.ok(rows[0].snippets.some((s) => s.includes(MARKER)),
    'page-text row missing a snippet containing the marker');
  assert.ok(rows[1].snippets.some((s) => s.startsWith('race:') && s.includes(MARKER)),
    'person row snippet must be prefixed with its field label ("race:")');
  assert.ok(rows[2].snippets.some((s) => s.startsWith('objective:') && s.includes(MARKER)),
    'quest row snippet must be prefixed with its field label ("objective:")');

  // --- Click row 2 (person) opens it in MEJ --------------------------------
  await dispatchClick(gm, `${RESULT_ROW}:nth-of-type(2)`);
  await gm.waitForFunction((id) => {
    const doc = game.MonksEnhancedJournal.journal?.document;
    return !!doc && (doc.id === id || doc.parent?.id === id);
  }, personEntryId, { timeout: 15_000 });

  // --- Emptying the query restores the folder tree -------------------------
  await gm.waitForSelector(SEARCH_INPUT, { state: 'visible', timeout: 15_000 });
  await gm.fill(SEARCH_INPUT, MARKER);
  await gm.press(SEARCH_INPUT, 'Enter');
  await gm.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });

  await gm.fill(SEARCH_INPUT, '');
  await gm.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });
  await gm.waitForSelector('.directory-sidebar .directory-list', { state: 'visible', timeout: 15_000 });

  // --- Player: only entries they can observe are returned (1 fewer) -------
  await openEntry(p1, pageEntryId);
  await p1.waitForSelector(SEARCH_INPUT, { state: 'visible', timeout: 15_000 });
  await dispatchClick(p1, modeIcon);
  await p1.waitForSelector(`${modeIcon}.fa-file-magnifying-glass`, { timeout: 15_000 });

  await p1.fill(SEARCH_INPUT, MARKER);
  await p1.press(SEARCH_INPUT, 'Enter');
  await p1.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });

  const playerRows = await readResults(p1);
  assert.equal(playerRows.length, 2,
    `expected 2 results as a player without quest permission, got ${playerRows.length}: ${JSON.stringify(playerRows)}`);
  assert.deepEqual(playerRows.map((r) => r.name).sort(),
    ['TT-deep-search-page', 'TT-deep-search-person']);
  assert.ok(!playerRows.some((r) => r.name === 'TT-deep-search-quest'),
    'player must not see the quest they have no permission on');

  assertNoErrors(session);
});
