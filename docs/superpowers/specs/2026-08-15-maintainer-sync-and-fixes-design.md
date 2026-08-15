# Maintainer 14.00 Sync, Discord Fix Round, and 14.07-test Integration — Design

Date: 2026-08-15
Status: approved (Dan, 2026-08-15)

## Background

The upstream maintainer manually merged PRs #820/#821 into their private repo and released a
test build (version string "14.00") at `~/mej-v14-testing/monks-enhanced-journal.zip`. Seven
issue threads from the maintainer's Discord testing channel
(`testing-enhanced-journal-v14`) were exported as HTML+images into `~/mej-v14-testing/`.

Comparing the zip against `backlog-fixes` @ 964bf19 (the PR #821 tip): ~61 files / ~1,900
lines differ (excluding `packs/`, lang JSON counted separately). The delta cuts both ways:

- **Maintainer additions**: new `apps/selectplayer.js`, `assets/defunct.png`, translation
  updates (10 lang files), CSS changes across 4 files, edits to ~20 sheets/apps/classes.
- **Our work missing from their build** (early probes; the merge will enumerate fully):
  no `ForcedReplacement` usage (round-3 objectives atomic-reorder fix), no
  `waitForFirstPage`/render-wrapper (the 14.04b shop-UI/open-gate fix — expected, it was
  never in #821).

## Decisions (Dan, 2026-08-15)

1. **Sync branch = ours + their additions.** Where the maintainer's tree conflicts with or
   drops our #821 work, our code stays; their work is layered where additive. Dropped items
   become a written report, not code changes.
2. **Integration = everything.** The step-4 integration branch includes the twelve
   round-1/round-2 enhancement branches (i.e., the `enhancements-test` lineage, which
   already carries the 14.04b cherry-pick), the maintainer sync, and the seven fix branches.
   Released as **14.07-test**.
3. **No PRs raised without explicit approval. Nothing pushed to `backlog-fixes`** (frozen
   per repo rules / upstream request).

## Global constraints

- `backlog-fixes` is frozen: no new commits, ever. All new work branches off it.
- No PRs raised on any repo without Dan's explicit approval.
- Releases get an annotated git tag named exactly after the release (`14.07-test`) at the
  built commit, pushed to origin. Older test manifests are NOT repointed.
- No posting to Discord or upstream; issue intake is read-only.
- `packs/` (LevelDB) is excluded from all diff/merge work.
- Harness specs live on the `playwright-harness` branch (worktree `test/`), specs prefixed
  per its conventions; `zz-currency-systems` must remain last-alphabetical.

## Phase A — Maintainer reconciliation

**Branch:** `maint/14.00-sync` off `backlog-fixes` @ 964bf19.

**Method — synthetic three-way merge:**

1. Identify the common ancestor: upstream `foundry-v14` tip that both `backlog-fixes` and
   the maintainer's private merge started from (origin/foundry-v14 @ 46de09d lineage).
2. Create a synthetic commit whose parent is that ancestor and whose tree is the zip
   contents (minus `packs/`, minus files upstream never tracked — CHANGELOG.md/README.md
   stay ours).
3. `git merge` the synthetic commit into `maint/14.00-sync`. Git's three-way classification
   does the triage: theirs-only hunks auto-apply (maintainer additions), ours-only hunks
   auto-keep (their drops — enumerated afterward via `git diff maint/14.00-sync <zip-tree>`),
   both-changed hunks conflict and are adjudicated **keep-ours-unless-additive**, each with
   a written ruling.
4. Translations (`lang/*.json`) and new assets are taken wholesale from theirs unless a
   key collides with a string one of our fixes added; collisions keep ours and are noted.

**Deliverables:**

- `maint/14.00-sync` branch (pushed to fork).
- `docs/superpowers/triage/2026-08-15-maintainer-14.00-reconciliation.md` with three lists:
  1. Maintainer additions, grouped by feature/theme.
  2. Our #820/#821 work absent from their 14.00 — the re-raise list.
  3. Conflict rulings (hunk, what each side did, why ours/theirs/both won).
- Any drop that looks *deliberate* (their "not the correct fix" pattern, cf. #816/#802) is
  kept-ours on the branch but flagged prominently in the report for Dan's call.

## Phase B — Tests for maintainer changes

From the Phase-A additions list, cluster maintainer changes into testable features. Known
clusters going in: `selectplayer` app, `defunct.png` asset flow, CSS/font rework; the rest
emerge from the merge. For each cluster:

- **Behavioral clusters** get playwright-harness specs (new spec files on
  `playwright-harness`, following existing `run.mjs`/ensureWorld conventions), run against
  `maint/14.00-sync` in the v14 test environment.
- **Pure-cosmetic CSS clusters** get screenshot-level smoke checks only (render the
  affected surface, assert no console errors, capture screenshot).

A cluster that turns out untestable in the harness (e.g., requires a second human client
beyond the harness's capabilities) is documented as manually-verified-or-skipped in the
outcomes doc rather than silently dropped.

## Phase C — Seven Discord-issue fix branches

Each issue is triaged first (reproduce in the harness against `maint/14.00-sync` where
possible), then fixed on its own branch **off `backlog-fixes` @ 964bf19** so it can be a PR
on top of #821 — except a bug living only in maintainer-added code, which bases on
`maint/14.00-sync` instead. Each fix branch gets a harness spec (or documented
manual-verification when the harness can't reach it, e.g. multi-client player scenarios).

| # | Branch | Discord thread | Evidence | Expected shape |
|---|---|---|---|---|
| 1 | `fix/encounter-controlicon` | Create Encounter Buttons | `ControlIcon#iconSrc` deprecation error, `encounter-template.js:94` (zip sets `controlIcon.iconSrc`; removed in v16) | `iconSrc` → `texture` API; check whether our tree shares the usage |
| 2 | `fix/dialog-button-overlap` | List, Create Entry | "Save Changes" icon/text overlap in Edit Item + Create Folder dialogs | CSS for dialog footer buttons |
| 3 | `fix/encounter-placement-scene` | MATT Start Encounter | `TypeError: reading 'scene'` at `monks-enhanced-journal.js:5182` in `restrict()` via Monk's Active Tiles `selectClick` | guard `restrict()` when canvas/scene state is not MEJ's; verify against our round-3 placement fix |
| 4 | `fix/player-open-journal` | Players can't open the journal | players can't reopen handouts they created; Show-to-Players no-op; GM fine; no stack trace | investigate first — likely the open-gate family (14.04b fix absent from their build); may resolve to already-fixed-by-us |
| 5 | `fix/large-font-headers` | Relationship Header & Large Font Size | vertical mis-centering + ~1px clip at large fonts; Customise Page column headers dark/clipped | CSS (line-height/align on list headers and customise-page table headers) |
| 6 | `fix/renderpage-removeattribute` | removeAttribute Error | intermittent `TypeError: reading 'removeAttribute'` in core `JournalEntrySheet._renderPageView` on journal open | render-race guard on MEJ's side; intermittent, so fix-by-code-evidence if no repro |
| 7 | `fix/tableresult-deprecation` | rollTable Deprecation | `TableResult#text` deprecated (removed v15), `EnhancedJournalSheet.js:2391`, Quest populate-from-rolltable (+ probably Loot) | `result.text` → `result.name`/`result.description` at all call sites |

**Triage outcomes other than "fix":** an issue already fixed in our #821 code (e.g., #4 may
be exactly the 14.04b fix), core-side, or unreproducible-with-no-code-evidence gets a
written verdict in the outcomes doc instead of a no-op branch. The branch list above is the
plan, not a quota.

## Phase D — Integration and 14.07-test

**Branch:** `integration-14.07` starting from `enhancements-test` (@ current tip, which
carries rounds 1+2 and the 14.04b cherry-pick), then merging `maint/14.00-sync` and each of
the Phase-C fix branches.

- Expected conflict hotspots: `monks-enhanced-journal.js` (open-gate wrapper vs maintainer
  edits), `EnhancedJournalSheet.js`, CSS files touched by both dark-mode and the
  maintainer. Resolutions documented in the outcomes doc.
- **Test gate:** full harness suite — 15 existing specs + Phase-B specs + Phase-C specs —
  ×2 consecutive green runs, zero MEJ console errors. Discovered integration issues are
  fixed on `integration-14.07` if integration-specific, or on the owning feature/fix branch
  (then re-merged) if they belong there.
- **Build/release:** build the module zip from the branch tip, release **14.07-test** on
  the fork with an annotated tag at that commit (pushed), manifest self-pointing, older
  test manifests NOT repointed. Post-publish `test/release-smoke.mjs` against the live
  manifest must pass.

**Outcomes doc:** `docs/superpowers/triage/2026-08-15-maintainer-sync-and-fixes-outcomes.md`
— per-phase results, triage verdicts for all 7 issues, conflict rulings, follow-up
candidates, and the re-raise list pointer.

## Error handling / stop conditions

- Synthetic merge produces a conflict whose resolution would functionally revert one of our
  shipped fixes → keep ours, flag in report; if that makes a maintainer feature
  non-functional, STOP and ask Dan.
- Issue #4 (player open) unreproducible in a two-client harness session AND no code
  evidence → document as needs-info verdict; no speculative fix.
- Integration suite still red after two fix rounds on the same failure → STOP, report.
- Release-smoke failure post-publish → follow release rules (no in-place asset repair; cut
  a new release from a hotfix branch if the source backs an open PR).

## Testing summary

- Phase B: new specs per maintainer feature cluster (run vs `maint/14.00-sync`).
- Phase C: one spec (or documented manual verification) per fix branch.
- Phase D: whole suite ×2 green + zero console errors + release-smoke vs live manifest.
