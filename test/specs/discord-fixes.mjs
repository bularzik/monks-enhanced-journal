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

  assertNoErrors(session);
});
