// Objectives survive a reorder + world-trip: objectives are persisted on the
// quest PAGE as an object keyed by id (not an array — QuestSheet migrates any
// legacy array shape to an object on first render). The 2026-08-08 fix routed
// drag-reorder through a ForcedReplacement operator instead of plain setFlag,
// because a same-key/same-value reorder diffs to "no change" under Foundry's
// diffObject and gets silently dropped, leaving the old key order in place.
//
// This drives the real reorder path: a synthetic drop on the rendered
// objectives list, handled by QuestSheet's _onDropRewardItem Objective branch
// (sheets/QuestSheet.js:608-641), which is what actually calls setFlag with
// the ForcedReplacement wrapper. If QuestSheet.js:637 ever regresses to a
// plain setFlag, this spec fails because the reorder silently no-ops.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, entryFlag, setEntryFlag, assertNoErrors } from '../helpers/mej.js';

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
  await gm.click('.monks-enhanced-journal [data-tab="objectives"]');
  await gm.waitForSelector('.objective-items li.item[data-id="obj-a"]', { state: 'visible', timeout: 15_000 });

  // QuestSheet._onDropRewardItem's Objective branch (QuestSheet.js:612-625)
  // moves the dragged id to the array index of the drop target's id, then
  // rebuilds the object in that key order. Dragging 'obj-c' (index 2) and
  // dropping it on 'obj-a' (index 0) reproduces the same [c, a, b] result the
  // old synthetic-flag-write version of this spec asserted directly.
  await dropOnSheet(gm, '.objective-items li.item[data-id="obj-a"]', { type: 'Objective', id: 'obj-c' });

  await gm.waitForFunction((id) => {
    const flag = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'objectives');
    return flag && Object.keys(flag)[0] === 'obj-c';
  }, id, { timeout: 15_000 });

  const order = Object.keys(await entryFlag(gm, id, 'objectives'));
  assert.deepEqual(order, ['obj-c', 'obj-a', 'obj-b'], 'reorder did not persist');
  assertNoErrors(session);
});
