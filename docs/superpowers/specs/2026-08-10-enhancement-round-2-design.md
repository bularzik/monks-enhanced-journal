# Enhancement Round 2 — Design

Date: 2026-08-10
Status: approved by Dan (sections approved individually in session; this document is the consolidated spec)

## Goal

Ship the second wave of fork enhancements/fixes: four demand-ranked enhancements from the upstream backlog, one internal-fixes branch hardening earlier rounds, and the E5 spec-gap completion — each upstream-issue item on its own branch for a later standalone PR, integrated and released as **14.06-test**.

## Ground rules (binding)

- **No PRs are raised** this round. Branches are pushed to the fork for later PRs when upstream is ready.
- **One branch per upstream-issue item.** Fixes for issues discovered during our own work are bundled into the minimum number of branches that make sense (Dan's rule, 2026-08-10).
- `backlog-fixes` / PR #821 is **frozen** — never commit to or push it.
- No upstream or Discord communication of any kind; release URLs go to Dan only.
- Every release gets an annotated git tag named after the release, pushed to origin (repo CLAUDE.md rule).
- Older test-release manifests are NOT repointed.
- Never cherry-pick b878a87 (fork plumbing, CRLF flip).
- Test entities use the `TT-` prefix; scripted Playwright harness (`test/`, branch `playwright-harness`) is the QA workhorse, not MCP browsing.

## Branch topology (Approach A, approved)

Base for all new branches: `backlog-fixes` @ **964bf19** (same base as round 1, keeping each branch a standalone upstream PR), with one exception:

| Branch | Base | Issues | Content |
|---|---|---|---|
| `enh/currency-config` | 964bf19 | #569, #321/#746, #656/#755 | Configurable price/quantity/currency attribute paths |
| `enh/more-type-attributes` | `enh/attribute-visibility` (stacked) | #503/#523 | Attributes for Organization/Event/POI |
| `enh/detail-field-links` | 964bf19 | #66/#203 | @UUID links in detail fields |
| `enh/deep-search` | 964bf19 | #42/#210 | Full-text on-demand search in MEJ directory |
| `fix/internal-followups` | 964bf19 | (internal) | Medium-severity deferred fixes from rounds 1–3 |
| `enh/shop-price-tiers` (existing) | — | #603 | E5 spec-gap: world-default Adjust Prices entry + UX papercuts |

`enh/more-type-attributes` stacks on `enh/attribute-visibility` because it reuses the exact dialogs/templates and `playerHidden` filtering E2 rewrote; upstream has stacked-PR precedent (#821 on #820). Its future PR is raised stacked, or flattened at PR time if E2 has merged by then.

Integration: `enhancements-test` (continues from 00486c7/ee1c1d2). Rejected alternatives: basing branches on `enhancements-test` (future PRs would drag in round-1 content) and full sequential stacking (needless PR dependency chain).

## §1 `enh/currency-config` — #569, #321/#746 (Mythras), #656/#755 (Symbaroum)

The triage report calls system currency/price mapping "the single largest recurring theme (7+ related issues)."

**Existing state:** the currency *list* is already configurable (Edit Currency app → `currency` world setting, falling back to the hardcoded `defaultCurrencies`, which is `[]` for unknown systems). What is NOT configurable are three hardcoded attribute paths set per-system at init (monks-enhanced-journal.js ~239–266): `MonksEnhancedJournal.pricename` (item price attribute, default `"price"`), `quantityname` (default `"quantity"`), `currencyname` (actor currency location, default `"currency"`). On unsupported systems MEJ cannot read item prices or move money on actors — this is what actually breaks shops/loot for Mythras and Symbaroum.

**Change:** three new world settings, visible in module settings (text inputs):

- `price-attribute` — item price attribute path (e.g. `cost`, `technology.cost`)
- `quantity-attribute` — item quantity attribute path
- `currency-attribute` — actor currency attribute path (relative to `system.`)

Default `""` = inherit MEJ's built-in per-system value → **zero behavior change for existing worlds unless set**. When non-empty, the setting overrides the corresponding `MonksEnhancedJournal.*name` static at ready; changes prompt the standard reload. Because `currencyname = ""` is already meaningful (age-system: denominations at actor root), the literal value `.` in the setting means actor-root, documented in the hint. Setting hints cross-reference the Edit Currency app so unsupported-system users get the full recipe: define denominations there, point the paths here.

**Error handling:** paths flow through the existing `getValue`/`getProperty` machinery; a wrong path degrades exactly like today's unsupported-system behavior (empty price, no crash). No extra validation UI.

**Testing:** create **Test Mythras** and **Test Symbaroum** worlds (free systems, added to the test-world set). Playwright spec per system: define 2 custom currencies via Edit Currency, set the three paths to the system's real schema, GM creates a TT- shop and adds a system item (price read correctly), player purchases (item delivered, currency deducted at the configured path), player sells to loot. Regression spec on dnd5e: untouched settings produce byte-identical behavior.

## §2 `enh/more-type-attributes` — #503/#523 (stacked on `enh/attribute-visibility`)

**Existing state:** Person and Place render GM-configurable attribute rows via a `fieldlist()` method (duplicated in both sheets; reads sheet-settings `attributes`, applies E2's `playerHidden` filter) plus the `templates/sheets/partials/sheet-details.hbs` partial, configured through Customise Pages — whose internal type list already enumerates all eight page types, but only Person/Place sheets consume attributes.

**Change:**

- Hoist `fieldlist()` into the shared base `EnhancedJournalSheet` (Person/Place delegate; behavior byte-identical).
- Wire the `sheet-details.hbs` partial + `detailFields` context into **Organization, Event, and POI** sheets.
- Each new type gets a small default attribute set (e.g. Organization: Leader, Headquarters, Scope, Alignment) registered in sheet-settings **with `shown: false` by default** — existing worlds see zero visual change until a GM enables attributes in Customise Pages.
- The Customise Pages attributes tab for these types works end-to-end: define/reorder/show/hide + per-attribute player visibility (E2).

**Excluded:** Quest, Shop, Encounter — specialized layouts where generic attribute rows would clutter; may follow later.

**Testing:** Playwright spec — enable two attributes on Organization via Customise Pages, set values, GM sees rows, player render omits a `playerHidden` attribute (same DOM assertions as E2's spec). Regression: Person/Place `fieldlist()` output identical after the hoist.

## §3 `enh/detail-field-links` — #66/#203

**Existing state:** every detail/attribute field is a bare `<input>`/`<textarea>` (attribute rows in `sheet-details.hbs`, header fields like Person Role/Location in `sheet-detailed-header.hbs`); `@UUID[…]` text is never enriched and documents cannot be dropped onto fields.

**Change:**

1. **Drop-to-link:** detail inputs accept document drops (any document with a UUID; journal entries/pages are the primary case). A drop inserts `@UUID[<uuid>]{<name>}` at the cursor. Data stays plain text in the flag — exports/imports untouched.
2. **Enriched display mode:** a field whose saved value contains a content-link pattern renders as an enriched clickable div; links route through MEJ's normal click handling (open in MEJ browser, respect round-1 open-behavior settings). Double-click swaps to the raw input for editing; blur/save returns to display. The named input stays present-but-hidden in display mode so form submission is unchanged. **Fields with no link pattern render exactly as today.**

Applies to both `sheet-details.hbs` (including `full` textareas) and the header-fields partial. §2's types inherit automatically at integration.

**Testing:** Playwright spec — drop a TT- journal onto Person's Location field (syntax inserted), saved sheet shows enriched link, click opens target in MEJ, double-click restores raw editing, player render enriched; regression: link-free fields DOM-identical to today.

## §4 `enh/deep-search` — #42/#210 (approved scope: full-text, on-demand, no index)

**Existing state:** MEJ's directory panel has core's name-filter `SearchFilter` and reads the collection `searchMode`, but in practice only name filtering works, and core's full-text mode knows nothing about MEJ flag data.

**Change:**

1. **Trigger:** the directory search box gains the core-style mode toggle (name filter ↔ deep search). In deep-search mode, Enter runs an on-demand scan. Name mode stays the default; normal directory use is untouched.
2. **Scan coverage:** every journal entry the user can observe (ownership respected — players search only what they could open): entry/page names, page text content (HTML-stripped), and MEJ flag fields — attributes/detail fields, Person/Place role & location, quest objectives, shop/loot item names, notes. Case-insensitive substring match. Player scans exclude `playerHidden` attributes (E2).
3. **Results panel:** the directory list swaps to a flat results list — entry name, type icon, context snippet around the match (flag hits prefixed with their field name). Click opens via `openJournalEntry` (round-1 open-behavior settings apply). ✕ or empty query restores the tree.

**Performance:** on-demand scan only on explicit Enter; hundreds of entries scan in milliseconds; no persistent index, no hooks on document updates.

**Testing:** Playwright spec — seed TT- entries with a marker string in (a) page body, (b) an attribute, (c) a quest objective; deep search finds all three with correct snippets; click-through opens the right entry; player scan excludes a hidden-attribute hit and an unowned entry; name-mode regression.

## §5a `fix/internal-followups` — internal discoveries from rounds 1–3

One branch (internal discoveries, not upstream issues):

1. **transfer-currency crash:** `getFlag('currency')` missing `|| {}` at the pre-check site (transfer-currency.js ~line 111) throws for loot pages that never had a currency flag, blocking submission.
2. **Person/Place migration keys:** malformed keys at PersonSheet.js:75/94 and PlaceSheet.js:105/124 (same class as the fixed ShopSheet.js:86); legacy attribute migration silently no-ops.
3. **Unguarded migration write** in `PersonSheet._prepareBodyContext` on non-GM renders.
4. **CustomisePage save throw** when world sheet-settings lacks per-type adjustment rows.
5. **sellItem intermittent null crash** (monks-enhanced-journal.js:3439, first in-place save after creating a loot item) — *investigation task*: scripted repro loop; fix if root-caused, document as not-reproducible if not.

Trivial Low findings are folded in only when they live in a file already being touched. Line numbers above are as recorded in the round-1–3 outcomes docs — verify against current code at implementation time.

## §5b E5 spec-gap — applied directly to `enh/shop-price-tiers`

That branch is the future #603 PR, so its spec-completion work lands on it:

- A settings-menu entry constructing Adjust Prices without a document, making **world-default price tiers reachable** (the branch's world-tier resolution code is currently dead; completes round-1 spec §E5.2).
- Adjust-Prices UX papercuts: add/remove tier no longer discards unsaved type-row edits; Reset clears tier rows; tier inputs get the negative-clamp validation classes.

## §6 Integration, testing, release

- `enhancements-test` continues (base: current head). Order: cherry-pick 14.04b fix commits **302e778 + 3d00a29** (known trivial conflict with the altOpensOutside insertion — keep both), then merge `fix/internal-followups`, updated `enh/shop-price-tiers`, `enh/more-type-attributes`, `enh/currency-config`, `enh/detail-field-links`, `enh/deep-search`.
- **Harness:** each feature ships its Playwright spec in `test/` (playwright-harness worktree) alongside implementation; full suite + new specs run against the integration branch as the QA gate. Single-instance rule and `/api/status` users:0 pre-flight apply.
- **Final review:** whole-branch review on the most capable available model before release (round 1 caught both cross-feature Criticals this way).
- **Release 14.06-test** from `enhancements-test` via `build-release.sh` (builds from `git archive HEAD`; zip excludes `test/`); annotated tag `14.06-test` pushed; `release-smoke.mjs` run against the live published manifest (also proves the 14.04b shop fix is in the shipped build). Release URL reported to Dan only.
- Outcomes doc written to `docs/superpowers/triage/` at close.

## Out of scope

Bestiary (#197/#248), new journal types/Rooms (#60/#108), backlinks (#35/#426), indexed search with in-page highlighting, style presets (#217/#514/#647), third-party integrations (Auctioneer #616/#619, MAT #469/#701, Better Roll Tables #269, GURPS #258), Actors-as-relationships (#449/#434), repointing older manifests, raising any PRs.

## Stop conditions

- If a stacked-base conflict makes `enh/more-type-attributes` unmergeable into integration, stop and consult Dan before flattening.
- If Mythras/Symbaroum schemas turn out to need more than path configuration (e.g. currency stored as embedded items), report findings and get a scope ruling before expanding the design.
