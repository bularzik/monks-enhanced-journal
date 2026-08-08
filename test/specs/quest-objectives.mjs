// Objectives survive a reorder + world-trip: objectives are persisted on the
// quest PAGE as an object keyed by id (not an array — QuestSheet migrates any
// legacy array shape to an object on first render). The 2026-08-08 fix routed
// drag-reorder through a ForcedReplacement operator instead of plain setFlag,
// because a same-key/same-value reorder diffs to "no change" under Foundry's
// diffObject and gets silently dropped, leaving the old key order in place.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, entryFlag, setEntryFlag, assertNoErrors } from '../helpers/mej.js';

await withSession('quest-objectives', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const id = await createEntry(gm, 'quest', 'TT-quest-objectives');

  const objectives = {
    'obj-a': { id: 'obj-a', title: 'First', available: true, status: false },
    'obj-b': { id: 'obj-b', title: 'Second', available: true, status: false },
    'obj-c': { id: 'obj-c', title: 'Third', available: true, status: false },
  };
  await setEntryFlag(gm, id, 'objectives', objectives);
  await openEntry(gm, id);

  // Reorder exactly the way the sheet's _onDropRewardItem does: rebuild the
  // object in the new key order and commit it with a ForcedReplacement so the
  // reordered keys are retained verbatim by diffObject in one write.
  await gm.evaluate(async ({ id, reordered }) => {
    const page = game.journal.get(id).pages.contents[0];
    await page.setFlag('monks-enhanced-journal', 'objectives', new foundry.data.operators.ForcedReplacement(reordered));
  }, { id, reordered: { 'obj-c': objectives['obj-c'], 'obj-a': objectives['obj-a'], 'obj-b': objectives['obj-b'] } });

  const order = Object.keys(await entryFlag(gm, id, 'objectives'));
  assert.deepEqual(order, ['obj-c', 'obj-a', 'obj-b'], 'reorder did not persist');
  assertNoErrors(session);
});
