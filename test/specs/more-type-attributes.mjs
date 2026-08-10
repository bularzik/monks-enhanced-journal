// Task 6 (enh/more-type-attributes, #503/#523): Organization/Event/POI gain
// the same configurable-attribute system Person/Place already have, driven
// entirely through sheet-settings (EnhancedJournalSheet.fieldlist(), hoisted
// verbatim off PersonSheet/PlaceSheet). Defaults for the three new types'
// entry-details tab and their attribute rows all ship `shown: false` so
// there is zero visual change until a GM opts in via Customise Pages.
//
// This spec drives the real Customise Pages dialog (open -> pick the
// Organization category -> attributes/tabs subtabs -> toggle checkboxes ->
// Save) for the enable-attribute and enable-tab steps, exactly like a GM
// would. Direct flag reads/writes are used only for setting up entry data
// and for verification.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, setEntryFlag, assertNoErrors } from '../helpers/mej.js';

const MODULE = 'monks-enhanced-journal';

async function openCustomisePages(page) {
  await page.evaluate((mod) => {
    const menu = game.settings.menus.get(`${mod}.customise-pages`);
    if (!menu) throw new Error('customise-pages menu is not registered');
    new menu.type().render(true);
  }, MODULE);
  await page.waitForSelector('#customise-pages', { state: 'visible' });
}

async function saveCustomisePages(page) {
  await page.click('#customise-pages button[type="submit"]');
  await page.waitForSelector('#customise-pages', { state: 'hidden' });
}

await withSession('more-type-attributes', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const player = session.pages['User 1'];

  // Customise Pages persists to the world-scoped "sheet-settings" setting
  // (game.settings.set, no per-run isolation) - capture the pre-test value
  // and restore it in `finally` so this spec is idempotent across runs and
  // doesn't leak an enabled organization attributes/entry-details tab into
  // the world (which would also break the "defaults to hidden" assertion
  // below on a second run).
  const originalSheetSettings = await gm.evaluate((mod) => game.settings.get(mod, 'sheet-settings'), MODULE);
  try {

  // --- Customise Pages: Organization attributes/tabs default to hidden ---
  await openCustomisePages(gm);
  await gm.click('#customise-pages .page-tabs button[data-tab="organization"]');
  await gm.click('a[data-group="organization"][data-tab="attributes"]');

  const defaultIds = ['leader', 'headquarters', 'scope', 'alignment', 'founded'];
  const beforeShown = await gm.evaluate((ids) =>
    ids.map((id) => document.querySelector(`input[name="sheetSettings.organization.attributes.${id}.shown"]`)?.checked),
    defaultIds);
  assert.ok(beforeShown.every((v) => v === false), `expected all default organization attributes unchecked, got ${JSON.stringify(beforeShown)}`);

  const beforeTabShown = await gm.evaluate(() =>
    document.querySelector('input[name="sheetSettings.organization.tabs.entry-details.shown"]')?.checked);
  assert.equal(beforeTabShown, false, 'expected the entry-details tab checkbox unchecked by default');

  // Enable "leader"
  await gm.click('input[name="sheetSettings.organization.attributes.leader.shown"]');

  // Add + configure a custom attribute. The header's add button sits right
  // above the scrollable item-list, and a sticky-positioning edge case makes
  // the list the element Playwright's coordinate-based click lands on even
  // with force:true - dispatch a genuine click directly at the button
  // element instead (still the real DOM handler, just not coordinate-routed).
  await gm.evaluate(() => {
    document.querySelector('#customise-pages button[data-action="addAttribute"][data-attribute="sheetSettings.organization.attributes"]').click();
  });
  await gm.waitForFunction(() =>
    document.querySelectorAll('li.item[data-id^="sheetSettings.organization.attributes."]').length === 6);
  const customId = await gm.evaluate((known) => {
    const items = [...document.querySelectorAll('li.item[data-id^="sheetSettings.organization.attributes."]')];
    for (const li of items) {
      const id = li.dataset.id.split('.').pop();
      if (!known.includes(id)) return id;
    }
    return null;
  }, defaultIds);
  assert.ok(customId, 'could not locate the newly added custom attribute row');
  await gm.fill(`input[name="sheetSettings.organization.attributes.${customId}.name"]`, 'TT Custom Attribute');
  await gm.press(`input[name="sheetSettings.organization.attributes.${customId}.name"]`, 'Tab');

  // Enable the entry-details tab
  await gm.click('a[data-group="organization"][data-tab="tabs"]');
  await gm.click('input[name="sheetSettings.organization.tabs.entry-details.shown"]');

  await saveCustomisePages(gm);

  const saved = await gm.evaluate((mod) => game.settings.get(mod, 'sheet-settings').organization, MODULE);
  assert.equal(saved.attributes.leader.shown, true, 'leader.shown was not persisted');
  assert.equal(saved.attributes[customId]?.shown, true, 'custom attribute.shown was not persisted');
  assert.equal(saved.attributes[customId]?.name, 'TT Custom Attribute', 'custom attribute.name was not persisted');
  assert.equal(saved.tabs['entry-details'].shown, true, 'entry-details tab.shown was not persisted');

  // --- GM: create an Organization entry, populate the two enabled attributes ---
  const orgId = await createEntry(gm, 'organization', 'TT-org-attrs');
  await setEntryFlag(gm, orgId, 'attributes', { leader: 'Test Leader Name', [customId]: 'Custom Value' });
  await openEntry(gm, orgId);
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');

  const gmRows = await gm.evaluate(() => [...document.querySelectorAll('.monks-enhanced-journal .document-details ul li')].map((li) => {
    const field = li.querySelector('input,textarea');
    return { name: field?.name, value: field?.value, hasEyeSlash: !!li.querySelector('.fa-eye-slash') };
  }));
  const leaderRow = gmRows.find((r) => r.name?.endsWith('.leader'));
  const customRow = gmRows.find((r) => r.name?.endsWith(`.${customId}`));
  assert.ok(leaderRow, 'GM: entry-details tab is missing the leader row');
  assert.equal(leaderRow.value, 'Test Leader Name', 'GM: leader row has the wrong value');
  assert.equal(leaderRow.hasEyeSlash, false, 'GM: leader row should not show the hidden-from-players marker yet');
  assert.ok(customRow, 'GM: entry-details tab is missing the custom attribute row');
  assert.equal(customRow.value, 'Custom Value', 'GM: custom attribute row has the wrong value');

  // --- GM: mark "leader" playerHidden via the E2 checkbox, then re-render ---
  await openCustomisePages(gm);
  await gm.click('#customise-pages .page-tabs button[data-tab="organization"]');
  await gm.click('a[data-group="organization"][data-tab="attributes"]');
  await gm.click('input[name="sheetSettings.organization.attributes.leader.playerHidden"]');
  await saveCustomisePages(gm);

  await gm.evaluate(() => game.MonksEnhancedJournal.journal.render(true));
  await gm.waitForSelector('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');

  const gmRowsAfter = await gm.evaluate(() => [...document.querySelectorAll('.monks-enhanced-journal .document-details ul li')].map((li) => {
    const field = li.querySelector('input,textarea');
    return { name: field?.name, hasEyeSlash: !!li.querySelector('.fa-eye-slash') };
  }));
  const leaderRowAfter = gmRowsAfter.find((r) => r.name?.endsWith('.leader'));
  assert.ok(leaderRowAfter, 'GM: leader row disappeared for the GM after marking playerHidden');
  assert.equal(leaderRowAfter.hasEyeSlash, true, 'GM: leader row should now show the hidden-from-players marker');

  // --- Player (Observer): leader row is omitted, custom attribute row remains ---
  await openEntry(player, orgId);
  await player.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  const playerFieldNames = await player.evaluate(() =>
    [...document.querySelectorAll('.monks-enhanced-journal .document-details ul li input,.monks-enhanced-journal .document-details ul li textarea')]
      .map((el) => el.name));
  assert.ok(!playerFieldNames.some((n) => n.endsWith('.leader')), 'player render should omit the playerHidden leader row');
  assert.ok(playerFieldNames.some((n) => n.endsWith(`.${customId}`)), 'player render should still show the non-hidden custom attribute row');

  // --- Regression: Person's fieldlist() output is unaffected by the hoist ---
  const personId = await createEntry(gm, 'person', 'TT-person-regression');
  await openEntry(gm, personId);
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');

  const expectedPersonIds = await gm.evaluate((mod) => {
    const registered = game.settings.settings.get(`${mod}.sheet-settings`);
    const def = foundry.utils.duplicate(registered.default.person || {});
    const stored = foundry.utils.duplicate((game.settings.get(mod, 'sheet-settings') || {}).person || {});
    const merged = foundry.utils.mergeObject(def, stored);
    const fields = Object.entries(merged.attributes || {}).map(([id, v]) => ({ id, ...v }));
    return fields
      .filter((f) => f.shown && (game.user.isGM || !f.playerHidden))
      .sort((a, b) => a.order - b.order)
      .map((f) => f.id);
  }, MODULE);

  const actualPersonIds = await gm.evaluate(() =>
    [...document.querySelectorAll('.monks-enhanced-journal [data-tab="entry-details"] input[name^="flags.monks-enhanced-journal.attributes."],.monks-enhanced-journal [data-tab="entry-details"] textarea[name^="flags.monks-enhanced-journal.attributes."]')]
      .map((el) => el.name.split('.').pop()));

  assert.deepEqual(actualPersonIds, expectedPersonIds, 'Person detailFields output changed after the fieldlist() hoist');

  assertNoErrors(session);
  } finally {
    await gm.evaluate((args) => game.settings.set(args.mod, 'sheet-settings', args.orig, { diff: false }),
      { mod: MODULE, orig: originalSheetSettings });
  }
});
