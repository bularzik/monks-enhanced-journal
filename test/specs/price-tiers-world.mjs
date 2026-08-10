// E5 spec-gap: world-default Adjust Prices. Before this fix, AdjustPrice
// (apps/adjust-price.js) could only ever be constructed with a document (from a shop's own
// "Adjust Prices" button), so its documentless branches - reading/writing world-default price
// tiers - were dead code with no reachable UI. This exercises the new settings.js
// 'adjustPrices' registerMenu entry (which constructs `new AdjustPrice()` with no options,
// same as Foundry's real SettingsConfig submenu click handler does), confirms a tier defined
// there with no document persists to the world sheet-settings.shop.adjustment row that
// EnhancedJournalSheet#sheetSettings()/MEJHelpers.adjustmentRate() actually resolve against,
// and exercises three dialog UX papercuts along the way (type-row edits surviving an
// addTier/removeTier re-render, Reset clearing tier rows, and negative tier rates being
// clamped). Also covers ShopSheet#convertItems (the "Convert Shop Items" button, document
// mode only) actually picking up those same world defaults/tiers for a shop with no local
// override, rather than the orphaned "adjustment-defaults" setting it used to read.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';

await withSession('price-tiers-world', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];

  const original = await gm.evaluate(() => game.settings.get('monks-enhanced-journal', 'sheet-settings'));
  try {
    // Start from a clean, known "shop" adjustment row (no price tiers, no type overrides) so
    // the dialog opens with a deterministic, empty tier list.
    await gm.evaluate(async () => {
      const s = foundry.utils.duplicate(game.settings.get('monks-enhanced-journal', 'sheet-settings'));
      s.shop = s.shop || {};
      s.shop.adjustment = { default: { sell: 1, buy: 0.5 } };
      await game.settings.set('monks-enhanced-journal', 'sheet-settings', s, { diff: false });
    });

    // --- Open the world-defaults dialog through the real settings-menu wiring --------------
    await gm.evaluate(() => { game.settings.sheet.render(true); });
    await gm.waitForSelector('#settings-config', { state: 'visible', timeout: 15_000 });
    await gm.click('#settings-config button[data-action="tab"][data-tab="monks-enhanced-journal"]');
    const menuSel = '#settings-config button[data-action="openSubmenu"][data-key="monks-enhanced-journal.adjustPrices"]';
    await gm.waitForSelector(menuSel, { timeout: 15_000 });
    await gm.click(menuSel);
    await gm.waitForSelector('#adjust-price', { state: 'visible', timeout: 15_000 });
    // Documentless AdjustPrice is now open on top - close the settings sheet underneath so
    // later clicks are unambiguous.
    await gm.evaluate(() => foundry.applications.instances.get('settings-config')?.close());

    // --- UX papercut: a type-row edit survives an addTier re-render ------------------------
    await gm.fill('#adjust-price input[name="adjustment.weapon.sell"]', '0.75');
    await gm.click('#adjust-price [data-action="addTier"]');
    await gm.waitForSelector('#adjust-price [data-tier-idx="0"]', { timeout: 15_000 });
    const weaponSell = await gm.$eval('#adjust-price input[name="adjustment.weapon.sell"]', (el) => el.value);
    assert.equal(weaponSell, '0.75', 'type-row edit should survive an addTier re-render');

    // --- UX papercut: a negative tier rate gets the validation class and is clamped --------
    const tierSellSel = '#adjust-price [data-tier-idx="0"] input[name$=".sell"]';
    const hasValidationClass = await gm.$eval(tierSellSel, (el) => el.classList.contains('sell-field'));
    assert.ok(hasValidationClass, 'tier sell-rate input should carry the sell-field validation class');
    await gm.fill(tierSellSel, '-5');
    await gm.locator(tierSellSel).blur();
    await gm.waitForFunction((sel) => document.querySelector(sel)?.value === '', tierSellSel, { timeout: 15_000 });

    // --- UX papercut: Reset clears the tier rows --------------------------------------------
    await gm.click('#adjust-price [data-action="reset"]');
    await gm.waitForFunction(() => !document.querySelector('#adjust-price [data-tier-idx]'), null, { timeout: 15_000 });

    // --- Define a real tier (threshold 100, rate 0.5) with no document involved, and save --
    await gm.click('#adjust-price [data-action="addTier"]');
    await gm.waitForSelector('#adjust-price [data-tier-idx="0"]', { timeout: 15_000 });
    await gm.fill('#adjust-price [data-tier-idx="0"] input[name$=".threshold"]', '100');
    await gm.fill('#adjust-price [data-tier-idx="0"] input[name$=".sell"]', '0.5');
    await gm.click('#adjust-price button[type="submit"]');
    await gm.waitForSelector('#adjust-price', { state: 'detached', timeout: 15_000 });

    const savedSheetSettings = await gm.evaluate(() => game.settings.get('monks-enhanced-journal', 'sheet-settings'));
    const tiers = savedSheetSettings?.shop?.adjustment?.priceTiers;
    assert.ok(
      Array.isArray(tiers) && tiers.some((t) => t.threshold === 100 && t.sell === 0.5),
      `expected a {threshold:100, sell:0.5} price tier in sheet-settings.shop.adjustment, got ${JSON.stringify(tiers)}`
    );
    // Reset (above) must have cleared the earlier clamped negative-sell attempt before this
    // tier was ever created - it must not have snuck into the saved data.
    assert.ok(!tiers.some((t) => t.sell < 0), `no tier should have a negative sell rate, got ${JSON.stringify(tiers)}`);

    // --- Resolved price: a 150gp item in a shop with no local override uses the world tier -
    const shopId = await createEntry(gm, 'shop', 'TT-price-tier-shop', { purchasing: 'confirm', state: 'open' });
    const resolvedSell = await gm.evaluate(async (id) => {
      const page = game.journal.get(id).pages.contents[0];
      const sheet = page.sheet;
      const adjustment = sheet.sheetSettings()?.adjustment || {};
      return sheet.constructor.adjustmentRate(adjustment, { type: 'loot' }, 'sell', { value: 150, currency: 'gp' });
    }, shopId);
    assert.equal(
      resolvedSell, 0.5,
      `expected the world price tier (0.5) to resolve for a 150gp item with no shop override, got ${resolvedSell}`
    );

    // --- Convert Shop Items (document-mode dialog) must also use the world tier -------------
    const itemId = await gm.evaluate(async (id) => {
      const page = game.journal.get(id).pages.contents[0];
      const items = foundry.utils.duplicate(page.getFlag('monks-enhanced-journal', 'items') || {});
      const itemId = foundry.utils.randomID();
      items[itemId] = {
        _id: itemId,
        name: 'TT-price-tier-item',
        type: 'loot',
        flags: { 'monks-enhanced-journal': { price: '150 gp', quantity: 1 } },
      };
      await page.setFlag('monks-enhanced-journal', 'items', items);
      return itemId;
    }, shopId);

    await openEntry(gm, shopId);
    await gm.waitForSelector('.monks-enhanced-journal [data-tab="items"]', { timeout: 15_000 });
    await gm.click('.monks-enhanced-journal [data-tab="items"]');
    await gm.waitForSelector('.monks-enhanced-journal [data-action="adjustPrice"]', { timeout: 15_000 });
    await gm.click('.monks-enhanced-journal [data-action="adjustPrice"]');
    await gm.waitForSelector('#adjust-price', { state: 'visible', timeout: 15_000 });
    // Leave every field untouched (no local override) and hit Convert - the resolved rate must
    // fall through to the world tier, not the stale adjustment-defaults {sell:1, buy:0.5}.
    await gm.click('#adjust-price [data-action="convert"]');
    await gm.waitForFunction(
      (args) => game.journal.get(args.id)?.pages.contents[0]
        ?.getFlag('monks-enhanced-journal', 'items')?.[args.itemId]
        ?.flags?.['monks-enhanced-journal']?.cost === '75 gp',
      { id: shopId, itemId },
      { timeout: 15_000 }
    );
    await gm.evaluate(() => foundry.applications.instances.get('adjust-price')?.close());
    await gm.evaluate(() => foundry.applications.instances.get('MonksEnhancedJournal')?.close());

    const convertedCost = await gm.evaluate((args) =>
      game.journal.get(args.id).pages.contents[0]
        .getFlag('monks-enhanced-journal', 'items')[args.itemId]
        .flags['monks-enhanced-journal'].cost,
      { id: shopId, itemId });
    assert.equal(
      convertedCost, '75 gp',
      `expected Convert Shop Items to bake in the world tier rate (150gp * 0.5 = 75gp), got ${convertedCost}`
    );

    assertNoErrors(session);
  } finally {
    await gm.evaluate(async (orig) => {
      await game.settings.set('monks-enhanced-journal', 'sheet-settings', orig, { diff: false });
    }, original);
  }
});
