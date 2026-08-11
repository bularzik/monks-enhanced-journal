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

const MODULE = 'monks-enhanced-journal';
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

// Runs one deep-search query to completion (fill, Enter, wait for the
// results panel, read rows, clear back to the folder tree) - used by the
// final-review leak-gate checks below, each of which runs several searches.
// A doc created/flagged on the GM's client reaches other clients over the
// socket asynchronously - searching from a player immediately afterward with
// no other round trip in between (unlike most of this spec's existing
// checks, which always run a same-client GM search first, incidentally
// giving the socket update time to land) can race that sync and never see a
// results panel at all. Wait for the flag to actually be visible on the
// target page's own client first.
async function waitForPageFlag(page, entryId, key) {
  await page.waitForFunction(({ id, key }) => {
    const val = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', key);
    return val !== undefined && val !== null && (typeof val !== 'object' || Object.keys(val).length > 0);
  }, { id: entryId, key }, { timeout: 15_000 });
}

async function searchAndRead(page, marker) {
  await page.fill(SEARCH_INPUT, marker);
  await page.press(SEARCH_INPUT, 'Enter');
  await page.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
  const rows = await readResults(page);
  await page.fill(SEARCH_INPUT, '');
  await page.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });
  return rows;
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

  // --- Secret-section content must not leak to non-owner observers --------
  // MEJ's own sheets gate secrets on isOwner, not OBSERVER
  // (EnhancedJournalSheet.js/QuestSheet.js: `secrets: this.document.isOwner`).
  // An OBSERVER-only player must not get a word from inside
  // <section class="secret"> back in a labeled snippet just because
  // deepSearch happened to scan the raw page text.
  const SECRET_MARKER = 'zzzsecretmarker';
  const OUTER_MARKER = 'zzzoutermarker';
  const secretEntryId = await gm.evaluate(async ({ secret, outer }) => {
    const entry = await JournalEntry.create({
      name: 'TT-deep-search-secret',
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      pages: [{
        name: 'TT-deep-search-secret',
        type: 'text',
        text: {
          content: `<p>Public info mentions the ${outer}.</p>`
            + `<section class="secret"><p>GM-only detail: ${secret}</p></section>`,
        },
      }],
    });
    return entry.id;
  }, { secret: SECRET_MARKER, outer: OUTER_MARKER });

  // GM is the owner of everything: finds the marker that only lives inside
  // the secret section.
  await gm.fill(SEARCH_INPUT, SECRET_MARKER);
  await gm.press(SEARCH_INPUT, 'Enter');
  await gm.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
  const gmSecretRows = await readResults(gm);
  assert.equal(gmSecretRows.length, 1,
    `GM should find the secret-only marker, got ${JSON.stringify(gmSecretRows)}`);
  assert.equal(gmSecretRows[0].id, secretEntryId);
  assert.equal(gmSecretRows[0].name, 'TT-deep-search-secret');
  assert.ok(gmSecretRows[0].snippets.some((s) => s.includes(SECRET_MARKER)));
  await gm.fill(SEARCH_INPUT, '');
  await gm.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });

  // Player has OBSERVER (not OWNER) on this entry: must NOT find a marker
  // that exists only inside the secret section.
  await p1.fill(SEARCH_INPUT, SECRET_MARKER);
  await p1.press(SEARCH_INPUT, 'Enter');
  await p1.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
  const playerSecretRows = await readResults(p1);
  assert.equal(playerSecretRows.length, 0,
    `player must not find a marker that only exists inside a secret section, got ${JSON.stringify(playerSecretRows)}`);
  await p1.fill(SEARCH_INPUT, '');
  await p1.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });

  // Same page, same player: a marker outside the secret section still hits -
  // proves the secret *section* was stripped, not the whole page excluded.
  await p1.fill(SEARCH_INPUT, OUTER_MARKER);
  await p1.press(SEARCH_INPUT, 'Enter');
  await p1.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
  const playerOuterRows = await readResults(p1);
  assert.equal(playerOuterRows.length, 1,
    `player should still find the non-secret marker on the same page, got ${JSON.stringify(playerOuterRows)}`);
  assert.equal(playerOuterRows[0].name, 'TT-deep-search-secret');
  assert.ok(playerOuterRows[0].snippets.some((s) => s.includes(OUTER_MARKER)));
  await p1.fill(SEARCH_INPUT, '');
  await p1.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });

  // --- playerHidden attribute guard (Task 9 merge check) ------------------
  // deepSearch's `!game.user.isGM && pageSettings.attributes?.[k]?.playerHidden`
  // guard (apps/enhanced-journal.js) was written defensively against a
  // per-attribute playerHidden setting that didn't exist on this branch's own
  // base - it goes live once merged with enh/attribute-visibility (already on
  // enhancements-test) + enh/more-type-attributes. A GM-only attribute must
  // not surface a player's search hit, while a visible attribute on the very
  // same page still does. sheet-settings is world-scoped: save/restore it
  // around marking "race" playerHidden, mirroring more-type-attributes.mjs.
  const HIDDEN_MARKER = 'zzzhiddenattrmarker';
  const VISIBLE_MARKER = 'zzzvisibleattrmarker';
  const originalSheetSettings = await gm.evaluate((mod) => game.settings.get(mod, 'sheet-settings'), MODULE);
  try {
    await gm.evaluate((mod) => {
      const settings = foundry.utils.duplicate(game.settings.get(mod, 'sheet-settings') || {});
      settings.person = settings.person || {};
      settings.person.attributes = settings.person.attributes || {};
      settings.person.attributes.race = { ...(settings.person.attributes.race || {}), playerHidden: true };
      return game.settings.set(mod, 'sheet-settings', settings, { diff: false });
    }, MODULE);

    const hiddenAttrEntryId = await createEntry(gm, 'person', 'TT-deep-search-hidden-attr');
    await setEntryFlag(gm, hiddenAttrEntryId, 'attributes', { race: HIDDEN_MARKER, ancestry: VISIBLE_MARKER });

    // GM: not subject to the playerHidden guard, finds the hidden attribute.
    await gm.fill(SEARCH_INPUT, HIDDEN_MARKER);
    await gm.press(SEARCH_INPUT, 'Enter');
    await gm.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
    const gmHiddenRows = await readResults(gm);
    assert.equal(gmHiddenRows.length, 1, `GM should find the playerHidden attribute, got ${JSON.stringify(gmHiddenRows)}`);
    assert.ok(gmHiddenRows[0].snippets.some((s) => s.startsWith('race:') && s.includes(HIDDEN_MARKER)));
    await gm.fill(SEARCH_INPUT, '');
    await gm.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });

    // Player: the playerHidden "race" attribute must not surface a hit...
    await p1.fill(SEARCH_INPUT, HIDDEN_MARKER);
    await p1.press(SEARCH_INPUT, 'Enter');
    await p1.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
    const playerHiddenRows = await readResults(p1);
    assert.equal(playerHiddenRows.length, 0,
      `player must not find a marker that only exists in a playerHidden attribute, got ${JSON.stringify(playerHiddenRows)}`);
    await p1.fill(SEARCH_INPUT, '');
    await p1.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });

    // ...but a visible attribute on the very same page still hits, proving
    // the guard excludes only the one hidden attribute, not the whole page.
    await p1.fill(SEARCH_INPUT, VISIBLE_MARKER);
    await p1.press(SEARCH_INPUT, 'Enter');
    await p1.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
    const playerVisibleRows = await readResults(p1);
    assert.equal(playerVisibleRows.length, 1,
      `player should still find the visible attribute on the same page, got ${JSON.stringify(playerVisibleRows)}`);
    assert.equal(playerVisibleRows[0].name, 'TT-deep-search-hidden-attr');
    assert.ok(playerVisibleRows[0].snippets.some((s) => s.startsWith('ancestry:') && s.includes(VISIBLE_MARKER)));
    await p1.fill(SEARCH_INPUT, '');
    await p1.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });
  } finally {
    await gm.evaluate((args) => game.settings.set(args.mod, 'sheet-settings', args.orig, { diff: false }),
      { mod: MODULE, orig: originalSheetSettings });
  }

  // --- final-review C1: page-level sheet-settings playerHidden (distinct --
  // from the world-scoped check above) ------------------------------------
  // C1.3's fix merges a page's own `flags["sheet-settings"]` override on top
  // of the static/world default before the playerHidden check
  // (apps/enhanced-journal.js's deepSearch) - previously only the world
  // default was consulted, so a GM hiding just ONE page's attribute (via
  // Configure Sheet on that page, not a world setting) was silently ignored.
  {
    const PAGE_HIDDEN_MARKER = 'zzzpagehiddenmarker';
    const PAGE_VISIBLE_MARKER = 'zzzpagevisiblemarker';
    const pageHiddenEntryId = await createEntry(gm, 'person', 'TT-deep-search-page-hidden-attr');
    await setEntryFlag(gm, pageHiddenEntryId, 'attributes', { race: PAGE_HIDDEN_MARKER, ancestry: PAGE_VISIBLE_MARKER });
    // A page-level override, not a world setting: written straight to the
    // page's own flags, exactly what Configure Sheet persists there.
    await setEntryFlag(gm, pageHiddenEntryId, 'sheet-settings', { attributes: { race: { playerHidden: true } } });
    await waitForPageFlag(p1, pageHiddenEntryId, 'sheet-settings');

    const gmPageHiddenRows = await searchAndRead(gm, PAGE_HIDDEN_MARKER);
    assert.equal(gmPageHiddenRows.length, 1, `GM should find the page-level playerHidden attribute, got ${JSON.stringify(gmPageHiddenRows)}`);

    const playerPageHiddenRows = await searchAndRead(p1, PAGE_HIDDEN_MARKER);
    assert.equal(playerPageHiddenRows.length, 0,
      `player must not find a marker hidden by a page-level sheet-settings override, got ${JSON.stringify(playerPageHiddenRows)}`);

    const playerPageVisibleRows = await searchAndRead(p1, PAGE_VISIBLE_MARKER);
    assert.equal(playerPageVisibleRows.length, 1,
      `player should still find the un-hidden attribute on the same page, got ${JSON.stringify(playerPageVisibleRows)}`);
  }

  // --- final-review C1: unavailable quest objectives -----------------------
  // QuestSheet only shows an objective to non-owners once it's `available`
  // (sheets/QuestSheet.js: `this.document.isOwner || o.available`).
  {
    const UNAVAILABLE_MARKER = 'zzzunavailobjmarker';
    const AVAILABLE_MARKER = 'zzzavailobjmarker';
    const objQuestId = await createEntry(gm, 'quest', 'TT-deep-search-objectives');
    await setEntryFlag(gm, objQuestId, 'objectives', {
      'obj-hidden': { id: 'obj-hidden', title: `secret plan: ${UNAVAILABLE_MARKER}`, available: false, status: false },
      'obj-shown': { id: 'obj-shown', title: `known plan: ${AVAILABLE_MARKER}`, available: true, status: false },
    });
    await waitForPageFlag(p1, objQuestId, 'objectives');

    const playerUnavailRows = await searchAndRead(p1, UNAVAILABLE_MARKER);
    assert.equal(playerUnavailRows.length, 0,
      `player must not find an unavailable objective's title, got ${JSON.stringify(playerUnavailRows)}`);

    const playerAvailRows = await searchAndRead(p1, AVAILABLE_MARKER);
    assert.equal(playerAvailRows.length, 1,
      `player should still find an available objective on the same quest, got ${JSON.stringify(playerAvailRows)}`);
    assert.ok(playerAvailRows[0].snippets.some((s) => s.startsWith('objective:') && s.includes(AVAILABLE_MARKER)));

    const gmUnavailRows = await searchAndRead(gm, UNAVAILABLE_MARKER);
    assert.equal(gmUnavailRows.length, 1, `GM (owner) should still find the unavailable objective, got ${JSON.stringify(gmUnavailRows)}`);
  }

  // --- final-review C1: hidden / unidentified / closed-shop items ---------
  // Mirrors EnhancedJournalSheet.js's getItemGroups() display gate
  // (`item.hidden !== true`) and its unidentified-name substitution
  // (MonksEnhancedJournal.getItemDetails()), plus ShopSheet.js's `hideitems`
  // (entire item list hidden from non-owners while the shop is closed).
  // Synthetic item objects are written straight to the `items` flag - the
  // same minimal pattern price-tiers-world.mjs uses - rather than driving a
  // real drag-drop, since only the stored shape deepSearch reads is under
  // test here.
  {
    const HIDDEN_ITEM_MARKER = 'zzzhiddenitemmarker';
    const SHOWN_ITEM_MARKER = 'zzzshownitemmarker';
    const REAL_NAME_MARKER = 'zzzrealnamemarker';
    const UNIDENTIFIED_NAME_MARKER = 'zzzunidentifiednamemarker';

    const openShopId = await createEntry(gm, 'shop', 'TT-deep-search-shop-open', { purchasing: 'confirm', state: 'open' });
    await gm.evaluate(async ({ id, hiddenMarker, shownMarker, realMarker, unidMarker }) => {
      const page = game.journal.get(id).pages.contents[0];
      const items = {};
      const hiddenId = foundry.utils.randomID();
      items[hiddenId] = { _id: hiddenId, name: `TT-hidden-item ${hiddenMarker}`, type: 'loot', hidden: true, flags: { 'monks-enhanced-journal': { quantity: 1 } } };
      const shownId = foundry.utils.randomID();
      items[shownId] = { _id: shownId, name: `TT-shown-item ${shownMarker}`, type: 'loot', hidden: false, flags: { 'monks-enhanced-journal': { quantity: 1 } } };
      const unidId = foundry.utils.randomID();
      items[unidId] = {
        _id: unidId, name: `TT-real-item ${realMarker}`, type: 'loot', hidden: false,
        system: { identification: { status: 'unidentified', unidentified: { name: `TT-unidentified-item ${unidMarker}` } } },
        flags: { 'monks-enhanced-journal': { quantity: 1 } },
      };
      await page.setFlag('monks-enhanced-journal', 'items', items);
    }, { id: openShopId, hiddenMarker: HIDDEN_ITEM_MARKER, shownMarker: SHOWN_ITEM_MARKER, realMarker: REAL_NAME_MARKER, unidMarker: UNIDENTIFIED_NAME_MARKER });
    await waitForPageFlag(p1, openShopId, 'items');

    // Hidden item: invisible to the player, still found by the GM (owner).
    const playerHiddenItemRows = await searchAndRead(p1, HIDDEN_ITEM_MARKER);
    assert.equal(playerHiddenItemRows.length, 0, `player must not find a hidden item's name, got ${JSON.stringify(playerHiddenItemRows)}`);
    const gmHiddenItemRows = await searchAndRead(gm, HIDDEN_ITEM_MARKER);
    assert.equal(gmHiddenItemRows.length, 1, `GM (owner) should still find the hidden item, got ${JSON.stringify(gmHiddenItemRows)}`);

    // A non-hidden item on the same (open) shop still hits for the player.
    const playerShownItemRows = await searchAndRead(p1, SHOWN_ITEM_MARKER);
    assert.equal(playerShownItemRows.length, 1, `player should find a non-hidden item on an open shop, got ${JSON.stringify(playerShownItemRows)}`);
    assert.ok(playerShownItemRows[0].snippets.some((s) => s.startsWith('item:') && s.includes(SHOWN_ITEM_MARKER)));

    // Unidentified item: the player must not find the REAL name...
    const playerRealNameRows = await searchAndRead(p1, REAL_NAME_MARKER);
    assert.equal(playerRealNameRows.length, 0, `player must not find an unidentified item's real name, got ${JSON.stringify(playerRealNameRows)}`);
    // ...but does find the unidentified display name...
    const playerUnidNameRows = await searchAndRead(p1, UNIDENTIFIED_NAME_MARKER);
    assert.equal(playerUnidNameRows.length, 1, `player should find an unidentified item's unidentified display name, got ${JSON.stringify(playerUnidNameRows)}`);
    assert.ok(playerUnidNameRows[0].snippets.some((s) => s.startsWith('item:') && s.includes(UNIDENTIFIED_NAME_MARKER)));
    // ...while the GM (owner) sees the real name, not the substitute.
    const gmRealNameRows = await searchAndRead(gm, REAL_NAME_MARKER);
    assert.equal(gmRealNameRows.length, 1, `GM (owner) should find the item by its real name, got ${JSON.stringify(gmRealNameRows)}`);

    // Closed shop: the whole item list is invisible to the player, even a
    // plain (non-hidden) item - GM (owner) is unaffected.
    const closedShopId = await createEntry(gm, 'shop', 'TT-deep-search-shop-closed', { purchasing: 'confirm', state: 'closed' });
    const CLOSED_ITEM_MARKER = 'zzzclosedshopitemmarker';
    await gm.evaluate(async ({ id, marker }) => {
      const page = game.journal.get(id).pages.contents[0];
      const itemId = foundry.utils.randomID();
      await page.setFlag('monks-enhanced-journal', 'items', {
        [itemId]: { _id: itemId, name: `TT-closed-shop-item ${marker}`, type: 'loot', hidden: false, flags: { 'monks-enhanced-journal': { quantity: 1 } } },
      });
    }, { id: closedShopId, marker: CLOSED_ITEM_MARKER });
    await waitForPageFlag(p1, closedShopId, 'items');

    const playerClosedShopRows = await searchAndRead(p1, CLOSED_ITEM_MARKER);
    assert.equal(playerClosedShopRows.length, 0,
      `player must not find any item on a closed shop, got ${JSON.stringify(playerClosedShopRows)}`);
    const gmClosedShopRows = await searchAndRead(gm, CLOSED_ITEM_MARKER);
    assert.equal(gmClosedShopRows.length, 1, `GM (owner) should still find an item on a closed shop, got ${JSON.stringify(gmClosedShopRows)}`);
  }

  // --- final-review I2: a result click must open SOME sheet, never a ------
  // silent no-op, even when openJournalEntry declines (`mej-only-types`
  // enabled + a plain, non-MEJ-typed journal entry - monks-enhanced-journal.js:2412).
  {
    const originalMejOnlyTypes = await gm.evaluate((mod) => game.settings.get(mod, 'mej-only-types'), MODULE);
    try {
      await gm.evaluate((mod) => game.settings.set(mod, 'mej-only-types', true), MODULE);

      const FALLBACK_MARKER = 'zzzfallbackclickmarker';
      const plainEntryId = await gm.evaluate(async (marker) => {
        const entry = await JournalEntry.create({
          name: 'TT-deep-search-fallback',
          ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
          pages: [{
            name: 'TT-deep-search-fallback',
            type: 'text',
            text: { content: `<p>${marker}</p>` },
          }],
        });
        return entry.id;
      }, FALLBACK_MARKER);
      await p1.waitForFunction((id) => !!game.journal.get(id), plainEntryId, { timeout: 15_000 });

      await p1.fill(SEARCH_INPUT, FALLBACK_MARKER);
      await p1.press(SEARCH_INPUT, 'Enter');
      await p1.waitForSelector(RESULTS, { state: 'visible', timeout: 15_000 });
      await dispatchClick(p1, RESULT_ROW);

      await p1.waitForFunction((id) => Array.from(foundry.applications.instances.values())
        .some((app) => app.document?.id === id && app.rendered), plainEntryId, { timeout: 15_000 });

      await p1.fill(SEARCH_INPUT, '');
      await p1.waitForSelector(RESULTS, { state: 'detached', timeout: 15_000 });
      await p1.evaluate((id) => Array.from(foundry.applications.instances.values())
        .find((app) => app.document?.id === id)?.close(), plainEntryId);
    } finally {
      await gm.evaluate((args) => game.settings.set(args.mod, 'mej-only-types', args.orig), { mod: MODULE, orig: originalMejOnlyTypes });
    }
  }

  assertNoErrors(session);
});
