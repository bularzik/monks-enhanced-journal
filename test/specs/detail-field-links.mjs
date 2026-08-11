// Task 7 (enh/detail-field-links, #66/#203): Person/Place header fields
// (context.fields, sheet-detailed-header.hbs) and detail/attribute fields
// (context.detailFields, sheet-details.hbs) accept an @UUID[...] drop and
// render an enriched, clickable content-link instead of the raw syntax.
//
// EnhancedJournalSheet.enrichFields() sets `field.enriched` (TextEditor
// enrichHTML output) whenever a field's raw value contains @Foo[...] syntax;
// both partials only switch into the dual-mode "display div (enriched) +
// hidden raw input, dblclick to edit" render when `field.enriched` is
// truthy - a field with no link syntax renders the exact same bare <input>
// this partial produced before this branch (asserted as an exact outerHTML
// match against the pre-branch template output for the unlinked "role"
// header field).
//
// Content-link clicks inside `.mej-field-display` route through MEJ's own
// document click delegate (JournalEntry.prototype._onClickDocumentLink,
// patched in monks-enhanced-journal.js - the same delegate the description
// editor's rendered display already relies on), not a new router: this spec
// asserts openJournalEntry's effect directly (the enhanced-journal browser's
// tracked `.document` swapping to the linked entry) for both GM and player.
//
// A `.mej-field-display` can be wider than its content-link anchor (e.g. the
// header fields, which flex to fill the row), so the first half of a real
// double-click on the link text would otherwise fire single-click navigation
// immediately, racing the DOM out from under the second click before it can
// register as a dblclick. EnhancedJournalSheet._onFieldDisplayClick debounces
// single clicks (~300ms) so a following click cancels navigation in favour of
// the dblclick-to-edit swap; this spec's real dblclick() action against a
// link-filled display (the "ancestry" detail field, whose display div is
// nearly as narrow as its anchor - the case that reproduced the race during
// implementation) is itself the regression check for that fix.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, dropOnSheet, assertNoErrors } from '../helpers/mej.js';

const LOCATION_SEL = 'input[name="flags.monks-enhanced-journal.location"]';
const ROLE_SEL = 'input[name="flags.monks-enhanced-journal.role"]';
const ANCESTRY_SEL = 'input[name="flags.monks-enhanced-journal.attributes.ancestry"]';

await withSession('detail-field-links', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const player = session.pages['User 1'];

  const targetId = await createEntry(gm, 'person', 'TT-link-target');
  const targetUuid = await gm.evaluate((id) => game.journal.get(id).uuid, targetId);

  const personId = await createEntry(gm, 'person', 'TT-field-links-person');
  await openEntry(gm, personId);
  await gm.waitForSelector(LOCATION_SEL, { state: 'attached' });

  // --- Unlinked field: byte-identical bare <input>, no display div grown ---
  const roleOuterHTML = await gm.evaluate((sel) => document.querySelector(sel)?.outerHTML, ROLE_SEL);
  assert.equal(roleOuterHTML, '<input type="text" name="flags.monks-enhanced-journal.role" value="">',
    'a field with no link syntax must render the exact pre-branch bare <input> DOM');
  const roleHasEditClass = await gm.evaluate((sel) => document.querySelector(sel)?.classList.contains('mej-field-edit'), ROLE_SEL);
  assert.equal(roleHasEditClass, false, 'unlinked field input should not carry the dual-mode mej-field-edit class');

  // --- Header field ("Location"): drop inserts @UUID syntax at the cursor ---
  await dropOnSheet(gm, LOCATION_SEL, { type: 'JournalEntry', uuid: targetUuid });
  const droppedValue = await gm.evaluate((sel) => document.querySelector(sel)?.value, LOCATION_SEL);
  assert.equal(droppedValue, `@UUID[${targetUuid}]{TT-link-target}`, 'drop did not insert @UUID[...] syntax into the field');

  // The drop handler's synthetic `change` event triggers the sheet's normal
  // submitOnChange save + re-render; wait for the enriched display.
  await gm.waitForSelector('.mej-field-display[data-field="location"] a.content-link', { state: 'attached' });
  const linkDataUuid = await gm.evaluate(() =>
    document.querySelector('.mej-field-display[data-field="location"] a.content-link')?.dataset.uuid);
  assert.equal(linkDataUuid, targetUuid, 'enriched content-link does not point at the dropped entry');

  // --- Clicking the enriched link opens the target entry in the MEJ browser ---
  await gm.click('.mej-field-display[data-field="location"] a.content-link');
  await gm.waitForFunction((id) => {
    const doc = game.MonksEnhancedJournal.journal?.document;
    return doc?.id === id || doc?.parent?.id === id;
  }, targetId, { timeout: 5000 });
  const openAppCount = await gm.evaluate(() =>
    Object.values(ui.windows).filter((w) => w.rendered && w.document?.documentName === 'JournalEntry').length);
  assert.equal(openAppCount, 0, 'clicking the content-link should route through MEJ, not also pop a default core JournalEntry sheet');

  // --- Double-click swaps back to the raw input containing the @UUID syntax ---
  // Navigate back to the person entry (the click above moved the MEJ browser
  // to the linked entry) before exercising the dblclick-to-edit swap.
  await openEntry(gm, personId);
  await gm.waitForSelector('.mej-field-display[data-field="location"] a.content-link', { state: 'attached' });
  await gm.dblclick('.mej-field-display[data-field="location"]');
  const swappedState = await gm.evaluate((sel) => {
    const input = document.querySelector(`input.mej-field-edit[name="${sel}"]`);
    return { visible: input && getComputedStyle(input).display !== 'none', value: input?.value };
  }, 'flags.monks-enhanced-journal.location');
  assert.ok(swappedState.visible, 'double-click did not reveal the raw edit input');
  assert.equal(swappedState.value, `@UUID[${targetUuid}]{TT-link-target}`, 'raw edit input does not contain the @UUID syntax');

  // Blur without further edits swaps back to the enriched display (round trip).
  await gm.click('.monks-enhanced-journal .header-name input[name="name"]');
  await gm.waitForFunction((sel) => {
    const display = document.querySelector('.mej-field-display[data-field="location"]');
    return display && getComputedStyle(display).display !== 'none';
  }, null, { timeout: 5000 });

  // --- Detail (attribute) field: drop, enrich, and a dblclick landing
  // squarely on the (narrow) content-link anchor - the exact geometry that
  // reproduced the click/dblclick navigation race during implementation ---
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector(ANCESTRY_SEL, { state: 'attached' });
  await dropOnSheet(gm, ANCESTRY_SEL, { type: 'JournalEntry', uuid: targetUuid });
  const ancestryDropped = await gm.evaluate((sel) => document.querySelector(sel)?.value, ANCESTRY_SEL);
  assert.equal(ancestryDropped, `@UUID[${targetUuid}]{TT-link-target}`, 'detail-field drop did not insert @UUID[...] syntax');

  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector('.mej-field-display[data-field="ancestry"] a.content-link', { state: 'attached' });
  await gm.dblclick('.mej-field-display[data-field="ancestry"]');
  const ancestrySwapped = await gm.evaluate(() => {
    const input = document.querySelector('input.mej-field-edit[name="flags.monks-enhanced-journal.attributes.ancestry"]');
    return { visible: input && getComputedStyle(input).display !== 'none', value: input?.value };
  });
  assert.ok(ancestrySwapped.visible, 'double-click on the detail field display did not reveal the raw edit input');
  assert.equal(ancestrySwapped.value, `@UUID[${targetUuid}]{TT-link-target}`, 'detail field raw edit input does not contain the @UUID syntax');
  // Critically: the dblclick must NOT have navigated the MEJ browser away
  // from the person entry (the race this design guards against).
  const showingAfterDblclick = await gm.evaluate(() => game.MonksEnhancedJournal.journal?.document?.parent?.id
    ?? game.MonksEnhancedJournal.journal?.document?.id);
  assert.equal(showingAfterDblclick, personId, 'double-click on an enriched detail field navigated away instead of entering edit mode');

  // --- Full/textarea detail field ("ideals"): same drop -> enrich -> edit
  // round trip as the short <input> variant, but on a <textarea> ---
  const IDEALS_SEL = 'textarea[name="flags.monks-enhanced-journal.attributes.ideals"]';
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector(IDEALS_SEL, { state: 'attached' });
  await dropOnSheet(gm, IDEALS_SEL, { type: 'JournalEntry', uuid: targetUuid });
  const idealsDropped = await gm.evaluate((sel) => document.querySelector(sel)?.value, IDEALS_SEL);
  assert.equal(idealsDropped, `@UUID[${targetUuid}]{TT-link-target}`, 'full/textarea field drop did not insert @UUID[...] syntax');

  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector('.mej-field-display[data-field="ideals"] a.content-link', { state: 'attached' });
  await gm.dblclick('.mej-field-display[data-field="ideals"]');
  const idealsSwapped = await gm.evaluate(() => {
    const textarea = document.querySelector('textarea.mej-field-edit[name="flags.monks-enhanced-journal.attributes.ideals"]');
    return { visible: textarea && getComputedStyle(textarea).display !== 'none', value: textarea?.value };
  });
  assert.ok(idealsSwapped.visible, 'double-click on the full/textarea field display did not reveal the raw edit textarea');
  assert.equal(idealsSwapped.value, `@UUID[${targetUuid}]{TT-link-target}`, 'full/textarea field raw edit textarea does not contain the @UUID syntax');

  // --- Player: the enriched link renders and opens through MEJ too ---
  await openEntry(player, personId);
  await player.waitForSelector('.mej-field-display[data-field="location"] a.content-link', { state: 'attached' });
  await player.click('.mej-field-display[data-field="location"] a.content-link');
  await player.waitForFunction((id) => {
    const doc = game.MonksEnhancedJournal.journal?.document;
    return doc?.id === id || doc?.parent?.id === id;
  }, targetId, { timeout: 5000 });

  assertNoErrors(session);
});
