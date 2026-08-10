# Shop-UI bug: 14.04-test packaging verification & repro — Design

**Date:** 2026-08-10
**Status:** Approved (Option 1 for release strategy)

## Problem

A Discord user (report relayed 2026-08-10, tested night of 2026-08-09) installed the fork's test build and reports: creating a shop journal note does not show the MEJ shop UI — it shows the default Foundry note UI instead. The upstream maintainer has validated the bug. The user installed via the `14.04-test` manifest URL published to Discord (not `14.05-test`). Their Foundry version and console output are unknown, and no follow-up with the reporter will occur.

All prior fork testing ran against the repo checkout, never against the published release artifact — so packaging defects would have been invisible to the Playwright harness. The leading hypothesis is a packaging-related problem in the published `14.04-test` release.

## Goal

1. Determine whether the published `14.04-test` artifact is defective (packaging) or whether the bug lives in its source code.
2. Reproduce the reported symptom from the published artifact, exactly as a user would experience it.
3. Fix, verify, and publish a corrected build **without touching `backlog-fixes`/PR #821** (upstream maintainer has requested no further additions to that PR).

## Non-goals

- No Discord communication (no reply to the reporter, no posting of new URLs — the user handles distribution).
- No changes to `backlog-fixes` or PR #821 under any circumstances.
- No enhancement-round changes mixed into the fix build.

## Constraints & rules established during design

- **Always tag releases**: every release cut from now on gets a git tag named after the release, pushed to origin, at the commit the zip was built from (recorded in repo `CLAUDE.md`). `14.04-test`'s source commit gets a retroactive tag as part of this work.
- **No in-place repair** of `14.04-test` assets: rebuilding from `backlog-fixes` would add commits to the branch backing PR #821.

## Design

### Section 1 — Static artifact verification

Verify the published artifact is complete and self-consistent before any browser work.

- Identify the commit `14.04-test` was built from (release published 2026-08-08 19:55 UTC; zip file timestamps 2026-08-08 13:05 local). No tags exist, so correlate against `backlog-fixes` history and diff zip contents against candidate commits until the source commit is pinned down. Tag it `14.04-test` retroactively. If no commit matches the zip exactly (e.g. the zip was built from a dirty working tree), tag the closest commit and document the deltas — the deltas themselves are then prime root-cause candidates.
- Diff the zip's file list against the source tree at that commit. Every file referenced by `module.json` (`esmodules`, `styles`, `templates`, `languages`, `packs`) and every template path referenced in code (`templates/…` strings in JS, `loadTemplates`/`renderTemplate` calls) must exist in the zip with matching content.
- Check packaging-specific hazards: files omitted by the zip build (e.g. `.gitignore`-driven exclusions), case-sensitivity mismatches (built on macOS, served to case-sensitive hosts), stale or mixed-version files in the zip.
- Already verified during design: the released `module.json` is internally consistent (fork URLs, `compatibility.minimum: 14`, correct `esmodules`/`styles` lists) and the zip has files at its root with all 17 sheet files present, including `ShopSheet.js`. The defect, if packaging, is therefore subtler than a missing sheet — content diff is the point of this section.

Output: a concrete packaging defect, or a clean bill for the artifact.

### Section 2 — Live repro from the published manifest

Simulate the reporter exactly, using the Foundry v14 test environment and the Playwright harness (`test/` scripts, TT- prefix).

- Install the module **via the published `14.04-test` manifest URL** — the same URL posted to Discord — not from the repo checkout. This is the key difference from all prior testing.
- Use a **fresh world** (not seeded World A) so fresh-install/default-settings issues also surface.
- Repro path: create a shop journal note both ways a user might, since the report's phrasing is ambiguous:
  1. MEJ Enhanced Journal browser → new entry → Shop type.
  2. Native Foundry journal sidebar creation path.
- Capture console output and screenshots at each step. A failed ESM import or an exception in the `init` hook would explain all MEJ sheets silently falling back to default Foundry UI.
- Also record the artifact's behavior signature broadly (does the MEJ browser open at all?) — the reporter only tested shops, but the defect may be module-wide.

Output: a reproduced failure with console evidence, or a documented non-repro.

### Section 3 — Fix, verify, release (Option 1: hotfix branch)

- Branch `hotfix/14.04b` from the tagged `14.04-test` source commit.
- Apply the fix there:
  - **Packaging-only defect**: possibly zero code commits — correct the build process (script/checklist), rebuild the zip from the same source. The packaging fix itself must be captured durably (commit the build script/steps to the hotfix branch or docs), not performed by hand once.
  - **Code defect**: fix on the hotfix branch only. `backlog-fixes` never moves.
- Cut release `14.04b-test` from the hotfix branch; tag it `14.04b-test` per the new rule. Its `module.json` `manifest`/`download` URLs point at the `14.04b-test` release assets.
- Verify by repeating the Section 2 install-from-manifest flow against the new artifact: shop creation must show the MEJ shop UI in a fresh world.
- Apply the same packaging correction to future `enhancements-test` releases when the next one is cut naturally (14.05-test is near-certainly affected if the defect is packaging, but no release is cut for it as part of this work).

### Error handling / stop conditions

- **Bug does not reproduce** from the published artifact in Section 2: deliverable becomes a documented repro attempt plus the list of ruled-out causes; stop and ask Dan rather than guessing.
- **Root cause is a code bug present in `backlog-fixes` source**: PR #821 itself carries the bug. Fix on the hotfix branch for the release, then stop and surface the PR implication to Dan before anything else — communicating with upstream is his call.
- **Distribution**: the published 14.04-test `module.json` pins its `manifest` to the versioned URL, so installed users never auto-update; the fix reaches users only via a newly shared URL. The final summary includes the `14.04b-test` manifest URL for Dan to share; nothing is posted anywhere by the agent.

### Testing

- The Section 2 flow doubles as the regression test for the fix (Section 3 re-runs it against the new artifact).
- Capture the install-from-published-artifact flow as a reusable harness script (TT- pattern in `test/`) so every future release gets an install-from-artifact smoke test instead of checkout-only testing.

## Success criteria

1. Root cause identified with evidence (packaging diff or console trace).
2. `14.04b-test` published from `hotfix/14.04b`, tagged, with `backlog-fixes`/PR #821 untouched (verified via `git log` of the branch and the PR's commit list).
3. Fresh-world install from the `14.04b-test` manifest URL shows the MEJ shop UI when creating a shop journal note, via both creation paths, with a clean console.
4. Retroactive `14.04-test` tag and new `14.04b-test` tag pushed to origin.
5. Reusable install-from-artifact smoke-test script exists in `test/`.
