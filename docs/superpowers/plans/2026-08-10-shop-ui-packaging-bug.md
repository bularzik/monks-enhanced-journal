# 14.04-test Shop-UI Packaging Bug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Root-cause the "shop journal note shows plain Foundry UI" report against the published `14.04-test` artifact, fix it without touching `backlog-fixes`/PR #821, and publish a tagged `14.04b-test` release verified by installing from its own manifest URL.

**Architecture:** Three phases matching the spec: (1) static verification — pin the source commit the zip was built from and diff the artifact against it; (2) dynamic verification — simulate a user install from the published manifest URL into a fresh world and reproduce the symptom; (3) hotfix release from a `hotfix/14.04b` branch with a committed, repeatable build script, re-verified through the same install flow.

**Tech Stack:** git, `zip`/`unzip`, `gh` CLI, Node 20+, the MEJ Playwright harness (`.claude/worktrees/playwright-harness/test/`), local Foundry v14 (build 14.365, `~/FoundryVTT-14/`, port 30000).

## Global Constraints

- **Never commit to or push `backlog-fixes`** — it backs upstream PR #821 and the maintainer requested no further additions. Verify at the end that `git rev-parse backlog-fixes` is unchanged from start value.
- **Tag every release**: annotated tag named exactly like the release, at the built commit, pushed to origin (repo `CLAUDE.md` rule).
- **No Discord/upstream communication of any kind.** Output URLs in the final summary only.
- Foundry data path: `~/FoundryVTT-14/Data` → modules live at `~/FoundryVTT-14/Data/Data/modules/`; `monks-enhanced-journal` there is a **symlink to this repo checkout** — any step that replaces it MUST restore it afterwards, even on failure.
- Harness rules: single harness instance at a time (check `curl -s localhost:30000/api/status` first — nonzero `users` means another session is connected); test entities `TT-` prefixed; headless; timeouts ≤15s.
- Scratch/temp files go in `/private/tmp/claude-502/-Users-danbularzik-Claude-Projects-monks-enhanced-journal/2bf1f8c9-7aa2-40fd-9580-48f138d53f74/scratchpad` (call it `$SCRATCH` below); throwaway harness scripts in `.claude/worktrees/playwright-harness/test/scratch/` (gitignored).
- Published artifact URLs: manifest `https://github.com/bularzik/monks-enhanced-journal/releases/download/14.04-test/module.json`, download `.../14.04-test/module.zip`. A copy of the zip already exists at `$SCRATCH/module-14.04.zip`.
- Evidence already in hand (do not re-derive): released `module.json` is internally consistent (`compatibility.minimum: "14"`, fork URLs, correct `esmodules`/`styles`); zip has 277 files at root incl. all 17 `sheets/*.js`; repo tracks 34 `.png` files but the zip contains only 12 PNG entries — the artifact provably diverges from source.

---

### Task 1: Pin the 14.04-test source commit and tag it

**Files:**
- Create: `$SCRATCH/pin-commit.sh` (throwaway analysis script)
- Create: `$SCRATCH/pin-report.md` (findings: pinned commit, delta list)

**Interfaces:**
- Produces: `PINNED_COMMIT` (a full SHA on `backlog-fixes` history), git tag `14.04-test` pushed to origin, and `$SCRATCH/pin-report.md` listing every file whose content differs between the zip and the pinned commit. Tasks 2 and 4 consume the pinned commit and the delta list.

- [ ] **Step 1: Record the starting state of protected branches**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
git rev-parse backlog-fixes > $SCRATCH/backlog-fixes-start.sha
git rev-parse origin/backlog-fixes >> $SCRATCH/backlog-fixes-start.sha
cat $SCRATCH/backlog-fixes-start.sha
```

- [ ] **Step 2: Extract the published zip**

```bash
mkdir -p $SCRATCH/zip-14.04 && cd $SCRATCH/zip-14.04
unzip -oq $SCRATCH/module-14.04.zip
find . -type f | wc -l   # expect 277 minus directory entries — record the number
```

- [ ] **Step 3: Write the commit-pinning script**

The metric: for each candidate commit, hash every extracted zip file with `git hash-object` and compare against the commit's `ls-tree` blobs. Fewest mismatches wins. `module.json` is edited per-release without committing, so exclude it from the metric (but record its diff separately).

```bash
cat > $SCRATCH/pin-commit.sh <<'EOF'
#!/bin/zsh
set -e
REPO=/Users/danbularzik/Claude/Projects/monks-enhanced-journal
SCRATCH=/private/tmp/claude-502/-Users-danbularzik-Claude-Projects-monks-enhanced-journal/2bf1f8c9-7aa2-40fd-9580-48f138d53f74/scratchpad
ZIPDIR=$SCRATCH/zip-14.04
cd $REPO
# Candidates: commits on backlog-fixes reachable history around the build time
# (zip file mtimes 2026-08-08 13:05 EDT; release published 19:55 UTC).
for C in $(git rev-list backlog-fixes --since=2026-08-06 --until=2026-08-09); do
  MISS=0
  while IFS= read -r F; do
    REL=${F#$ZIPDIR/}
    [ "$REL" = "module.json" ] && continue
    H=$(git hash-object "$F")
    TREEH=$(git ls-tree "$C" -- "$REL" | awk '{print $3}')
    [ "$H" != "$TREEH" ] && MISS=$((MISS+1))
  done < <(find $ZIPDIR -type f)
  echo "$MISS $C $(git log -1 --format='%ci %s' $C)"
done | sort -n
EOF
chmod +x $SCRATCH/pin-commit.sh
```

- [ ] **Step 4: Run it and pin the commit**

```bash
$SCRATCH/pin-commit.sh | tee $SCRATCH/pin-results.txt | head -5
```

Expected: a clear winner (lowest mismatch count). If `--since/--until` yields no candidates or no commit scores plausibly low (< ~20 mismatches), widen the range and re-run; also try `enhancements-test` history in case 14.04 was cut from a different branch than assumed. Record `PINNED_COMMIT`.

- [ ] **Step 5: Enumerate the deltas for the pinned commit**

For the winning commit, list each mismatching or zip-only file, plus each file tracked at the commit but absent from the zip (this is the packaging-omission list — expect the ~22 missing PNGs here, and look hard for any missing `.js`/`.hbs`/`.css`):

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
C=<PINNED_COMMIT>
# tracked-but-not-shipped (candidate packaging omissions):
comm -23 <(git ls-tree -r --name-only $C | sort) \
         <(cd $SCRATCH/zip-14.04 && find . -type f | sed 's|^\./||' | sort) \
  | grep -Ev '^(test/|docs/|\.claude/|\.superpowers/|\.remember/|\.github/)' \
  | tee $SCRATCH/missing-from-zip.txt
# shipped-but-content-differs: re-run the inner loop of pin-commit.sh for $C printing names
```

Write `$SCRATCH/pin-report.md` summarizing: pinned SHA, mismatch count, missing-file list grouped by extension, content-diff list, and the `module.json` diff.

- [ ] **Step 6: Tag the pinned commit and push the tag**

```bash
git tag -a 14.04-test -m "Retroactive tag: source commit of the 14.04-test release zip (pinned by content diff, see docs/superpowers/specs/2026-08-10-shop-ui-packaging-bug-design.md)" $C
git push origin 14.04-test
```

Note: pushing a tag does not modify any branch; PR #821 is unaffected.

- [ ] **Step 7: Commit nothing in the repo; verify clean**

```bash
git status --porcelain   # expect only the pre-existing untracked files; no staged changes
```

---

### Task 2: Static reference audit of the shipped artifact

**Files:**
- Create: `$SCRATCH/audit-zip.mjs`
- Create: `$SCRATCH/static-audit.md` (findings)

**Interfaces:**
- Consumes: `$SCRATCH/zip-14.04/` (extracted artifact), `$SCRATCH/pin-report.md`.
- Produces: `$SCRATCH/static-audit.md` — verdict `PACKAGING DEFECT: <detail>` or `ARTIFACT REFERENCES OK`, consumed by Task 4's root-cause decision.

- [ ] **Step 1: Write the reference-audit script**

Checks, all against the *zip contents only* (what the user actually has):
1. every path in `module.json` `esmodules`, `styles`, `languages[].path`, `packs[].path` exists in the zip;
2. every `templates/...` string literal referenced in the zip's JS exists in the zip;
3. every relative `import ... from './x.js'` in each shipped JS file resolves inside the zip (a broken ESM import chain kills the whole module → exactly the reported symptom);
4. case-sensitivity: every reference must match a zip entry byte-for-byte, not just case-insensitively.

```js
// $SCRATCH/audit-zip.mjs — run with: node audit-zip.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
const ROOT = new URL('./zip-14.04', import.meta.url).pathname;
const files = [];
(function walk(d){ for (const e of readdirSync(d)) { const p = join(d,e);
  statSync(p).isDirectory() ? walk(p) : files.push(p.slice(ROOT.length+1)); } })(ROOT);
const fileSet = new Set(files);
const problems = [];
const check = (ref, from) => { if (!fileSet.has(normalize(ref))) problems.push(`${from} -> MISSING: ${ref}`); };
const mod = JSON.parse(readFileSync(join(ROOT,'module.json'),'utf8'));
for (const f of mod.esmodules ?? []) check(f, 'module.json esmodules');
for (const f of mod.styles ?? []) check(f, 'module.json styles');
for (const l of mod.languages ?? []) check(l.path, 'module.json languages');
for (const p of mod.packs ?? []) { // LevelDB packs are directories: require at least one file under the path
  if (!files.some(f => f.startsWith(p.path.replace(/^\.\//,'') + '/')) && !fileSet.has(p.path)) problems.push(`module.json packs -> MISSING: ${p.path}`); }
for (const js of files.filter(f => f.endsWith('.js'))) {
  const src = readFileSync(join(ROOT,js),'utf8');
  for (const m of src.matchAll(/["'`]((?:modules\/monks-enhanced-journal\/)?templates\/[^"'`\s]+?\.(?:html|hbs))["'`]/g))
    check(m[1].replace(/^modules\/monks-enhanced-journal\//,''), js);
  for (const m of src.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g))
    check(normalize(join(dirname(js), m[1])), js);
}
console.log(problems.length ? problems.join('\n') : 'ARTIFACT REFERENCES OK');
console.log(`\n${files.length} files scanned, ${problems.length} problems`);
```

- [ ] **Step 2: Run it**

```bash
cd $SCRATCH && node audit-zip.mjs | tee static-audit-raw.txt
```

Expected: either `ARTIFACT REFERENCES OK` or a concrete missing-reference list. Either result is progress.

- [ ] **Step 3: Cross-check against the omission list**

Merge with `$SCRATCH/missing-from-zip.txt` from Task 1: classify each omitted file as *cosmetic* (icons/art) vs *functional* (js/hbs/css/lang/packs). Write `$SCRATCH/static-audit.md` with the verdict line at top: `PACKAGING DEFECT: ...` if any functional file is missing or any reference is broken, else `ARTIFACT REFERENCES OK (cosmetic omissions only: N icons)`.

---

### Task 3: Live repro — install from the published manifest into a fresh world

**Files:**
- Create: `$SCRATCH/install-from-manifest.sh`
- Create: `.claude/worktrees/playwright-harness/test/scratch/tt-repro-14.04.mjs`
- Create: `$SCRATCH/repro-report.md`

**Interfaces:**
- Consumes: published manifest URL (Global Constraints).
- Produces: `$SCRATCH/repro-report.md` — `REPRODUCED: <console evidence>` or `NOT REPRODUCED`, plus screenshots. Task 4 consumes the evidence; the spec's stop condition fires on `NOT REPRODUCED`.

- [ ] **Step 1: Check no other session is on the Foundry server**

```bash
curl -s localhost:30000/api/status
```

Expected: `users` is 0 (or server down — the harness boots it). If nonzero, stop and wait; do not displace another session.

- [ ] **Step 2: Swap the dev symlink for a real user-style install**

This mirrors Foundry's own install protocol exactly (fetch manifest → download its `download` URL → extract into `modules/<id>`), which is equivalent to clicking Install Module with the manifest URL, without fighting the setup UI:

```bash
cat > $SCRATCH/install-from-manifest.sh <<'EOF'
#!/bin/zsh
set -e
MOD=~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal
MANIFEST=https://github.com/bularzik/monks-enhanced-journal/releases/download/14.04-test/module.json
[ -L "$MOD" ] || { echo "ABORT: $MOD is not a symlink — refusing to touch it"; exit 1; }
mv "$MOD" "$MOD.devlink"
DL=$(curl -sL "$MANIFEST" | python3 -c "import json,sys; print(json.load(sys.stdin)['download'])")
echo "download: $DL"
mkdir -p "$MOD" && curl -sLo /tmp/mej-install.zip "$DL"
unzip -oq /tmp/mej-install.zip -d "$MOD"
ls "$MOD/module.json" && grep '"version"' "$MOD/module.json"
EOF
chmod +x $SCRATCH/install-from-manifest.sh && $SCRATCH/install-from-manifest.sh
```

Expected: prints the fork's download URL and `"version": "14.04-test"`. The restore step (Step 7) is mandatory even if later steps fail.

- [ ] **Step 3: Create a fresh world**

Restart Foundry so it rescans packages, then create world `tt-fresh-shop` (dnd5e, like the reporter's likely system). Order of attempts, stop at the first that works:

1. **Setup JSON API from a Playwright page on `http://localhost:30000/setup`:**

```js
await page.evaluate(async () => {
  // v11+ setup client exposes Setup.post; confirm the exact namespace by searching the
  // unbundled source: grep -rn "createWorld" ~/FoundryVTT-14/FoundryVTT-Node-14.365/client/
  const S = globalThis.Setup ?? foundry.setup?.Setup;
  return S.post({ action: 'createWorld', id: 'tt-fresh-shop', title: 'TT Fresh Shop',
                  system: 'dnd5e', background: '' });
});
```

2. **Setup UI form via Playwright** (selectors verified against `~/FoundryVTT-14/FoundryVTT-Node-14.365/client/templates/setup/` before use): click the Create World button, fill title `TT Fresh Shop` / id `tt-fresh-shop`, select system `dnd5e`, submit.

Then launch the world, join as Gamemaster (blank password), and enable `monks-enhanced-journal` + `lib-wrapper` via the API (this is settings data, not UI wiring, so `page.evaluate` is fine):

```js
await gm.evaluate(async () => {
  const cfg = game.settings.get('core', 'moduleConfiguration');
  await game.settings.set('core', 'moduleConfiguration',
    { ...cfg, 'monks-enhanced-journal': true, 'lib-wrapper': true });
});
// Foundry reloads the world after module config changes — wait for the reload and re-join.
```

Leave every MEJ setting at its default. The world id MUST be `tt-fresh-shop` (TT- convention; it gets deleted in Step 7).

- [ ] **Step 4: Write the repro script**

Base it on the harness template (`test/README.md`) and the existing shop spec's selectors (see `test/specs/` — the shop spec asserts the MEJ shop sheet DOM). The harness helpers default to world-a: check `helpers/foundry.js` for the world-activation helper and pass/patch `tt-fresh-shop`.

```js
// .claude/worktrees/playwright-harness/test/scratch/tt-repro-14.04.mjs
import { withSession } from '../helpers/mej.js';
await withSession('tt-repro-14.04', { users: ['Gamemaster'], world: 'tt-fresh-shop' }, async ({ pages }) => {
  const gm = pages['Gamemaster'];
  // 1. Module + sheet registration state
  const reg = await gm.evaluate(() => ({
    active: game.modules.get('monks-enhanced-journal')?.active,
    version: game.modules.get('monks-enhanced-journal')?.version,
    mejGlobal: typeof globalThis.MonksEnhancedJournal !== 'undefined',
    shopSheetRegistered: Object.keys(CONFIG.JournalEntryPage.sheetClasses ?? {})
      .flatMap(t => Object.keys(CONFIG.JournalEntryPage.sheetClasses[t] ?? {}))
      .some(k => k.includes('monks-enhanced-journal')),
  }));
  console.log('REGISTRATION:', JSON.stringify(reg));
  // 2. Create a shop the API way MEJ does it, then render its sheet
  const entry = await gm.evaluate(async () => {
    const e = await JournalEntry.create({ name: 'TT-repro-shop' });
    const page = await e.createEmbeddedDocuments('JournalEntryPage', [{
      name: 'TT-repro-shop', type: 'text',
      flags: { 'monks-enhanced-journal': { type: 'shop' } },
    }]);
    return { id: e.id, pageType: page[0].type, flags: page[0].flags };
  });
  console.log('CREATED:', JSON.stringify(entry));
  // 3. Open it and capture what rendered
  await gm.evaluate(id => game.journal.get(id).sheet.render(true), entry.id);
  await gm.waitForTimeout(2000);
  const rendered = await gm.evaluate(() => {
    const apps = Object.values(ui.windows).map(w => w.constructor.name);
    const mejDom = !!document.querySelector('.monks-enhanced-journal');
    return { apps, mejDom };
  });
  console.log('RENDERED:', JSON.stringify(rendered));
  await gm.screenshot({ path: '../screenshots/tt-repro-14.04.png', fullPage: true });
});
```

**Adaptation note for the executor:** the exact MEJ shop-creation call and the sheet-assertion selectors must match what the current harness shop spec uses — read `test/specs/*shop*.mjs` first and mirror its creation + assertion code; the snippet above is the shape, the existing spec is the source of truth. Also exercise the UI path (open the Enhanced Journal browser via its sidebar button, create a Shop from its new-entry control) as a second check inside the same session.

- [ ] **Step 5: Run it and capture the console**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal/.claude/worktrees/playwright-harness/test
node scratch/tt-repro-14.04.mjs 2>&1 | tee $SCRATCH/repro-console.txt
```

Expected: `REPRODUCED` — `shopSheetRegistered: false`, or `mejGlobal: false`, or ESM import errors in the buffered browser console (the harness prints it on failure). If everything reports healthy and the shop sheet renders, that's `NOT REPRODUCED`.

- [ ] **Step 6: Record the verdict**

Write `$SCRATCH/repro-report.md`: verdict line, the `REGISTRATION`/`RENDERED` output, first console error with stack, screenshot path. **If `NOT REPRODUCED`: STOP the plan here** (spec stop condition) — restore the environment (Step 7), then report to Dan what was ruled out.

- [ ] **Step 7: Restore the dev environment (ALWAYS, even on failure)**

```bash
MOD=~/FoundryVTT-14/Data/Data/modules/monks-enhanced-journal
[ -L "$MOD" ] && { echo "already a symlink"; } || { [ -L "$MOD.devlink" ] && rm -rf "$MOD" && mv "$MOD.devlink" "$MOD"; }
readlink "$MOD"   # expect the repo checkout path
rm -rf ~/FoundryVTT-14/Data/Data/worlds/tt-fresh-shop
```

Then restart Foundry once so world-a sees the symlinked dev module again.

---

### Task 4: Root cause and fix on `hotfix/14.04b`

**Files:**
- Create: branch `hotfix/14.04b` (from tag `14.04-test`)
- Create: `build-release.sh` (committed to the hotfix branch)
- Modify: `module.json` (on the hotfix branch only — version/URLs)
- Possibly modify: whichever source file the root cause implicates (only if the defect is code, and see the gate below)

**Interfaces:**
- Consumes: `$SCRATCH/static-audit.md`, `$SCRATCH/repro-report.md`, `PINNED_COMMIT`/tag `14.04-test`.
- Produces: branch `hotfix/14.04b` containing `build-release.sh` (usage: `./build-release.sh 14.04b-test` → writes `$SCRATCH/release/module.zip` + `module.json`) and a correct `module.json`. Task 5 runs the script verbatim.

- [ ] **Step 1: Decision gate on root cause**

Combine the three evidence sources into one written root-cause statement in `$SCRATCH/root-cause.md`. Two branches:
- **Packaging** (missing/broken file in the zip, source at the pinned commit is fine): proceed with Steps 2–6; no source-code commits beyond `module.json` + `build-release.sh`.
- **Code** (the defect exists in the pinned commit's source): the same bug lives in PR #821. Implement the fix as a commit on `hotfix/14.04b` (never on `backlog-fixes`), continue the plan, and make the PR-#821 implication the first line of the final summary for Dan — no upstream/PR communication.

- [ ] **Step 2: Create the hotfix branch**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal
git switch -c hotfix/14.04b 14.04-test
```

(If the current checkout has skip-worktree pack guards blocking the switch, follow the pack-churn procedure: clear flags, switch, re-flag — see repo memory `foundry-v14-test-env`.)

- [ ] **Step 3: Write the build script**

Requirements: build from a **clean `git archive` of HEAD**, never from the working tree (kills the dirty-tree failure class); patch `module.json` version/URLs deterministically; ship every tracked runtime file (assets included — no `*.png` exclusion); exclude dev-only paths explicitly.

```bash
cat > build-release.sh <<'EOF'
#!/bin/zsh
# Usage: ./build-release.sh 14.04b-test
# Builds $SCRATCH_OUT/module.zip + module.json from a clean archive of HEAD.
set -e
V=$1; [ -n "$V" ] || { echo "usage: build-release.sh <version>"; exit 1; }
OUT=${SCRATCH_OUT:-/tmp/mej-release}/$V
rm -rf "$OUT" && mkdir -p "$OUT/src"
git archive HEAD | tar -x -C "$OUT/src"
cd "$OUT/src"
# dev-only paths that are tracked but must not ship:
rm -rf test docs .github .gitattributes .gitignore CLAUDE.md build-release.sh
python3 - "$V" <<'PY'
import json, sys
v = sys.argv[1]
m = json.load(open('module.json'))
m['version'] = v
m['manifest'] = f"https://github.com/bularzik/monks-enhanced-journal/releases/download/{v}/module.json"
m['download'] = f"https://github.com/bularzik/monks-enhanced-journal/releases/download/{v}/module.zip"
json.dump(m, open('module.json','w'), indent=2)
PY
zip -rq "$OUT/module.zip" .
cp module.json "$OUT/module.json"
echo "built: $OUT/module.zip ($(unzip -l $OUT/module.zip | tail -1 | awk '{print $2}') files)"
EOF
chmod +x build-release.sh
```

**Adaptation note:** the `rm -rf` dev-exclusion list must be reconciled against `git ls-files` on the hotfix branch — remove entries that don't exist there, add any other tracked dev-only paths found. Packs note: `git archive` ships the *tracked* pack files; the skip-worktree churn guard only affects the working tree, so archived pack contents are the committed ones — verify the packs open in the Task 5 install check.

- [ ] **Step 4: Fix `module.json` on the branch**

The tracked `module.json` still carries upstream URLs and `"version": "14.01"`. Commit the fork's correct baseline (the build script overrides version/URLs per release, but the committed file should not point at upstream):

```bash
# edit module.json: id stays monks-enhanced-journal; set version to 14.04b-test,
# manifest/download to the 14.04b-test URLs; compatibility minimum/verified 14 (already true at this commit? verify)
git add module.json build-release.sh
git commit -m "Release plumbing: committed build script + fork URLs in module.json (hotfix/14.04b)"
```

- [ ] **Step 5: Apply the root-cause fix (code branch only)**

If Step 1 concluded *code*: write the failing check first as a harness scratch script (same shape as `tt-repro-14.04.mjs`, pointed at a local build), see it fail, apply the minimal fix, see it pass, commit on the hotfix branch. If Step 1 concluded *packaging*: skip — Steps 3–4 already are the fix.

- [ ] **Step 6: Build and statically verify the candidate artifact**

```bash
./build-release.sh 14.04b-test
# reuse Task 2's audit against the new zip:
rm -rf $SCRATCH/zip-14.04 && mkdir $SCRATCH/zip-14.04 && unzip -q /tmp/mej-release/14.04b-test/module.zip -d $SCRATCH/zip-14.04
cd $SCRATCH && node audit-zip.mjs
```

Expected: `ARTIFACT REFERENCES OK` and zero functional omissions vs `git ls-files` on the branch (all 34 PNGs present, all js/hbs/css/lang/packs).

---

### Task 5: Publish `14.04b-test`, tagged, PR #821 untouched

**Files:**
- Create: GitHub release `14.04b-test` with assets `module.json` + `module.zip`
- Create: git tag `14.04b-test`

**Interfaces:**
- Consumes: `/tmp/mej-release/14.04b-test/{module.zip,module.json}` from Task 4.
- Produces: live manifest URL `https://github.com/bularzik/monks-enhanced-journal/releases/download/14.04b-test/module.json`, consumed by Task 6's verification.

- [ ] **Step 1: Push the hotfix branch and tag**

```bash
git push origin hotfix/14.04b
git tag -a 14.04b-test -m "14.04b-test: 14.04-test + packaging/shop-UI fix (built by build-release.sh)"
git push origin 14.04b-test
```

- [ ] **Step 2: Create the release**

```bash
gh release create 14.04b-test --prerelease --target hotfix/14.04b \
  --title "14.04b test build (14.04 + shop-UI packaging fix)" \
  --notes "Fixes the shop-journal-note-shows-default-UI defect in 14.04-test. Install via this release's module.json manifest URL. See docs/superpowers/specs/2026-08-10-shop-ui-packaging-bug-design.md." \
  /tmp/mej-release/14.04b-test/module.zip /tmp/mej-release/14.04b-test/module.json
```

- [ ] **Step 3: Verify the published manifest round-trips**

```bash
curl -sL https://github.com/bularzik/monks-enhanced-journal/releases/download/14.04b-test/module.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['version'], d['manifest'], d['download'])"
```

Expected: `14.04b-test` with both URLs pointing at the `14.04b-test` release.

- [ ] **Step 4: Verify PR #821 is untouched**

```bash
git rev-parse backlog-fixes origin/backlog-fixes
diff <(git rev-parse backlog-fixes origin/backlog-fixes) $SCRATCH/backlog-fixes-start.sha && echo "PR #821 SAFE"
gh pr view 821 -R ironmonk108/monks-enhanced-journal --json commits --jq '.commits | length'
```

Expected: `PR #821 SAFE` and the same commit count as before this work.

---

### Task 6: Verify the fix end-to-end and keep a reusable smoke test

**Files:**
- Modify: `$SCRATCH/install-from-manifest.sh` (point at 14.04b-test)
- Create: `.claude/worktrees/playwright-harness/test/release-smoke.mjs` (committed to `playwright-harness` branch)
- Create: `$SCRATCH/final-summary.md`

**Interfaces:**
- Consumes: everything above.
- Produces: verified-fix evidence + `test/release-smoke.mjs <manifest-url>` for all future releases.

- [ ] **Step 1: Re-run the Task 3 flow against 14.04b-test**

Repeat Task 3 Steps 1–7 exactly, with the manifest URL swapped to `14.04b-test` and world `tt-fresh-shop` recreated. Expected: `REGISTRATION` healthy (`shopSheetRegistered: true`, `mejGlobal: true`), shop sheet renders with `.monks-enhanced-journal` DOM, clean console, screenshot captured. This is the fix's regression test. Restore the symlink and delete the world afterwards, as before.

- [ ] **Step 2: Promote the repro script to a reusable release smoke test**

Turn `scratch/tt-repro-14.04.mjs` into `test/release-smoke.mjs` taking the manifest URL as `process.argv[2]`: it performs the install-swap (with the symlink guard + restore in a `finally`), fresh-world check, registration + shop-render assertions, then restores. It is a standalone script, NOT auto-run by `run.mjs` (it hits the network and swaps the live module dir). Document it in `test/README.md` under Release zips: "before uploading any release, run `node release-smoke.mjs <manifest-url-or-local-module.json>`".

- [ ] **Step 3: Commit the smoke test on the harness branch**

```bash
cd /Users/danbularzik/Claude/Projects/monks-enhanced-journal/.claude/worktrees/playwright-harness
git add test/release-smoke.mjs test/README.md
git commit -m "test: release-smoke — install-from-manifest + shop-sheet check for published artifacts"
git push origin playwright-harness
```

- [ ] **Step 4: Write the final summary**

`$SCRATCH/final-summary.md` and the closing message to Dan, containing: root cause with evidence; what shipped in `14.04b-test`; the manifest URL for Dan to share on Discord (nothing posted by the agent); PR #821 safety proof; whether `14.05-test` carries the same defect (from the pinned-commit/build-process analysis — if the same zip process built it, say so and recommend the fix ride the next natural `enhancements-test` release, per spec); and, if the root cause was code, the PR-#821 implication as the FIRST line.

---

## Self-review notes

- Spec coverage: Section 1 → Tasks 1–2; Section 2 → Task 3; Section 3/Option 1 → Tasks 4–5; verification + reusable smoke test → Task 6; stop conditions encoded in Task 3 Step 6 and Task 4 Step 1; success criteria 1–5 map to Tasks 1 (tag), 2/3 (evidence), 4–5 (release, PR safety), 6 (smoke test).
- Known uncertainty, flagged inline rather than hidden: exact harness helper signatures (`withSession` world option) and Foundry setup-screen automation — the executor must read `test/helpers/` and the unbundled client source first; the plan marks these with adaptation notes and names the authoritative sources.
- The Task 3 API-level shop creation mirrors the harness's existing shop spec rather than inventing flags — executor mirrors `test/specs/*shop*` verbatim; snippet is shape only.
