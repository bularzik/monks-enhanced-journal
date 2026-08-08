// Dropping a world Item onto a loot sheet adds it to the items flag with qty 1.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, entryFlag, assertNoErrors } from '../helpers/mej.js';

await withSession('loot-drop', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const lootId = await createEntry(gm, 'loot', 'TT-loot-entry');
  const itemUuid = await gm.evaluate(async () => {
    const item = await Item.create({ name: 'TT-loot-item', type: 'loot' }); // dnd5e item type
    return item.uuid;
  });
  await openEntry(gm, lootId);
  await dropOnSheet(gm, '.loot-items .items-list', { type: 'Item', uuid: itemUuid });

  // A bare world Item with no owning actor and no origin loot/shop entry has
  // no natural "max" quantity, so LootSheet._onDropLootItem's confirmQuantity()
  // call can't take its (maxquantity==1) shortcut and always renders a
  // blocking "Confirm Quantity" DialogV2 - click through it for real.
  await gm.waitForSelector('dialog.dialog button[data-action="yes"]', { timeout: 15000 });
  await gm.click('dialog.dialog button[data-action="yes"]');

  await gm.waitForFunction((id) => {
    const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items');
    return items && Object.keys(items).length > 0;
  }, lootId, { timeout: 15000 });

  const items = await entryFlag(gm, lootId, 'items');
  const added = Object.values(items).find((i) => i.name === 'TT-loot-item');
  assert.ok(added, 'dropped item not in loot items flag');
  // quantity lives under the item's own MEJ flags, not a top-level `quantity`
  // (LootSheet.addItem merges { quantity: 1, remaining: 1, ... } into
  // flags['monks-enhanced-journal'] on the stored item data).
  const qty = added.flags?.['monks-enhanced-journal']?.quantity;
  assert.equal(Number(qty), 1, `unexpected quantity: ${qty}`);
  assertNoErrors(session);
});
