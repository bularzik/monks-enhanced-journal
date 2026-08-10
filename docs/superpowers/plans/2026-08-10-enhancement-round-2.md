# Enhancement Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship wave 2 of the fork: four enhancements (`enh/currency-config`, `enh/more-type-attributes`, `enh/detail-field-links`, `enh/deep-search`), one internal-fixes branch, E5 spec-gap completion on `enh/shop-price-tiers`, integrated on `enhancements-test` with the 14.04b fix and released as tagged **14.06-test**.

**Architecture:** Each upstream-issue item lives on its own branch off `backlog-fixes`@964bf19 (exception: `enh/more-type-attributes` stacks on `enh/attribute-visibility`). All verification is scripted through the Playwright harness (`test/` on branch `playwright-harness`, checked out at `.claude/worktrees/playwright-harness/`); specs are written red-first where possible. Integration merges everything into `enhancements-test`, and the release is built from a clean `git archive`.

**Tech Stack:** Foundry VTT v14 (build 14.365) module JS (no bundler, no unit-test runner — the harness is the test cycle), Handlebars templates, libWrapper, Playwright harness (`node run.mjs`), `gh` CLI for releases.

Spec: `docs/superpowers/specs/2026-08-10-enhancement-round-2-design.md`

## Global Constraints

- **No PRs are raised.** Branches are pushed to the fork only.
- `backlog-fixes` / PR #821 is **frozen** — never commit to it, never push it.
- No upstream (ironmonk108) or Discord communication of any kind. Release URLs go to Dan only.
- Never cherry-pick commit **b878a87** (fork plumbing + CRLF flip).
- Base for new branches: `backlog-fixes` @ **964bf19** — except `enh/more-type-attributes`, based on `enh/attribute-visibility` (head 2fe0aab).
- Release rule: annotated tag named exactly `14.06-test` at the built commit, pushed to origin. Older test manifests are NOT repointed.
- Test entities use the `TT-` prefix. One harness instance at a time; before any suite run check `curl -s http://localhost:30000/api/status` shows `"users":0`.
- Defaults must produce **zero behavior change** for existing worlds: every new setting defaults to off/empty/inherit; new attribute sets and tabs default `shown: false`.
- Harness specs are committed to the `playwright-harness` branch (worktree `.claude/worktrees/playwright-harness/`), never to feature branches; release zips must exclude `test/`.
- The main checkout at the repo root is symlinked into Foundry as the live module — check out the branch under test there before running specs; restore `enhancements-test` when done.
- Line numbers in this plan were read on 2026-08-10 at the stated branches; re-verify with grep before editing.

---

## File Structure

| Unit | Files | Responsibility |
|---|---|---|
| currency-config | `settings.js`, `monks-enhanced-journal.js` (~line 266 after the system block), `lang/en.json` | 3 world settings overriding `pricename`/`quantityname`/`currencyname` |
| more-type-attributes | `sheets/EnhancedJournalSheet.js` (hoisted `fieldlist()`), `sheets/{Person,Place}Sheet.js` (delete dupes), `sheets/{Organization,Event,PointOfInterest}Sheet.js`, `templates/sheets/{organization,event,poi}.html`, `settings.js` sheet-settings defaults, `lang/en.json` | attribute rows on 3 more types, opt-in |
| detail-field-links | `templates/sheets/partials/sheet-details.hbs`, `templates/sheets/partials/sheet-detailed-header.hbs`, `sheets/EnhancedJournalSheet.js` (enrich context + listeners + drop) | @UUID drop-to-link + enriched display |
| deep-search | `apps/enhanced-journal.js`, `templates/directory.html`, `styles/` (results list CSS) | full-text on-demand search mode |
| internal-followups | `apps/transfer-currency.js`, `sheets/PersonSheet.js`, `sheets/PlaceSheet.js`, `apps/customise-page.js`, `monks-enhanced-journal.js` (sellItem) | 4 fixes + 1 investigation |
| E5 gap | `apps/adjust-price.js`, `settings.js` (menu entry), `lang/en.json` | world-default Adjust Prices + UX papercuts |
| specs | `.claude/worktrees/playwright-harness/test/specs/` | one spec file per task, TT- fixtures |

Harness conventions: copy the scratch template from `test/README.md`; use existing specs in `test/specs/` as the API reference (`withSession`, login helpers, TT- sweep). Run: `cd .claude/worktrees/playwright-harness/test && node run.mjs <filter>`.

---

### Task 1: `fix/internal-followups` — four concrete fixes

**Files:**
- Modify: `apps/transfer-currency.js:111` (the `_onSubmitForm` remainder read)
- Modify: `sheets/PersonSheet.js:75,94` and `sheets/PlaceSheet.js:105,124` (malformed migration keys)
- Modify: `sheets/PersonSheet.js` + `sheets/PlaceSheet.js` `_prepareBodyContext` migration blocks (GM gate)
- Modify: `apps/customise-page.js` (save throw)
- Test: `.claude/worktrees/playwright-harness/test/specs/internal-followups.mjs` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on; merged at integration (Task 9).

- [ ] **Step 1: Create the branch**

```bash
git checkout -b fix/internal-followups 964bf19
```

- [ ] **Step 2: Write the failing spec**

In the harness worktree create `test/specs/internal-followups.mjs` from the README template with three checks:
1. **transfer-currency:** as GM create a TT- loot page, immediately open Transfer Currency (before any currency flag exists), pick an actor, submit a positive amount → assert no thrown error and the dialog closes (today: `TypeError` reading `remainder[k]` because the flag is undefined).
2. **migration keys:** create a TT- person page and seed a legacy-object attribute via script: `page.setFlag('monks-enhanced-journal','attributes',{ race: { value: 'Elf', hidden: false } })`; render the sheet as GM; then assert `page.flags['monks-enhanced-journal']['sheet-settings']` now contains `attributes.race.shown === true` **and** no stray top-level key path `monks-enhanced-journal.flags…` was written to the document root (today the update targets the malformed key and silently no-ops). Repeat for a place page.
3. **non-GM migration write:** log in as User 1 (observer on the seeded person page), render it, and assert the page's `_stats.modifiedTime` (captured before) is unchanged — a player render must not write.

- [ ] **Step 3: Run the spec, verify it fails**

```bash
cd .claude/worktrees/playwright-harness/test && node run.mjs internal-followups
```
Expected: checks 1–3 FAIL (crash, no-op migration, player-triggered write).

- [ ] **Step 4: Fix transfer-currency**

```js
// apps/transfer-currency.js:111
let remainder = this.options.document.getFlag('monks-enhanced-journal', 'currency') || {};
```

- [ ] **Step 5: Fix the malformed migration keys (4 sites)**

At PersonSheet.js:75/94 and PlaceSheet.js:105/124, replace:

```js
await this.document.update({ 'monks-enhanced-journal.flags.sheet-settings.attributes': sheetSettings });
```
with:
```js
await this.document.update({ 'flags.monks-enhanced-journal.sheet-settings.attributes': sheetSettings });
```
(One of the four sites is the fields-conversion branch; same transposition, same fix. The correct key shape is proven by the round-1 ShopSheet.js:86 fix — check `git log -1 -p --all -S "flags.monks-enhanced-journal.sheet-settings" -- sheets/ShopSheet.js` for the precedent.)

- [ ] **Step 6: Gate the migration blocks to GMs**

Wrap both migration branches (the `changedObjectValues` block and the fields-conversion block) in Person and Place `_prepareBodyContext` so they only run for GMs, mirroring how the rest of MEJ gates writes:

```js
if (game.user.isGM) {
    // existing migration if/else-if chain, unchanged inside
}
```
Non-GM renders take the data as-is (the render context already tolerates object-shaped legacy values for one render; the GM's next open migrates).

- [ ] **Step 7: Fix the CustomisePage save throw**

Repro first (browser console as GM, dnd5e world): `game.settings.set('monks-enhanced-journal','sheet-settings', (() => { let s = game.settings.get('monks-enhanced-journal','sheet-settings'); delete s.shop.adjustment; return s; })())`, then open Customise Pages → Shop → Save. Capture the stack; the throw is in `apps/customise-page.js`'s submit path reading per-type adjustment rows that don't exist. Apply the minimal `|| {}` / optional-chain guard at the exact throwing line so save succeeds and writes a well-formed `adjustment` object. Add this scenario as check 4 in the spec.

- [ ] **Step 8: Run the spec, verify green, plus regression suite**

```bash
node run.mjs internal-followups && node run.mjs
```
Expected: all checks PASS; full suite stays green.

- [ ] **Step 9: Commit (feature branch) and commit the spec (harness worktree)**

```bash
git add -u && git commit -m "Fix transfer-currency crash, Person/Place migration keys, non-GM migration writes, CustomisePage save throw"
cd .claude/worktrees/playwright-harness && git add test/specs/internal-followups.mjs && git commit -m "Spec: internal follow-up fixes"
```

### Task 2: sellItem intermittent crash — investigation (same branch)

**Files:**
- Investigate/Modify: `monks-enhanced-journal.js:3440-3460` (`static async sellItem`)
- Test: extend `.claude/worktrees/playwright-harness/test/specs/internal-followups.mjs`

**Interfaces:** none.

- [ ] **Step 1: Examine the constructor discrepancy**

`sellItem` (line ~3446) constructs `new cls({ document: entry }, { render: false })` while the adjacent `addItem` (line ~3433) uses `new cls(entry, { render: false })`. MEJ sheets are ApplicationV2 subclasses — determine the correct signature from `EnhancedJournalSheet`'s constructor and from every other `new cls(` call site (`grep -n "new cls(" monks-enhanced-journal.js`). The recorded crash is `TypeError: Cannot read properties of null (reading 'name')` at ~line 3439 during the first in-place save after creating a loot item.

- [ ] **Step 2: Build a scripted repro loop**

Harness scratch script: GM + player session; player sells an item to a TT- shop 10 times in a loop (create item → sell → confirm), asserting no console `TypeError` each round. Run against unfixed code — if the crash reproduces, proceed; if 3 runs (30 iterations) stay clean, record the loop + result in the task report and stop (documented as not-reproducible, per spec).

- [ ] **Step 3: Fix if root-caused**

If the mismatched constructor is confirmed as the cause (or another concrete defect is found), apply the minimal fix (e.g. align `sellItem` to the working `addItem` construction), re-run the repro loop ×3 clean, and fold the loop into the spec as a permanent check.

- [ ] **Step 4: Commit**

```bash
git add -u && git commit -m "Fix sellItem sheet construction (intermittent null crash)"   # or commit report only
```

### Task 3: E5 spec-gap on `enh/shop-price-tiers`

**Files:**
- Modify: `apps/adjust-price.js` (no-document world mode: load + save world defaults; tier-row state preservation; Reset; validation classes)
- Modify: `settings.js` (registerMenu entry), `lang/en.json`
- Test: `.claude/worktrees/playwright-harness/test/specs/price-tiers-world.mjs` (new)

**Interfaces:**
- Consumes: existing `MEJHelpers.adjustmentRate` resolution (already on the branch) — world-default tiers are read from `setting("sheet-settings").<type>.adjustment`.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Check out the branch**

```bash
git checkout enh/shop-price-tiers
```

- [ ] **Step 2: Write the failing spec**

`price-tiers-world.mjs`: as GM open module settings → the new "Adjust Prices (world defaults)" menu → define a tier (threshold 100, rate 0.5) with **no document involved** → save → assert `game.settings.get('monks-enhanced-journal','sheet-settings')` carries the tier under the configured type; then create a TT- shop with a 150 gp item and assert the resolved sell price uses the world tier (0.5) when the shop has no local adjustment. Plus UX checks: add a type-row edit, then add a tier row → the type-row edit survives; Reset clears tier rows; a negative tier rate gets the validation class and is clamped on save.

- [ ] **Step 3: Run, verify it fails** (`node run.mjs price-tiers-world`) — menu entry doesn't exist yet.

- [ ] **Step 4: Add the settings menu entry**

```js
// settings.js, after the customise-pages registerMenu block (~line 88)
game.settings.registerMenu(modulename, 'adjustPrices', {
    label: i18n("MonksEnhancedJournal.adjustprices.name"),
    hint: i18n("MonksEnhancedJournal.adjustprices.hint"),
    icon: 'fas fa-money-bill-trend-up',
    restricted: true,
    type: AdjustPrice
});
```
plus the two lang keys. `registerMenu` constructs `new AdjustPrice()` with no options → `this.document` is undefined, which is exactly the dormant world-mode branch (adjust-price.js:73 already reads `defaultAdjustment` when documentless).

- [ ] **Step 5: Make the documentless save path write the world setting**

In `_onSubmitForm`/save (adjust-price.js ~199–209), the else-branch currently still references `this.options.document` (dead/wrong). Replace so that with no document it merges `submitData.adjustment` into `sheet-settings.<type>.adjustment` for each edited type via `game.settings.set('monks-enhanced-journal','sheet-settings', merged)`. Also make the documentless load path read those same world rows (line 73's `defaultAdjustment` source must be `setting("sheet-settings")`, mirroring how `CustomisePage` reads it).

- [ ] **Step 6: Fix the three UX papercuts**

- Before any re-render triggered by add/remove tier row, read the current form state back into the app's working adjustment object (same pattern the type rows use on submit) so unsaved edits survive.
- Reset action: also delete the working tier rows before re-render.
- Tier rate/threshold inputs: copy the class names + input listeners the type-row rate inputs use for negative-clamp validation.

- [ ] **Step 7: Run spec green + full suite** (`node run.mjs price-tiers-world && node run.mjs`).

- [ ] **Step 8: Commit** (branch commit + harness spec commit, as in Task 1 Step 9, message: "Complete E5 §E5.2: world-default Adjust Prices menu + tier UX fixes").

### Task 4: `enh/currency-config` — the three path settings

**Files:**
- Modify: `settings.js`, `monks-enhanced-journal.js` (immediately after the system-specific assignment block ending ~line 266), `lang/en.json`
- Test: `.claude/worktrees/playwright-harness/test/specs/currency-config.mjs` (new)

**Interfaces:**
- Consumes: existing statics `MonksEnhancedJournal.pricename/quantityname/currencyname` and accessors `pricename()/quantityname()/currencyname()`.
- Produces: world settings named exactly `price-attribute`, `quantity-attribute`, `currency-attribute` (Task 5 configures them on the new worlds).

- [ ] **Step 1: Create the branch** — `git checkout -b enh/currency-config 964bf19`

- [ ] **Step 2: Write the failing spec (dnd5e regression + override mechanics)**

`currency-config.mjs`, on world-a:
1. Regression: with all three settings `""`, assert `game.MonksEnhancedJournal.constructor.pricename === "price"` (wording per actual export — verify), currencyname `"currency"`, and a TT- shop item shows its normal gp price.
2. Override: set `quantity-attribute` to `quantity` (identity override — proves a set value is applied without changing behavior) and `price-attribute` to a deliberately bogus path `xyzzy`; reload; assert the TT- shop item's price now reads empty/0 (proves the override reaches the read path); restore both to `""`; reload; assert the original price is restored.
3. Root sentinel: set `currency-attribute` to `.`; reload; assert `MonksEnhancedJournal.currencyname === ""`; restore.

- [ ] **Step 3: Run, verify failure** — settings don't exist, `game.settings.get` throws.

- [ ] **Step 4: Register the settings**

```js
// settings.js, near the other world settings (config:true block)
game.settings.register(modulename, "price-attribute", {
    name: i18n("MonksEnhancedJournal.price-attribute.name"),
    hint: i18n("MonksEnhancedJournal.price-attribute.hint"),
    scope: "world", config: true, default: "", type: String, requiresReload: true
});
game.settings.register(modulename, "quantity-attribute", {
    name: i18n("MonksEnhancedJournal.quantity-attribute.name"),
    hint: i18n("MonksEnhancedJournal.quantity-attribute.hint"),
    scope: "world", config: true, default: "", type: String, requiresReload: true
});
game.settings.register(modulename, "currency-attribute", {
    name: i18n("MonksEnhancedJournal.currency-attribute.name"),
    hint: i18n("MonksEnhancedJournal.currency-attribute.hint"),
    scope: "world", config: true, default: "", type: String, requiresReload: true
});
```
Six lang keys; hints must state: blank = system default, paths are relative to `system.`, `.` in currency-attribute = actor root, and point at Edit Currency for denominations (per spec §1).

- [ ] **Step 5: Apply the overrides**

Immediately after the system-specific `pricename/quantityname/currencyname` assignment chain (monks-enhanced-journal.js ~266, inside the same init-time method — settings are registered by then; verify `setting()` is callable there, else move to the `ready` assignment point):

```js
if (setting("price-attribute")) MonksEnhancedJournal.pricename = setting("price-attribute");
if (setting("quantity-attribute")) MonksEnhancedJournal.quantityname = setting("quantity-attribute");
let currencyAttribute = setting("currency-attribute");
if (currencyAttribute) MonksEnhancedJournal.currencyname = (currencyAttribute === "." ? "" : currencyAttribute);
```

- [ ] **Step 6: Spec green + full suite; commit** ("Add configurable price/quantity/currency attribute paths (#569)"), spec committed to harness branch.

### Task 5: currency-config validation on Mythras + Symbaroum

**Files:**
- Create: Foundry worlds `test-mythras`, `test-symbaroum` (Foundry data, not repo)
- Test: `.claude/worktrees/playwright-harness/test/specs/currency-systems.mjs` (new)
- Docs: append world facts to the harness `test/README.md`

**Interfaces:**
- Consumes: Task 4's three settings.

- [ ] **Step 1: Install both systems** via Foundry's setup API (Foundry running, no world active):
POST to `http://localhost:30000/setup` `{"action":"installPackage","type":"system","id":"mythras"}` — if the manifest id differs, look it up on the Foundry package registry (`https://foundryvtt.com/packages/mythras`, `/packages/symbaroum`) and use the manifest URL form of the same endpoint. Then create worlds `TT-appropriate`? No — worlds persist: name them `Test Mythras` / `Test Symbaroum` (id `test-mythras`, `test-symbaroum`), matching the seven existing test worlds, via the `/create` flow used on 2026-07-24 (see `foundry-v14-test-env` memory). Enable MEJ + lib-wrapper in each.

- [ ] **Step 2: Discover the real schemas.** In each world, via script: create one sample actor + one equipment-ish item, dump `actor.system` and `item.system`, and record: currency location (e.g. Symbaroum: `system.money.thaler/shilling/orteg` — verify live), price attribute, quantity attribute. **STOP CONDITION (spec):** if currency is not a plain readable/writable object path (e.g. stored as embedded items), stop and report to Dan before expanding scope.

- [ ] **Step 3: Write `currency-systems.mjs`.** Parameterized over the two worlds: launch world → as GM run Edit Currency defining the system's denominations with convert rates → set the three path settings to the discovered schema values → reload → create TT- shop, drag the sample item in, assert its price renders (non-empty, correct value) → player purchase: assert item lands on the actor and the currency path decremented correctly → player sell to a TT- loot page: assert currency incremented. Restore world-a as active world at the end.

- [ ] **Step 4: Run to green.** Fix path-handling bugs in Task 4's code if the real schemas expose any (e.g. nested `{value:}` shapes — `getCurrency` already handles `hasOwnProperty("value")`, EnhancedJournalSheet.js:1056/1242).

- [ ] **Step 5: Commit** spec + README world notes to the harness branch; any code fixes to `enh/currency-config` ("Validate currency config on Mythras/Symbaroum").

### Task 6: `enh/more-type-attributes`

**Files:**
- Modify: `sheets/EnhancedJournalSheet.js` (add `fieldlist()`), `sheets/PersonSheet.js:134-151` + `sheets/PlaceSheet.js` (delete duplicate `fieldlist()`), `sheets/OrganizationSheet.js`, `sheets/EventSheet.js`, `sheets/PointOfInterestSheet.js`, `templates/sheets/organization.html`, `templates/sheets/event.html`, `templates/sheets/poi.html`, `settings.js` (sheet-settings defaults), `lang/en.json`
- Test: `.claude/worktrees/playwright-harness/test/specs/more-type-attributes.mjs` (new)

**Interfaces:**
- Consumes: E2's `playerHidden` filtering inside `fieldlist()` (branch base = `enh/attribute-visibility` @ 2fe0aab).
- Produces: `EnhancedJournalSheet.prototype.fieldlist()` — Task 7 relies on `detailFields` context items keeping shape `{id, name, value, full, playerHidden}`.

- [ ] **Step 1: Create the stacked branch** — `git checkout -b enh/more-type-attributes enh/attribute-visibility`

- [ ] **Step 2: Write the failing spec.** `more-type-attributes.mjs`: GM opens Customise Pages → Organization → attributes tab exists with the default rows all unchecked; enable `leader` + one custom attribute and enable the `entry-details` tab; create TT- organization; assert the details tab renders both rows; set `leader` playerHidden (E2 checkbox); player render (Observer) omits the leader row; regression: TT- person's detailFields DOM unchanged vs. today (snapshot the `<li>` list before/after branch).

- [ ] **Step 3: Run red** (`node run.mjs more-type-attributes`).

- [ ] **Step 4: Hoist `fieldlist()`.** Move PersonSheet.js:134-151's method verbatim into `EnhancedJournalSheet` (after `sheetSettings()`, ~line 160); delete the copies in PersonSheet and PlaceSheet; verify with `git diff` that the deleted bodies are byte-identical to the hoisted one (if Place's differs, reconcile and note it in the report).

- [ ] **Step 5: Defaults for the three types.** In settings.js `sheet-settings` default, add to `organization`, `event`, and `poi` blocks: an `entry-details` tab entry `{ name: 'MonksEnhancedJournal.Details', shown: false }` and an `attributes` object, all `shown: false`:
  - organization: `leader`, `headquarters`, `scope`, `alignment`, `founded`
  - event: `date`, `duration`, `outcome`
  - poi: `region`, `terrain`, `discovered`
  (lang keys `MonksEnhancedJournal.Leader` etc.; reuse existing keys where present — grep `lang/en.json` first.)

- [ ] **Step 6: Wire the sheets.** For each of the three sheets: add `"modules/monks-enhanced-journal/templates/sheets/partials/sheet-details.hbs"` to `PARTS.main.templates`; add the `entry-details` tab to `TABS` mirroring PersonSheet's entry (tab visibility is already driven by sheet-settings tabs `shown`); in `_prepareBodyContext` add `context.detailFields = this.fieldlist();`; in the three page templates add the details-tab section by copying `templates/sheets/person.html`'s `entry-details` tab block (the `{{> …sheet-details.hbs}}` include and its wrapper) verbatim, adjusting only the tab id wiring if the template uses per-type ids.

- [ ] **Step 7: Spec green + full suite; commit** ("Add configurable attributes to Organization/Event/POI (#503, #523)") + harness spec commit.

### Task 7: `enh/detail-field-links`

**Files:**
- Modify: `templates/sheets/partials/sheet-details.hbs`, `templates/sheets/partials/sheet-detailed-header.hbs`, `sheets/EnhancedJournalSheet.js` (context enrichment + listeners), CSS file already holding `.details-section` rules (grep `styles/` for it)
- Test: `.claude/worktrees/playwright-harness/test/specs/detail-field-links.mjs` (new)

**Interfaces:**
- Consumes: `detailFields` item shape `{id, name, value, full, playerHidden}` (Task 6 hoists the producer, but this branch bases on 964bf19 where Person/Place still own `fieldlist()` — enrich at the template/context seam so both bases work: compute enrichment where `detailFields`/`fields` are put on context in **EnhancedJournalSheet**, via a shared helper).
- Produces: helper `EnhancedJournalSheet.prototype.enrichFields(fields)` → same array with added `enriched` (string|null).

- [ ] **Step 1: Create the branch** — `git checkout -b enh/detail-field-links 964bf19`

- [ ] **Step 2: Write the failing spec.** `detail-field-links.mjs`: GM opens TT- person; drags a TT- journal entry from the sidebar onto the Location header field → assert input value becomes `@UUID[JournalEntry.<id>]{<name>}`; after save, the field shows an enriched `<a class="content-link">`; clicking it opens that entry in the MEJ browser; double-click swaps back to the raw input containing the syntax; as player, the enriched link renders and opens; a field without link syntax renders a bare input identical to a pre-branch DOM snapshot.

- [ ] **Step 3: Run red.**

- [ ] **Step 4: Context enrichment helper** in EnhancedJournalSheet:

```js
async enrichFields(fields) {
    for (let f of fields) {
        f.enriched = (typeof f.value === "string" && /@\w+\[[^\]]+\]/.test(f.value))
            ? await foundry.applications.ux.TextEditor.implementation.enrichHTML(f.value, { relativeTo: this.document, secrets: this.document.isOwner })
            : null;
    }
    return fields;
}
```
Call it on `detailFields` and the header `fields` arrays wherever sheets put them on context (Person/Place `_prepareBodyContext`; the calls are one-line `await this.enrichFields(...)` wraps).

- [ ] **Step 5: Templates.** In both partials, wrap each input:

```handlebars
{{#if field.enriched}}
<div class="mej-field-display" data-field="{{field.id}}">{{{field.enriched}}}</div>
<input type="text" class="mej-field-edit" style="display:none" name="flags.monks-enhanced-journal.attributes.{{field.id}}" value="{{ field.value }}" />
{{else}}
<input type="text" name="flags.monks-enhanced-journal.attributes.{{field.id}}" value="{{ field.value }}" />
{{/if}}
```
(Textarea/full variant and header-field variant analogous — header inputs keep their `flags.monks-enhanced-journal.{{field.id}}` names.)

- [ ] **Step 6: Listeners** (in the sheet's activate-listeners path): dblclick on `.mej-field-display` → hide div, show + focus its sibling input; blur → submit form (existing change-submit machinery re-renders into display mode). Drop: `dragover` preventDefault + `drop` handler on `.document-details input, .document-details textarea, .details-section textarea` and the header field inputs — parse `TextEditor.implementation.getDragEventData(event)`, and if `data.uuid` exists, insert `@UUID[${data.uuid}]{${(await fromUuid(data.uuid))?.name ?? "Link"}}` at the cursor (`setRangeText`), then trigger `change`. Content-link clicks inside `.mej-field-display` already route through MEJ's document click handling — verify the openJournalEntry path is hit; if the generic content-link handler bypasses MEJ, bind MEJ's existing link-click delegate (same one the description editor display uses) to the display div's links.

- [ ] **Step 7: Spec green + full suite; commit** ("Detail fields accept @UUID drops and render enriched links (#66, #203)") + harness spec commit.

### Task 8: `enh/deep-search`

**Files:**
- Modify: `apps/enhanced-journal.js` (search handling ~lines 221-238, 1785; new methods `deepSearch`, `_renderSearchResults`), `templates/directory.html` (results list container), MEJ styles file holding directory CSS (grep `styles/` for `.directory-list`)
- Test: `.claude/worktrees/playwright-harness/test/specs/deep-search.mjs` (new)

**Interfaces:**
- Consumes: `MonksEnhancedJournal.openJournalEntry(entry, options)`; `EnhancedJournalSheet.sheetSettings()` statics for playerHidden filtering; `getMEJType`-style flag reads.
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Create the branch** — `git checkout -b enh/deep-search 964bf19`

- [ ] **Step 2: Write the failing spec.** `deep-search.mjs`: seed three TT- entries — page body containing `xyzqmarker`, a person with attribute value `xyzqmarker`, a quest with an objective `find the xyzqmarker`; GM toggles the MEJ directory search mode to full, types `xyzqmarker`, Enter → results list shows exactly 3 rows with correct entry names + snippets (attribute row prefixed with its field label); click row 2 opens the person in MEJ; ✕ restores the tree. Player pass: mark the person attribute playerHidden (needs E2? — **no**: on 964bf19 base there is no playerHidden, so the player check is: player search returns only entries they can observe; give the player no permission on the quest → 1 fewer result). Name-mode regression: typing in name mode still live-filters the tree.

- [ ] **Step 3: Run red.**

- [ ] **Step 4: Implement the scan** in `apps/enhanced-journal.js`:

```js
async deepSearch(query) {
    const q = query.toLowerCase();
    const strip = (html) => { const d = document.createElement("div"); d.innerHTML = html || ""; return d.textContent || ""; };
    const snippet = (text, label) => {
        const i = text.toLowerCase().indexOf(q);
        if (i < 0) return null;
        const s = Math.max(0, i - 40), e = Math.min(text.length, i + q.length + 40);
        return `${label ? label + ": " : ""}${s > 0 ? "…" : ""}${text.slice(s, e)}${e < text.length ? "…" : ""}`;
    };
    let results = [];
    for (let entry of game.journal) {
        if (!entry.testUserPermission(game.user, "OBSERVER")) continue;
        let matches = [];
        for (let page of entry.pages) {
            if (!page.testUserPermission(game.user, "OBSERVER")) continue;
            let hit = snippet(page.name, null) || snippet(strip(page.text?.content), null);
            if (hit) matches.push(hit);
            const flags = page.flags["monks-enhanced-journal"] || {};
            for (let [k, v] of Object.entries(flags.attributes || {}))
                { let h = typeof v === "string" && snippet(v, k); if (h) matches.push(h); }
            for (let key of ["role", "location"])
                { let h = typeof flags[key] === "string" && snippet(flags[key], key); if (h) matches.push(h); }
            for (let obj of Object.values(flags.objectives || {}))
                { let h = obj?.title && snippet(obj.title, "objective"); if (h) matches.push(h); }
            for (let item of Object.values(flags.items || {}))
                { let h = item?.name && snippet(item.name, "item"); if (h) matches.push(h); }
            let notes = typeof flags.notes === "string" ? snippet(strip(flags.notes), "notes") : null;
            if (notes) matches.push(notes);
        }
        let nameHit = snippet(entry.name, null);
        if (nameHit) matches.unshift(nameHit);
        if (matches.length) results.push({ entry, snippets: matches.slice(0, 3) });
    }
    return results;
}
```
Player-hidden attributes: when the E2 branch is present (integration), attributes carry per-field `playerHidden` in sheet-settings — filter them for non-GMs by checking the page type's merged `sheetSettings().attributes[k]?.playerHidden`. Write the guard defensively (`?.`) so it compiles on this branch's base too, and note it for integration verification.

- [ ] **Step 5: Wire the trigger + results panel.** In deep-search mode (`this.collection.searchMode !== NAME` — reuse the existing toggle context at line 221), a `keydown` Enter on `input[name="search"]` calls `deepSearch`, hides the folder tree, and renders `<ol class="mej-search-results">` rows (entry name + type icon from the sheet config + snippets); row click → `MonksEnhancedJournal.openJournalEntry(entry)`; ✕/empty query → remove the panel, restore the tree. In name mode, do not intercept — the existing SearchFilter at :1785 keeps working. Add minimal CSS for `.mej-search-results` (row layout, snippet in muted small text, dark-mode-safe using existing `--mej-*` vars).

- [ ] **Step 6: Spec green + full suite; commit** ("Deep search across entries and MEJ fields in the directory (#42, #210)") + harness spec commit.

### Task 9: Integration on `enhancements-test`

**Files:** merges only.

- [ ] **Step 1: Cherry-pick the 14.04b fix**

```bash
git checkout enhancements-test
git cherry-pick 302e778 3d00a29
```
Expected: trivial conflict in `monks-enhanced-journal.js` where the altOpensOutside insertion sits — resolve by keeping BOTH the round-1 method and the hotfix's `waitForFirstPage`/render-patch additions. Never pick b878a87.

- [ ] **Step 2: Merge the six branches, one at a time, harness suite between each**

```bash
for b in fix/internal-followups enh/shop-price-tiers enh/more-type-attributes enh/currency-config enh/detail-field-links enh/deep-search; do
  git merge --no-ff $b   # resolve, then run suite before the next merge
done
```
After `enh/more-type-attributes` + `enh/detail-field-links` are both in: verify enrichment flows through the hoisted `fieldlist()` for the three new types (spec `detail-field-links` re-run must pass on an Organization field too — extend the spec with that one check now). After `enh/deep-search` merges onto E2: verify the playerHidden search guard live (hidden attribute no longer matched for players) and extend `deep-search.mjs` with that check.

- [ ] **Step 3: Full QA gate**

```bash
cd .claude/worktrees/playwright-harness/test && node run.mjs
```
All specs (old 8 + new 6) green against `enhancements-test`, world-a. Then the two system worlds: `node run.mjs currency-systems`. Zero MEJ console errors throughout.

- [ ] **Step 4: Push branches** (not backlog-fixes): `git push origin fix/internal-followups enh/shop-price-tiers enh/more-type-attributes enh/currency-config enh/detail-field-links enh/deep-search enhancements-test` and push the harness branch from its worktree.

### Task 10: Release 14.06-test

**Files:** none in repo (release artifacts + outcomes doc).

- [ ] **Step 1: Final whole-branch review gate.** (Run by the SDD controller on the most capable model — do not release before it returns clean.)

- [ ] **Step 2: Build + release**

```bash
git checkout enhancements-test
./build-release.sh 14.06-test    # builds from git archive HEAD; verify zip lacks test/
gh release create 14.06-test /tmp/mej-release/14.06-test/module.zip /tmp/mej-release/14.06-test/module.json \
  --repo bularzik/monks-enhanced-journal --prerelease --title "14.06-test" --notes "<summary incl. 14.04b shop fix + wave-2 features>"
git tag -a 14.06-test -m "Release 14.06-test" HEAD && git push origin 14.06-test
```
(build-release.sh currently stamps its version/urls — pass/patch for 14.06-test per its usage.)

- [ ] **Step 3: Post-publish smoke**

```bash
cd .claude/worktrees/playwright-harness/test && node release-smoke.mjs https://github.com/bularzik/monks-enhanced-journal/releases/download/14.06-test/module.json
```
Expected: SMOKE PASSED (fresh install from live manifest; shop UI opens — proving the 14.04b fix shipped).

- [ ] **Step 4: Outcomes doc + wrap.** Write `docs/superpowers/triage/2026-08-10-enhancement-round-2-outcomes.md` (per-branch results table, logged-not-fixed list, release URL), commit to `enhancements-test`. Do not repoint older manifests. Report the URL to Dan only.
