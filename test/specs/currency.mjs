// EnhancedJournalSheet.addCurrency adjusts one denomination without
// corrupting the others (regression: multi-coin corruption fix, PR #821).
import assert from 'node:assert/strict';
import { withSession, assertNoErrors } from '../helpers/mej.js';

await withSession('currency', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const currency = await gm.evaluate(async () => {
    const actor = await Actor.create({
      name: 'TT-currency-actor', type: 'character',
      system: { currency: { pp: 1, gp: 10, ep: 0, sp: 20, cp: 30 } },
    });
    // addCurrency is a static on EnhancedJournalSheet, inherited by every
    // concrete MEJ sheet subclass (QuestSheet, ShopSheet, ...). Registered
    // sheets live on CONFIG.JournalEntryPage.sheetClasses[type][sheetId].cls.
    const cls = Object.values(CONFIG.JournalEntryPage.sheetClasses ?? {})
      .flatMap((v) => Object.values(v)).map((s) => s.cls)
      .find((c) => c && typeof c.addCurrency === 'function');
    if (!cls) throw new Error('no registered sheet class exposes static addCurrency');
    await cls.addCurrency(actor, 'gp', 5);    // 10 → 15
    await cls.addCurrency(actor, 'sp', -8);   // 20 → 12
    return foundry.utils.duplicate(actor.system.currency);
  });
  assert.equal(currency.gp, 15);
  assert.equal(currency.sp, 12);
  assert.equal(currency.pp, 1, 'pp corrupted by unrelated addCurrency calls');
  assert.equal(currency.cp, 30, 'cp corrupted by unrelated addCurrency calls');
  assertNoErrors(session);
});
