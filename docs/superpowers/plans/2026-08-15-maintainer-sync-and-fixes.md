# Maintainer 14.00 Sync, Discord Fix Round, and 14.07-test Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the upstream maintainer's 14.00 test build into a `maint/14.00-sync` branch (keeping all our #821 fixes), test the maintainer's additions, fix the 7 Discord-reported issues on individual branches, and ship an all-inclusive `integration-14.07` build as the 14.07-test release.

**Architecture:** A synthetic three-way git merge (base = merge-base 1a0eefa, ours = `backlog-fixes`@964bf19, theirs = the zip snapshot) mechanically separates maintainer additions from our dropped work. Fix branches stack on 964bf19 (PR-able onto #821). Integration stacks everything on `enhancements-test`. All verification runs through the playwright harness against the live local Foundry v14.

**Tech Stack:** git worktrees/three-way merge, Foundry VTT v14 (build 14.365), Playwright harness (`playwright-harness` branch, worktree `.claude/worktrees/playwright-harness/test/`), `gh` CLI for the fork release.

## Global Constraints

- `backlog-fixes` is FROZEN: never commit to it, never push it. All work branches off it.
- NO PRs raised on any repo. NO posting to Discord or upstream. (Dan's explicit approval required for any PR.)
- Release 14.07-test gets an annotated git tag named exactly `14.07-test` at the built commit, pushed to origin (`bularzik/monks-enhanced-journal`). Older test manifests are NOT repointed.
- `packs/` (LevelDB) is excluded from all diff/merge/zip work.
- Spec: `docs/superpowers/specs/2026-08-15-maintainer-sync-and-fixes-design.md`. Conflict rule for the sync merge: **keep-ours-unless-additive**, every ruling written down.
- Foundry test env: launch `~/FoundryVTT-14/start-foundry.command`, serves http://localhost:30000, dataPath `~/FoundryVTT-14/Data` (modules live in `~/FoundryVTT-14/Data/Data/modules/`; `monks-enhanced-journal` there is a **symlink to the main repo checkout** — whatever branch the main repo has checked out is what Foundry runs). World `world-a`, users `Gamemaster`/`User 1`/`User 2`, blank passwords. Unbundled v14 source (API reference): `~/FoundryVTT-14/FoundryVTT-Node-14.365/client/` and `common/`.
- Harness: `cd .claude/worktrees/playwright-harness/test && node run.mjs` (all specs), `node run.mjs <substring>` (filter). Specs import helpers from `helpers/mej.js` (`withSession`, `createEntry`, `openEntry`, `setEntryFlag`, `assertNoErrors`). `zz-currency-systems.mjs` must stay last alphabetically; name no spec after "zz".
- New harness specs are committed on the `playwright-harness` branch (in its worktree), NOT on feature branches.
- Maintainer zip: `~/mej-v14-testing/monks-enhanced-journal.zip` (version string "14.00"). Discord exports: the seven `*.html` files + `*_Files/` image dirs in `~/mej-v14-testing/`.
- Key SHAs: merge-base `1a0eefa`; `backlog-fixes` tip `964bf19`; `enhancements-test` carries rounds 1+2 + the 14.04b cherry-pick (302e778+3d00a29). Commit `b878a87` is fork plumbing — never cherry-pick it anywhere.

---

## File/Branch Map

| Unit | What it is |
|---|---|
| `tmp/maint-zip` (branch) | synthetic snapshot commit: base 1a0eefa's tree overlaid with zip contents (no packs) |
| `maint/14.00-sync` (branch) | 964bf19 + merge of `tmp/maint-zip` — ours + maintainer additions |
| `docs/superpowers/triage/2026-08-15-maintainer-14.00-reconciliation.md` | additions list / drops (re-raise) list / conflict rulings |
| `test/specs/maintainer-features.mjs` (playwright-harness branch) | Phase-B specs for maintainer feature clusters |
| `fix/encounter-controlicon`, `fix/tableresult-deprecation`, `fix/encounter-placement-scene`, `fix/player-open-journal`, `fix/large-font-headers`, `fix/renderpage-removeattribute`, `fix/dialog-button-overlap` | one branch per Discord issue, off 964bf19 unless triage says maintainer-only |
| `test/specs/discord-fixes.mjs` (playwright-harness branch) | Phase-C regression checks (one section per fix) |
| `integration-14.07` (branch) | `enhancements-test` + `maint/14.00-sync` + fix branches |
| `docs/superpowers/triage/2026-08-15-maintainer-sync-and-fixes-outcomes.md` | outcomes doc (Task 14) |

Workspace scratch (ledger, notes): `.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes/` — conflict rulings and triage notes accumulate in `notes-*.md` files there until the Task-3/Task-14 docs consume them.

---

### Task 1: Synthetic zip snapshot commit (`tmp/maint-zip`)

**Files:**
- Create: branch `tmp/maint-zip` (one commit on top of 1a0eefa)
- Create: `.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes/notes-zip-import.md`

**Interfaces:**
- Produces: branch `tmp/maint-zip` whose tree = 1a0eefa's tree with the zip overlaid (packs/ excluded; files present at 1a0eefa but absent from the zip are KEPT — deletions are reported, not applied). Also a maintainer-deleted-files list in the notes file. Task 2 merges this branch.

- [ ] **Step 1: Extract the zip fresh**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
rm -rf /tmp/maint-zip-extract && mkdir -p /tmp/maint-zip-extract
unzip -q ~/mej-v14-testing/monks-enhanced-journal.zip -d /tmp/maint-zip-extract
ls /tmp/maint-zip-extract   # expect module.json, sheets/, apps/, css/ ... at top level
```

- [ ] **Step 2: Create a worktree at the merge base**

```bash
git branch tmp/maint-zip 1a0eefa
git worktree add .claude/worktrees/maint-zip tmp/maint-zip
```

- [ ] **Step 3: Overlay zip contents (excluding packs/) onto the base tree**

```bash
cd .claude/worktrees/maint-zip
rsync -a --exclude='packs/' /tmp/maint-zip-extract/ ./
git status --porcelain | head -40   # sanity: modified + new files, no deletions
```

- [ ] **Step 4: Record files the maintainer deleted (present at base, absent in zip)**

```bash
mkdir -p ../../../.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes
{ echo "# Files at 1a0eefa missing from maintainer zip (NOT deleted on the branch)";
  git ls-tree -r --name-only 1a0eefa | grep -v '^packs/' | while read f; do
    [ -e "/tmp/maint-zip-extract/$f" ] || echo "- $f";
  done; } > ../../../.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes/notes-zip-import.md
```

- [ ] **Step 5: Verify no deletions staged, then commit**

```bash
git add -A
git status --porcelain | grep '^D' && echo "UNEXPECTED DELETIONS - investigate" || echo "no deletions, good"
git commit -m "Synthetic snapshot of maintainer 14.00 test zip (packs excluded, base-tree files preserved)"
git diff 1a0eefa tmp/maint-zip --stat | tail -3   # record the summary line in the notes file
```

- [ ] **Step 6: Sanity — the tree matches the zip where the zip has files**

```bash
diff -rq /tmp/maint-zip-extract . --exclude=packs --exclude=.git 2>/dev/null | grep -v '^Only in \.' | head
# Expect empty output (every zip file identical in the worktree).
```

### Task 2: Three-way merge into `maint/14.00-sync`

**Files:**
- Create: branch `maint/14.00-sync` (off 964bf19, merge commit of `tmp/maint-zip`)
- Create: `.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes/notes-conflict-rulings.md`

**Interfaces:**
- Consumes: `tmp/maint-zip` from Task 1.
- Produces: merged branch `maint/14.00-sync`; per-conflict rulings in `notes-conflict-rulings.md`, each entry formatted `## <file> — <hunk one-liner>` + "ours:", "theirs:", "ruling: kept-ours|took-theirs|combined — <why>", plus a `FLAG-DELIBERATE-REVERT` marker on any conflict where the maintainer appears to have intentionally reverted one of our shipped fixes.

- [ ] **Step 1: Create the sync branch worktree**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
git branch maint/14.00-sync 964bf19
git worktree add .claude/worktrees/maint-sync maint/14.00-sync
cd .claude/worktrees/maint-sync
```

- [ ] **Step 2: Merge the synthetic commit (no commit yet)**

```bash
git merge --no-ff --no-commit tmp/maint-zip || true
git status --porcelain | grep '^UU\|^AA\|^DU\|^UD' > /tmp/conflict-list.txt; cat /tmp/conflict-list.txt
```

- [ ] **Step 3: Adjudicate every conflict — keep-ours-unless-additive**

For each conflicted file: open it, examine each `<<<<<<<` hunk.
- Theirs is purely additive (new function/setting/CSS rule/lang key that doesn't touch our fix) → combine both sides.
- Theirs rewrites/removes code one of our #821 commits changed → keep ours; if their version looks like a deliberate alternative fix, mark `FLAG-DELIBERATE-REVERT` in the ruling.
- `lang/*.json`: take theirs wholesale EXCEPT keys our fixes added (check `git log -p 964bf19 --oneline -- lang/en.json` if unsure) — those keep ours.
- Record every hunk ruling in `notes-conflict-rulings.md` (format above). Resolve, `git add <file>`.

- [ ] **Step 4: Syntax-check all merged JS, then commit the merge**

```bash
for f in $(git diff --cached --name-only | grep '\.js$'); do node --check "$f" || echo "SYNTAX FAIL: $f"; done
git commit -m "Merge maintainer 14.00 additions onto backlog-fixes (keep-ours-unless-additive)"
```

- [ ] **Step 5: Smoke-boot the merged module**

Point Foundry at this tree: in the MAIN repo checkout run `git checkout maint/14.00-sync` (the modules symlink follows the main checkout; the worktree was only for the merge — from here on work in the main checkout and remove the maint-sync worktree with `git worktree remove .claude/worktrees/maint-sync`). Then:

```bash
cd .claude/worktrees/playwright-harness/test && node run.mjs connect
```

Expected: connect/smoke spec passes, no MEJ console errors. Fix any load-time breakage introduced by the merge (adjudication error) before proceeding.

### Task 3: Reconciliation report + push

**Files:**
- Create: `docs/superpowers/triage/2026-08-15-maintainer-14.00-reconciliation.md` (committed on `enhancements-test` in the main repo)
- Push: `maint/14.00-sync` to origin

**Interfaces:**
- Consumes: `notes-zip-import.md`, `notes-conflict-rulings.md`, branches from Tasks 1–2.
- Produces: the report with three sections — `## Maintainer additions` (grouped by feature), `## Our #820/#821 work absent from 14.00` (re-raise list), `## Conflict rulings` — plus `## Files maintainer deleted` and a prominent `## Flagged deliberate reverts` section (may be "none"). Task 4 reads the additions section to derive test clusters.

- [ ] **Step 1: Enumerate maintainer additions (what the merge brought in)**

```bash
git diff 964bf19 maint/14.00-sync --stat
git diff 964bf19 maint/14.00-sync > /tmp/additions.diff   # read and group by feature
```

- [ ] **Step 2: Enumerate our work absent from their build (kept by the merge)**

```bash
git diff tmp/maint-zip maint/14.00-sync --stat
git diff tmp/maint-zip maint/14.00-sync > /tmp/drops.diff
# Hunks where the sync branch has code the zip lacks (ignoring Task-1 base-file preservation
# and the additions themselves) = our #820/#821 work the maintainer dropped. Cross-check each
# against `git log --oneline 1a0eefa..964bf19` to name the originating commit/fix.
```

- [ ] **Step 3: Write the report**

Write `docs/superpowers/triage/2026-08-15-maintainer-14.00-reconciliation.md` with the five sections listed in Interfaces. For the re-raise list, each entry: our commit SHA + one-line fix description + affected file(s). Known-expected entries (verify, don't assume): the round-3 `ForcedReplacement` objectives atomic-reorder fix; the 14.04b open-gate/render-wrapper fix (never in #821 — list it as "expected absent").

- [ ] **Step 4: Commit the report and push the branch**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
git checkout enhancements-test && git add docs/superpowers/triage/2026-08-15-maintainer-14.00-reconciliation.md
git commit -m "Add maintainer 14.00 reconciliation report"
git push origin maint/14.00-sync
```

### Task 4: Harness specs for maintainer feature clusters (Phase B)

**Files:**
- Create: `test/specs/maintainer-features.mjs` (in `.claude/worktrees/playwright-harness/test/`, committed on `playwright-harness`)

**Interfaces:**
- Consumes: `## Maintainer additions` section of the Task-3 report.
- Produces: one spec file with a named section per behavioral cluster; passes against `maint/14.00-sync`. Task 13 runs it as part of the full suite.

- [ ] **Step 1: Derive clusters**

Read the report's additions section. Group into named clusters (known going in: `selectplayer` app, `defunct.png` asset flow, CSS/font rework; add whatever else the report shows, e.g. new settings or sheet behaviors). For each, decide behavioral (gets assertions) vs cosmetic (screenshot + `assertNoErrors` only). Record the cluster list at the top of the spec file as a comment.

- [ ] **Step 2: Write the spec (failing-first where it asserts behavior)**

Main repo stays checked out on `maint/14.00-sync` for this task. Skeleton mirroring existing specs:

```js
// Phase B (maintainer 14.00 sync): coverage for the maintainer's own additions,
// derived from docs/superpowers/triage/2026-08-15-maintainer-14.00-reconciliation.md.
// Clusters: <list them>.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';

const MODULE = 'monks-enhanced-journal';

await withSession('maintainer-features', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];

  // --- cluster: selectplayer app registers and opens ---
  const hasSelectPlayer = await gm.evaluate(async () => {
    try { const m = await import('/modules/monks-enhanced-journal/apps/selectplayer.js'); return Object.keys(m); }
    catch (e) { return { error: e.message }; }
  });
  assert.ok(!hasSelectPlayer.error, `selectplayer.js should import cleanly: ${hasSelectPlayer.error}`);
  // ...then drive whatever UI invokes it (find the caller in the additions diff) and
  // assert the dialog renders and its primary action completes without console errors.

  // --- one section per remaining cluster, same shape ---

  await assertNoErrors(session);
});
```

Each behavioral cluster's section must drive the real UI path (like `more-type-attributes.mjs` drives the Customise Pages dialog) — not just flag reads.

- [ ] **Step 3: Run it against the sync branch**

```bash
cd .claude/worktrees/playwright-harness/test && node run.mjs maintainer-features
```

Expected: PASS with zero MEJ console errors. A cluster that cannot be exercised by the harness (needs capability the harness lacks) is documented in the spec file's header comment as manually-verified-or-skipped, with a one-line reason — not silently dropped.

- [ ] **Step 4: Commit on playwright-harness**

```bash
cd .claude/worktrees/playwright-harness
git add test/specs/maintainer-features.mjs && git commit -m "Add maintainer-features spec (14.00 sync coverage)"
```

### Task 5: `fix/encounter-controlicon` — ControlIcon#iconSrc deprecation

**Files:**
- Modify: `classes/encounter-template.js:100-106` (branch `fix/encounter-controlicon` off 964bf19)
- Test: `test/specs/discord-fixes.mjs` (new file, section 1)

**Interfaces:**
- Produces: branch `fix/encounter-controlicon`; creates `test/specs/discord-fixes.mjs` with the shared header that later fix tasks append sections to.

Evidence: Discord "Create Encounter Buttons" — `ControlIcon#iconSrc has been deprecated in favor of ControlIcon#texture` (since v14, removed v16), stack through `EncounterTemplate._draw` → `EncounterSheet.startEncounter`. Our tree has the identical defect at `classes/encounter-template.js:100-106`:

```js
async _draw(options) {
    await super._draw(options);
    this.controlIcon.iconSrc = "icons/svg/sword.svg";
    this.controlIcon.texture = null;
    await this.controlIcon.draw();
}
```

- [ ] **Step 1: Branch**

```bash
git checkout -b fix/encounter-controlicon 964bf19
```

- [ ] **Step 2: Check the v14 ControlIcon API**

```bash
grep -n "texture" ~/FoundryVTT-14/FoundryVTT-Node-14.365/client/canvas/containers/elements/control-icon* 2>/dev/null || \
  grep -rn "class ControlIcon" -A 40 ~/FoundryVTT-14/FoundryVTT-Node-14.365/client/ | head -60
```

Confirm what `texture` expects (a texture path string set via constructor/`texture` property in v14 — verify, and check whether `draw()` re-reads it).

- [ ] **Step 3: Write the failing harness check (start `discord-fixes.mjs`)**

```js
// Discord fix round (2026-08-15): one section per reported issue.
// Run with the fix branches (or integration-14.07) checked out in the main repo.
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry, assertNoErrors } from '../helpers/mej.js';

const MODULE = 'monks-enhanced-journal';

await withSession('discord-fixes', { users: ['Gamemaster'] }, async (session) => {
  const gm = session.pages['Gamemaster'];

  // --- 1. encounter ControlIcon deprecation ---
  const depWarnings = [];
  gm.on('console', (msg) => { if (msg.text().includes('ControlIcon#iconSrc')) depWarnings.push(msg.text()); });
  const enc = await createEntry(gm, { name: 'TT-discord-enc', type: 'encounter' });
  await openEntry(gm, enc);
  await gm.evaluate(() => {
    const sheet = Object.values(ui.windows ?? {}).concat([...foundry.applications.instances.values()])
      .find(a => a.constructor?.name === 'EncounterSheet' || a.document?.getFlag?.('monks-enhanced-journal', 'type') === 'encounter');
    return sheet.startEncounter?.() ?? sheet._onClickAction?.({}, { dataset: { action: 'startEncounter' } });
  });
  await gm.waitForTimeout(1500);
  await gm.keyboard.press('Escape'); // cancel placement
  assert.equal(depWarnings.length, 0, `ControlIcon#iconSrc deprecation fired: ${depWarnings[0] ?? ''}`);

  await assertNoErrors(session);
});
```

(Adjust the sheet-lookup/start invocation to match how `EncounterSheet.startEncounter` is actually reached — see `sheets/EncounterSheet.js:431-442`; drive the real button if the encounter sheet exposes it in the opened window.) Run: `node run.mjs discord-fixes` with main repo on `fix/encounter-controlicon` **before** the code fix. Expected: FAIL on the deprecation assertion.

- [ ] **Step 4: Fix**

```js
async _draw(options) {
    await super._draw(options);
    this.controlIcon.texture = "icons/svg/sword.svg";
    await this.controlIcon.draw();
}
```

(If Step 2 showed `texture` must be a loaded Texture rather than a path, instead pass the path through the supported v14 constructor/config route found there — the invariant: no `iconSrc` writes remain. `git grep -n iconSrc` must return nothing.)

- [ ] **Step 5: Run test to verify it passes**

`node run.mjs discord-fixes` → PASS, placement preview still shows the sword icon (screenshot to confirm visually).

- [ ] **Step 6: Commit both sides**

```bash
git add classes/encounter-template.js && git commit -m "Fix ControlIcon#iconSrc deprecation in encounter template (Discord: Create Encounter Buttons)"
cd .claude/worktrees/playwright-harness && git add test/specs/discord-fixes.mjs && git commit -m "Add discord-fixes spec: encounter ControlIcon section"
```

### Task 6: `fix/tableresult-deprecation` — TableResult#text

**Files:**
- Modify: `sheets/EnhancedJournalSheet.js:2368` region + any sibling TableResult text reads (branch `fix/tableresult-deprecation` off 964bf19)
- Test: `test/specs/discord-fixes.mjs` section 2 (playwright-harness branch)

Evidence: Discord "rollTable Deprecation" — `TableResult#text is deprecated. Use TableResult#name or TableResult#description` (removed v15), stack at their `EnhancedJournalSheet.js:2391` from Quest populate-from-rolltable; reporter suspects Loot too. Our tree: `let text = tableresult.text;` at `sheets/EnhancedJournalSheet.js:2368`.

- [ ] **Step 1: Branch and find ALL TableResult text reads**

```bash
git checkout -b fix/tableresult-deprecation 964bf19
git grep -n "\.text\b" -- sheets/ apps/ classes/ | grep -iv "textarea\|getText\|text-\|innerText"   # inspect each hit; TableResult reads only
```

- [ ] **Step 2: Check v14 TableResult API for the correct replacement**

```bash
grep -rn "get text\|#text" ~/FoundryVTT-14/FoundryVTT-Node-14.365/common/documents/table-result* | head
```

Expected replacement: `tableresult.description || tableresult.name` (text-type results carry description; document-type carry name — confirm from source and mirror core's own back-compat getter logic).

- [ ] **Step 3: Failing test — append section 2 to `discord-fixes.mjs`**

```js
  // --- 2. TableResult#text deprecation (quest/loot populate-from-rolltable) ---
  const trWarnings = [];
  gm.on('console', (msg) => { if (msg.text().includes('TableResult#text')) trWarnings.push(msg.text()); });
  await gm.evaluate(async () => {
    const table = await RollTable.implementation.create({ name: 'TT-discord-rolltable',
      results: [{ type: CONST.TABLE_RESULT_TYPES?.TEXT ?? "text", description: "10 gp", range: [1, 1] }] });
    const quest = await JournalEntry.implementation.create({ name: 'TT-discord-quest',
      flags: { 'monks-enhanced-journal': { type: 'quest' } },
      pages: [{ name: 'TT-discord-quest', type: 'text', flags: { 'monks-enhanced-journal': { type: 'quest' } } }] });
    window.__tt = { tableUuid: table.uuid, questUuid: quest.uuid };
  });
  // Drive the real populate-from-rolltable path on the opened quest sheet (the DialogV2 the
  // stack shows). Locate the entry point with: git grep -n "rolltable\|RollTable" sheets/ apps/
  // and invoke it as the UI would, selecting TT-discord-rolltable.
  await gm.waitForTimeout(1000);
  assert.equal(trWarnings.length, 0, `TableResult#text deprecation fired: ${trWarnings[0] ?? ''}`);
```

Run `node run.mjs discord-fixes` (main repo on this branch, pre-fix). Expected: FAIL on the new assertion.

- [ ] **Step 4: Fix every read**

At `sheets/EnhancedJournalSheet.js:2368` (and each sibling hit found in Step 1):

```js
let text = tableresult.description || tableresult.name || "";
```

Preserve the downstream `{…}` coin-formula parsing untouched — only the source of `text` changes. Also verify the result actually lands (the populated reward/item shows "10 gp"), not just warning-silence.

- [ ] **Step 5: Run test → PASS; commit both sides**

```bash
git add sheets/EnhancedJournalSheet.js && git commit -m "Replace deprecated TableResult#text reads (Discord: rollTable Deprecation)"
cd .claude/worktrees/playwright-harness && git add test/specs/discord-fixes.mjs && git commit -m "discord-fixes: TableResult deprecation section"
```

### Task 7: `fix/encounter-placement-scene` — MATT start-encounter crash

**Files:**
- Modify: `monks-enhanced-journal.js:5214` region (branch `fix/encounter-placement-scene` off 964bf19)
- Test: `test/specs/discord-fixes.mjs` section 3

Evidence: Discord "MATT Start Encounter" — `Uncaught TypeError: Cannot read properties of undefined (reading 'scene')` at their `monks-enhanced-journal.js:5182` inside a `restrict` callback, invoked through **Monk's Active Tiles**' `MonksActiveTiles.selectClick` → `TilesLayer.canvasClick`. Our equivalent (line 5214): `restrict: (entity) => { return (entity instanceof Tile && this.scene.id == entity.parent.id) || this.scene.id == entity.id; }`.

- [ ] **Step 1: Branch + understand the interop**

```bash
git checkout -b fix/encounter-placement-scene 964bf19
grep -n "restrict" monks-enhanced-journal.js | sed -n '1,10p'
sed -n '5195,5230p' monks-enhanced-journal.js   # read the enclosing function: what is `this` here, who registers the handler?
```

Determine why `this` is undefined when MAT relays the click (MAT calls the restrict callback detached from MEJ's object). The reporter's symptom is "unable to select a location on the scene" — the throw aborts placement.

- [ ] **Step 2: Repro attempt**

Monk's Active Tiles is NOT in the test install (modules present: lib-wrapper, monks-tokenbar, tidy5e-sheet). Install it:

```bash
# In Foundry setup UI or via CLI: install "monks-active-tiles" into ~/FoundryVTT-14/Data/Data/modules/
# then enable it in world-a (module list scan requires world relaunch).
```

Repro: encounter journal → MATT/start-encounter button → click the canvas. Expected pre-fix: console TypeError, location never selected. If MAT installation is impractical, downgrade to code-evidence fix and say so in the outcomes notes — the guard below is safe regardless.

- [ ] **Step 3: Fix — null-safe restrict (and any sibling with the same shape)**

```js
restrict: (entity) => { return (entity instanceof Tile && this.scene?.id == entity.parent?.id) || this.scene?.id == entity.id; },
```

If Step 1 shows `this` is structurally undefined in the MAT path (not just missing scene), capture the scene into a local before the callback is handed out:

```js
let scene = this.scene ?? canvas.scene;
restrict: (entity) => { return (entity instanceof Tile && scene?.id == entity.parent?.id) || scene?.id == entity.id; },
```

- [ ] **Step 4: Test**

With MAT installed: repro path now completes placement (location selectable, no TypeError). Append section 3 to `discord-fixes.mjs` at minimum asserting the encounter-placement flow from Task 5's section still completes with zero page errors (`assertNoErrors`); with MAT present, drive the MAT-relayed click too. Run `node run.mjs discord-fixes` → PASS. **Then disable/remove MAT from world-a again** so later suite runs match the standard module set.

- [ ] **Step 5: Commit both sides**

```bash
git add monks-enhanced-journal.js && git commit -m "Guard scene access in placement restrict callbacks (Discord: MATT Start Encounter)"
cd .claude/worktrees/playwright-harness && git add test/specs/discord-fixes.mjs && git commit -m "discord-fixes: encounter placement scene-guard section"
```

### Task 8: `fix/player-open-journal` — players can't reopen handouts (investigate-first)

**Files:**
- Investigation task — branch only if triage lands "bug in our/maintainer code": `fix/player-open-journal` off 964bf19 (or off `maint/14.00-sync` if maintainer-only)
- Test: `test/specs/discord-fixes.mjs` section 4
- Create: `.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes/notes-player-open-triage.md`

Evidence: Discord "Players can't open the journal" (N0P3_0ne, vs maintainer 14.00) — GM fine; players can create a handout but can't reopen it after closing; Show-to-Players shows nothing. No stack trace. Prior art: the 14.04b fix (302e778+3d00a29) wrapped `JournalEntrySheet.prototype.render` because core's `createDialog` bypassed MEJ's open-gate — the maintainer's build LACKS that fix. Strong hypothesis: same family.

- [ ] **Step 1: Repro on the maintainer-equivalent tree**

Main repo → `git checkout maint/14.00-sync`. Two-user session (`users: ['Gamemaster', 'User 1']`): as User 1, create a journal entry (own it), close it, reopen from the sidebar; as GM, Show-to-Players an entry User 1 can observe. Record exactly what happens (nothing? core sheet? error?) in `notes-player-open-triage.md`, including console output from BOTH pages.

- [ ] **Step 2: Cross-check against our fixed trees**

Repeat the same script with main repo on `enhancements-test` (has 14.04b fix). Three verdict paths:
- **(a) broken on sync, fine on enhancements-test** → the 14.04b family covers it. Verdict: already-fixed-by-us; no new branch. Document that the fix for #821 remains "cherry-pick 302e778+3d00a29" (already a standing recommendation) and that `maint/14.00-sync` inherits the gap → add the cherry-pick ONTO `maint/14.00-sync` now (`git cherry-pick 302e778 3d00a29`, resolve as done for enhancements-test — keep both `altOpensOutside` and `waitForFirstPage` if the conflict appears) so the sync branch is testably whole.
- **(b) broken on both** → live bug in OUR code too: branch `fix/player-open-journal` off 964bf19, root-cause (open-gate settings `mej-only-types`? permission check in `_onCreate`/render wrapper? sidebar click path in `JournalDirectory`?), minimal fix, spec section proves player reopen + Show-to-Players.
- **(c) unreproducible on both** → needs-info verdict per spec stop-conditions; write it up with the exact scripts tried; no speculative fix.

- [ ] **Step 3: Regression spec — append section 4 to `discord-fixes.mjs`**

Whatever the verdict, add the player-reopen check (it's cheap and guards the family):

```js
  // --- 4. players can reopen their own handouts; Show-to-Players reaches them ---
  const player = session.pages['User 1'];   // session must be opened with both users for this file
  const handoutId = await player.evaluate(async () => {
    const je = await JournalEntry.implementation.create({ name: 'TT-discord-handout',
      pages: [{ name: 'TT-discord-handout', type: 'text', text: { content: '<p>hi</p>' } }] });
    return je.id;
  });
  await player.evaluate((id) => { for (const app of foundry.applications.instances.values()) { if (app.document?.id === id) app.close(); } }, handoutId);
  await player.evaluate((id) => game.journal.get(id).sheet.render(true), handoutId);
  await player.waitForTimeout(1000);
  const reopened = await player.evaluate((id) =>
    [...foundry.applications.instances.values()].some(a => a.document?.id === id && a.rendered), handoutId);
  assert.ok(reopened, 'player could not reopen their own handout');
```

Also drive the real sidebar double-click (`player.dblclick` on the directory entry) — the programmatic render can pass while the UI path fails, and the UI path is the reported bug.

- [ ] **Step 4: Commit** (notes always; code only if verdict (a)-cherry-pick or (b)-fix)

```bash
cd .claude/worktrees/playwright-harness && git add test/specs/discord-fixes.mjs && git commit -m "discord-fixes: player reopen/show-to-players section"
```

### Task 9: `fix/large-font-headers` — large-font vertical centering + Customise Page headers

**Files:**
- Modify: CSS under `css/` (branch `fix/large-font-headers` off 964bf19) — exact rules located in Step 1
- Test: screenshot verification (cosmetic; no assertion spec)

Evidence: Discord "Relationship Header & Large Font Size" — at large core font sizes, relationship-list header text ("Person / Relationship") is vertically uncentered with ~1px clipped at the bottom; Customise Page column headers ("Name"/"Show") render as a dark clipped strip.

- [ ] **Step 1: Branch + locate the rules**

```bash
git checkout -b fix/large-font-headers 964bf19
grep -n "items-header\|item-header" css/monks-journal-sheet.css | head
grep -n "customise\|customize" css/*.css | head
```

Inspect the header rules for fixed `height:`/`line-height:` px values — those are the large-font breakage.

- [ ] **Step 2: Repro + before screenshot**

Foundry core font size: `game.settings.set("core", "fontSize", 8)` (large step; v14 core exposes fontSize index — verify the setting key via `game.settings.settings` if it errors). Open a Person's relationships tab and the Customise Page dialog; screenshot both.

- [ ] **Step 3: Fix**

Replace fixed heights with content-driven centering on the affected header rules (keep selectors as found):

```css
/* pattern — apply to each offending rule */
.monks-journal-sheet .items-header {
    display: flex;
    align-items: center;
    min-height: 28px;   /* was height: 28px + line-height */
    height: auto;
}
```

For the Customise Page header strip: same treatment on its header row, plus ensure the text color/background aren't inherited-dark (compare against the dark-mode palette work — this branch is off 964bf19, which predates `enh/dark-mode`, so fix only what reproduces at 964bf19; note anything dark-mode-specific for the integration pass instead).

- [ ] **Step 4: After screenshots at normal AND large font; reset font size; commit**

```bash
git add css/ && git commit -m "Center list/customise-page headers at large font sizes (Discord: Relationship Header & Large Font Size)"
```

### Task 10: `fix/renderpage-removeattribute` — intermittent _renderPageView TypeError

**Files:**
- Investigation task — branch `fix/renderpage-removeattribute` off 964bf19 if code evidence found
- Create: `.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes/notes-removeattribute-triage.md`

Evidence: Discord "removeAttribute Error" — intermittent on journal open: `Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'removeAttribute')` at core `JournalEntrySheet._renderPageView` (foundry.mjs:100730) ← `_renderPageViews` ← `_onRender`. Reporter: can't replicate, may be an old v13-era core issue.

- [ ] **Step 1: Read the core code**

```bash
grep -n "removeAttribute" ~/FoundryVTT-14/FoundryVTT-Node-14.365/client/applications/sheets/journal/journal-entry-sheet* | head
# Read _renderPageView / _renderPageViews: what element does it look up (likely
# this.element.querySelector for the page article) and under what conditions is it missing?
```

- [ ] **Step 2: Identify MEJ's exposure**

The element is missing when core renders page views for a page not present in MEJ's DOM (MEJ overrides the sheet body/PARTS). Check our `sheets/JournalEntrySheet.js` (and the 14.04b-style render path on this branch): does MEJ ever let core `_onRender`/`_renderPageViews` run against MEJ's replaced DOM (e.g., the open-gate fallback rendering core sheet into a half-swapped state, or `goToPage` racing a re-render)? Write findings to the notes file with file:line receipts.

- [ ] **Step 3: Fix by code evidence (spec allows no-repro)**

Shape depends on Step 2; the acceptable envelope: a narrow guard so the core path no-ops instead of throwing when the page element is absent (e.g., early-return/`?.` in OUR override before delegating, or gating which pageIds we pass through). NOT acceptable: monkey-patching core's `_renderPageView` wholesale. If Step 2 finds no MEJ-side exposure at all, verdict = core-side/needs-info; document and skip the branch.

- [ ] **Step 4: Regression guard + commit (if branch created)**

Open/close + rapid page-switch loop (10×) in `discord-fixes.mjs` section 5 with `assertNoErrors` — races won't repro deterministically, but the loop plus zero-error gate is the practical net.

```bash
git add sheets/JournalEntrySheet.js && git commit -m "Guard page-view render race (Discord: removeAttribute Error)"
```

### Task 11: `fix/dialog-button-overlap` — Save Changes icon/text overlap

**Files:**
- Modify: CSS under `css/` (branch `fix/dialog-button-overlap` off 964bf19)
- Test: screenshot verification (cosmetic)

Evidence: Discord "List, Create Entry" — in the Edit Item dialog (List sheet) and the Create Folder window, the "Save Changes" footer button renders with icon/text overlapping (screenshot shows a caret/bar through the label).

- [ ] **Step 1: Branch + locate**

```bash
git checkout -b fix/dialog-button-overlap 964bf19
grep -n "form-footer\|dialog.*button\|footer button" css/*.css | head -20
```

Find which MEJ rule constrains those buttons (width/position/letter-spacing/font metrics). Both reported windows are MEJ-styled dialogs — confirm by opening List sheet → edit an item, and journal directory → Create Folder, then inspecting the button's computed style for the winning MEJ rule (use the harness page + `getComputedStyle` via evaluate, or DevTools).

- [ ] **Step 2: Fix the rule** (shape depends on Step 1 — typical: remove fixed `width`/absolute positioning on `> i`, use `display:flex; gap:4px; align-items:center; justify-content:center;` on the button). Only touch the offending selector(s).

- [ ] **Step 3: Before/after screenshots of both dialogs; commit**

```bash
git add css/ && git commit -m "Fix Save Changes button icon/text overlap in list edit + create folder dialogs (Discord: List, Create Entry)"
```

### Task 12: `integration-14.07` branch assembly

**Files:**
- Create: branch `integration-14.07` off `enhancements-test` tip
- Create: `.superpowers/sdd/2026-08-15-maintainer-sync-and-fixes/notes-integration-conflicts.md`

**Interfaces:**
- Consumes: `maint/14.00-sync` (Task 2/3, incl. any Task-8 cherry-pick) + every fix branch that exists after Tasks 5–11.
- Produces: merged branch where Task 13 runs the suite.

- [ ] **Step 1: Create and merge, one at a time**

```bash
git checkout -b integration-14.07 enhancements-test
for b in maint/14.00-sync fix/encounter-controlicon fix/tableresult-deprecation \
         fix/encounter-placement-scene fix/large-font-headers fix/dialog-button-overlap; do
  git merge --no-ff $b || break   # resolve, document, continue
done
# plus fix/player-open-journal and fix/renderpage-removeattribute IF those branches exist.
```

Expected conflict hotspots (resolve keeping BOTH features, document each in `notes-integration-conflicts.md`): `monks-enhanced-journal.js` (open-gate wrapper + `altOpensOutside` vs maintainer edits vs restrict-guard), `sheets/EnhancedJournalSheet.js` (TableResult fix vs round-2 currency/deep-search work), `css/*` (dark-mode palette vs maintainer CSS vs the two cosmetic fixes — at integration, ALSO verify the Task-9/11 fixes hold in dark mode since `enh/dark-mode` is now present).

- [ ] **Step 2: Syntax-check + boot smoke**

```bash
for f in $(git diff enhancements-test..HEAD --name-only | grep '\.js$'); do node --check "$f"; done
git checkout integration-14.07   # main repo checkout = what Foundry serves
cd .claude/worktrees/playwright-harness/test && node run.mjs connect
```

- [ ] **Step 3: Commit state note** — append the merge order + conflict rulings summary to the notes file. (No push yet; Task 14 pushes.)

### Task 13: Full suite ×2 + fix round

**Files:**
- Modify: whatever the failures demand — integration-specific fixes commit on `integration-14.07`; feature-owned defects commit on the owning branch, then re-merge into `integration-14.07`

- [ ] **Step 1: Run the complete suite twice**

```bash
cd .claude/worktrees/playwright-harness/test
node run.mjs 2>&1 | tee /tmp/suite-run1.log
node run.mjs 2>&1 | tee /tmp/suite-run2.log
```

Suite = 15 existing specs + `maintainer-features.mjs` + `discord-fixes.mjs`. Gate: both runs fully green AND zero MEJ console errors (the helpers' `assertNoErrors` plus a scan of the logs for `monks-enhanced-journal` in error lines).

- [ ] **Step 2: Fix loop**

Per failure: classify (integration-conflict artifact → fix on `integration-14.07`; latent bug in one branch → fix on that branch, re-merge; test-infra flake → fix spec on `playwright-harness`). Re-run the affected spec, then repeat Step 1 from scratch. STOP condition (spec): the same failure survives two fix rounds → halt and report to Dan.

- [ ] **Step 3: Commit all fixes with per-failure messages; re-run full ×2 green.**

### Task 14: Build, release 14.07-test, outcomes doc

**Files:**
- Create: GitHub release `14.07-test` on `bularzik/monks-enhanced-journal` (assets: `module.json`, `module.zip`), annotated tag `14.07-test`
- Create: `docs/superpowers/triage/2026-08-15-maintainer-sync-and-fixes-outcomes.md` (committed on `enhancements-test`)
- Push: `integration-14.07`, fix branches, `playwright-harness`, tag

- [ ] **Step 1: Mirror the previous release's manifest pattern**

```bash
cd /tmp && gh release download 14.06-test -p module.json --repo bularzik/monks-enhanced-journal -O module-14.06.json
cat module-14.06.json | grep -E '"version"|"manifest"|"download"'
```

Build the 14.07 asset `module.json`: copy the tree's `module.json` from `integration-14.07`, set the same three fields following the 14.06 pattern with `14.07-test` values (version `14.07`-style string exactly as 14.06 did it; manifest `https://github.com/bularzik/monks-enhanced-journal/releases/download/14.07-test/module.json`; download `.../14.07-test/module.zip`).

- [ ] **Step 2: Build module.zip from the branch tip**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal && git checkout integration-14.07
mkdir -p /tmp/mej-build && rm -rf /tmp/mej-build/*
git archive integration-14.07 | tar -x -C /tmp/mej-build
rm -rf /tmp/mej-build/docs /tmp/mej-build/test
cp /tmp/module-14.07.json /tmp/mej-build/module.json     # the patched manifest built in Step 1
cd /tmp/mej-build && zip -qr /tmp/module.zip . && cp module.json /tmp/module.json
unzip -l /tmp/module.zip | grep -c packs   # packs ARE shipped in releases (match 14.06 zip contents: verify against the 14.06 module.zip file list before deciding to include/exclude)
```

- [ ] **Step 3: Tag (annotated, per release rules) and push everything**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
git tag -a 14.07-test -m "14.07-test: maintainer 14.00 sync + Discord fix round + rounds 1-2 enhancements" integration-14.07
git push origin integration-14.07 playwright-harness 14.07-test \
  fix/encounter-controlicon fix/tableresult-deprecation fix/encounter-placement-scene \
  fix/large-font-headers fix/dialog-button-overlap
# plus fix/player-open-journal / fix/renderpage-removeattribute if they exist. NOT backlog-fixes. NO PRs.
```

- [ ] **Step 4: Create the release + smoke it**

```bash
gh release create 14.07-test /tmp/module.json /tmp/module.zip --repo bularzik/monks-enhanced-journal \
  --prerelease --title "14.07-test" --notes "Maintainer 14.00 sync + 7 Discord-reported fixes + enhancement rounds 1-2. Test build - not for production worlds."
cd .claude/worktrees/playwright-harness/test && node release-smoke.mjs   # against the live 14.07-test manifest; see its header for usage
```

Release-smoke must PASS (fresh manifest install, page types + ShopSheet registered). If it fails: per release rules, NO in-place asset repair if the source branch backs an open PR — `integration-14.07` backs no PR, but still prefer fixing forward with a fresh cut (14.07b-test) if assets were already downloaded by anyone.

- [ ] **Step 5: Outcomes doc**

Write `docs/superpowers/triage/2026-08-15-maintainer-sync-and-fixes-outcomes.md` following the structure of `2026-08-10-enhancement-round-2-outcomes.md`: per-phase results table (sync branch, drops/re-raise pointer, per-issue verdicts with branch HEADs), integration conflict rulings, suite results, release link + install URL, logged-not-fixed follow-ups, open decisions (raise-the-PRs-when-ready list now including the fix branches and the re-raise list). Commit on `enhancements-test`, push `enhancements-test`.

---

## Self-review notes

- Spec coverage: Phase A → Tasks 1–3; Phase B → Task 4; Phase C 7 issues → Tasks 5–11 (branch-only-if-warranted honored in 8/10); Phase D → Tasks 12–14; stop conditions embedded in Tasks 8, 13, 14; release rules in Task 14. Deliberate-revert flagging in Task 2/3.
- Investigation-shaped steps (Tasks 8/10/11 fix shapes, Task 4 cluster list) intentionally specify decision procedure + acceptance envelope instead of verbatim code — the inputs don't exist until Task 3's report/triage. Everything mechanical carries exact commands/code.
- Type/name consistency: branch names, spec file names (`maintainer-features.mjs`, `discord-fixes.mjs`), notes paths, and SHAs are used identically across tasks.
