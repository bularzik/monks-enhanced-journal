# Enhancement Round 2 — Outcomes

Date: 2026-08-10
Spec: `docs/superpowers/specs/2026-08-10-enhancement-round-2-design.md` · Plan: `docs/superpowers/plans/2026-08-10-enhancement-round-2.md`
Base: `backlog-fixes` @ 964bf19 (stacked branch off `enh/attribute-visibility` @ 2fe0aab) · Integration: `enhancements-test` @ dc5893b (pushed) · Release: [14.06-test](https://github.com/bularzik/monks-enhanced-journal/releases/tag/14.06-test) (annotated tag at dc5893b, pushed)

Install URL: `https://github.com/bularzik/monks-enhanced-journal/releases/download/14.06-test/module.json` — older test manifests NOT repointed. No PRs raised (each branch becomes its own upstream PR when upstream is ready). Post-publish `release-smoke.mjs` against the live manifest: SMOKE PASSED (fresh manifest install, all 12 MEJ page types + ShopSheet registered).

## Per-branch results

| Branch (HEAD, pushed) | Issues | Result |
|---|---|---|
| `fix/internal-followups` (cc09843) | internal | Transfer-currency `\|\| {}` crash guard; Person/Place malformed migration keys (`monks-enhanced-journal.flags.…` → `flags.monks-enhanced-journal.…`, 4 sites) + migration GM-gated; CustomisePage save guard for missing per-type adjustment rows; **sellItem "intermittent" crash root-caused as deterministic** — free-sell mode emits `sellItem` without `actorId`, `fromUuid(undefined).name` threw; guarded (addLog path unaffected). Constructor-signature lead disproven via core's `_migrateConstructorParams`. |
| `enh/shop-price-tiers` (8800043) | #603 | E5 §E5.2 completed: `adjustPrices` settings menu constructs the dialog documentless; world rows load/save at `sheet-settings.<type>.adjustment`; `ShopSheet.convertItems` redirected off the dead `adjustment-defaults` setting (was silently ignoring world tiers); tier UX fixes (add/remove preserves unsaved edits, Reset clears tiers, negative-clamp validation). |
| `enh/currency-config` (5135e71) | #569, #321/#746, #656/#755 | Three world settings: `price-attribute`, `quantity-attribute`, `currency-attribute` ("" = system default, `.` = actor root), overriding pricename/quantityname/currencyname at init. Validated end-to-end on **new permanent worlds Test Mythras + Test Symbaroum**: Symbaroum fully (money.thaler/shilling/orteg, cost, number — purchase deducts, sell credits); Mythras via MEJ's pre-existing embedded-item currency branch + Edit Currency + price-attribute=`value` (price render + delivery proven; currency credit blocked by a pre-existing MEJ bug, logged below). Zero product-code changes needed for validation. |
| `enh/more-type-attributes` (9a3238d, stacked on attribute-visibility) | #503/#523 | `fieldlist()` hoisted byte-identically to EnhancedJournalSheet; Organization (leader/headquarters/scope/alignment/founded), Event (date/duration/outcome), POI (region/terrain/discovered) get attributes + entry-details tab — all `shown:false` by default (zero visual change until enabled in Customise Pages, which needed no code changes). |
| `enh/detail-field-links` (467fd33) | #66/#203 | Detail + header fields accept document drops (insert `@UUID[…]{…}` at cursor) and render enriched clickable links (dual-mode: display div + hidden input, dblclick to edit, 300ms click/dblclick disambiguation); dataset-driven link resolution (any enrichable type; `.broken` inert); clicks route through MEJ's `_onClickDocumentLink` delegates (respect open-behavior settings). Final-review fix: all five non-Person/Place sheets' header fields now enrich too. |
| `enh/deep-search` (3b4ec52) | #42/#210 | Directory search-mode toggle (previously dead button) + on-demand full-text scan: entry/page names, HTML-stripped page text, attributes, role/location, objective titles, item names. Permission-correct after two hardening rounds: secret sections stripped for non-owners; unavailable objectives, hidden items, closed-shop inventories, unidentified real names, and page-level playerHidden attributes all excluded from player scans. Results panel with labeled snippets; clicks follow the standard open pattern (core-sheet fallback under `mej-only-types`). |

Integration also cherry-picked the 14.04b shop-UI fix (302e778 + 3d00a29) onto `enhancements-test` — kept both `altOpensOutside` and `waitForFirstPage` (expected conflict, resolved as planned). b878a87 never cherry-picked.

## Process summary

10-task SDD run, 4 fix rounds at task level (Task 3 convertItems source; Task 5 world-restore finally + scoped error tolerance; Task 7 generic link resolution; Task 8 secret-section leak — a Critical caught by task review) + 1 final-review fix wave (fable whole-branch review found the three remaining deep-search leak gates C1, the five unenriched header-field types I1, and the silent result-click no-op I2). One spec stop condition fired (Mythras embedded-item currency) → Dan ruled validate-both-no-new-code. Release gate: full 15-spec harness suite ×2 green (incl. renamed `zz-currency-systems.mjs`, which now runs last — fixes an alphabetical-order flake with world-switching), zero MEJ console errors.

Harness additions (branch `playwright-harness` @ c639461, pushed): 6 new specs (internal-followups, price-tiers-world, currency-config, zz-currency-systems, more-type-attributes, detail-field-links, deep-search — the round-1 8 still green), `ensureWorld()` world-to-world switching fixed, Test Mythras/Test Symbaroum worlds documented in README (Symbaroum's system.json hand-patched for v14 launch — durable Foundry-data state).

## Logged (not fixed this round) — future defect-round candidates

- **Mythras `addCurrency` never credits** — `EnhancedJournalSheet.js:1162` compares `i.name == currency` (object) instead of `currency.name`; always false, silently no-ops. Same file's `getCurrency` (:1005) does it right. Blocks Mythras sell-credit; one-line fix.
- **Sold-out shop items searchable** — deep-search mirrors the `hidden`/closed-shop gates but not the `quantity === 0 && !show-zero-quantity` display gate; a sold-out item's name still surfaces to players.
- Deep-search `strip()` removes ALL `section.secret` including `.revealed` (over-conservative vs core's `:not(.revealed)` — false negative, fails safe); revealed secrets aren't searchable by players.
- Deep-search "notes" coverage is a silent spec deviation: `flags.notes` is scanned but real per-user notes live at `flags.monks-enhanced-journal.<userId>.notes` — dead path; objective *content* HTML is never scanned (titles only).
- Deep-search results panel is discarded (no re-scan) by any incidental full-app re-render (root:true PARTS).
- Non-GM render of a very-old "fields"-format Person/Place page shows placeholder attribute values until a GM first opens it (migration GM-gate; self-healing, release-noted).
- customise-pages/customise-page "default" placeholder columns still read the dead `adjustment-defaults` setting (cosmetic; the persisted/resolved values are correct); dead commented convertItems block at adjust-price.js:270-292.
- CustomisePages wholesale `{diff:false}` sheet-settings write can clobber world tiers saved from adjustPrices while both dialogs are open (GM-only race).
- 300ms uniform single-click latency on enriched field links (click/dblclick disambiguation — revisit only on user reports).
- sellItem guard silently no-ops for any future actorId-less caller (in-code comment documents current callers).
- Harness: pageerror capture lacks `.stack` (forces temporal rather than pattern scoping of known-error tolerances); world-a restore is best-effort if the restore itself fails on a passing run; capture-then-restore baselines corrupt if a run is interrupted (README-noted).

## Open decisions (Dan's)

- When upstream is ready: raise the six branches as PRs (`enh/more-type-attributes` stacked on `enh/attribute-visibility`, or flattened if E2 merges first).
- Whether to repoint older test manifests at 14.06-test (deliberately not done, per standing instruction).
- PR #821 still carries the shop-UI bug (cherry-pick 302e778+3d00a29 remains clean) — unchanged from the 14.04b outcomes doc; `backlog-fixes` untouched this round.
