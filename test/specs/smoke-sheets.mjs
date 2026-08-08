// Every MEJ sheet type opens in world-a with zero console errors.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';

const TYPES = ['encounter', 'event', 'list', 'loot', 'organization', 'person',
               'picture', 'place', 'poi', 'quest', 'shop', 'slideshow'];

await withSession('smoke-sheets', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  for (const type of TYPES) {
    const id = await createEntry(gm, type, `TT-smoke-${type}`);
    await openEntry(gm, id);
    // The enhanced-journal window (MonksEnhancedJournal.journal) tracks the
    // currently displayed document on `.document`. For a single-page entry
    // whose page carries an MEJ type flag, renderSubSheet() (apps/enhanced-
    // journal.js:445) swaps `.document` from the JournalEntry to its sole
    // JournalEntryPage, so `.document.id` is the *page* id, not the entry id
    // we created — the entry is reachable via `.document.parent.id` instead.
    // There is no `.object` property on EnhancedJournal at all.
    const showing = await gm.evaluate((id) => {
      const j = game.MonksEnhancedJournal.journal;
      const doc = j?.document;
      return !!doc && (doc.id === id || doc.parent?.id === id);
    }, id);
    assert.ok(showing, `enhanced journal window is not showing the ${type} entry`);
  }
  assertNoErrors(session);
});
