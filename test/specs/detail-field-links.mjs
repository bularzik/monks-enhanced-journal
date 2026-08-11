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
//
// enrichFields()'s @Foo[...] gate enriches ANY content-link syntax, not just
// @UUID[JournalEntry...] - a hand-typed reference to some other document
// type (Macro, Item, ...) or an unresolvable one is just as reachable as a
// dropped journal link. _onFieldDisplayClick resolves the target from the
// enricher's own anchor dataset (data-uuid primarily) and calls the
// resolved document's own `_onClickDocumentLink` - the base Foundry
// implementation already does the right per-type thing (execute a Macro,
// render an Item sheet, ...) without MEJ hand-rolling type dispatch, and an
// unresolvable `a.content-link.broken` is explicitly skipped (checked
// below: a hand-typed Macro reference and a deliberately broken reference).
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, setEntryFlag, dropOnSheet, assertNoErrors } from '../helpers/mej.js';

const MODULE = 'monks-enhanced-journal';
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
  // ui.windows is the (empty, for ApplicationV2) legacy registry;
  // foundry.applications.instances is what actually tracks rendered V2 apps.
  const strayJournalSheets = await gm.evaluate(() =>
    [...foundry.applications.instances.values()]
      .filter((w) => w.rendered && w.document?.documentName === 'JournalEntry' && w.constructor.name !== 'EnhancedJournal')
      .map((w) => w.constructor.name));
  assert.deepEqual(strayJournalSheets, [], 'clicking the content-link should route through MEJ, not also pop a default core JournalEntry sheet');

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

  // --- A hand-typed non-JournalEntry reference (Macro) resolves and
  // activates on click, not just @UUID[JournalEntry...] drops ---
  const macroUuid = await gm.evaluate(async () => {
    let macro = game.macros.find((m) => m.name === 'TT-field-links-macro');
    if (!macro) {
      macro = await Macro.create({
        name: 'TT-field-links-macro', type: 'script',
        command: 'window.__mejFieldLinksMacroRan = true;',
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
      });
    }
    return macro.uuid;
  });
  const EYES_SEL = 'input[name="flags.monks-enhanced-journal.attributes.eyes"]';
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector(EYES_SEL, { state: 'attached' });
  await setEntryFlag(gm, personId, 'attributes', {
    ...(await gm.evaluate((id) => game.journal.get(id).pages.contents[0].getFlag('monks-enhanced-journal', 'attributes'), personId)),
    eyes: `@UUID[${macroUuid}]{TT-field-links-macro}`,
  });
  await gm.evaluate(() => game.MonksEnhancedJournal.journal.render(true));
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector('.mej-field-display[data-field="eyes"] a.content-link', { state: 'attached' });
  await gm.evaluate(() => { window.__mejFieldLinksMacroRan = false; });
  await gm.click('.mej-field-display[data-field="eyes"] a.content-link');
  await gm.waitForFunction(() => window.__mejFieldLinksMacroRan === true, null, { timeout: 3000 })
    .catch(() => { throw new Error('hand-typed Macro reference did not resolve/activate on click (silent no-op)'); });
  await gm.evaluate(() => delete window.__mejFieldLinksMacroRan);

  // --- A deliberately broken reference renders as .broken and stays inert ---
  const TRAITS_SEL = 'input[name="flags.monks-enhanced-journal.attributes.traits"]';
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector(TRAITS_SEL, { state: 'attached' });
  await setEntryFlag(gm, personId, 'attributes', {
    ...(await gm.evaluate((id) => game.journal.get(id).pages.contents[0].getFlag('monks-enhanced-journal', 'attributes'), personId)),
    traits: '@UUID[JournalEntry.doesnotexist000000]{Ghost}',
  });
  await gm.evaluate(() => game.MonksEnhancedJournal.journal.render(true));
  await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
  await gm.waitForSelector('.mej-field-display[data-field="traits"] a.content-link.broken', { state: 'attached' });
  const brokenAffordance = await gm.evaluate(() =>
    getComputedStyle(document.querySelector('.mej-field-display[data-field="traits"] a.content-link.broken')).pointerEvents);
  assert.equal(brokenAffordance, 'none', 'a broken content-link must not carry a pointer/navigation affordance');
  const docBeforeBrokenClick = await gm.evaluate(() => game.MonksEnhancedJournal.journal?.document?.id);
  await gm.click('.mej-field-display[data-field="traits"]', { force: true });
  await gm.waitForTimeout(400);
  const docAfterBrokenClick = await gm.evaluate(() => game.MonksEnhancedJournal.journal?.document?.id);
  assert.equal(docAfterBrokenClick, docBeforeBrokenClick, 'clicking a broken content-link should be a silent no-op, not navigate');
  // A broken reference is still fixable: dblclick-to-edit must still work.
  await gm.dblclick('.mej-field-display[data-field="traits"]');
  const brokenEditState = await gm.evaluate(() => {
    const input = document.querySelector('input.mej-field-edit[name="flags.monks-enhanced-journal.attributes.traits"]');
    return { visible: input && getComputedStyle(input).display !== 'none', value: input?.value };
  });
  assert.ok(brokenEditState.visible, 'double-click on a broken field display did not reveal the raw edit input');
  assert.equal(brokenEditState.value, '@UUID[JournalEntry.doesnotexist000000]{Ghost}', 'broken field raw edit input does not contain the original syntax');

  // --- Player: the enriched link renders and opens through MEJ too ---
  await openEntry(player, personId);
  await player.waitForSelector('.mej-field-display[data-field="location"] a.content-link', { state: 'attached' });
  await player.click('.mej-field-display[data-field="location"] a.content-link');
  await player.waitForFunction((id) => {
    const doc = game.MonksEnhancedJournal.journal?.document;
    return doc?.id === id || doc?.parent?.id === id;
  }, targetId, { timeout: 5000 });

  // --- Organization attribute field also drops + enriches (Task 9 merge
  // check): Organization/Event/POI (enh/more-type-attributes) gained
  // fieldlist() via the hoist off Person/Place, but only Person/Place called
  // enrichFields(this.fieldlist()) before this branch existed - the merge
  // must have wired enrichFields() into the three new sheets too, or their
  // attribute fields would drop @UUID[...] syntax but never render it as a
  // clickable link. sheet-settings is world-scoped, so save/restore it
  // around enabling the "leader" attribute + entry-details tab, mirroring
  // more-type-attributes.mjs's own idempotency guard.
  const originalSheetSettings = await gm.evaluate((mod) => game.settings.get(mod, 'sheet-settings'), MODULE);
  try {
    await gm.evaluate((mod) => {
      const settings = foundry.utils.duplicate(game.settings.get(mod, 'sheet-settings') || {});
      settings.organization = settings.organization || {};
      settings.organization.attributes = settings.organization.attributes || {};
      settings.organization.attributes.leader = { ...(settings.organization.attributes.leader || {}), shown: true };
      settings.organization.tabs = settings.organization.tabs || {};
      settings.organization.tabs['entry-details'] = { ...(settings.organization.tabs['entry-details'] || {}), shown: true };
      return game.settings.set(mod, 'sheet-settings', settings, { diff: false });
    }, MODULE);

    const orgId = await createEntry(gm, 'organization', 'TT-org-field-link');
    await openEntry(gm, orgId);
    await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
    const LEADER_SEL = 'input[name="flags.monks-enhanced-journal.attributes.leader"]';
    await gm.waitForSelector(LEADER_SEL, { state: 'attached' });
    await dropOnSheet(gm, LEADER_SEL, { type: 'JournalEntry', uuid: targetUuid });
    const leaderDropped = await gm.evaluate((sel) => document.querySelector(sel)?.value, LEADER_SEL);
    assert.equal(leaderDropped, `@UUID[${targetUuid}]{TT-link-target}`, 'Organization detail-field drop did not insert @UUID[...] syntax');

    await gm.click('.monks-enhanced-journal a[data-tab="entry-details"]');
    await gm.waitForSelector('.mej-field-display[data-field="leader"] a.content-link', { state: 'attached' });
    const orgLinkUuid = await gm.evaluate(() =>
      document.querySelector('.mej-field-display[data-field="leader"] a.content-link')?.dataset.uuid);
    assert.equal(orgLinkUuid, targetUuid,
      'Organization attribute field did not enrich its dropped link - enrichFields() must be wired through the hoisted fieldlist() for the new types too');
  } finally {
    await gm.evaluate((args) => game.settings.set(args.mod, 'sheet-settings', args.orig, { diff: false }),
      { mod: MODULE, orig: originalSheetSettings });
  }

  assertNoErrors(session);
});
