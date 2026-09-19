# Upstream PR batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open six small, individually verified pull requests against upstream `ironmonk108/monks-enhanced-journal` main (14.01), each porting one fix that 14.01 lacks.

**Architecture:** Every PR is a branch `up/<slug>` off `upstream/main` (`9d66fb9`, tag `14.01`). The local Foundry install's module directory becomes a git worktree of this repo, so "stock 14.01" is `git checkout --detach 14.01` and "PR under test" is `git checkout up/<slug>` — no symlink swapping. Each fix gets a throwaway harness script under `test/scratch/` that FAILS on stock 14.01 and PASSES on the branch; the PR body quotes both runs. Tasks are sequential (one Foundry instance, one module worktree).

**Tech Stack:** Foundry VTT 14.368 (`~/FoundryVTT-14`), World A (`world-a`, dnd5e 6.0.3), the Playwright harness on branch `playwright-harness` (`test/`), `gh` CLI, git worktrees.

**Spec:** `docs/superpowers/specs/2026-09-18-upstream-14.01-realignment-design.md` (Stream A, batch 1).

## Global Constraints

- Base every PR branch on `upstream/main` at `9d66fb970c428dd9198d5920a20b042233ad0661`; never on any fork branch.
- One issue or subsystem per PR; no `CHANGELOG.md` or `module.json` edits; no unrelated cleanups.
- Keep `Co-authored-by` trailers on ports of other people's work (none in batch 1 — all six are our own or new).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01KNDA8HjNgkLBVHYQ9tGWCL`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)` and the session link.
- Stay out of: DSA5 currency sites, the "Allow GM" setting, `onAcceptOffer`'s `currencyId(k)` (coffiarts owns these on #797), and the encounter control icon (maintainer ruling: intentionally blank).
- Harness rules: test entities are named `TT-…` and are auto-swept; never touch hand-made entries; headless only; check `curl -s localhost:30000/api/status` shows `"users":0` before a run; never run two harness processes at once; run suites with `--trace off` if Playwright tracing is enabled anywhere (disk has ~3 GB free).
- The Foundry data path is `~/FoundryVTT-14/Data`, packages live in `~/FoundryVTT-14/Data/Data/modules/`, the server runs on http://localhost:30000 (pid in `~/FoundryVTT-14/Data/.pid`, log in `~/FoundryVTT-14/Data/Logs/stdout.log`). Restart = `kill $(cat ~/FoundryVTT-14/Data/.pid)`, then from `~/FoundryVTT-14/FoundryVTT-Node-14.368` run `node main.js --dataPath=$HOME/FoundryVTT-14/Data --world=world-a --port=30000 >> $HOME/FoundryVTT-14/Data/Logs/stdout.log 2>&1 &` and write the pid to `Data/.pid`.
- Foundry only rescans packages at launch; the checkout switches below change only JS/CSS/templates under an unchanged `module.json`, so no restart is needed between branch switches. Harness specs launch a fresh headless browser per spec, so there is no stale-cache risk.

---

### Task 0: Harness worktree and module worktree

**Files:**
- Create (git worktree): `.claude/worktrees/playwright-harness` on branch `playwright-harness`
- Create (git worktree): `~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal` detached at tag `14.01`
- Move: the stock install dir `~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal` → `~/FoundryVTT-14/backups/mej-stock-14.01`

**Interfaces:**
- Produces: `MODULE=$HOME/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal` (a worktree; later tasks run `git -C $MODULE checkout …` there), `HARNESS=/Users/danbularzik/Claude/Projects/monks-enhanced-journal/.claude/worktrees/playwright-harness/test` (later tasks run `node scratch/<name>.mjs` from there).

- [ ] **Step 1: Add the harness worktree and install its dependencies**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
git worktree add .claude/worktrees/playwright-harness playwright-harness
cd .claude/worktrees/playwright-harness/test
npm install
npx playwright install chromium
mkdir -p scratch
```

Expected: worktree created; `npm install` completes; `ls scratch` exists (gitignored per `test/README.md`).

- [ ] **Step 2: Confirm the running install is byte-identical to the 14.01 tag, then move it aside**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
rm -rf /Users/danbularzik/.claude/jobs/7f6f9d70/tmp/tagcheck && mkdir -p /Users/danbularzik/.claude/jobs/7f6f9d70/tmp/tagcheck
git archive 14.01 | tar -x -C /Users/danbularzik/.claude/jobs/7f6f9d70/tmp/tagcheck
diff -rq /Users/danbularzik/.claude/jobs/7f6f9d70/tmp/tagcheck ~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal -x packs -x .DS_Store
```

Expected: no output (identical apart from `packs/` LevelDB bookkeeping). If any file differs, STOP and report — the install is not stock.

```bash
mkdir -p ~/FoundryVTT-14/backups
mv ~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal ~/FoundryVTT-14/backups/mej-stock-14.01
```

Expected: `ls ~/FoundryVTT-14/Data/Data/modules/` no longer lists `monks-enhanced-journal`.

- [ ] **Step 3: Create the module worktree at the install path, detached at the 14.01 tag**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
git worktree add --detach ~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal 14.01
git -C ~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal log -1 --oneline
```

Expected: `9d66fb9 14.01 changes`.

- [ ] **Step 4: Guard the pack-churn files in the new worktree so LevelDB bookkeeping never shows as modified**

```bash
M=~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal
cd $M && git ls-files packs | grep -E 'packs/(person-names|shop-names)/(LOG|LOG\.old|CURRENT|MANIFEST-|[0-9]+\.log|[0-9]+\.ldb)' | xargs git update-index --skip-worktree
git -C $M status --short | head
```

Expected: empty status (or only untracked pack files, which are fine).

- [ ] **Step 5: Restart Foundry on world-a and run the harness gating spec against stock 14.01**

```bash
kill $(cat ~/FoundryVTT-14/Data/.pid); sleep 3
cd ~/FoundryVTT-14/FoundryVTT-Node-14.368 && (node main.js --dataPath=$HOME/FoundryVTT-14/Data --world=world-a --port=30000 >> $HOME/FoundryVTT-14/Data/Logs/stdout.log 2>&1 & echo $! > $HOME/FoundryVTT-14/Data/.pid)
sleep 10; curl -s localhost:30000/api/status
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal/.claude/worktrees/playwright-harness/test && node run.mjs connect
```

Expected: `api/status` shows `"active":true,"world":"world-a","users":0`; `connect` spec passes (it only logs in and opens the shell). If it fails because World A shows a migration prompt, the world was already migrated on 2026-09-18 — report the actual error instead.

- [ ] **Step 6: Record the setup in the plan's progress notes (no commit; nothing tracked changed)**

Write `.superpowers/sdd/2026-09-18-upstream-pr-batch-1/progress.md` with the two worktree paths and the backup path.

---

### Task 1: `up/large-font-headers` — headers grow with large font scale

**Files:**
- Modify (in `$MODULE`): `css/monks-enhanced-journal.css:1723-1735` (customise-page/transfer/distribute/adjust/edit-currency/list-item-edit headers), `css/monks-journal-sheet.css:801-812` (sheet `.items-list header` etc.), `css/monks-journal-sheet.css:1717-1722` (loot `.loot-characters header`)
- Create: `$HARNESS/scratch/large-font-headers.mjs`

**Interfaces:**
- Consumes: Task 0 paths.
- Produces: PR branch `up/large-font-headers` pushed to `origin`, PR on upstream.

- [ ] **Step 1: Write the failing scratch check**

`$HARNESS/scratch/large-font-headers.mjs`:

```js
import assert from 'node:assert/strict';
import { withSession, createEntry, openEntry } from '../helpers/mej.js';

// Discord "Relationship Header & Large Font Size": at large core font scale the
// fixed-height list headers clip their text. Clipped == scrollHeight > clientHeight.
await withSession('large-font-headers', { users: ['Gamemaster'] }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  const orig = await gm.evaluate(() => foundry.utils.duplicate(game.settings.get('core', 'uiConfig')));
  try {
    await gm.evaluate(async (orig) => {
      const c = foundry.utils.duplicate(orig); c.fontScale = 10;
      await game.settings.set('core', 'uiConfig', c);
    }, orig);
    const clipped = [];
    for (const type of ['person', 'loot']) {
      const id = await createEntry(gm, type, `TT-largefont-${type}`);
      await openEntry(gm, id);
      await gm.waitForTimeout(800);
      const found = await gm.evaluate(() => {
        const sel = '.monks-enhanced-journal .items-list header, .monks-enhanced-journal .loot-characters header, .monks-enhanced-journal .currency-group header';
        return [...document.querySelectorAll(sel)].map(h => ({ text: h.textContent.trim().slice(0, 30), sh: h.scrollHeight, ch: h.clientHeight, css: getComputedStyle(h).height }));
      });
      assert.ok(found.length > 0, `no list headers rendered for ${type}`);
      for (const h of found) if (h.sh > h.ch) clipped.push({ type, ...h });
    }
    assert.deepEqual(clipped, [], `headers clipped at fontScale 10: ${JSON.stringify(clipped)}`);
  } finally {
    await gm.evaluate(async (orig) => { await game.settings.set('core', 'uiConfig', orig); }, orig);
  }
});
console.log('large-font-headers: OK');
```

- [ ] **Step 2: Run it against stock 14.01 — expect FAIL**

```bash
git -C $MODULE checkout --detach 14.01
cd $HARNESS && node scratch/large-font-headers.mjs
```

Expected: `AssertionError … headers clipped at fontScale 10: [{"type":"person",…}]`. Save the output to the progress notes (it goes in the PR body).

- [ ] **Step 3: Create the branch and apply the three CSS changes**

```bash
git -C $MODULE checkout -b up/large-font-headers 14.01
```

In `$MODULE/css/monks-enhanced-journal.css`, the rule starting at line 1723:

```css
.customise-page.sheet .sheet-content .items-list header,
.transfer-currency .transfer-container .items-list header,
.distribute-currency .items-list header,
.adjust-price .items-list header,
.edit-currency .items-list header,
#list-item-edit .items-list header {
    height: auto;
    min-height: 30px;
```

(replace the single `height: 30px;` line; keep every other declaration in the rule).

In `$MODULE/css/monks-journal-sheet.css`, the rule at line 801 (`.monks-journal-sheet .items-list header, .monks-journal-sheet .currency-group header, .monks-journal-sheet .slideshow-container .slide-details header`): change `height: 30px;` (line 808) to `height: auto;` and keep the existing `min-height: 30px;` on the next line.

In `$MODULE/css/monks-journal-sheet.css`, the rule at line 1717 (`.monks-journal-sheet.sheet .loot-container .loot-characters header`): replace

```css
    height: 30px;
    line-height: 30px;
```

with

```css
    height: auto;
    min-height: 30px;
```

Verify: `git -C $MODULE diff --stat` shows exactly 2 files, ~5 insertions / ~4 deletions.

- [ ] **Step 4: Run the scratch check on the branch — expect PASS**

```bash
cd $HARNESS && node scratch/large-font-headers.mjs
```

Expected: `large-font-headers: OK`. Then confirm nothing regressed at normal scale: `node run.mjs smoke-sheets` passes.

- [ ] **Step 5: Commit and push**

```bash
cd $MODULE && git add css/monks-enhanced-journal.css css/monks-journal-sheet.css
git commit -m "Let list headers grow at large font scales instead of clipping

At core fontScale above the default, the fixed height:30px on the item-list
headers (relationships, customise page columns, loot characters) clipped the
bottom of the text. Use height:auto with min-height:30px so the row grows
with its content; normal scales render identically.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KNDA8HjNgkLBVHYQ9tGWCL"
git push -u origin up/large-font-headers
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --repo ironmonk108/monks-enhanced-journal --base main --head bularzik:up/large-font-headers \
  --title "Let list headers grow at large font scales instead of clipping" \
  --body-file /Users/danbularzik/.claude/jobs/7f6f9d70/tmp/pr-large-font.md
```

`pr-large-font.md`:

```markdown
**Symptom** (Discord `testing-enhanced-journal-v14` → "Relationship Header & Large Font Size"): at large core font scale the relationship-list header and the Customise Page column headers clip the bottom of their text.

**Cause**: `css/monks-enhanced-journal.css:1729` and `css/monks-journal-sheet.css:808,1718` fix the header rows at `height: 30px` (the loot-characters header also pins `line-height: 30px`), so text taller than 30px is cut.

**Fix**: `height: auto` + `min-height: 30px` on those three rules. `align-items: center` (already present) keeps the default scale pixel-identical.

**Verified** on Foundry 14.368 / dnd5e 6.0.3, GM client, `uiConfig.fontScale = 10`: on 14.01 the Person relationships header and the Loot characters header report `scrollHeight > clientHeight` (clipped); with this change none do, and `smoke-sheets` at default scale is unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01KNDA8HjNgkLBVHYQ9tGWCL
```

Expected: PR URL printed. Record it in the progress notes.

---

### Task 2: `up/tabs-active-before-dedupe` — the shell fails to open when the saved active tab is a duplicate

**Files:**
- Modify (in `$MODULE`): `apps/enhanced-journal.js:1101-1124` (`removeDuplicateTabs`)
- Create: `$HARNESS/scratch/dup-tab-open.mjs`

**Interfaces:**
- Produces: PR branch `up/tabs-active-before-dedupe`.

- [ ] **Step 1: Write the failing scratch check**

`$HARNESS/scratch/dup-tab-open.mjs`:

```js
import assert from 'node:assert/strict';
import { withSession, createEntry } from '../helpers/mej.js';

// 14.01 _preFirstRender calls removeDuplicateTabs() before it defines
// this.tabs.active; when the dropped duplicate was the active tab the dedupe
// calls this.tabs.active(true) and throws, so the journal never opens.
await withSession('dup-tab-open', { users: ['Gamemaster'] }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  const id = await createEntry(gm, 'person', 'TT-duptab');
  const orig = await gm.evaluate(() => foundry.utils.duplicate(game.user.getFlag('monks-enhanced-journal', 'tabs') || null));
  try {
    const result = await gm.evaluate(async (id) => {
      const entry = game.journal.get(id);
      try { await game.MonksEnhancedJournal.journal?.close(); } catch (e) {}
      await game.user.setFlag('monks-enhanced-journal', 'tabs', [
        { id: 'ttdup1', entityId: entry.uuid, text: entry.name, active: false, history: [] },
        { id: 'ttdup2', entityId: entry.uuid, text: entry.name, active: true, history: [] },
      ]);
      try {
        await game.MonksEnhancedJournal.openJournalEntry(entry);
        await new Promise(r => setTimeout(r, 2500));
        const app = game.MonksEnhancedJournal.journal;
        return { rendered: !!app?.rendered, tabs: app?.tabs?.map(t => [t.id, t.active]) };
      } catch (e) { return { thrown: String(e) }; }
    }, id);
    assert.equal(result.thrown, undefined, `opening the journal threw: ${result.thrown}`);
    assert.equal(result.rendered, true, 'journal did not render');
    assert.equal(result.tabs.length, 1, `duplicate not removed: ${JSON.stringify(result.tabs)}`);
    assert.equal(result.tabs[0][1], true, 'surviving tab is not active');
  } finally {
    await gm.evaluate(async (orig) => {
      try { await game.MonksEnhancedJournal.journal?.close(); } catch (e) {}
      if (orig) await game.user.setFlag('monks-enhanced-journal', 'tabs', orig); else await game.user.unsetFlag('monks-enhanced-journal', 'tabs');
    }, orig);
  }
});
console.log('dup-tab-open: OK');
```

- [ ] **Step 2: Run against stock — expect FAIL**

```bash
git -C $MODULE checkout --detach 14.01
cd $HARNESS && node scratch/dup-tab-open.mjs
```

Expected: `opening the journal threw: TypeError: this.tabs.active is not a function`.

- [ ] **Step 3: Branch and fix `removeDuplicateTabs` so it does not depend on `tabs.active`**

```bash
git -C $MODULE checkout -b up/tabs-active-before-dedupe 14.01
```

In `$MODULE/apps/enhanced-journal.js`, inside `removeDuplicateTabs()` replace

```js
            if (tabs.find(t => t.active) == undefined) {
                let activeEntityId = this.tabs.active(true)?.entityId;
```

with

```js
            if (tabs.find(t => t.active) == undefined) {
                // this.tabs.active() is not defined yet when _preFirstRender calls us
                let activeEntityId = (this.tabs.find(t => t.active) ?? this.tabs[0])?.entityId;
```

- [ ] **Step 4: Run the scratch check — expect PASS**

```bash
cd $HARNESS && node scratch/dup-tab-open.mjs && node run.mjs connect
```

Expected: `dup-tab-open: OK`; `connect` passes.

- [ ] **Step 5: Commit, push, open the PR**

Commit message: `Fix journal failing to open when the saved active tab is a duplicate` with body: "`removeDuplicateTabs()` runs from `_preFirstRender` before `this.tabs.active` is assigned. When the duplicate being dropped was the active tab it called `this.tabs.active(true)` and threw `TypeError: this.tabs.active is not a function`, so the Enhanced Journal never rendered. Find the active tab inline instead." + the two trailers. Push `up/tabs-active-before-dedupe`, then `gh pr create` with title `Fix journal failing to open when the saved active tab is a duplicate` and a body in the same Symptom / Cause / Fix / Verified shape as Task 1 (verified line: "saved tabs = two entries for the same entry with the second active → 14.01 rejects with the TypeError above and the window never opens; with this change it opens with one active tab").

---

### Task 3: `up/close-hooks-page-id` — per-page close hooks never fire on page switch

**Files:**
- Modify (in `$MODULE`): `sheets/JournalEntrySheet.js:1048-1050` (`callCloseHooks`)
- Create: `$HARNESS/scratch/close-hooks-page-id.mjs`

- [ ] **Step 1: Write the failing scratch check**

```js
import assert from 'node:assert/strict';
import { withSession } from '../helpers/mej.js';

// callCloseHooks(pageId) looks up this._pages["test"] (a debug leftover), so with
// a page id it processes zero pages; without an id it processes all of them.
await withSession('close-hooks-page-id', { users: ['Gamemaster'] }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  const r = await gm.evaluate(async () => {
    const je = await JournalEntry.create({ name: 'TT-closehooks', pages: [
      { name: 'P1', type: 'text', text: { content: '<p>one</p>' } },
      { name: 'P2', type: 'text', text: { content: '<p>two</p>' } },
    ] });
    await game.MonksEnhancedJournal.openJournalEntry(je);
    await new Promise(r => setTimeout(r, 2500));
    const sub = game.MonksEnhancedJournal.journal.subsheet;
    const ids = Object.keys(sub._pages);
    let calls = []; const orig = sub.getPageSheet.bind(sub);
    sub.getPageSheet = id => { calls.push(id); return orig(id); };
    sub.callCloseHooks(ids[0]); const withId = calls.slice(); calls = [];
    sub.callCloseHooks(); const noId = calls.slice();
    sub.getPageSheet = orig;
    await game.MonksEnhancedJournal.journal.close();
    return { ids, withId, noId };
  });
  assert.deepEqual(r.noId, r.ids, 'no-id path should visit every page');
  assert.deepEqual(r.withId, [r.ids[0]], `page-id path visited ${JSON.stringify(r.withId)} instead of the requested page`);
});
console.log('close-hooks-page-id: OK');
```

- [ ] **Step 2: Run against stock — expect FAIL** (`page-id path visited [] instead of the requested page`).

- [ ] **Step 3: Branch and fix**

```bash
git -C $MODULE checkout -b up/close-hooks-page-id 14.01
```

In `$MODULE/sheets/JournalEntrySheet.js` replace

```js
        const pages = pageId ? [this._pages["test"]].filter(p => !!p) : Object.values(this._pages);
```

with

```js
        const pages = pageId ? (pageId in this._pages ? [this._pages[pageId]] : []) : Object.values(this._pages);
```

(this is core v14 `journal-entry-sheet.mjs`'s own form).

- [ ] **Step 4: Run the scratch check — expect PASS**; then `node run.mjs smoke-sheets` passes.

- [ ] **Step 5: Commit, push, open the PR** — title `Fix callCloseHooks looking up a hard-coded page id`; body Symptom: "closeView hooks for the page being left never fire when switching pages inside the Enhanced Journal" / Cause: `sheets/JournalEntrySheet.js:1050` indexes `this._pages["test"]` / Fix: index by `pageId` as core does / Verified: TT 2-page journal, spy on `getPageSheet`: 14.01 visits 0 pages with an id and both without; patched visits exactly the requested page.

---

### Task 4: `up/imagepopout-render` — limited-permission open throws

**Files:**
- Modify (in `$MODULE`): `monks-enhanced-journal.js:2431`
- Create: `$HARNESS/scratch/limited-image-popout.mjs`

- [ ] **Step 1: Write the failing scratch check**

```js
import assert from 'node:assert/strict';
import { withSession, createEntry } from '../helpers/mej.js';

// A LIMITED-permission user opening an entry with an image goes through
// `new ImagePopout(...)._render(true)` — ApplicationV2 has no _render.
await withSession('limited-image-popout', { users: ['Gamemaster', 'User 1'] }, async ({ pages }) => {
  const gm = pages['Gamemaster']; const player = pages['User 1'];
  const id = await createEntry(gm, 'person', 'TT-limited-img');
  await gm.evaluate(async (id) => {
    const je = game.journal.get(id);
    await je.update({ ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED } });
    await je.pages.contents[0].update({ src: 'icons/svg/mystery-man.svg' });
  }, id);
  await player.waitForTimeout(1000);
  const r = await player.evaluate(async (id) => {
    const je = game.journal.get(id);
    try {
      const ok = await game.MonksEnhancedJournal.openJournalEntry(je);
      await new Promise(r => setTimeout(r, 1500));
      const popout = Object.values(foundry.applications.instances ? Object.fromEntries(foundry.applications.instances) : {}).find(a => a.constructor.name === 'ImagePopout');
      return { ok, popoutRendered: !!popout?.rendered, level: je.getUserLevel(game.user) };
    } catch (e) { return { thrown: String(e) }; }
  }, id);
  assert.equal(r.thrown, undefined, `openJournalEntry threw for a LIMITED user: ${r.thrown}`);
  assert.equal(r.popoutRendered, true, `no ImagePopout rendered (${JSON.stringify(r)})`);
});
console.log('limited-image-popout: OK');
```

If `foundry.applications.instances` is not a Map in this build, fall back to `document.querySelector('.image-popout')` for `popoutRendered`.

- [ ] **Step 2: Run against stock — expect FAIL** with `TypeError: img._render is not a function` in `thrown`.

- [ ] **Step 3: Branch and fix**

```bash
git -C $MODULE checkout -b up/imagepopout-render 14.01
```

In `$MODULE/monks-enhanced-journal.js` line 2431 replace `img._render(true);` with `img.render({ force: true });`.

- [ ] **Step 4: Run the scratch check — expect PASS.**

- [ ] **Step 5: Commit, push, open the PR** — title `Fix limited-permission open of an image entry throwing`; Cause: `monks-enhanced-journal.js:2431` calls `_render(true)` on an ApplicationV2 `ImagePopout` (no such method since v13; the other two popout sites in the file already use `render`); Verified: User 1 with LIMITED ownership opening a Person with an image: 14.01 rejects with the TypeError and shows nothing; patched shows the image popout.

---

### Task 5: `up/tab-activation-queue` — overlapping tab activations are dropped instead of queued

**Files:**
- Modify (in `$MODULE`): `apps/enhanced-journal.js` — field block near line 46 (add `_activateTabQueue`), `_onRender` (~385-410), `deleteEntity` (~908), `addTab` refresh branch (~925), `activateTab`/`updateTab`/`removeTab` (948-1098), `open()` (1295-1315)
- Create: `$HARNESS/scratch/tab-queue.mjs`

**Interfaces:**
- Produces: `queueTabChange(fn)`, `activateTab(tab, event, options)` (queued wrapper) + `_activateTab(...)` (body), `updateTab(...)` (queued wrapper) + `_updateTab(...)` (body), `removeTab(tab, event, options = {})` with `options.inline`.

- [ ] **Step 1: Write the failing scratch check**

```js
import assert from 'node:assert/strict';
import { withSession, createEntry } from '../helpers/mej.js';

// Two "open in new tab" requests back to back: 14.01's 1-second _activatingTab
// debounce silently drops the second activation (its tab is added but never
// activated), so the shell ends on the FIRST entry. A queue runs both in order.
await withSession('tab-queue', { users: ['Gamemaster'] }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  const a = await createEntry(gm, 'person', 'TT-queue-A');
  const b = await createEntry(gm, 'person', 'TT-queue-B');
  const r = await gm.evaluate(async ({ a, b }) => {
    const A = game.journal.get(a), B = game.journal.get(b);
    await game.MonksEnhancedJournal.openJournalEntry(A);
    await new Promise(r => setTimeout(r, 2000));
    const app = game.MonksEnhancedJournal.journal;
    const p1 = app.open(A, true); const p2 = app.open(B, true);
    await Promise.all([p1, p2]);
    await new Promise(r => setTimeout(r, 3000));
    const active = app.tabs.find(t => t.active);
    const out = { activeEntity: active?.entityId, shown: app.subsheet?.document?.uuid, tabsForB: app.tabs.filter(t => t.entityId === B.uuid).length, bUuid: B.uuid };
    await app.close();
    return out;
  }, { a, b });
  assert.equal(r.activeEntity, r.bUuid, `last-requested entry is not the active tab: ${JSON.stringify(r)}`);
  assert.equal(r.shown, r.bUuid, `shell shows a different document than the active tab: ${JSON.stringify(r)}`);
});
console.log('tab-queue: OK');
```

- [ ] **Step 2: Run against stock — expect FAIL** (`activeEntity` is A's uuid, or `shown` ≠ active).

- [ ] **Step 3: Branch and port the queue**

```bash
git -C $MODULE checkout -b up/tab-activation-queue 14.01
```

Edits in `$MODULE/apps/enhanced-journal.js`:

(a) Field declaration — after `subsheetState = {};` (line ~48) add:

```js
    _activateTabQueue = Promise.resolve();
```

(b) `_onRender` — delete the `this.renderSubSheet(options);` call inside `if (this.element) { … }` (~line 398) and, immediately before `return result;` at the end of `_onRender`, add:

```js
        // Awaited (_onRender is awaited by render(), under its render semaphore) so that render() doesn't
        // resolve until the subsheet content, this.document and the active tab's entity have been committed.
        // Otherwise the next queued tab change starts while this one is still assigning content.
        if (this.element)
            await this.renderSubSheet(options);
```

(c) `deleteEntity` — replace `this.render(true);  //if this entity was being shown…` with `this.queueTabChange(() => this.render(true));  //if this entity was being shown on the active tab, then refresh the journal`.

(d) `addTab` — in the `else { this.saveTabs(); if (options.refresh) this.render(true, { focus: true }); }` branch replace the render with `this.queueTabChange(() => this.render(true, { focus: true }));`.

(e) Replace the whole `async activateTab(tab, event, options) { … }` method with:

```js
    // Rapidly activating/opening/updating tabs (e.g. duplicate-named entries opened in quick succession) can
    // otherwise interleave the tab bodies below, corrupting which tab ends up marked active and which
    // document's content gets rendered. Queue tab changes so only one runs at a time.
    // Only external entry points may queue; anything called from inside a queued body has to run inline
    // (see the inline option on removeTab), otherwise it would finish after the body that asked for it.
    queueTabChange(fn) {
        this._activateTabQueue = this._activateTabQueue.then(fn, fn);
        this._activateTabQueue.catch(() => { }); //observe failures, the next queued change might never come
        return this._activateTabQueue;
    }

    activateTab(tab, event, options) {
        return this.queueTabChange(() => this._activateTab(tab, event, options));
    }

    async _activateTab(tab, event, options) {
        this.saveScrollPos();

        if (await this?.subsheet?.close() === false)
            return false;

        if (tab == undefined)
            tab = await this.addTab(null, { activate: false, refresh: false });   //we're activating it ourselves below

        if (event != undefined)
            event.preventDefault();

        if (tab.currentTarget != undefined) {
            tab.preventDefault();
            tab = tab.currentTarget.dataset.tabid;
        }
        if (typeof tab == 'string')
            tab = this.tabs.find(t => t.id == tab);
        else if (typeof tab == 'number')
            tab = this.tabs[tab];

        if (event?.altKey) {
            // Open this outside of the Enhnaced Journal
            let document = await this.findEntity(tab?.entityId, tab?.text);
            if (document) {
                MonksEnhancedJournal.fixType(document);
                document.sheet.render(true);
            }
        } else if (event?.shiftKey) {
            // Close this tab, waiting for it to pick the tab that takes its place, otherwise that
            // activation would land after this one
            await this.removeTab(tab, event, { inline: true });
            tab = this.tabs.active(false);
            if (!tab) {
                if (this.tabs.length)
                    tab = this.tabs[0];
                else
                    tab = await this.addTab(null, { activate: false, refresh: false });
            }
        }

        let currentTab = this.tabs.active(false);
        if (currentTab?.id != tab.id || this.subsheetElement == undefined || $(this.subsheetElement).is(":empty")) {
            tab.entity = await this.findEntity(tab.entityId, tab.text);
        }

        if (currentTab != undefined)
            currentTab.active = false;
        tab.active = true;

        if (this._tabs)
            this._tabs.active = null;

        this.saveTabs();

        if (this.rendered)
            await this.render(true, options);
        else {
            window.setTimeout(() => {
                $(`.journal-tab[data-tabid="${tab.id}"]`, this.element).addClass("active").siblings().removeClass("active");
            }, 100);
        }

        this.updateRecent(tab.entity);

        return true;
    }
```

(this is 14.01's body with the three `_activatingTab` lines removed and the two `addTab()` calls given `{ activate: false, refresh: false }`; check that 14.01's `addTab` accepts that options shape — it does: `addTab(entity, options = { activate: true, refresh: true })`).

(f) Rename `async updateTab(tab, entity, options = {})` to `async _updateTab(tab, entity, options = {})`, make its final render `await this.render(true, foundry.utils.mergeObject({ focus: true }, options));`, and add above it:

```js
    updateTab(tab, entity, options = {}) {
        return this.queueTabChange(() => this._updateTab(tab, entity, options));
    }
```

(g) Replace `async removeTab(tab, event)` with:

```js
    async removeTab(tab, event, options = {}) {
        if (event != undefined)
            event.preventDefault();

        if (typeof tab == 'string')
            tab = this.tabs.find(t => t.id == tab);

        let idx = this.tabs.findIndex(t => t.id == tab.id);
        if (idx >= 0) {
            this.tabs.splice(idx, 1);
            $('.journal-tab[data-tabid="' + tab.id + '"]', this.element).remove();
        }

        // when called from inside a queued tab change the replacement tab has to be activated inline,
        // queueing it would run it after the body that removed this tab
        const activate = (t) => options.inline ? this._activateTab(t) : this.activateTab(t);

        if (this.tabs.length == 0) {
            await activate(await this.addTab(null, { activate: false, refresh: false }));
        } else {
            if (tab.active) {
                let nextIdx = (idx >= this.tabs.length ? idx - 1 : idx);
                if (!(await activate(nextIdx)))
                    this.saveTabs();
            }
        }
    }
```

(h) `open()` — both `await this.addTab(entity);` calls become `await this.addTab(entity, Object.assign({ activate: true, refresh: true }, options));` so `pageId`/`anchor` reach the new tab.

(i) Grep for any other caller of `_activatingTab`: `grep -n _activatingTab apps/enhanced-journal.js` must print nothing.

- [ ] **Step 4: Run the scratch check — expect PASS**; then `node run.mjs connect && node run.mjs smoke-sheets` pass (they open and switch tabs).

- [ ] **Step 5: Commit, push, open the PR** — title `Queue tab activations instead of dropping overlapping ones (#742)`; body: Symptom (tracker #742 and Discord "Sidebar click opens the previous tab instead of the clicked entry"): opening a second entry while the first is still activating leaves the second un-activated or renders one tab's label over another's content / Cause: `activateTab` returns `false` for any call within 1 s of another (`_activatingTab`), and `_onRender` does not await `renderSubSheet`, so the guard is even released before content is committed / Fix: serialize every tab change through one promise chain (`queueTabChange`), await `renderSubSheet` under the render semaphore, run nested activations inline, forward open options into new tabs / Verified: two back-to-back `open(entry, true)` calls: 14.01 ends on the first entry with the second tab inert; patched ends on the second with both tabs present; `connect` and `smoke-sheets` unchanged. Note in the body that a canvas-on manual check of the Discord scenario is welcome.

---

### Task 6: `up/modifier-clicks` — Cmd-click new tab on macOS, Alt-click on map notes

**Files:**
- Modify (in `$MODULE`): `monks-enhanced-journal.js:689,718,736,758` (newtab sites), `:1208` (clickNote2), `:1241` (no-libWrapper fallback)
- Create: `$HARNESS/scratch/modifier-clicks.mjs`

- [ ] **Step 1: Write the failing scratch check (Cmd-click part; Alt-click on notes needs a canvas and is verified by hand)**

```js
import assert from 'node:assert/strict';
import { withSession, createEntry } from '../helpers/mej.js';

// #95/#85: Cmd-click (metaKey) on a content link should open in a new tab like Ctrl-click.
await withSession('modifier-clicks', { users: ['Gamemaster'] }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  const a = await createEntry(gm, 'person', 'TT-meta-A');
  const b = await createEntry(gm, 'person', 'TT-meta-B');
  const r = await gm.evaluate(async ({ a, b }) => {
    const A = game.journal.get(a), B = game.journal.get(b);
    await game.MonksEnhancedJournal.openJournalEntry(A);
    await new Promise(r => setTimeout(r, 2000));
    const app = game.MonksEnhancedJournal.journal;
    const before = app.tabs.length;
    const link = document.createElement('a'); link.dataset.link = ''; link.dataset.uuid = B.uuid; link.dataset.id = B.id; link.dataset.type = 'JournalEntry';
    const fake = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: link, currentTarget: link, preventDefault() {}, stopPropagation() {} };
    await B._onClickDocumentLink(fake);
    await new Promise(r => setTimeout(r, 2500));
    const out = { before, after: app.tabs.length, activeIsB: app.tabs.find(t => t.active)?.entityId === B.uuid };
    await app.close();
    return out;
  }, { a, b });
  assert.equal(r.after, r.before + 1, `Cmd-click did not open a new tab: ${JSON.stringify(r)}`);
  assert.equal(r.activeIsB, true, 'new tab is not the clicked entry');
});
console.log('modifier-clicks: OK');
```

- [ ] **Step 2: Run against stock — expect FAIL** (`after === before`: the entry replaced the current tab). If `_onClickDocumentLink` on a JournalEntry is not the patched function in 14.01 (it is: `JournalEntry.prototype._onClickDocumentLink` at ~line 716), use `JournalEntryPage` instead.

- [ ] **Step 3: Branch and apply the six edits**

```bash
git -C $MODULE checkout -b up/modifier-clicks 14.01
```

Lines 689, 718, 736, 758: replace `newtab: event.ctrlKey && !setting("open-new-tab")` with `newtab: (event.ctrlKey || event.metaKey) && !setting("open-new-tab")` (four sites; `grep -c 'event.ctrlKey || event.metaKey' monks-enhanced-journal.js` → 4).

Line 1208 (`clickNote2`): the function is registered as a libWrapper OVERRIDE, so its first parameter (`wrapped`) is the click event itself. Replace

```js
				if (! await MonksEnhancedJournal.openJournalEntry(this.entry, options)) {
```

with

```js
				if (wrapped?.altKey || ! await MonksEnhancedJournal.openJournalEntry(this.entry, options)) {
```

Line 1241 (no-libWrapper fallback): replace

```js
			const oldClickNote = foundry.canvas.placeables.Note.prototype._onClickLeft2;
			foundry.canvas.placeables.Note.prototype._onClickLeft2 = function (event) {
				return clickNote2.call(this, oldClickNote.bind(this));
			}
```

with

```js
			foundry.canvas.placeables.Note.prototype._onClickLeft2 = function (event) {
				return clickNote2.call(this, event);
			}
```

- [ ] **Step 4: Run the scratch check — expect PASS**; `node run.mjs connect` passes.

- [ ] **Step 5: Manual check of Alt-click on a map note** — ask Dan (in the task report) to Alt-double-click a note on World A with lib-wrapper on and off; expected: the native journal sheet opens instead of the Enhanced Journal. Do not block the PR on it; state it in the PR body as "Alt-click verified by hand on 14.368".

- [ ] **Step 6: Commit, push, open the PR** — title `Honor Cmd-click for new tabs on macOS and Alt-click on map notes (#95, #85, #817, #677)`; body: Symptom / Cause (`event.ctrlKey` only at four link sites; `clickNote2` never reads the event's `altKey`; the fallback passes the bound core handler as the event) / Fix / Verified (scratch result above + manual Alt-click).

---

### Task 7: Batch wrap-up

**Files:**
- Modify: `.superpowers/sdd/2026-09-18-upstream-pr-batch-1/progress.md`
- Modify (memory): `~/.claude/projects/-Users-danbularzik-Claude-Projects-monks-enhanced-journal/memory/mej-backlog-triage.md`

- [ ] **Step 1: Leave the module worktree on stock 14.01** — `git -C $MODULE checkout --detach 14.01`, and confirm `node run.mjs connect` passes.

- [ ] **Step 2: Record the six PR URLs, the two scratch results per PR, and the worktree layout** in `progress.md` and in the memory file (one line per PR: branch, URL, status "open").

- [ ] **Step 3: List for Dan the Discord threads to reply to with PR links** — "Relationship Header & Large Font Size" (Task 1) and "Sidebar click opens the previous tab" (Task 5). Replies are Dan's to post (the Discord connector is unavailable in this session).
