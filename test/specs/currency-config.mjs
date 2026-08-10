// enh/currency-config (#569): the price-attribute/quantity-attribute/currency-attribute
// world settings that make MonksEnhancedJournal.pricename/quantityname/currencyname
// configurable, so systems outside the hardcoded per-system if/else chain in
// MonksEnhancedJournal.init() (monks-enhanced-journal.js) can still read item
// prices/quantities and move actor currency.
//
// Exercises the real read path: EnhancedJournalSheet#addItem (invoked the same way a
// drag-drop onto the shop's item list invokes it) resolves a dropped Item's price via
// MEJHelpers.getSystemPrice(item, pricename()), which is what actually reads
// item.system[pricename()] - not a reimplementation of that logic. All three settings
// are `requiresReload: true`, so each mutation is followed by a real page.reload().
import assert from 'node:assert/strict';
import { withSession, createEntry, assertNoErrors } from '../helpers/mej.js';

const MODULE = 'monks-enhanced-journal';
const KEYS = ['price-attribute', 'quantity-attribute', 'currency-attribute'];

await withSession('currency-config', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];

  const original = {};
  for (const key of KEYS) {
    original[key] = await gm.evaluate(({ MODULE, key }) => game.settings.get(MODULE, key), { MODULE, key });
  }

  async function setSettings(values) {
    await gm.evaluate(async ({ MODULE, values }) => {
      for (const [k, v] of Object.entries(values)) {
        await game.settings.set(MODULE, k, v);
      }
    }, { MODULE, values });
    await gm.reload();
    await gm.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
  }

  // Drop a fresh dnd5e loot Item (system.price = {value:5, denomination:'gp'},
  // system.quantity = 1) onto the shop via the sheet's real addItem() method, and
  // return the resolved `cost` flag the item list actually renders
  // (templates/sheets/partials/sheet-shop-items.hbs: `.item-cost input`).
  async function dropPricedItemAndReadCost(shopId, itemName) {
    return await gm.evaluate(async ({ shopId, itemName }) => {
      const itemUuid = (await Item.create({
        name: itemName,
        type: 'loot',
        system: { price: { value: 5, denomination: 'gp' }, quantity: 1 },
      })).uuid;
      const page = game.journal.get(shopId).pages.contents[0];
      await page.sheet.addItem({ type: 'Item', uuid: itemUuid });
      const items = page.getFlag('monks-enhanced-journal', 'items') || {};
      const entry = Object.values(items).find((i) => i.name === itemName);
      return entry?.flags?.['monks-enhanced-journal']?.cost;
    }, { shopId, itemName });
  }

  try {
    // --- 1. Regression: all three settings blank (their default) -------------------------
    for (const key of KEYS) {
      const v = await gm.evaluate(({ MODULE, key }) => game.settings.get(MODULE, key), { MODULE, key });
      assert.equal(v, '', `expected ${key} to default to "" before this spec touches anything`);
    }
    const defaults = await gm.evaluate(() => ({
      pricename: game.MonksEnhancedJournal.pricename,
      quantityname: game.MonksEnhancedJournal.quantityname,
      currencyname: game.MonksEnhancedJournal.currencyname,
    }));
    assert.equal(defaults.pricename, 'price', 'dnd5e is not in the per-system override chain, so pricename should stay the class default');
    assert.equal(defaults.quantityname, 'quantity');
    assert.equal(defaults.currencyname, 'currency');

    const shopId = await createEntry(gm, 'shop', 'TT-currency-config-shop', { purchasing: 'confirm', state: 'open' });

    const baselineCost = await dropPricedItemAndReadCost(shopId, 'TT-currency-config-item-baseline');
    assert.equal(baselineCost, '5 gp', `expected a 5gp item to resolve to "5 gp" with default settings, got ${baselineCost}`);

    // --- 2. Override mechanics: identity quantity-attribute + bogus price-attribute ------
    await setSettings({ 'quantity-attribute': 'quantity', 'price-attribute': 'xyzzy' });
    const overriddenNames = await gm.evaluate(() => ({
      pricename: game.MonksEnhancedJournal.pricename,
      quantityname: game.MonksEnhancedJournal.quantityname,
    }));
    assert.equal(overriddenNames.pricename, 'xyzzy', 'price-attribute override should reach MonksEnhancedJournal.pricename');
    assert.equal(overriddenNames.quantityname, 'quantity', 'identity quantity-attribute override should leave quantityname unchanged');

    const overriddenCost = await dropPricedItemAndReadCost(shopId, 'TT-currency-config-item-overridden');
    // item.system.xyzzy does not exist -> MEJHelpers.getSystemPrice returns a falsy cost ->
    // MEJHelpers.getPrice() falls back to { value: 0, currency: defaultCurrency() }.
    assert.ok(
      overriddenCost === '0 gp' || !overriddenCost,
      `expected the bogus price-attribute to produce an empty/0 cost (proving the override reached the real read path), got ${JSON.stringify(overriddenCost)}`
    );
    assert.notEqual(overriddenCost, '5 gp', 'the bogus price-attribute must not still resolve the real price');

    // Restore both to "" and confirm the original price comes back.
    await setSettings({ 'quantity-attribute': '', 'price-attribute': '' });
    const restoredCost = await dropPricedItemAndReadCost(shopId, 'TT-currency-config-item-restored');
    assert.equal(restoredCost, '5 gp', `expected price to resolve normally again after restoring price-attribute to "", got ${restoredCost}`);

    // --- 3. Root sentinel: currency-attribute "." means actor-root storage (currencyname = "") ---
    await setSettings({ 'currency-attribute': '.' });
    const rootCurrencyname = await gm.evaluate(() => game.MonksEnhancedJournal.currencyname);
    assert.equal(rootCurrencyname, '', 'currency-attribute "." should map to currencyname === "" (actor-root storage)');

    await setSettings({ 'currency-attribute': '' });
    const restoredCurrencyname = await gm.evaluate(() => game.MonksEnhancedJournal.currencyname);
    assert.equal(restoredCurrencyname, 'currency', 'currencyname should be restored to the class default once currency-attribute is blank again');

    assertNoErrors(session);
  } finally {
    // Best-effort restore even on failure - reload so the client is left in a known state.
    try {
      await gm.evaluate(async ({ MODULE, original }) => {
        for (const [k, v] of Object.entries(original)) {
          await game.settings.set(MODULE, k, v);
        }
      }, { MODULE, original });
      await gm.reload();
      await gm.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
    } catch (e) {
      console.error(`currency-config: settings restore failed: ${e.stack ?? e}`);
    }
  }
});
