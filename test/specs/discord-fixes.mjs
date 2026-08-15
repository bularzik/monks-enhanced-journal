// Discord fix round (2026-08-15): one section per reported issue. Run with
// the fix branches (or an integration branch merging them) checked out in
// the main repo. Tasks 6-8/10 append further `// --- N. <name> ---` sections
// below inside the SAME outer withSession() — keep that pattern.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';
import { connect } from '../helpers/foundry.js';

await withSession('discord-fixes', { users: ['Gamemaster', 'User 1'] }, async (session) => {
  const gm = session.pages['Gamemaster'];
  const player = session.pages['User 1']; // used by section 4 below

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

  // --- 3. Encounter-placement scene guard (Discord: "MATT Start Encounter") ---
  // monks-enhanced-journal.js's "startencounter" Monks Active Tiles (MAT) tile
  // action registers a `restrict` callback for its "location" ctrl that used
  // to read `this.scene.id`. That callback is an arrow function nested inside
  // Hooks.on("setupTileActions", (app) => {...}) - itself an arrow function -
  // so `this` is never dynamically bindable; it resolves to the ES module's
  // top-level `this`, which is `undefined` (this file ships via esmodules in
  // module.json). MAT's own MonksActiveTiles.selectClick calls
  // `restrict(canvas.scene, tileDocument)` as a bare function call when the
  // user clicks the canvas to pick the "location" field's value while
  // configuring a Start Encounter trigger on a Tile - `this.scene` throws
  // there ("Cannot read properties of undefined (reading 'scene')"),
  // matching the Discord report exactly, and aborts the click before the
  // location is ever recorded. The fix reads `canvas.scene` directly (the
  // established live-access pattern used elsewhere in this file, e.g. the
  // EncounterTemplate code Task 5's section above exercises) instead of the
  // never-valid `this.scene`.
  //
  // This is only reachable at all when Monks Active Tiles is installed and
  // active - MEJ's registration itself lives inside a "setupTileActions" hook
  // that only MAT fires. MAT is NOT part of this suite's standard module set
  // (lib-wrapper, monks-tokenbar, tidy5e-sheet, monks-enhanced-journal) and
  // must not be left installed after a suite run, so this section drives the
  // real MAT relay only when it detects MAT active in the world, and falls
  // back to a no-op skip (with the outer `assertNoErrors(session)` below and
  // Task 5's own canvas-session assertion above still covering the "zero page
  // errors" baseline) when it isn't - matching a normal run of this suite.
  const matSession = await connect({ users: ['Gamemaster'], noCanvas: false });
  const matGm = matSession.pages['Gamemaster'];
  let tileId;
  let matActive = false;
  try {
    matActive = await matGm.evaluate(() => game.modules.get('monks-active-tiles')?.active === true);
    if (!matActive) {
      console.log('discord-fixes section 3: monks-active-tiles not installed/active - skipping MAT-relayed repro (fix is still exercised by build-time review; see task-7-report.md)');
    } else {
      await matGm.waitForFunction(() => !!canvas?.ready, null, { timeout: 20_000 });

      tileId = await matGm.evaluate(async () => {
        const [tile] = await canvas.scene.createEmbeddedDocuments('Tile', [{
          texture: { src: 'icons/svg/hazard.svg' }, x: 500, y: 500, width: 200, height: 200,
        }]);
        return tile.id;
      });

      // Open the (MAT-patched) Tile Config sheet and drill into its Triggers
      // tab -> Actions sub-tab -> "+" (createAction) -> pick "Start Encounter"
      // from MEJ's optgroup -> the "location" ctrl's crosshair picker button.
      // This is the real, unmodified MAT UI path a GM uses to configure the
      // trigger the Discord reporter hit - not a hand-rolled mock of MAT's
      // internals.
      await matGm.evaluate(async (id) => {
        await canvas.scene.tiles.get(id).sheet.render(true);
      }, tileId);
      await matGm.waitForSelector('a[data-action="tab"][data-tab="activetile"]', { state: 'visible' });
      await matGm.click('a[data-action="tab"][data-tab="activetile"]');
      await matGm.click('div[data-tab="activetile"] a[data-action="tab"]:has-text("Actions")');
      await matGm.click('div[data-tab="activetile"] button[data-action="createAction"]');
      await matGm.waitForFunction(() => [...foundry.applications.instances.values()]
        .some((a) => a.constructor.name === 'ActionConfig'), null, { timeout: 10_000 });

      await matGm.evaluate(() => {
        const actionCfg = [...foundry.applications.instances.values()].find((a) => a.constructor.name === 'ActionConfig');
        const sel = actionCfg.element.querySelector('select[name="action"]');
        sel.value = 'monks-enhanced-journal.startencounter';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await matGm.waitForSelector('[data-action-id="data.location"] button.location-picker[data-type="either"]', { state: 'visible' });
      await matGm.click('[data-action-id="data.location"] button.location-picker[data-type="either"]');

      // Entering "select a location" mode minimizes the config windows and
      // arms MonksActiveTiles.waitingInput with the real restrict callback
      // MEJ registered - the click handler's minimize() calls are async, so
      // poll rather than checking immediately after the click resolves.
      // Confirm that armed state before clicking canvas, so a failure to
      // reach the click at all doesn't masquerade as a pass.
      await matGm.waitForFunction(() => {
        const wf = game.MonksActiveTiles.waitingInput?.waitingfield;
        return !!wf && wf.data('type') === 'either' && typeof wf.data('restrict') === 'function';
      }, null, { timeout: 10_000 });

      // The real click: TilesLayer's canvas click handler (MAT-wrapped via
      // libWrapper) -> MonksActiveTiles.canvasClick -> selectClick ->
      // restrict(canvas.scene, tileDocument) - the exact call that threw in
      // the Discord report's stack trace.
      const board = await matGm.evaluate(() => {
        const r = document.getElementById('board').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await matGm.mouse.click(board.x, board.y);
      await matGm.waitForTimeout(500);

      // Pre-fix this never resolves false: the TypeError aborts selectClick
      // before it clears waitingInput, matching the reporter's "unable to
      // select a location on the scene" - so this is the direct assertion
      // that a location was actually selectable, not just that nothing threw.
      const stillWaiting = await matGm.evaluate(() => !!game.MonksActiveTiles.waitingInput);
      assert.equal(stillWaiting, false, 'location was not selected - MonksActiveTiles.waitingInput still armed after the canvas click (restrict likely threw)');

      assertNoErrors(matSession);
    }
  } finally {
    try {
      if (tileId) await matGm.evaluate(async (id) => { await canvas.scene.tiles.get(id)?.delete(); }, tileId);
    } catch {}
    try { await matSession.close(); } catch (e) { console.error(`discord-fixes section 3: matSession.close() failed: ${e.stack}`); }
  }

  if (matActive) {
    // Creating/deleting the Tile above broadcasts real-time doc-change events
    // to every connected client, including this suite's noCanvas
    // 'Gamemaster'/'User 1' pages that stay joined for the whole spec. Two
    // unrelated handlers there choke on canvas being uninitialized:
    //  - MAT's own createTile/deleteTile hooks (monks-active-tiles.js
    //    findTileTriggers()) unconditionally read `canvas.scene.tiles`
    //    ("Cannot read properties of null (reading 'tiles')").
    //  - Foundry core's own delete lifecycle (client/documents/abstract/
    //    canvas-document.mjs _onDeleteOperation) unconditionally reads
    //    `documents[0].layer.clipboard` - `TileDocument.layer` resolves to
    //    `canvas.tiles`, which is undefined under core.noCanvas
    //    ("Cannot read properties of null (reading 'clipboard')").
    // Neither is reachable through MEJ's code and neither depends on whether
    // restrict() is fixed - they're a MAT-active + noCanvas-client
    // incompatibility inherent to this harness, not a regression. Filter only
    // these two known artifacts (only reachable when MAT is actually active -
    // MAT is not part of the standard suite module set, so this branch is
    // dormant in ordinary runs) rather than masking real regressions.
    const known = [
      "Cannot read properties of null (reading 'tiles')",
      "Cannot read properties of null (reading 'clipboard')",
    ];
    for (const [page, log] of session.logs) {
      session.logs.set(page, log.filter((l) => !known.some((k) => l.includes(k))));
    }
  }

  // --- 4. players can reopen their own handouts; Show-to-Players reaches them ---
  // Discord: "Players can't open the journal" (N0P3_0ne). Triage (task-8-report.md /
  // notes-player-open-triage.md) found TWO independent, silent bugs:
  //  (a) core ClientDocument.createDialog() (Foundry v13+'s sidebar "Create Journal
  //      Entry" flow) creates with renderSheet:false and renders doc.sheet itself,
  //      bypassing MEJ's JournalEntry._onCreate open-gate - the 14.04b hotfix family
  //      (302e778+3d00a29), cherry-picked onto maint/14.00-sync for this task.
  //  (b) EnhancedJournalSheet's `get form()` searched for a <form> nested inside the
  //      EnhancedJournal shell ($("form", this.enhancedjournal.form)) - broken by the
  //      independently-legitimate templates/main.html <form>->div change, which
  //      removed that nested <form> entirely. Any embedded-subsheet action calling
  //      this.submit() - including the real "Show to Players" header action - then
  //      crashed inside core's FormDataExtended#processFormFields before doing
  //      anything, silently swallowing the action for both GM and player. A
  //      maintainer-sync-merge-only regression, NOT part of the 14.04b family -
  //      fixed directly on maint/14.00-sync (this task).
  //
  // Expected to PASS on: maint/14.00-sync AFTER the task-8 amendment (both fixes
  // above are present), and on enhancements-test (has the 14.04b hotfix under
  // different SHAs - e0c3ae2/0dccb25 - and never took the <form>->div change, so
  // never had bug (b) to begin with).
  // Expected to FAIL on: maint/14.00-sync BEFORE the task-8 amendment (both bugs
  // reproduce live, full stack traces in notes-player-open-triage.md), and on any
  // hypothetical tree that has 14.04b's createDialog fix but not this task's
  // `get form()` fix (bug (b) alone still crashes "Show to Players").
  {
    // world-a's stock Permissions Configuration matches Foundry's own default
    // (JOURNAL_CREATE: [TRUSTED, ASSISTANT, GAMEMASTER] = [2,3,4]) - a PLAYER-role
    // user has no "Create Journal Entry" button in the sidebar at all, core-side,
    // independent of MEJ. Grant it for this section only and restore it after -
    // this must not leak into other spec files that assume the stock permission set.
    const originalPermissions = await gm.evaluate(() => game.settings.get('core', 'permissions'));
    const grantedJournalCreate = !originalPermissions.JOURNAL_CREATE?.includes(1);
    if (grantedJournalCreate) {
      await gm.evaluate(async () => {
        const perms = game.settings.get('core', 'permissions');
        perms.JOURNAL_CREATE = [...new Set([...(perms.JOURNAL_CREATE ?? []), 1])];
        await game.settings.set('core', 'permissions', perms);
      });
      await player.reload();
      await player.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });
    }

    // MEJ persists the EnhancedJournal shell's open tabs as a USER FLAG
    // (apps/enhanced-journal.js: `this.tabs = ... game.user.getFlag('monks-enhanced-
    // journal', 'tabs') || [...]`), not just in-memory/localStorage - it survives a
    // page reload and leaks across separate test runs. Left alone, a stale tab from
    // an earlier run (or an unrelated earlier fixture entry) can be the ACTIVE tab
    // when EnhancedJournal reopens, making `.document` resolve to that leftover
    // document instead of the one this section just created - clear it so every run
    // starts from a real "no tabs open" state, matching a genuinely fresh player.
    await player.evaluate(async () => { await game.user.unsetFlag('monks-enhanced-journal', 'tabs'); });

    let handoutId;
    try {
      // Skeleton check from the task brief: a programmatic create + .sheet.render(true)
      // reopen. Kept as a cheap first assertion, but NOT sufficient coverage on its
      // own - during this task's manual triage the programmatic path stayed green
      // in scenarios where the real UI path (below) failed, which is exactly the
      // reported bug.
      handoutId = await player.evaluate(async () => {
        const je = await JournalEntry.implementation.create({ name: 'TT-discord-handout',
          pages: [{ name: 'TT-discord-handout', type: 'text', text: { content: '<p>hi</p>' } }] });
        return je.id;
      });
      await player.evaluate((id) => { for (const app of foundry.applications.instances.values()) { if (app.document?.id === id) app.close(); } }, handoutId);
      await player.evaluate((id) => game.journal.get(id).sheet.render(true), handoutId);
      await player.waitForTimeout(1000);
      const reopened = await player.evaluate((id) =>
        [...foundry.applications.instances.values()].some(a => a.document?.id === id && a.rendered), handoutId);
      assert.ok(reopened, 'player could not reopen their own handout (programmatic path)');

      await player.evaluate(async (id) => { await game.journal.get(id)?.delete(); }, handoutId);
      handoutId = null;

      // Reload before the real UI path: the programmatic check above can leave
      // MonksEnhancedJournal.journal (MEJ's shared browser shell) instantiated in
      // some intermediate tab/document state from the raw `.sheet.render(true)`
      // call, which isn't how a real user would have gotten there and has been
      // observed to make the createDialog-race assertion below flaky/misleading.
      // Starting the real-UI portion from a clean client avoids that entirely.
      await player.reload();
      await player.waitForFunction(() => window.game?.ready === true, null, { timeout: 30_000 });

      // --- Real UI path: sidebar "Create Journal Entry" -> close -> real sidebar
      // dblclick to reopen. This is the actual reported gesture, not a synthetic
      // equivalent - v14 replaced the old double-click-to-open with a single-click
      // `activateEntry` action (client/applications/sidebar/document-directory.mjs
      // _onClickEntry), so a dblclick here fires that handler twice.
      await player.evaluate(() => { ui.sidebar.expand(); ui.sidebar.changeTab('journal', 'primary'); });
      await player.waitForSelector('[data-action="createEntry"]', { timeout: 15_000 });
      await player.click('[data-action="createEntry"]');
      await player.waitForSelector('dialog input[name="name"]', { timeout: 15_000 });

      const UI_NAME = 'TT-discord-handout-ui';
      await player.fill('dialog input[name="name"]', UI_NAME);
      // Pick an MEJ single-sheet type explicitly - the dialog's default ("text") is
      // a plain core type MEJ never claims, so it can't exercise the createDialog
      // race at all. "journalentry" (MEJ's generic viewer) is the variant that
      // reproduced a real console crash during triage.
      await player.evaluate(() => {
        const el = document.querySelector('dialog select[name="flags.monks-enhanced-journal.pagetype"]');
        el.value = 'journalentry';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await player.click('dialog button[data-action="ok"], dialog button[type="submit"]');
      await player.waitForTimeout(2000);

      handoutId = await player.evaluate((name) => game.journal.getName(name)?.id ?? null, UI_NAME);
      assert.ok(handoutId, `entry "${UI_NAME}" was not created via the real sidebar dialog`);

      // EnhancedJournal is a multi-tab shell (apps/enhanced-journal.js); its own
      // `.document` getter tracks whichever tab last finished activating, and tab
      // activation is fire-and-forget/queued (queueTabChange), not synchronous with
      // addTab() - so polling is needed. A single-page entry auto-drills into that
      // page (shell.document ends up being the JournalEntryPage, not the parent
      // JournalEntry - confirmed live: shell.document.constructor.name was
      // "JournalEntryPage5e", .parent.id === the entry id passed in), so match
      // either the entry id itself or its current page's parent id.
      const rendersMEJ = (id) => player.waitForFunction((id) => {
        const shell = game.MonksEnhancedJournal?.journal;
        if (!shell?.rendered) return false;
        const shown = shell.subsheet?.document ?? shell.document;
        if (!shown) return false;
        return shown.id === id || shown.parent?.id === id;
      }, id, { timeout: 10_000 }).then(() => true).catch(() => false);
      assert.ok(await rendersMEJ(handoutId), 'entry created via the real sidebar UI did not open through the Enhanced Journal (createDialog race)');

      await player.evaluate((id) => { for (const app of foundry.applications.instances.values()) { if (app.document?.id === id || app.document?.parent?.id === id) app.close(); } }, handoutId);
      await player.waitForTimeout(500);
      await player.evaluate(() => { ui.sidebar.expand(); ui.sidebar.changeTab('journal', 'primary'); });
      const entrySelector = `.directory-item[data-entry-id="${handoutId}"] a[data-action="activateEntry"]`;
      await player.waitForSelector(entrySelector, { timeout: 15_000 });
      await player.dblclick(entrySelector);
      await player.waitForTimeout(2000);
      assert.ok(await rendersMEJ(handoutId), 'player could not reopen their own handout via a real sidebar dblclick');

      // --- GM "Show to Players" (real header-control action) reaches the player ---
      await player.evaluate((id) => { for (const app of foundry.applications.instances.values()) { if (app.document?.id === id || app.document?.parent?.id === id) app.close(); } }, handoutId);
      await player.waitForTimeout(500);

      await gm.evaluate(() => { ui.sidebar.expand(); ui.sidebar.changeTab('journal', 'primary'); });
      const gmEntrySelector = `.directory-item[data-entry-id="${handoutId}"] a[data-action="activateEntry"]`;
      await gm.waitForSelector(gmEntrySelector, { timeout: 15_000 });
      await gm.click(gmEntrySelector);
      await gm.waitForTimeout(1500);

      // ApplicationV2 collapses every header control beyond Close behind a "..."
      // (toggleControls) button; the showPlayers control's DOM only exists once
      // that dropdown has actually been opened. Multiple top-level windows can be
      // open at once (the EnhancedJournal shell plus a page's own subsheet popout),
      // each with its own toggle - click the frontmost (highest z-index) one.
      const toggled = await gm.evaluate(() => {
        const apps = [...foundry.applications.instances.values()].filter((a) => a.rendered && a.element);
        apps.sort((a, b) => (parseInt(getComputedStyle(b.element).zIndex) || 0) - (parseInt(getComputedStyle(a.element).zIndex) || 0));
        for (const app of apps) {
          const btn = app.element.querySelector('.window-header [data-action="toggleControls"]');
          if (btn) { btn.click(); return true; }
        }
        return false;
      });
      assert.ok(toggled, 'no open window had a toggleControls header button for the GM');
      await gm.waitForTimeout(500);

      const showClicked = await gm.evaluate(() => {
        const btn = document.querySelector('[data-action="showPlayers"]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      assert.ok(showClicked, '"Show to Players" header control was not found for the GM');
      await gm.waitForTimeout(1000);

      // Confirm the real ShowToPlayersDialog (core Journal.showDialog) - pre-fix,
      // bug (b)'s crash happened before Journal.showDialog was ever called, so this
      // dialog never appeared at all.
      const confirmed = await gm.evaluate(() => {
        const btn = document.querySelector('dialog button[data-action="yes"], dialog button[data-action="ok"], dialog button[type="submit"]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      assert.ok(confirmed, '"Show to Players" confirmation dialog did not appear - _onShowPlayers likely crashed before calling Journal.showDialog');
      await player.waitForTimeout(1500);

      // Match either the entry id directly (e.g. a core JournalEntrySheet, or an
      // EnhancedJournal shell showing a multi-page entry) or a page's parent id
      // (EnhancedJournal auto-drills a single-page entry into that page - see the
      // rendersMEJ note above).
      const playerGotIt = await player.waitForFunction((id) =>
        [...foundry.applications.instances.values()].some((a) =>
          a.rendered && (a.document?.id === id || a.document?.parent?.id === id)),
        handoutId, { timeout: 10_000 }).then(() => true).catch(() => false);
      assert.ok(playerGotIt, 'player got no window after GM used the real "Show to Players" action');
    } finally {
      // Close any windows still showing the entry on EITHER client before deleting
      // it - deleting out from under a still-open EnhancedJournal tab has been
      // observed to throw ("A subclass of Document must implement this getter",
      // apps/enhanced-journal.js renderSubSheet -> document.compendium) from a
      // pending re-render racing the delete, which is a cleanup-ordering artifact,
      // not a product bug under test here.
      if (handoutId) {
        for (const p of [gm, player]) {
          await p.evaluate((id) => {
            for (const app of foundry.applications.instances.values()) {
              if (app.document?.id === id || app.document?.parent?.id === id) app.close();
            }
          }, handoutId).catch(() => {});
        }
        await gm.waitForTimeout(300).catch(() => {});
        await gm.evaluate(async (id) => { await game.journal.get(id)?.delete(); }, handoutId).catch(() => {});
      }
      if (grantedJournalCreate) {
        await gm.evaluate(async (perms) => { await game.settings.set('core', 'permissions', perms); }, originalPermissions).catch(() => {});
      }
    }
  }

  assertNoErrors(session);
});
