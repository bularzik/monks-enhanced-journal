// Five internal follow-up fixes, each its own check in one session:
//  1. transfer-currency crash when no currency flag exists yet
//     (apps/transfer-currency.js:111).
//  2. malformed migration-key document.update() calls in Person/Place
//     _prepareBodyContext that silently no-op instead of writing
//     flags.monks-enhanced-journal.sheet-settings.attributes
//     (sheets/PersonSheet.js:75/94, sheets/PlaceSheet.js:105/124).
//  3. those migration writes must be GM-gated - a non-GM render must not
//     write to the document at all.
//  4. CustomisePage.onSubmitForm throwing when a per-type adjustment row
//     has no counterpart in the (possibly trimmed) default settings
//     (apps/customise-page.js).
//  5. MonksEnhancedJournal.sellItem crashing with "Cannot read properties
//     of null (reading 'name')" (monks-enhanced-journal.js:3439) when a
//     shop's "free" selling mode sells straight to the GM without an
//     actorId (ShopSheet.js's free-sell _onDropItem branch never sent
//     one - the offer/accept flow is the only caller that does).
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, entryFlag, assertNoErrors } from '../helpers/mej.js';

await withSession('internal-followups', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const p1 = session.pages['User 1'];

  // --- Check 1: transfer-currency crash --------------------------------
  // Open Transfer Currency on a loot page before any 'currency' flag
  // exists, then submit a positive amount. onCurrencyChange caps typed
  // values at the loot's existing currency for that denomination (0 when
  // the flag is missing), so a real positive amount can only reach
  // _onSubmitForm by setting the app's in-memory `currency` state
  // directly - the same state a real drag-and-drop or multi-step edit
  // would eventually produce. TransferCurrency.onTransferCurrency/
  // transferCurrency (LootSheet.js:200-206) opens it via the currently
  // displayed subsheet.
  const lootId = await createEntry(gm, 'loot', 'TT-followup-loot');
  const transferActorId = await gm.evaluate(async () =>
    (await Actor.create({ name: 'TT-followup-actor', type: 'character' })).id);
  await openEntry(gm, lootId);
  await gm.evaluate((actorId) => {
    const actor = game.actors.get(actorId);
    game.MonksEnhancedJournal.journal.subsheet.transferCurrency(actor);
  }, transferActorId);
  await gm.waitForSelector('.transfer-currency', { state: 'visible', timeout: 15_000 });
  await gm.evaluate(() => {
    foundry.applications.instances.get('transfer-currency').currency['gp'] = 5;
  });
  // A real Playwright click here is flaky with a second client connected:
  // the journal window's z-index jumps above the dialog's a few hundred ms
  // after open (some socket-driven re-render, unrelated to this fix), which
  // intermittently steals the hit-test at the button's screen coordinates.
  // Dispatch the click on the actual button element instead - it still
  // fires the same 'click'/form 'submit' listeners as a real user click,
  // it just isn't subject to Playwright's on-screen geometry check.
  await gm.evaluate(() => document.querySelector('.transfer-currency button[type="submit"]').click());
  await gm.waitForSelector('.transfer-currency', { state: 'detached', timeout: 15_000 });
  const remainder = await entryFlag(gm, lootId, 'currency');
  assert.equal(remainder?.gp, -5, 'loot currency flag not written after transfer');

  // --- Check 2: malformed migration keys (person + place) --------------
  async function checkMigration(type, name) {
    const id = await createEntry(gm, type, name);
    await gm.evaluate(async (id) => {
      const page = game.journal.get(id).pages.contents[0];
      await page.setFlag('monks-enhanced-journal', 'attributes', { race: { value: 'Elf', hidden: false } });
    }, id);
    await openEntry(gm, id);
    await gm.waitForFunction((id) => {
      const page = game.journal.get(id)?.pages.contents[0];
      return page?.getFlag('monks-enhanced-journal', 'sheet-settings')?.attributes?.race?.shown === true;
    }, id, { timeout: 15_000 });

    const sheetSettings = await entryFlag(gm, id, 'sheet-settings');
    assert.equal(sheetSettings?.attributes?.race?.shown, true,
      `${type}: sheet-settings.attributes.race.shown not migrated`);

    // The old code targeted 'monks-enhanced-journal.flags.sheet-settings...'
    // (document-root-relative), not 'flags.monks-enhanced-journal...' - make
    // sure that malformed path never actually landed on the document root.
    const stray = await gm.evaluate((id) =>
      foundry.utils.getProperty(game.journal.get(id).pages.contents[0], 'monks-enhanced-journal.flags'), id);
    assert.equal(stray, undefined, `${type}: stray top-level malformed key path was written to the document root`);

    return id;
  }
  await checkMigration('person', 'TT-followup-person');
  await checkMigration('place', 'TT-followup-place');

  // --- Check 3: non-GM render must not migrate/write -------------------
  const nonGmId = await createEntry(gm, 'person', 'TT-followup-person-nongm');
  const user1Id = await gm.evaluate(() => game.users.getName('User 1').id);
  await gm.evaluate(async ({ id, user1Id }) => {
    const page = game.journal.get(id).pages.contents[0];
    await page.setFlag('monks-enhanced-journal', 'attributes', { race: { value: 'Elf', hidden: false } });
    await page.update({ ownership: { default: 0, [user1Id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER } });
  }, { id: nonGmId, user1Id });
  const modifiedBefore = await gm.evaluate((id) =>
    game.journal.get(id).pages.contents[0]._stats.modifiedTime, nonGmId);

  await openEntry(p1, nonGmId);
  await p1.waitForTimeout(1000);

  const modifiedAfter = await gm.evaluate((id) =>
    game.journal.get(id).pages.contents[0]._stats.modifiedTime, nonGmId);
  assert.equal(modifiedAfter, modifiedBefore,
    'a player render wrote to the document - migration must be GM-gated');

  // --- Check 4: CustomisePage save throw --------------------------------
  // Repro (final-review scenario): the shop adjustment row for one or more
  // types is missing from the world 'sheet-settings' setting, so the
  // Save handler's defaultSettings[k][k2][k3] lookup hits an undefined
  // per-type row and throws. Restore the original world setting afterwards
  // so other specs relying on it aren't affected.
  const originalSheetSettings = await gm.evaluate(() =>
    foundry.utils.duplicate(game.settings.get('monks-enhanced-journal', 'sheet-settings')));
  try {
    await gm.evaluate(async () => {
      let s = foundry.utils.duplicate(game.settings.get('monks-enhanced-journal', 'sheet-settings'));
      delete s.shop.adjustment;
      await game.settings.set('monks-enhanced-journal', 'sheet-settings', s);
    });

    const shopId = await createEntry(gm, 'shop', 'TT-followup-shop');
    await openEntry(gm, shopId);
    await gm.evaluate(() => {
      const shopSheet = game.MonksEnhancedJournal.journal.subsheet;
      shopSheet.actions['editFields'].call(shopSheet);
    });
    await gm.waitForSelector('.customise-page', { state: 'visible', timeout: 15_000 });
    // Same dispatch-not-geometry-click reasoning as check 1 above.
    await gm.evaluate(() => document.querySelector('.customise-page button[type="submit"]').click());
    await gm.waitForSelector('.customise-page', { state: 'detached', timeout: 15_000 });

    const pageSettings = await entryFlag(gm, shopId, 'sheet-settings');
    assert.ok(pageSettings && typeof pageSettings.adjustment === 'object' && pageSettings.adjustment !== null,
      'CustomisePage save did not write a well-formed adjustment object');
  } finally {
    await gm.evaluate((orig) =>
      game.settings.set('monks-enhanced-journal', 'sheet-settings', orig), originalSheetSettings);
  }

  // --- Check 5: sellItem crash on a "free" mode sale --------------------
  // ShopSheet._onDropItem's free-selling branch emits sellItem with only
  // { shopid, itemdata } (it already logs the sale itself, separately,
  // with the actor pre-resolved). sellItem must not assume every caller
  // sends actorId. Repro is deterministic per sale (fromUuid(undefined)
  // synchronously returns null), so three sales is enough to cover it as
  // a regression check without the cost of a long loop.
  const sellerActorId = await gm.evaluate(async () => {
    const user = game.users.getName('User 1');
    const actor = await Actor.create({
      name: 'TT-followup-seller', type: 'character',
      system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } },
      ownership: { default: 0, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });
    await user.update({ character: actor.id });
    return actor.id;
  });
  const sellShopId = await createEntry(gm, 'shop', 'TT-followup-sell-shop', { selling: 'free', state: 'open' });
  await p1.waitForFunction((id) => game.user.character?.id === id, sellerActorId, { timeout: 15_000 });
  await p1.waitForFunction((id) => !!game.journal.get(id), sellShopId, { timeout: 15_000 });
  await openEntry(p1, sellShopId);
  await p1.waitForSelector('.shop-items', { state: 'attached', timeout: 15_000 });

  for (let i = 0; i < 3; i++) {
    const itemUuid = await gm.evaluate(async ({ actorId, i }) => {
      const actor = game.actors.get(actorId);
      const [item] = await actor.createEmbeddedDocuments('Item', [{
        name: `TT-followup-sell-item-${i}`, type: 'loot',
        system: { quantity: 1, price: { value: 5, denomination: 'gp' } },
      }]);
      return item.uuid;
    }, { actorId: sellerActorId, i });

    await dropOnSheet(p1, '.shop-items', { type: 'Item', uuid: itemUuid });
    await p1.waitForSelector('dialog.dialog button[data-action="yes"]', { state: 'visible', timeout: 15_000 });
    await p1.click('dialog.dialog button[data-action="yes"]');
    await p1.waitForSelector('dialog.dialog', { state: 'detached', timeout: 15_000 });

    await gm.waitForFunction(({ id, name }) => {
      const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items');
      return items && Object.values(items).some((it) => it.name === name);
    }, { id: sellShopId, name: `TT-followup-sell-item-${i}` }, { timeout: 15_000 });

    assertNoErrors(session);
  }

  await gm.waitForFunction((id) => {
    const log = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'log');
    return Array.isArray(log) && log.length >= 3;
  }, sellShopId, { timeout: 15_000 });
  const sellLog = await entryFlag(gm, sellShopId, 'log');
  assert.equal(sellLog.filter((l) => l.type === 'sell' && l.actor === 'TT-followup-seller').length, 3,
    'expected 3 correctly-attributed sell log entries from the free-sell flow');

  assertNoErrors(session);
});
