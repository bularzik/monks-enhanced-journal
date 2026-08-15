// Discord fix round (2026-08-15): one section per reported issue. Run with
// the fix branches (or an integration branch merging them) checked out in
// the main repo. Tasks 6-8/10 append further `// --- N. <name> ---` sections
// below inside the SAME outer withSession() — keep that pattern.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';
import { connect } from '../helpers/foundry.js';

await withSession('discord-fixes', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const player = session.pages['User 1']; // reserved for later sections (Tasks 6-8/10)

  // --- 1. encounter ControlIcon deprecation (Discord: "Create Encounter Buttons") ---
  // EncounterTemplate._draw() is only reachable through a real canvas template
  // placement (EncounterSheet.startEncounter() -> EncounterTemplate.fromEncounter()
  // constructs a MeasuredTemplateDocument with `parent: canvas.scene`, which is
  // null under this harness's default `core.noCanvas` mode - see helpers/foundry.js
  // join()). Unlike every other spec in this suite, this section is genuinely
  // canvas-dependent, so it opens its own short-lived, separate session with
  // canvas enabled (`connect({ noCanvas: false })`) rather than reusing the
  // outer DOM-only `session` - keeps the heavier software-rasterized canvas
  // page scoped to just this section instead of the whole spec file.
  const canvasSession = await connect({ users: ['Gamemaster'], noCanvas: false });
  const canvasGm = canvasSession.pages['Gamemaster'];
  let actorId, encId;
  try {
    const depWarnings = [];
    canvasGm.on('console', (msg) => {
      if (msg.type() === 'warning' && msg.text().includes('ControlIcon#iconSrc')) depWarnings.push(msg.text());
    });

    actorId = await canvasGm.evaluate(async () => {
      const a = await Actor.create({ name: 'TT-discord-enc-monster', type: 'npc' });
      return a.id;
    });
    encId = await createEntry(canvasGm, 'encounter', 'TT-discord-enc', {
      actors: { [actorId]: { id: actorId, quantity: '1' } },
    });
    await openEntry(canvasGm, encId);

    // EncounterSheet is rendered as EnhancedJournal's embedded subsheet, not a
    // standalone Application instance (apps/enhanced-journal.js renderSubSheet()
    // assigns it to `this.subsheet`) - not discoverable via
    // foundry.applications.instances the way the brief's skeleton assumed.
    const startResult = await canvasGm.evaluate(async () => {
      const sheet = game.MonksEnhancedJournal.journal.subsheet;
      if (sheet?.constructor?.name !== 'EncounterSheet') return { error: `unexpected subsheet: ${sheet?.constructor?.name}` };
      // Fire-and-forget: startEncounter()'s own drawPreview().catch(()=>null) means
      // it only resolves once placement is confirmed or canceled - the caller
      // cancels via Escape below. EncounterTemplate._draw() (the fix under test)
      // runs synchronously inside drawPreview()'s initial this.draw() call, before
      // any placement interaction, so we don't need to wait for it to resolve.
      sheet.constructor.startEncounter.call(sheet, false);
      return { ok: true };
    });
    assert.ok(!startResult.error, startResult.error);

    // Give the preview's initial draw() a moment to run (async: ControlIcon.draw()
    // awaits texture load) and settle a couple of render frames.
    await canvasGm.waitForFunction(() => !!canvas.templates?.encounterTemplate, null, { timeout: 10_000 });
    await canvasGm.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    assert.equal(depWarnings.length, 0, `ControlIcon#iconSrc deprecation fired: ${depWarnings[0] ?? ''}`);

    // Harden beyond the deprecation warning itself: the pre-fix code's second
    // line (`this.controlIcon.texture = null`) clobbered the icon right back to
    // empty immediately after the deprecated iconSrc setter set it - so the
    // sword icon silently failed to render at all, independent of the warning.
    // This is the actual user-visible "Create Encounter Buttons" symptom.
    const iconState = await canvasGm.evaluate(() => {
      const ci = canvas.templates.encounterTemplate.controlIcon;
      return { isEmpty: ci.icon.texture === PIXI.Texture.EMPTY, isValid: !!ci.icon.texture?.valid };
    });
    assert.equal(iconState.isEmpty, false, 'encounter placement preview icon texture is EMPTY - sword icon is not rendering');
    assert.equal(iconState.isValid, true, 'encounter placement preview icon texture did not load');

    // Cancel placement: EncounterTemplate.activatePreviewListeners binds
    // cancellation to canvas.app.view.oncontextmenu (right-click), NOT Escape -
    // unlike core's own MeasuredTemplate placement workflow, this class never
    // wires an Escape-key handler at all. _onCancelPlacement rejects the
    // drawPreview() promise, which startEncounter() itself swallows via
    // .catch(() => null) - no unhandled rejection expected.
    await canvasGm.click('#board', { button: 'right' });
    await canvasGm.waitForFunction(() => !canvas.templates?.encounterTemplate, null, { timeout: 10_000 });

    assertNoErrors(canvasSession);
  } finally {
    try {
      if (encId) await canvasGm.evaluate(async (id) => { await game.journal.get(id)?.delete(); }, encId);
    } catch {}
    try {
      if (actorId) await canvasGm.evaluate(async (id) => { await game.actors.get(id)?.delete(); }, actorId);
    } catch {}
    try { await canvasSession.close(); } catch (e) { console.error(`discord-fixes section 1: canvasSession.close() failed: ${e.stack}`); }
  }

  // --- 2. TableResult#text deprecation (quest/loot populate-from-rolltable) ---
  // EnhancedJournalSheet#rollTable's per-result loop reads `tableresult.text`
  // (removed in v15; deprecated since v13, warns via foundry.utils.logCompatibilityWarning
  // -> console.warn, same capture pattern as section 1). It's the single shared
  // method every itemtype's "populate from roll table" button calls (Quest's
  // rewards tab is the stack Discord reported, but Loot/Shop/Encounter all
  // route through the exact same code - see sheets/*.js onRoll*() handlers).
  // We drive it through LootSheet rather than QuestSheet: quest's branch at
  // the end of rollTable's yes-callback (`rewards[rewardId].itemIds = ...`)
  // assumes an active reward already exists, which a freshly-created quest
  // doesn't have (its rewards tab requires manually adding a reward first,
  // itself unrelated to this bug) - Loot has no such precondition and reaches
  // the identical deprecated read.
  const trWarnings = [];
  gm.on('console', (msg) => { if (msg.type() === 'warning' && msg.text().includes('TableResult#text')) trWarnings.push(msg.text()); });

  let tableUuid, lootId;
  try {
    tableUuid = await gm.evaluate(async () => {
      const table = await RollTable.implementation.create({
        name: 'TT-discord-rolltable',
        results: [{ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 'text', description: '10 gp', range: [1, 1] }],
      });
      return table.uuid;
    });

    lootId = await createEntry(gm, 'loot', 'TT-discord-loot');
    await openEntry(gm, lootId);

    // sheet-loot-items.hbs: the "Populate from Roll Table" header icon,
    // data-action="rollItem" -> LootSheet.onRollItem -> this.rollTable(...).
    await gm.click('[data-action="rollItem"]');
    await gm.waitForSelector('dialog.dialog select[name="rollable-table"]', { state: 'visible' });

    // roll-table.html's <select name="rollable-table"> options are keyed by
    // raw uuid (selectGroups' groupid is undefined for this call site, so no
    // prefix is prepended) - set it directly rather than via a real click
    // sequence, matching foundry.js join()'s established "set .value + dispatch
    // change" approach for selects that aren't guaranteed to behave like a
    // vanilla <select> under Playwright's selectOption().
    await gm.evaluate((uuid) => {
      const el = document.querySelector('dialog.dialog select[name="rollable-table"]');
      el.value = uuid;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, tableUuid);
    await gm.click('dialog.dialog button[data-action="yes"]');

    await gm.waitForFunction((id) => {
      const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items') || {};
      return Object.keys(items).length > 0;
    }, lootId, { timeout: 10_000 });

    assert.equal(trWarnings.length, 0, `TableResult#text deprecation fired: ${trWarnings[0] ?? ''}`);

    // Warning-silence alone isn't enough - the deprecated getter forwards to
    // the same value pre-fix, so also assert the rolled text actually landed
    // as a populated loot item (the table's "10 gp" text result).
    const itemNames = await gm.evaluate((id) => {
      const items = game.journal.get(id)?.pages.contents[0]?.getFlag('monks-enhanced-journal', 'items') || {};
      return Object.values(items).map((i) => i.name);
    }, lootId);
    assert.ok(itemNames.includes('10 gp'), `populated loot item missing rolled text "10 gp": ${JSON.stringify(itemNames)}`);
  } finally {
    // sweep() (run by withSession's finally) only clears game.journal/actors/items
    // named 'TT-*' - RollTable documents live in a separate world collection
    // (game.tables) it never touches, so this one needs explicit cleanup.
    try {
      if (tableUuid) await gm.evaluate(async (uuid) => { await (await fromUuid(uuid))?.delete(); }, tableUuid);
    } catch {}
  }

  assertNoErrors(session);
});
