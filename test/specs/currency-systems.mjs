// enh/currency-config (#569) Task 5: validate the price-attribute/quantity-attribute/
// currency-attribute settings end-to-end on two real systems MEJ doesn't support
// natively - Mythras and Symbaroum - proving the configured paths + Edit Currency
// denominations actually drive a real shop: price renders on drop, a player purchase
// deducts currency at the configured path, a player sell credits it back.
//
// Symbaroum is a plain object path (actor.system.money.{thaler,shilling,orteg}) and is
// fully validated: all three settings are exercised and every currency mutation is a
// hard assertion.
//
// Mythras is NOT a plain object path - actor.system has no currency field at all;
// currency lives on embedded Item documents of type "currency", matched by name. MEJ
// already has a pre-existing, Task-4-independent hardcoded branch for this in
// EnhancedJournalSheet.getCurrency/addCurrency (sheets/EnhancedJournalSheet.js:1002,
// :1158) - the ruling on this task's stop condition was: use that existing branch
// (currency-attribute stays blank, it's bypassed entirely for game.system.id=='mythras'),
// and treat any failure INSIDE that pre-existing branch as a documented outcome, not a
// spec failure or something to patch here. That branch's read side (getCurrency,
// affordability checks) works; its write side (addCurrency) has a real bug -
// EnhancedJournalSheet.js:1162 compares `i.name == currency` (the whole currency-ROW
// OBJECT from MonksEnhancedJournal.currencies) instead of `i.name == currency.name`, so
// it can never find the matching embedded currency Item and silently no-ops. This spec
// still drives the real purchase/sell flow for Mythras (item lands on actor is a hard
// assertion - that path doesn't depend on addCurrency), but currency-mutation
// assertions are soft (logged, not thrown) there, with a message pointing at the exact
// line - see currencyMutationBroken below.
//
// A second pre-existing, system-agnostic bug surfaces on every 'free'-mode sell,
// regardless of system: ShopSheet's player-side sell handler emits a "sellItem" socket
// message without an `actorId` (sheets/ShopSheet.js's `MonksEnhancedJournal.emit(
// "sellItem", { shopid, itemdata })` call omits it), so the GM-side handler's
// `fromUuid(data.actorId)` resolves to null and `actor.name` throws
// (monks-enhanced-journal.js:3444, MonksEnhancedJournal.sellItem). This fires AFTER the
// real currency credit already happened (actorPurchase runs synchronously on the
// player's own client, before the emit), so it doesn't affect what's being validated
// here - it's tolerated as a known console error rather than fixed (zero new product
// code per the ruling on this task).
//
// A third and fourth error are Symbaroum's own system code, not MEJ's: its
// SymbaroumActor.applyActiveEffects/prepareData pipeline has a reentrancy bug that
// throws "ActiveEffect application phase ... has already completed and cannot be run
// again in this Actor's data-preparation cycle" (observed on ordinary Actor.create and
// after ShopSheet.js:429's `item.delete()` post-sell, standard/correct MEJ behavior) and
// a related "Failed data preparation for <actor>. Cannot set properties of undefined
// (setting 'initial')" (observed on ordinary Actor.create alone, routed through
// Hooks.onError so it doesn't abort the create). Neither is caused by
// currency-attribute/price-attribute/quantity-attribute or anything Task 4 touches, and
// neither actually breaks the create/delete they wrap (actors/items still end up
// correct - see the currency assertions right after each). Tolerated, not fixed (it's
// third-party system code, not MEJ's).
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet } from '../helpers/mej.js';

const MODULE = 'monks-enhanced-journal';

// EnhancedJournalSheet.js:1162's bug tolerates the empty getCurrency({}) path silently,
// but the sellItem socket handler bug above genuinely throws - filter that one specific,
// documented error out instead of using the shared assertNoErrors (which throws on any
// console error) so a real regression elsewhere still fails the spec loudly.
const KNOWN_ERRORS = [
  /Cannot read properties of null \(reading 'name'\)/, // ShopSheet sellItem emit missing actorId, see header comment
  /Detected \d+ package/, // benign Foundry core package-scan log line observed during multi-reload sessions; not MEJ-related
  /ActiveEffect application phase .* has already completed/, // Symbaroum system bug, not MEJ - see header comment
  /Failed data preparation for .*Cannot set properties of undefined \(setting 'initial'\)/, // Symbaroum system bug, not MEJ - see header comment
  /Issues with SymbaroumTour.*permission to browse the host file system/, // Symbaroum's own startup tour probing for optional file-system assets this dev box doesn't grant browse access to - not MEJ
];
function assertNoUnexpectedErrors(session, label) {
  const errs = [...session.logs.values()].flat();
  const unexpected = errs.filter((e) => !KNOWN_ERRORS.some((p) => p.test(e)));
  const known = errs.filter((e) => KNOWN_ERRORS.some((p) => p.test(e)));
  for (const e of known) console.log(`[${label}] tolerated known console error: ${e}`);
  if (unexpected.length) throw new Error(`[${label}] browser console errors:\n${unexpected.join('\n')}`);
}

const CASES = [
  {
    world: 'test-mythras',
    label: 'mythras',
    actorType: 'character',
    // Discovered schema (task-5-report.md): item price = system.value (plain number),
    // item quantity = system.quantity (already the class default, so left blank),
    // currency has no plain path at all - currency-attribute stays blank so the
    // pre-existing hardcoded mythras branch (which ignores currencyname entirely) is
    // what actually runs.
    pathSettings: { 'price-attribute': 'value', 'quantity-attribute': '', 'currency-attribute': '' },
    expectedNames: { pricename: 'value', quantityname: 'quantity', currencyname: 'currency' },
    // Edit Currency denomination name must exactly match the actor's embedded currency
    // Item's name - that's how EnhancedJournalSheet.getCurrency's mythras branch finds it.
    currencyRows: [{ id: 'sp', name: 'TT-Silver Pieces', convert: 0 }],
    currency: { kind: 'item', itemType: 'currency', itemName: 'TT-Silver Pieces', amount: 50 },
    buyItemData: { type: 'equipment', system: { value: 5 } },
    sellItemData: { type: 'equipment', system: { value: 4 } },
    expectedCost: '5 sp',
    expectedSellCredit: 2, // 4 * default 0.5 buy rate
    currencyMutationBroken: true,
    brokenNote: 'EnhancedJournalSheet.addCurrency\'s mythras branch (EnhancedJournalSheet.js:1162) '
      + 'compares `i.name == currency` (the whole currency-row object) instead of '
      + '`i.name == currency.name` - it never matches the embedded currency Item, so the '
      + 'update silently no-ops. Pre-existing, unrelated to Task 4 - getCurrency (the read/ '
      + 'affordability side) is correct and unaffected.',
  },
  {
    world: 'test-symbaroum',
    label: 'symbaroum',
    actorType: 'player',
    // Discovered schema: currency = actor.system.money.{thaler,shilling,orteg} (flat
    // numbers), item price = system.cost (string), item quantity = system.number.
    pathSettings: { 'price-attribute': 'cost', 'quantity-attribute': 'number', 'currency-attribute': 'money' },
    expectedNames: { pricename: 'cost', quantityname: 'number', currencyname: 'money' },
    // Edit Currency ids must equal the object keys under system.money.
    currencyRows: [
      { id: 'thaler', name: 'Thaler', convert: 0 },
      { id: 'shilling', name: 'Shilling', convert: 0.1 },
      { id: 'orteg', name: 'Orteg', convert: 0.01 },
    ],
    currency: { kind: 'path', path: 'system.money.thaler', amount: 50 },
    buyItemData: { type: 'equipment', system: { cost: '5 thaler', number: 1 } },
    sellItemData: { type: 'equipment', system: { cost: '4 thaler', number: 1 } },
    expectedCost: '5 thaler',
    expectedSellCredit: 2, // 4 * default 0.5 buy rate
    currencyMutationBroken: false,
  },
];

async function readCurrency(page, actorId, currency) {
  return await page.evaluate(({ actorId, currency }) => {
    const actor = game.actors.get(actorId);
    if (currency.kind === 'item') {
      const coin = actor.items.find((i) => i.type === currency.itemType && i.name === currency.itemName);
      return coin?.system?.quantity ?? 0;
    }
    return foundry.utils.getProperty(actor, currency.path) ?? 0;
  }, { actorId, currency });
}

// The actor.update() that credits/deducts currency (EnhancedJournalSheet.addCurrency) is
// a separate async DB write from whatever DOM/flag state a preceding waitForFunction
// already confirmed (e.g. the shop's item flags) - on a working (non-broken) case it can
// still be in flight when read immediately after. Poll instead of reading once so a real
// mismatch (or the documented Mythras no-op) is still detected reliably, not raced.
async function waitForCurrency(page, actorId, currency, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await readCurrency(page, actorId, currency);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

function softOrHardAssert(broken, actual, expected, label, note, message) {
  if (actual === expected) return;
  if (broken) {
    console.log(`[${label}] KNOWN BUG (pre-existing, unrelated to Task 4): ${message} `
      + `(expected ${expected}, got ${actual}). ${note}`);
    return;
  }
  assert.equal(actual, expected, `[${label}] ${message}: expected ${expected}, got ${actual}`);
}

for (const cfg of CASES) {
  await withSession(`currency-systems-${cfg.label}`, { world: cfg.world, users: ['Gamemaster', 'User 1'] }, async (session) => {
    const gm = session.pages['Gamemaster'];
    const p1 = session.pages['User 1'];

    const originalPaths = {};
    for (const k of Object.keys(cfg.pathSettings)) {
      originalPaths[k] = await gm.evaluate(({ MODULE, k }) => game.settings.get(MODULE, k), { MODULE, k });
    }
    const originalCurrency = await gm.evaluate((MODULE) => game.settings.get(MODULE, 'currency'), MODULE);

    try {
      // --- 1. Configure: the three path settings + Edit Currency denominations --------
      await gm.evaluate(async ({ MODULE, values }) => {
        for (const [k, v] of Object.entries(values)) await game.settings.set(MODULE, k, v);
      }, { MODULE, values: cfg.pathSettings });
      await gm.evaluate(async ({ MODULE, rows }) => {
        await game.settings.set(MODULE, 'currency', rows);
      }, { MODULE, rows: cfg.currencyRows });
      // price-attribute/quantity-attribute/currency-attribute are requiresReload:true and
      // MonksEnhancedJournal.{pricename,quantityname,currencyname} are only recomputed in
      // init() - reload BOTH clients so every code path that runs on either of them (GM
      // approval, player drop) picks up the new values.
      for (const page of [gm, p1]) {
        await page.reload();
        await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
      }

      const appliedNames = await gm.evaluate(() => ({
        pricename: game.MonksEnhancedJournal.pricename,
        quantityname: game.MonksEnhancedJournal.quantityname,
        currencyname: game.MonksEnhancedJournal.currencyname,
      }));
      assert.equal(appliedNames.pricename, cfg.expectedNames.pricename, `[${cfg.label}] pricename`);
      assert.equal(appliedNames.quantityname, cfg.expectedNames.quantityname, `[${cfg.label}] quantityname`);
      assert.equal(appliedNames.currencyname, cfg.expectedNames.currencyname, `[${cfg.label}] currencyname`);

      // --- 2. Fixture actor with starting currency, assigned to User 1 ----------------
      const actorId = await gm.evaluate(async ({ actorType, userName }) => {
        const u = game.users.getName(userName);
        const actor = await Actor.create({
          name: 'TT-currency-systems-shopper', type: actorType,
          ownership: { default: 0, [u.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
        });
        await u.update({ character: actor.id });
        return actor.id;
      }, { actorType: cfg.actorType, userName: 'User 1' });

      await gm.evaluate(async ({ actorId, currency }) => {
        const actor = game.actors.get(actorId);
        if (currency.kind === 'item') {
          await actor.createEmbeddedDocuments('Item', [
            { name: currency.itemName, type: currency.itemType, system: { quantity: currency.amount } },
          ]);
        } else {
          await actor.update({ [currency.path]: currency.amount });
        }
      }, { actorId, currency: cfg.currency });

      const startingCurrency = await readCurrency(gm, actorId, cfg.currency);
      assert.equal(startingCurrency, cfg.currency.amount, `[${cfg.label}] fixture starting currency`);

      // --- 3. TT- shop (buy in 'confirm' mode, buy-from-players in 'free' mode) -------
      const shopId = await createEntry(gm, 'shop', 'TT-currency-systems-shop', {
        purchasing: 'confirm', selling: 'free', state: 'open',
      });

      // Clear leftover request-item chat cards from earlier interrupted runs sharing the
      // same `.request-accept` selector (see shop-purchase.mjs).
      await gm.evaluate(async () => {
        const stale = game.messages.filter((m) =>
          m.getFlag('monks-enhanced-journal', 'action') === 'buy' &&
          String(m.getFlag('monks-enhanced-journal', 'items')?.[0]?.name ?? '').startsWith('TT-'));
        for (const m of stale) await m.delete();
      });

      const buyItemUuid = await gm.evaluate(async (data) =>
        (await Item.create({ name: 'TT-currency-systems-buyitem', ...data })).uuid, cfg.buyItemData);

      // --- 4. Drop the priced item into the shop; assert the rendered price ------------
      await openEntry(gm, shopId);
      await gm.waitForSelector('.shop-items', { state: 'attached', timeout: 15_000 });
      await dropOnSheet(gm, '.shop-items', { type: 'Item', uuid: buyItemUuid });
      // Bare world Item with no owning actor -> confirmQuantity() always renders a
      // blocking "Confirm Quantity" DialogV2 (see loot-drop.mjs/shop-purchase.mjs).
      await gm.waitForSelector('dialog.dialog button[data-action="yes"]', { timeout: 15_000 });
      await gm.click('dialog.dialog button[data-action="yes"]');
      await gm.waitForFunction((id) => {
        const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items');
        return items && Object.keys(items).length > 0;
      }, shopId, { timeout: 15_000 });

      const costFlag = await gm.evaluate((id) => {
        const items = game.journal.get(id).pages.contents[0].getFlag('monks-enhanced-journal', 'items');
        return Object.values(items)[0]?.flags?.['monks-enhanced-journal']?.cost;
      }, shopId);
      assert.equal(costFlag, cfg.expectedCost, `[${cfg.label}] dropped item's rendered cost`);

      // --- 5. Player purchase: request -> GM approves -> item lands, currency deducted -
      await p1.waitForFunction((id) => game.user.character?.id === id, actorId, { timeout: 15_000 });
      await p1.waitForFunction(() => game.users.getName('Gamemaster')?.active === true, null, { timeout: 15_000 });
      // These are brand-new worlds: this is User 1's first-ever character assignment in
      // them, which triggers Foundry's own "configure your player" UserConfig prompt -
      // close it (world-a's User 1 has long since dismissed this, so no existing spec
      // needed to handle it).
      await p1.evaluate(() => {
        for (const a of Array.from(foundry.applications.instances.values()))
          if (a.constructor.name === 'UserConfig') a.close();
      });
      await openEntry(p1, shopId);
      await p1.waitForSelector('.monks-enhanced-journal [data-tab="items"]', { timeout: 15_000 });
      await p1.click('.monks-enhanced-journal [data-tab="items"]');
      await p1.waitForSelector('.monks-enhanced-journal [data-action="requestItem"]', { timeout: 15_000 });
      await p1.click('.monks-enhanced-journal [data-action="requestItem"]');
      await p1.waitForSelector('dialog.dialog button[data-action="yes"]', { timeout: 15_000 });
      await p1.click('dialog.dialog button[data-action="yes"]');

      await gm.evaluate(async () => {
        await foundry.applications.instances.get('MonksEnhancedJournal')?.close();
        ui.sidebar.expand();
        ui.sidebar.activateTab('chat');
      });
      const approveSel = '.chat-message .request-accept';
      await gm.waitForSelector(approveSel, { timeout: 15_000 });
      await gm.locator(approveSel).last().click({ timeout: 15_000 });

      await gm.waitForFunction((id) =>
        game.actors.get(id)?.items.some((i) => i.name === 'TT-currency-systems-buyitem'), actorId, { timeout: 15_000 });
      const boughtItemPresent = await gm.evaluate((id) =>
        game.actors.get(id).items.some((i) => i.name === 'TT-currency-systems-buyitem'), actorId);
      assert.ok(boughtItemPresent, `[${cfg.label}] purchased item did not land on the actor`);

      const expectedAfterPurchase = cfg.currency.amount - 5;
      const afterPurchase = await waitForCurrency(gm, actorId, cfg.currency, (v) => v === expectedAfterPurchase);
      softOrHardAssert(cfg.currencyMutationBroken, afterPurchase, expectedAfterPurchase,
        cfg.label, cfg.brokenNote, 'currency not deducted after a 5-cost purchase');

      // --- 6. Player sell: drop an actor-owned item onto the shop, currency credited ---
      const sellItemUuid = await gm.evaluate(async ({ actorId, data }) => {
        const actor = game.actors.get(actorId);
        const items = await actor.createEmbeddedDocuments('Item', [{ name: 'TT-currency-systems-sellitem', ...data }]);
        return items[0].uuid;
      }, { actorId, data: cfg.sellItemData });

      await openEntry(p1, shopId);
      await p1.waitForSelector('.shop-items', { state: 'attached', timeout: 15_000 });
      await dropOnSheet(p1, '.shop-items', { type: 'Item', uuid: sellItemUuid });
      await p1.waitForSelector('dialog.dialog button[data-action="yes"]', { timeout: 15_000 });
      await p1.click('dialog.dialog button[data-action="yes"]');

      await gm.waitForFunction((id) => {
        const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items') || {};
        return Object.values(items).some((i) => i.name === 'TT-currency-systems-sellitem');
      }, shopId, { timeout: 15_000 });

      const expectedAfterSell = expectedAfterPurchase + cfg.expectedSellCredit;
      const afterSell = await waitForCurrency(gm, actorId, cfg.currency, (v) => v === expectedAfterSell);
      softOrHardAssert(cfg.currencyMutationBroken, afterSell, expectedAfterSell,
        cfg.label, cfg.brokenNote, 'currency not credited after a sell');

      assertNoUnexpectedErrors(session, cfg.label);
    } finally {
      await gm.evaluate(async ({ MODULE, originalPaths, originalCurrency }) => {
        for (const [k, v] of Object.entries(originalPaths)) await game.settings.set(MODULE, k, v);
        await game.settings.set(MODULE, 'currency', originalCurrency);
      }, { MODULE, originalPaths, originalCurrency }).catch((e) => {
        console.error(`currency-systems (${cfg.label}): settings restore failed: ${e.stack ?? e}`);
      });
    }
  });
}

// Both worlds above are switched to in turn by withSession's connect(); leave the
// environment back on world-a for other specs/manual use.
await withSession('currency-systems-restore-world-a', { world: 'world-a', users: ['Gamemaster'] }, async () => {});
