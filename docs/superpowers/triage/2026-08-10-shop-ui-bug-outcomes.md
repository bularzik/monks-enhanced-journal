# Shop-UI bug — final summary

**PR #821 ships this bug.** The root cause is *code*, not packaging, and it is present verbatim at
PR #821's head: `origin/backlog-fixes` = `964bf19f` — which is byte-for-byte the same commit as tag
`14.04-test`, the release whose published artifact reproduced the failure. The fix is two commits on
`hotfix/14.04b`: **`302e778`** (the fix) + **`3d00a29`** (review round: register the patch as `MIXED`,
always fall back). Whether to cherry-pick those onto `backlog-fixes` before merging #821, or to let
#821 merge and fix forward, is **Dan's call** — nothing has been cherry-picked, merged or pushed to
`backlog-fixes`.

---

## Root cause

Foundry v13+ moved sheet rendering for the create-document dialog out of the document lifecycle.
`ClientDocumentMixin.createDialog()` creates the document with `renderSheet: false` and then renders
the sheet itself:

```js
// client/documents/abstract/client-document.mjs:870-873
const doc = await cls.create(data, { renderSheet: false, ...createOptions });
renderOptions.renderContext ??= `create${this.documentName}`;
doc.sheet.render(true, renderOptions);
```

MEJ's only "an entry was just created — show it in the Enhanced Journal" interception lives inside its
`JournalEntry.prototype._onCreate` patch (`monks-enhanced-journal.js:959` at `964bf19f`) and is gated
on `options.renderSheet !== false`. `createDialog` passes exactly that, so the gate short-circuits,
`openJournalEntry()` is **never called**, and Foundry's own `doc.sheet.render(true)` opens the core
note sheet (`JournalEntrySheet5e`) instead — the plain window with "Search Pages" / "Add Page" and an
empty page list that the Discord user reported.

**Evidence pointers**

| Claim | Evidence |
|---|---|
| Published zip == pinned source, all internal refs resolve | Tasks 1-2 — `$SCRATCH/pin-report.md`, `$SCRATCH/static-audit.md` |
| Published `14.04-test` artifact reproduces in a fresh world | Task 3 — `$SCRATCH/tt-repro-14.04.json`, screenshot `tt-repro-14.04-ui-shop.png` |
| Dev checkout reproduces **identically** → not packaging | Task 3 control run — `$SCRATCH/tt-control-devcheckout.json` |
| API path works, only the UI path breaks | Task 3 — `RENDERED (API path)` vs `RENDERED (UI path)` |
| `openJournalEntry` is never called; core sheet renders first | Task 4 probe — `$SCRATCH/probe.json` (two render stacks, zero `openJournalEntry` calls) |
| The empty page list is a real core exception | `TypeError: ...reading 'removeAttribute'` at `JournalEntrySheet5e._renderPageView` |
| Persisted page type is `"text"` + `flags.monks-enhanced-journal.type = "shop"` — by design, not the bug | Task 4 — read back after a full client reload; matches what `fixPage()` has always written |

Silent failure: Task 3's full console capture over the whole repro was 297 entries with **zero**
errors, which is why it looked like a packaging problem for as long as it did.

---

## What `14.04b-test` contains

Two commits on `hotfix/14.04b`, on top of `964bf19f` (= tag `14.04-test` = PR #821 head):

- **`302e778`** — new patch on
  `foundry.applications.sheets.journal.JournalEntrySheet.prototype.render` that swallows exactly the
  render whose `renderContext == "createJournalEntry"`, and only when the entry carries an Enhanced
  Journal `flags.monks-enhanced-journal.pagetype` mapping to a real MEJ type; additionally guarded by
  `!setting("open-outside")` and `isAllowedToUseEnhancedJournal()`.
- **`3d00a29`** — review round. Registers that patch as **`MIXED`** (as `WRAPPER` it did not chain, so
  lib-wrapper unregistered it after the first swallow and every *subsequent* creation in the session
  reverted to the original bug), and makes the wrapper own the whole decision with a guaranteed
  fallback:

  ```js
  if (await MonksEnhancedJournal.waitForFirstPage(this.document)
      && await MonksEnhancedJournal.openJournalEntry(this.document, {}))
      return this;
  return wrapped(...args);
  ```

  so if the page never arrives *or* MEJ declines to open (display-mode modules, conversation-hud, a
  third-party `openJournalEntry` hook veto) the core sheet still comes back and the user is never left
  with nothing open.

`_onCreate` ends up **byte-identical to its original form** — the whole fix is additive: one new
static helper (`waitForFirstPage`) plus one new patch. Nothing about storage, sheet registration, the
type registry, or the create dialog changed.

**No migration needed.** Entries created while the bug was live are `text` pages carrying
`flags.monks-enhanced-journal.type = "shop"` — exactly the shape the fixed code still produces and
that `fixPage()` has always produced. They open correctly today and continue to (asserted explicitly,
green both before and after the fix).

---

## Manifest URL for Dan to share

```
https://github.com/bularzik/monks-enhanced-journal/releases/download/14.04b-test/module.json
```

**Nothing has been posted anywhere** — not to Discord, not to the GitHub issue, not to PR #821. This
URL is for Dan to hand to the reporter if and when he chooses.

---

## Verification — the fix works, end to end, from the published artifact

Installed the way a user installs it (manifest → `download` URL → unzip into
`Data/Data/modules/monks-enhanced-journal`), in a brand-new world with only `monks-enhanced-journal`
+ `lib-wrapper` enabled, driving the real sidebar path — **not** the API:

```
installed:    monks-enhanced-journal 14.04b-test  (compatibility 14/14)
registration: active=true  libWrapperActive=true  gameMEJ=true
              shopSheetRegistered=true  shopSheetClassName=ShopSheet
              all 12 monks-enhanced-journal.* page subtypes registered

afterCreate   (sidebar create #1)  mejDom=true  shopDom=true  openApps=[...,EnhancedJournal]
afterCreate2  (sidebar create #2)  mejDom=true  shopDom=true  openApps=[...,EnhancedJournal]
              -> no JournalEntrySheet* in either; libWrapperErrors: []
persisted     type="text"  flags={type:"shop"}  typeIsRegistered=true   (read after full reload)
reopen        mejDom=true  shopDom=true  subsheetClass="ShopSheet"
legacy        bug-era text+flags page -> subsheetClass="ShopSheet"
plainText     coreSheetOpen=true                                        (regression guard)
declined      hook veto -> JournalEntrySheet5e falls back                (nothing-open guard)

SMOKE PASSED   (0 failures, exit 0) — reproduced twice, back to back
```

The environment was fully restored after each run: module symlink back to the dev checkout, throwaway
world deleted, Foundry restarted with `world-a` active and `users: 0`.

> ⚠️ Hedge: this smoke verification ran on a **dnd5e** world with a **single client**. Multi-client
> behavior and non-dnd5e systems were not smoke-tested — they rest on code review, not observed
> behavior. In particular, any system that overrides `JournalEntrySheet` render without calling
> `super` would bypass the fix undetected by this suite.

---

## PR-#821 safety proof

- The fix branch `hotfix/14.04b` was cut **from** `964bf19f` and only ever added commits to itself.
- `origin/backlog-fixes` is still `964bf19fb15539169ba48baed72f443601a4a4a2` — untouched, nothing
  pushed, nothing merged, nothing cherry-picked.
- Everything in this investigation lives outside the tracked tree (`.superpowers/`, `$SCRATCH`) except
  the harness commit on the separate `playwright-harness` branch.
- Full harness regression suite against the fixed module: **8/8 specs passed** (connect, currency,
  fixtures, loot-drop, quest-objectives, relationships, shop-purchase, smoke-sheets).

> ⚠️ Housekeeping worth knowing: the **local** `backlog-fixes` ref currently points at `a5bc724`, which
> is a `playwright-harness` commit, not the PR branch. `origin/backlog-fixes` (`964bf19`) is the real
> PR #821 head and is what the statements above are about. Worth fixing the local ref
> (`git branch -f backlog-fixes origin/backlog-fixes`) before doing any cherry-picking, so a
> cherry-pick doesn't land on the wrong branch.

---

## Does `14.05-test` carry the same defect? — **Yes, proven, not inferred**

`14.05-test` = `00486c7975f0136db0d4b09e6a97ee186f9948f2`, which is exactly the current head of
`origin/enhancements-test`. Reading its source directly:

| ref | `waitForFirstPage` (the fix) | buggy `renderSheet !== false` gate |
|---|---|---|
| `origin/backlog-fixes` (PR #821) | absent | present (`:959`) |
| `14.04-test` | absent | present |
| **`14.05-test`** | **absent** | **present (`:968`)** |
| `origin/enhancements-test` | absent | present |
| `hotfix/14.04b` | present | (present but now bypassed by the new render patch) |

This is stronger than the packaging-process argument the spec anticipated: it is not that `14.05-test`
was built by the same zip process, it is that `14.05-test`'s source **does not contain the fix and does
contain the defect**. Task 3's control run corroborates it behaviourally — the dev checkout
(`enhancements-test` lineage) reproduced the failure identically to the published artifact.

**Recommendation:** don't cut a special release for this. Let the fix ride the next natural
`enhancements-test` release — cherry-pick `302e778` + `3d00a29` onto `enhancements-test` (and onto
`backlog-fixes` if #821 hasn't merged yet), and ship `14.06-test` normally. `14.04b-test` exists purely
as a verified artifact to hand the Discord reporter in the meantime.

---

## Smoke test — use it before every release

Committed on the `playwright-harness` branch as `test/release-smoke.mjs`:

```
cd test && node release-smoke.mjs <manifest-url-or-local-module.json>
```

Exit 0 = safe to upload, 1 = do not upload, 2 = usage / pre-flight refusal. It installs the artifact
the way a user does, spins up a throwaway `tt-release-smoke` world with only MEJ + lib-wrapper, runs
the A0-A10 assertions above, and then restores everything (module dir, world, Foundry, `world-a`) from
a `finally` — even if an assertion throws mid-world. It refuses to start unless `/api/status` reports
`users: 0`, and `run.mjs` never picks it up because that only scans `specs/`.
