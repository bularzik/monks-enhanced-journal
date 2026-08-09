// Dual-client: player requests a purchase, GM approves from chat, item lands
// on the player's actor and currency is deducted.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, assertNoErrors } from '../helpers/mej.js';

await withSession('shop-purchase', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const p1 = session.pages['User 1'];

  // Leftover request-item chat cards from earlier (interrupted) runs of this
  // spec share the `.request-accept` selector with the one we're about to
  // create, and sweep() (journal/actor/item docs only) never clears them -
  // wipe them first so the later selector is unambiguous.
  await gm.evaluate(async () => {
    const stale = game.messages.filter((m) => m.getFlag('monks-enhanced-journal', 'action') === 'buy');
    for (const m of stale) await m.delete();
  });

  // Fixture: an actor owned by + assigned to User 1, with pocket money.
  const actorId = await gm.evaluate(async () => {
    const user = game.users.getName('User 1');
    const actor = await Actor.create({
      name: 'TT-shopper', type: 'character',
      system: { currency: { pp: 0, gp: 50, ep: 0, sp: 0, cp: 0 } },
      ownership: { default: 0, [user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });
    await user.update({ character: actor.id });
    return actor.id;
  });

  // Fixture: a shop in confirm-purchase mode with one priced item (drop, then price it).
  const shopId = await createEntry(gm, 'shop', 'TT-shop', { purchasing: 'confirm', state: 'open' });
  const itemUuid = await gm.evaluate(async () => (await Item.create({ name: 'TT-shop-item', type: 'loot' })).uuid);
  await openEntry(gm, shopId);
  // ShopSheet._dragDrop binds the drop zone to ".shop-items" (the items-tab
  // container), not the sheet root - see ShopSheet.js:184-195. openEntry only
  // waits for the sheet's root form to appear; the shop-items partial can
  // still be mid-render, so wait for it explicitly before dropping. It's
  // hidden (not visible) until the "items" subtab is active, but that
  // doesn't matter - the synthetic drop event dispatches fine either way.
  await gm.waitForSelector('.shop-items', { state: 'attached', timeout: 15_000 });
  await dropOnSheet(gm, '.shop-items', { type: 'Item', uuid: itemUuid });
  // A bare world Item with no owning actor has no natural max quantity, so
  // ShopSheet._onDropItem's confirmQuantity() call renders a blocking
  // "Confirm Quantity" DialogV2 (same as LootSheet's drop path in
  // loot-drop.mjs) - click through it for real.
  await gm.waitForSelector('dialog.dialog button[data-action="yes"]', { timeout: 15_000 });
  await gm.click('dialog.dialog button[data-action="yes"]');
  await gm.waitForFunction((id) => {
    const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items');
    return items && Object.keys(items).length > 0;
  }, shopId);
  await gm.evaluate(async (id) => {
    const page = game.journal.get(id).pages.contents[0];
    const items = foundry.utils.duplicate(page.getFlag('monks-enhanced-journal', 'items'));
    const key = Object.keys(items)[0];
    foundry.utils.setProperty(items[key], 'flags.monks-enhanced-journal.cost', '5 gp');
    foundry.utils.setProperty(items[key], 'flags.monks-enhanced-journal.quantity', 3);
    await page.setFlag('monks-enhanced-journal', 'items', items);
  }, shopId);

  // Player opens the shop. showrequest (ShopSheet.js:111) requires
  // game.user.character to be set - wait for the Gamemaster's user.update
  // above to have synced over the socket before relying on it, and confirm
  // the GM connection the shop's request gating checks for is visible too.
  await p1.waitForFunction((id) => game.user.character?.id === id, actorId, { timeout: 15_000 });
  await p1.waitForFunction(() => game.users.getName('Gamemaster')?.active === true, null, { timeout: 15_000 });
  await openEntry(p1, shopId);
  // "items" is a subtab, not the sheet's default ("description") - switch to
  // it so the request-item control is actually visible/clickable. Wait for
  // each control explicitly first (both depend on async render/socket state)
  // so the click itself never has to carry an inflated timeout.
  await p1.waitForSelector('.monks-enhanced-journal [data-tab="items"]', { timeout: 15_000 });
  await p1.click('.monks-enhanced-journal [data-tab="items"]');
  await p1.waitForSelector('.monks-enhanced-journal [data-action="requestItem"]', { timeout: 15_000 });
  await p1.click('.monks-enhanced-journal [data-action="requestItem"]');
  // Quantity confirmation dialog (EnhancedJournalSheet.confirmQuantity, a
  // DialogV2.confirm) -> accept with the default quantity of 1.
  await p1.waitForSelector('dialog.dialog button[data-action="yes"]', { timeout: 15_000 });
  await p1.click('dialog.dialog button[data-action="yes"]');

  // GM approves the purchase request from chat. ShopSheet.onRequestItem's
  // 'confirm' path (ShopSheet.js:569-579) calls
  // EnhancedJournalSheet.createRequestMessage, which whispers the GM a chat
  // card rendered from templates/request-item.html; the GM's accept control
  // is the unconditionally-enabled `.request-accept` button in that card's
  // `.gm-only` block (monks-enhanced-journal.js:4773 wires the click handler,
  // MonksEnhancedJournal.acceptItem, which for action=="buy" adds the item
  // to the actor and calls ShopSheet.actorPurchase -> ShopSheet.addCurrency
  // at ShopSheet.js:725 to deduct the price).
  // The GM's still-open shop window ("MonksEnhancedJournal", apps/enhanced-
  // journal.js:57) sits on top of the sidebar and intercepts pointer events
  // there even after the chat tab is activated - close it, then make chat
  // the active tab, before clicking into it. Take the last match: sweep()
  // doesn't clean up chat messages, so an earlier run's leftover request
  // card can still be in the log.
  await gm.evaluate(async () => {
    await foundry.applications.instances.get('MonksEnhancedJournal')?.close();
    ui.sidebar.expand();
    ui.sidebar.activateTab('chat');
  });
  const approveSel = '.chat-message .request-accept';
  await gm.waitForSelector(approveSel, { timeout: 15_000 });
  await gm.locator(approveSel).last().click({ timeout: 15_000 });

  // Item lands on the shopper; 5 gp deducted.
  await gm.waitForFunction((actorId) =>
    game.actors.get(actorId)?.items.some((i) => i.name === 'TT-shop-item'), actorId, { timeout: 15_000 });
  const gp = await gm.evaluate((id) => game.actors.get(id).system.currency.gp, actorId);
  assert.equal(gp, 45, `expected 45 gp after 5 gp purchase, got ${gp}`);
  assertNoErrors(session);
});
