# Campaign Companion for Monk's Enhanced Journal — Design

**Date:** 2026-08-15
**Status:** Approved (brainstorming session, all sections user-approved)
**Deliverables:** (1) MEJ `feat/extension-api` branch (upstream-PR-able), (2) new module repo `mej-campaign-companion`

## 1. Background and decision summary

Research question: what features should a separate module, dependent on MEJ, add on top of it? Sources examined: World Anvil, LegendKeeper, Kanka, Obsidian-as-campaign-manager, the local `campaign-record` project, and MEJ's own extension surface.

Key research findings:

- **campaign-record is not a standalone app.** It is a feature-complete, never-published Foundry v13 module (v1.8.1, ~7,650 LOC, 380 unit tests, 38-spec Playwright multi-client harness). Eight of its ten typed journal page types duplicate MEJ sheets (MEJ's are mostly richer). Its *unique* layer — Campaign Hub, session timeline/timepoints, docx import/export, auto-capture, auto-link, inverted-index search, player collaboration — has no MEJ analogue and was written as pure, Foundry-global-free logic modules, making it portable.
- **The four reference tools converge on six gaps** absent from both core Foundry and MEJ: backlinks/"mentioned in"; relationship-graph visualization; calendars & timelines; layered secrets with granular reveal; tags/attributes/query dashboards; session management.
- **MEJ has no formal plugin API.** Easy extension points: own flags on MEJ pages, `renderJournalPageSheet` DOM injection, `activateControls` toolbar buttons, standalone apps. Hard: adding a new sheet type (requires monkey-patching `getDocumentTypes()`/`getTypeLabels()` and ~6 hardcoded lists, and `fixType()` wipes unknown type flags).

User decisions (recorded from the brainstorming dialogue):

| Decision | Choice |
|---|---|
| Direction | Phased single companion module: **A (campaign layer) → B (knowledge layer) → C (secrets layer)**; architecture designed for all three, A implemented first |
| MEJ changes | **Add a small extension API to MEJ** on a separate branch (`feat/extension-api`) so it can be raised as a PR against upstream MEJ |
| campaign-record fate | **Retire, no migration.** Only dev/test worlds are affected; the companion carries zero legacy code |
| Phase A scope | Full: Session sheet, timeline/timepoints + calendar dates, **Campaign Hub**, **inverted-index search**, docx **import and export**, auto-capture, auto-link, **player collaboration** |
| Hub design | **Integrated into MEJ's tabbed shell** as a landing/home tab; no inline record pane — records open as normal MEJ tabs |

## 2. Module identity

- **New repo/module:** id `mej-campaign-companion`, working title "Campaign Companion for Monk's Enhanced Journal" (name may change before release). New git repo at `~/Claude/Projects/mej-campaign-companion`.
- Foundry **v14** (matching MEJ 14.x), `relationships.requires: monks-enhanced-journal`, dnd5e-first but system-agnostic core, plain ES modules, no build step — matching both parent codebases' style.
- **MEJ branch `feat/extension-api`:** kept free of companion-specific code so it stands alone as an upstream PR.

## 3. MEJ extension API (the upstream PR)

One new hook, two registration calls, one enabling refactor:

- `Hooks.callAll("setupMonksEnhancedJournal", api)` fired at the end of MEJ's `init` (modeled on MATT's `setupTileActions`, which MEJ itself already consumes as a client).
- `api.registerSheetType({key, sheetClass, label, icon, relationships})` — immediately calls `DocumentSheetConfig.registerSheet` using MEJ's dual-key pattern (bare key + module-prefixed key) and records the type in an internal external-types map. `relationships` declares which existing types may relate to the new type (extends the `allowedRelationships` allowlists in both directions).
- `api.registerShellPage({id, label, icon, appClass})` — registers a landing page for MEJ's tabbed shell (used by the Hub).
- **Registry refactor (the bulk of the PR, ~100–150 lines):** `getDocumentTypes()`, `getTypeLabels()`, `getIcon()`, `fixType()`'s allowlist, `allowedRelationships`, and the `CustomisePages`/`convertSheet` type lists all derive from one merged registry (built-ins + externally registered types). Critically, `fixType()` must stop unsetting type flags it does not recognize when the type belongs to a registered external module. This refactor is independently valuable to MEJ (removes ~6 divergence-prone hardcoded lists).
- The external module declares its page subtype in its own `module.json` `documentTypes.JournalEntryPage`, per standard Foundry practice; the API handles MEJ-side resolution.
- The MEJ API branch ships with its own regression spec: external registration works; built-in type behavior is unchanged.

## 4. Companion data model

All companion data lives in `flags["mej-campaign-companion"]` — zero writes to MEJ's flag namespace, keeping the modules upgrade-independent.

### Session (the one new sheet type)

A single-page JournalEntry (MEJ convention), subtype `mej-campaign-companion.session`, sheet class extending MEJ's `EnhancedJournalSheet`. Flags:

- `sessionNumber` (number)
- `campaignDate` ({year, month, day, hour, minute} | null, bound to the Foundry v14 calendar API)
- `recap` (HTML)
- `gmNotes` (HTML, GM-only, stripped at render for non-GMs)
- `playerRecaps` (per-user HTML sections — players write recaps from their character's POV)
- `attendees` (actor UUIDs)
- `secrets` (checkable items `{id, text, revealed, revealedAt}` — the Lazy-DM secrets-and-clues pattern, and the seed Phase C extends)

### Timeline

campaign-record's timepoint model ported as-is: a flag array on one companion-managed "Campaign Timeline" JournalEntry per world.

```
{ id, label, sort, createdAt, campaignDate: {…}|null,
  links: [{ id, uuid|src, name?, showPlayers? }] }
```

Fractional sort keys for O(1) drag-inserts; links may be any document UUID or a raw image src with per-image player visibility; three ordering modes (manual / created / campaign-date).

## 5. Campaign Hub (integrated into MEJ's shell)

Registered via `api.registerShellPage` as a **"Campaign" home tab** in MEJ's tabbed browser. Adapts campaign-record's `HubMixin` with one structural change: the inline record pane and back/forward history are **dropped** — clicking any index, timeline, or search result calls `MonksEnhancedJournal.openJournalEntry()` so the record opens as a normal MEJ tab.

Retained from campaign-record: filterable index (type chips sourced from the merged type registry), drag-reorderable timeline with the three sort modes, and the search bar. This roughly halves the Hub port and avoids two competing reading surfaces.

## 6. Feature subsystems

Each is a ported campaign-record `scripts/logic/` module (pure, unit-tested) plus thin Foundry glue:

- **Search** — the inverted index, retargeted to MEJ's typed flag fields (name, description, person attributes, quest objectives, …) plus Session fields, via a pluggable per-type field-extractor. GM-only fields index under a `gm:` prefix and are filtered per-user at query time. Incrementally patched on document-update hooks; built lazily.
- **Auto-capture** — on combat end, creates an **MEJ Encounter entry** (filing into MEJ's richer type rather than a companion one) with combatants, outcome summary, and scene→Place matching, attached to the newest timepoint. GM "Show Players" images auto-file into that timepoint's gallery via a `shareImage` libWrapper registered with `libWrapper.ignore_conflicts` awareness (MEJ patches nearby surfaces).
- **Auto-link** — HTML tokenizer on journal save: names of existing MEJ entries in prose become `@UUID` links; never inserts inside existing links or code blocks. World-setting toggle plus per-entry opt-out.
- **Docx import/export** — the import wizard ports with a new **type-mapping table**: section heuristics suggest MEJ types (person, place, quest, …) and Session for dated session headers ("Arc 3 Session 12 4/15/24"); inline images import to galleries; dated headers generate timepoints. Export walks MEJ entries and emits round-trippable `.docx` with type markers and GM-content opt-in. `mammoth` (import) and `docx` (export) stay vendored in the companion.
- **Player collaboration** — a per-world "players can write sessions" setting: Session entries created with `ownership.default = OWNER`, plus campaign-record's chunked socket upload relay so players without file permissions add images through the GM. Scoped to Session entries only; MEJ's GM-centric posture elsewhere is untouched.

## 7. Phase B and C accommodation

Nothing from B or C is built in Phase A, but three Phase A choices are made for them:

- **Phase B (knowledge layer: backlinks, relationship graph, tags, attributes/templates, query blocks/dashboards):** backlink indexing becomes a second index over the search subsystem's existing document-scan pipeline. Tags and query blocks reuse the Hub's filter grammar. The relationship graph reads MEJ's existing `relationships` flags — no Phase A schema work required.
- **Phase C (secrets layer: block-level secrets with per-player/group reveal, hidden/labeled relationships, secrets tracker, storyteller screen):** Session's `secrets` field ships in Phase A as a simple checklist, so C extends an existing field rather than migrating one. Per-block reveal builds on the `gm:` index-prefix convention.
- The MEJ API stays minimal (two registration calls); B and C add API surface only if proven necessary.

## 8. Error handling

- Companion `init` verifies the MEJ API exists (the `setupMonksEnhancedJournal` hook fires); if MEJ is present but pre-API, the companion disables itself with a single clear UI notification rather than half-loading. Manifest `requires` plus a runtime MEJ version check.
- All socket handlers validate sender permissions GM-side (upload relay, timeline writes from players).
- Docx import is transactional per wizard run: documents are created only on final confirm; failures report per-section errors with no partial writes.
- Auto-capture and auto-link are observers: failures log and skip, never blocking the underlying combat-end or save operation.

## 9. Testing

1. **Unit (vitest):** campaign-record's 380-test suite ports alongside the logic modules it covers; the type-registry abstraction means most tests need only fixture changes.
2. **In-world (Playwright):** specs in the companion repo following the MEJ harness conventions (`test/` scripts, `run.mjs`, TT- prefix), run against the Foundry v14 test environment with GM + player clients. campaign-record's 38-spec multi-client suite is the template, cut to Phase A features.
3. **MEJ API branch:** its own regression spec (external registration works; built-in behavior unchanged), guarding the registry refactor.

## 10. Out of scope (Phase A)

- Phases B and C feature work (listed in §7 for architectural context only)
- Migration from campaign-record worlds (explicitly declined — retire with no migration)
- The Hub's inline record pane and navigation history (superseded by MEJ tab opening)
- campaign-record's media presenter/slideshow sync (MEJ's Slideshow type covers this)
- New MEJ sheet types beyond Session
- Importers for LegendKeeper/World Anvil/Kanka (noted as an unserved niche; a possible later phase)
- Non-English localization of the companion (follow MEJ's i18n layout, but ship en only)
