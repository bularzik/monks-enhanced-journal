# MEJ Campaign Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `mej-campaign-companion` Foundry module (Phase A: Session sheet, timeline, Campaign Hub, search, auto-capture, auto-link, docx import/export, player collaboration) plus the MEJ extension API branch it depends on.

**Architecture:** Two repos. (1) MEJ branch `feat/extension-api` (from `integration-14.07`) adds `Hooks.callAll("setupMonksEnhancedJournal", api)` with `registerSheetType` / `registerShellPage`, backed by a merged type registry. (2) New repo `mej-campaign-companion` registers a Session type and a Hub shell page through that API and ports campaign-record's pure logic modules (timeline, search, auto-link, auto-capture, docx, media relay) onto MEJ's types.

**Tech Stack:** Foundry VTT v14, plain ES modules (no build step), Handlebars/ApplicationV2, vitest + jsdom (unit), Playwright (e2e), vendored `mammoth.browser.min.js` + `docx.iife.js`.

**Spec:** `docs/superpowers/specs/2026-08-15-mej-campaign-companion-design.md`

## Global Constraints

- Foundry compatibility: `minimum: "14"`, `verified: "14"` (MEJ `integration-14.07` is version `14.01`).
- MEJ repo: `/Users/danbularzik/Claude/Projects/monks-enhanced-journal` (work in a worktree; branch `feat/extension-api` from `integration-14.07`, NOT from `main` which is still 13.06).
- MEJ API commits must touch only registry/API code — self-contained so they cherry-pick cleanly onto upstream for the eventual PR. No companion-specific code in MEJ.
- Companion repo: create at `/Users/danbularzik/Claude/Projects/mej-campaign-companion`. Module id `mej-campaign-companion`, title "Campaign Companion for Monk's Enhanced Journal".
- All companion data in `flags["mej-campaign-companion"]` — EXCEPT the MEJ interop flags MEJ itself owns (`flags["monks-enhanced-journal"].type` and `.relationships` on Session pages), which MEJ's machinery reads.
- Source to port from: `/Users/danbularzik/Claude/Projects/campaign-record/campaign-record` (read-only; never modify it). Its `MODULE_ID` is `campaign-record` — every ported file must swap imports to companion constants.
- No migration code from campaign-record worlds (explicitly out of scope).
- dnd5e-first, system-agnostic core. English-only i18n (`lang/en.json`), following MEJ's i18n key style.
- Frequent commits; MEJ-repo commit messages follow existing MEJ style; companion repo uses conventional `feat:`/`test:`/`chore:` prefixes (campaign-record's convention).
- campaign-record used `Date.now()` in `timepoints.mjs`; keep it (it runs in Foundry, not in a Workflow sandbox).

## Stage gates

- Stage 1 (Tasks 1–3): MEJ API branch complete, MEJ still works unchanged for built-in types.
- Stage 2 (Tasks 4–6): companion loads, Session entries create/open in MEJ shell, timeline data layer unit-tested.
- Stage 3–6 (Tasks 7–13): Hub, search, auto-link/auto-capture, docx.
- Stage 7 (Tasks 14–16): player collab, e2e suite, release polish.

---

### Task 1: MEJ external type registry + `registerSheetType` + setup hook

**Repo/branch:** MEJ worktree; create branch: `git checkout -b feat/extension-api integration-14.07`

**Files:**
- Modify: `monks-enhanced-journal.js` — `getDocumentTypes()` (~line 108), `getTypeLabels()` (~126), `getIcon()` (~2845), `fixType()` (~4212), `init()` (fire hook right after `registerSheetClasses()`, ~line 232 region where `game.MonksEnhancedJournal = this` is set)
- Modify: `sheets/EnhancedJournalSheet.js` — `allowedRelationships` getter (~line 176)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 4+):
  - `Hooks.callAll("setupMonksEnhancedJournal", api)` fired once during MEJ `init`, after built-in sheet registration and after `game.MonksEnhancedJournal` is set.
  - `api.registerSheetType({ key, moduleId, sheetClass, label, icon, relationships })` — `key`: bare type key (e.g. `"session"`); `moduleId`: the registering module's id (used for the namespaced subtype `${moduleId}.${key}`); `label`: i18n key; `icon`: FA class (e.g. `"fa-book"`); `relationships`: array of existing type keys this type may relate to (bidirectional).
  - `api.registerShellPage(...)` — added in Task 2 (stub `throw new Error("not implemented")` here).
  - `MonksEnhancedJournal.externalTypes` — `{ [key]: { moduleId, sheetClass, label, icon, relationships } }`.

- [ ] **Step 1: Add the external registry and API to `monks-enhanced-journal.js`**

Immediately after the `static includedTypes = [...]` class field (~line 103), add:

```javascript
	static externalTypes = {};

	static getApi() {
		return {
			registerSheetType: ({ key, moduleId, sheetClass, label, icon, relationships = [] }) => {
				if (!key || !moduleId || !sheetClass)
					throw new Error("registerSheetType requires key, moduleId and sheetClass");
				if (MonksEnhancedJournal.getDocumentTypes()[key])
					throw new Error(`Journal type '${key}' is already registered`);
				MonksEnhancedJournal.externalTypes[key] = { moduleId, sheetClass, label, icon, relationships };
				foundry.applications.apps.DocumentSheetConfig.registerSheet(JournalEntryPage, moduleId, sheetClass, {
					types: [key, `${moduleId}.${key}`],
					makeDefault: true,
					label: i18n(label)
				});
				CONFIG.JournalEntryPage.typeLabels = foundry.utils.mergeObject(
					(CONFIG.JournalEntryPage.typeLabels || {}), { [key]: label });
			},
			registerShellPage: () => { throw new Error("registerShellPage: not implemented until Task 2"); }
		};
	}

	/** External type keys allowed to relate to the given built-in type. */
	static externalRelationshipTypes(type) {
		return Object.entries(MonksEnhancedJournal.externalTypes)
			.filter(([k, v]) => (v.relationships || []).includes(type))
			.map(([k, v]) => k);
	}
```

- [ ] **Step 2: Merge externals into the two registry getters**

In `getDocumentTypes()` change the `return { ... }` to assign the literal to a variable and merge:

```javascript
	static getDocumentTypes() {
		let types = {
			list: ListSheet,
			encounter: EncounterSheet,
			event: EventSheet,
			organization: OrganizationSheet,
			person: PersonSheet,
			picture: PictureSheet,
			place: PlaceSheet,
			poi: PointOfInterestSheet,
			quest: QuestSheet,
			shop: ShopSheet,
			loot: LootSheet,
			slideshow: SlideshowSheet,
			journalentry: TextImageEntrySheet
		};
		for (let [k, v] of Object.entries(MonksEnhancedJournal.externalTypes))
			types[k] = v.sheetClass;
		return types;
	}
```

Apply the identical pattern to `getTypeLabels()` (merge `v.label` per external key).

- [ ] **Step 3: Extend `getIcon()` and guard `fixType()`**

In `getIcon(type)` (~2845), before `default:` add a lookup:

```javascript
			default:
				if (MonksEnhancedJournal.externalTypes[type]?.icon)
					return MonksEnhancedJournal.externalTypes[type].icon;
				return 'fa-book-open';
```

In `fixType()` (~4212) the current wipe branch is:

```javascript
			if (types[type])
				object.type = type;
			else if (game.user.isGM)
				object.unsetFlag("monks-enhanced-journal", "type");
```

Replace the wipe so a page whose real document subtype belongs to another module (e.g. `mej-campaign-companion.session` while the companion is disabled) is never stripped:

```javascript
			if (types[type])
				object.type = type;
			else if (game.user.isGM) {
				let sourceType = object._source?.type ?? "";
				let foreignSubtype = sourceType.includes(".") && !sourceType.startsWith("monks-enhanced-journal.");
				if (!foreignSubtype)
					object.unsetFlag("monks-enhanced-journal", "type");
			}
```

- [ ] **Step 4: Fire the setup hook in `init()`**

Directly after the line `game.MonksEnhancedJournal = this;` (which follows `MonksEnhancedJournal.registerSheetClasses()` in `init()`), add:

```javascript
		Hooks.callAll("setupMonksEnhancedJournal", MonksEnhancedJournal.getApi());
```

- [ ] **Step 5: Open relationships to registered externals**

In `sheets/EnhancedJournalSheet.js` replace the getter (~line 176):

```javascript
    get allowedRelationships() {
        return ["encounter", "loot", "organization", "person", "place", "poi", "event", "quest", "shop",
            ...game.MonksEnhancedJournal.externalRelationshipTypes(this.constructor.type)];
    }
```

(`game.MonksEnhancedJournal` is the class; import cycle avoided by going through the global.)

- [ ] **Step 6: Manual smoke check**

Launch the Foundry v14 test env with this branch installed (per `foundry-v14-test-env` memory). In the console verify: `game.MonksEnhancedJournal.externalTypes` is `{}`; create one entry of each built-in type (person, shop, quest) and open them — behavior unchanged. Then paste:

```javascript
Hooks.on("setupMonksEnhancedJournal", api => console.log("API hook works", api));
```

reload, and confirm the log fires (hook order: this registers too late to run for this reload — instead check `Hooks.events.setupMonksEnhancedJournal === undefined` and verify by grepping the console for errors; the real consumer test is the companion in Task 4).

- [ ] **Step 7: Commit**

```bash
git add monks-enhanced-journal.js sheets/EnhancedJournalSheet.js
git commit -m "Add setupMonksEnhancedJournal extension API: external sheet-type registry"
```

---

### Task 2: MEJ `registerShellPage` + `openShellPage`

**Files:**
- Modify: `apps/enhanced-journal.js` — the subsheet dispatch map (~line 805, `blank: EnhancedJournalSheet`), `findEntity` (~line 860–890), the `["blank", "folder"]` exclusion checks (lines ~332, 430, 453, 476, 636, 644, 664)
- Modify: `monks-enhanced-journal.js` — replace the `registerShellPage` stub in `getApi()`; add `openShellPage`

**Interfaces:**
- Consumes: `BlankJournal` synthetic document class and tab machinery in `apps/enhanced-journal.js` (`addTab`/`activateTab`/`findEntity`).
- Produces:
  - `api.registerShellPage({ id, label, icon, appClass })` — `appClass` must extend `EnhancedJournalSheet`; `id` is a bare slug (e.g. `"campaign-hub"`).
  - `MonksEnhancedJournal.shellPages` — `{ [id]: { label, icon, appClass } }`.
  - `MonksEnhancedJournal.openShellPage(id, options)` — opens/activates a shell tab showing the page; tab persists and restores across reloads via entity id `shellpage:${id}`.

- [ ] **Step 1: Add the shell-page registry**

In `monks-enhanced-journal.js`, next to `externalTypes`, add `static shellPages = {};` and replace the Task 1 stub inside `getApi()`:

```javascript
			registerShellPage: ({ id, label, icon, appClass }) => {
				if (!id || !appClass) throw new Error("registerShellPage requires id and appClass");
				MonksEnhancedJournal.shellPages[id] = { label, icon, appClass };
			}
```

Add the opener as a static on the class:

```javascript
	static async openShellPage(id, options = {}) {
		let page = MonksEnhancedJournal.shellPages[id];
		if (!page) return;
		let entity = MonksEnhancedJournal.journal
			? await MonksEnhancedJournal.journal.findEntity(`shellpage:${id}`, i18n(page.label))
			: null;
		if (!MonksEnhancedJournal.journal) {
			MonksEnhancedJournal.journal = new EnhancedJournal();
			entity = await MonksEnhancedJournal.journal.findEntity(`shellpage:${id}`, i18n(page.label));
			return MonksEnhancedJournal.journal.render(true, foundry.utils.mergeObject({ document: entity }, options));
		}
		return MonksEnhancedJournal.journal.open(entity, false, options);
	}
```

(Mirror how `openJournalEntry` constructs/renders `EnhancedJournal` at ~line 2392 of `monks-enhanced-journal.js` — copy its exact construction incantation rather than the sketch above if it differs.)

- [ ] **Step 2: Teach the shell about shell pages**

In `apps/enhanced-journal.js`:

1. In `findEntity` (the method that returns `new BlankJournal(...)` for missing ids, ~line 860): at the top add

```javascript
        if (typeof id == "string" && id.startsWith("shellpage:")) {
            let pageId = id.slice("shellpage:".length);
            let page = game.MonksEnhancedJournal.shellPages[pageId];
            if (page)
                return new BlankJournal({
                    _id: null,
                    name: i18n(page.label),
                    flags: { 'monks-enhanced-journal': { type: pageId } },
                    content: ""
                });
        }
```

BlankJournal ids: inspect its data model (top of `apps/enhanced-journal.js`, `blank-journal-entry` at lines ~30–34) — if `id` is a fixed getter, add an instance property `this.shellPageId = pageId` instead and persist the tab's `entityId` as the `shellpage:` string when the tab is saved (search for where `tab.entityId` is written in `addTab`/`_updateTab` and special-case `entity.shellPageId` there).

2. In the subsheet dispatch map (~line 805) where `blank: EnhancedJournalSheet` appears, merge registered pages:

```javascript
            ...Object.fromEntries(Object.entries(game.MonksEnhancedJournal.shellPages)
                .map(([k, v]) => [k, v.appClass])),
```

3. Every `["blank", "folder"].includes(...)` guard (lines ~332, 430, 453, 476, 636, 644, 664) treats those types as "not a real document". Shell pages need the same treatment. Add a helper near the top of the file and use it in all seven sites:

```javascript
function isSyntheticType(type) {
    return ["blank", "folder"].includes(type) || game.MonksEnhancedJournal.shellPages[type] != undefined;
}
```

Replace e.g. `!["blank", "folder"].includes(this.document.type)` with `!isSyntheticType(this.document.type)`.

- [ ] **Step 3: Manual smoke check**

In the test world console:

```javascript
class TestShellPage extends game.MonksEnhancedJournal.getDocumentTypes().person.__proto__.constructor {}
```

— too convoluted; instead verify inert behavior only: reload, open MEJ, confirm tabs/bookmarks/blank tabs still work (the registry is empty so all seven guard sites behave identically). Real coverage arrives with the Hub (Task 7) and e2e (Task 15).

- [ ] **Step 4: Commit**

```bash
git add monks-enhanced-journal.js apps/enhanced-journal.js
git commit -m "Add registerShellPage/openShellPage shell-page API"
```

---

### Task 3: MEJ API documentation + branch wrap-up

**Files:**
- Create: `API.md` (MEJ repo root)

**Interfaces:** none new — documents Tasks 1–2.

- [ ] **Step 1: Write `API.md`** documenting: the `setupMonksEnhancedJournal` hook timing (during MEJ `init`, consumers must register their hook in their own module's `init` given load order — safest is a top-level `Hooks.on("setupMonksEnhancedJournal", ...)` in the consumer's entry script, executed at import time); `registerSheetType` params with a full worked example (a `session` type extending `EnhancedJournalSheet`, declaring `documentTypes.JournalEntryPage.session` in the consumer's `module.json` with `htmlFields`); `registerShellPage` + `openShellPage`; the interop flags MEJ owns (`flags["monks-enhanced-journal"].type`, `.relationships`); the `fixType` foreign-subtype guarantee (disabled consumer's pages are left intact). Include the existing consumer-facing hooks (`renderJournalPageSheet`, `activateControls`, `openJournalEntry`) with one-line descriptions.

- [ ] **Step 2: Commit and push the branch**

```bash
git add API.md
git commit -m "Document the extension API"
git push -u origin feat/extension-api
```

Do NOT open the upstream PR — the user does that manually after the companion validates the API in practice.

---

### Task 4: Companion repo scaffold, MEJ registration, version guard

**Repo:** create `/Users/danbularzik/Claude/Projects/mej-campaign-companion` (`git init`).

**Files:**
- Create: `module.json`, `package.json`, `.gitignore`, `scripts/constants.mjs`, `scripts/campaign-companion.mjs`, `lang/en.json`, `styles/campaign-companion.css` (empty placeholder rule), `test/constants.test.js`

**Interfaces:**
- Consumes: `setupMonksEnhancedJournal` API (Task 1), `EnhancedJournalSheet` via `import "/modules/monks-enhanced-journal/sheets/EnhancedJournalSheet.js"`.
- Produces (used by every later task):
  - `scripts/constants.mjs` exports: `MODULE_ID = "mej-campaign-companion"`, `SESSION_TYPE = "session"`, `TIMELINE_JOURNAL_SETTING = "timelineJournalId"`, `SOCKET = "module.mej-campaign-companion"`, `HUB_PAGE_ID = "campaign-hub"`, plus setting-name constants added per task.
  - `scripts/campaign-companion.mjs` — module entry; owns the `setupMonksEnhancedJournal` consumer hook and a `ready`-time guard.

- [ ] **Step 1: `module.json`**

```json
{
  "id": "mej-campaign-companion",
  "title": "Campaign Companion for Monk's Enhanced Journal",
  "description": "Session journal, campaign timeline, hub, search, docx import/export and auto-capture on top of Monk's Enhanced Journal.",
  "version": "0.1.0",
  "authors": [{ "name": "Dan Bularzik" }],
  "compatibility": { "minimum": "14", "verified": "14" },
  "relationships": {
    "requires": [{ "id": "monks-enhanced-journal", "type": "module", "compatibility": { "minimum": "14.02" } }]
  },
  "esmodules": ["scripts/campaign-companion.mjs"],
  "styles": ["styles/campaign-companion.css"],
  "languages": [{ "lang": "en", "name": "English", "path": "lang/en.json" }],
  "documentTypes": {
    "JournalEntryPage": {
      "session": {
        "htmlFields": ["recap", "gmNotes"],
        "filePathFields": { "img": ["IMAGE"] }
      }
    }
  },
  "socket": true
}
```

(`minimum: "14.02"` presumes the API lands in the next MEJ version bump; adjust to whatever version `feat/extension-api` merges into.)

- [ ] **Step 2: `package.json` + `.gitignore`**

Copy `package.json` from campaign-record and edit: `"name": "mej-campaign-companion"`, drop the `changelog` script and `e2e:*` scripts (restored in Task 15). Keep devDependencies `vitest`, `jsdom`, `@playwright/test`. `.gitignore`: `node_modules/`, `test-results/`, `playwright-report/`. Run `npm install`.

- [ ] **Step 3: `scripts/constants.mjs`**

```javascript
export const MODULE_ID = "mej-campaign-companion";
export const SESSION_TYPE = "session";
export const HUB_PAGE_ID = "campaign-hub";
export const SOCKET = `module.${MODULE_ID}`;

/** World setting: JournalEntry id holding the campaign timeline flag. */
export const TIMELINE_JOURNAL_SETTING = "timelineJournalId";

/** i18n prefix for all companion strings. */
export const I18N = "MEJCampaignCompanion";
```

- [ ] **Step 4: `scripts/campaign-companion.mjs`**

```javascript
import { MODULE_ID, SESSION_TYPE, I18N } from "./constants.mjs";

let apiReceived = false;

Hooks.on("setupMonksEnhancedJournal", (api) => {
  apiReceived = true;
  // SessionSheet registration added in Task 5; Hub page in Task 7.
});

Hooks.once("ready", () => {
  if (!apiReceived) {
    ui.notifications.error(game.i18n.localize(`${I18N}.errors.mej-api-missing`), { permanent: true });
    return;
  }
});
```

- [ ] **Step 5: `lang/en.json`**

```json
{
  "MEJCampaignCompanion": {
    "errors": {
      "mej-api-missing": "Campaign Companion requires a Monk's Enhanced Journal version with the extension API. The module is disabled."
    },
    "sheettype": { "session": "Session" }
  }
}
```

- [ ] **Step 6: Write and run the smoke test**

`test/constants.test.js`:

```javascript
import { describe, it, expect } from "vitest";
import { MODULE_ID, SESSION_TYPE, SOCKET } from "../scripts/constants.mjs";

describe("constants", () => {
  it("socket channel is derived from module id", () => {
    expect(SOCKET).toBe(`module.${MODULE_ID}`);
    expect(MODULE_ID).toBe("mej-campaign-companion");
    expect(SESSION_TYPE).toBe("session");
  });
});
```

Run: `npm test` — expect PASS (1 test).

- [ ] **Step 7: Link into the test env and verify load**

Symlink the repo into the Foundry v14 test data dir's `Data/modules/mej-campaign-companion` (paths per `foundry-v14-test-env` memory). Enable in a test world alongside the `feat/extension-api` MEJ build. Expect: no console errors and no "API missing" toast (hook fired). Then temporarily swap MEJ to a non-API build and confirm the permanent error toast appears. Swap back.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: scaffold module, MEJ API handshake, version guard"
```

---

### Task 5: Session sheet

**Files:**
- Create: `scripts/sheets/SessionSheet.mjs`, `templates/session.hbs`, `test/session-defaults.test.js`
- Modify: `scripts/campaign-companion.mjs` (register the type), `lang/en.json` (labels)

**Interfaces:**
- Consumes: `api.registerSheetType` (Task 1); MEJ's `EnhancedJournalSheet` base class (its AppV2 `PARTS`/`TABS` idiom — copy structure from `git show integration-14.07:sheets/EventSheet.js`, the simplest MEJ sheet).
- Produces:
  - `SessionSheet` with `static get type() { return "session"; }` and `static get defaultObject()` returning `{ sessionNumber: null, campaignDate: null, attendees: [], secrets: [] }` — stored under `flags["mej-campaign-companion"]`, NOT merged by MEJ's preCreate (that merges into MEJ's namespace), so the sheet's `_prepareBodyContext` applies defaults at read time via `sessionData(page)`.
  - `sessionData(page)` helper exported from `SessionSheet.mjs`: returns `foundry.utils.mergeObject(SessionSheet.defaultObject, page.getFlag("mej-campaign-companion", "session") ?? {}, { inplace: false })`.
  - Session flag shape under `flags["mej-campaign-companion"].session`: `{ sessionNumber: number|null, campaignDate: {year,month,day,hour,minute}|null, attendees: string[] (actor uuids), secrets: [{id, text, revealed, revealedAt}] }`. `recap` and `gmNotes` live in the page's own system fields declared in `module.json` (`htmlFields`); `playerRecaps` under `flags["mej-campaign-companion"].playerRecaps: { [userId]: html }`.

- [ ] **Step 1: Write the failing unit test** (`test/session-defaults.test.js`)

```javascript
import { describe, it, expect } from "vitest";
import { sessionData } from "../scripts/sheets/session-data.mjs";

describe("sessionData", () => {
  const page = (flag) => ({ getFlag: (scope, key) => (key === "session" ? flag : undefined) });
  it("fills defaults for a bare page", () => {
    expect(sessionData(page(undefined))).toEqual({
      sessionNumber: null, campaignDate: null, attendees: [], secrets: []
    });
  });
  it("preserves stored values and fills gaps", () => {
    const d = sessionData(page({ sessionNumber: 12 }));
    expect(d.sessionNumber).toBe(12);
    expect(d.secrets).toEqual([]);
  });
});
```

Note: `sessionData` lives in its own pure file `scripts/sheets/session-data.mjs` (no Foundry imports — `mergeObject` replaced by a hand-rolled shallow merge) so vitest can load it. `SessionSheet.mjs` imports it.

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (module not found).

- [ ] **Step 3: Implement `session-data.mjs`**

```javascript
export const SESSION_DEFAULTS = Object.freeze({
  sessionNumber: null, campaignDate: null, attendees: [], secrets: []
});

export function sessionData(page) {
  const stored = page.getFlag("mej-campaign-companion", "session") ?? {};
  return { ...structuredClone(SESSION_DEFAULTS), ...stored };
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Implement `SessionSheet.mjs` + template**

Model the class on MEJ's `EventSheet` (read `git show integration-14.07:sheets/EventSheet.js` and `templates/sheets/event.html` equivalents first; replicate its `PARTS`/`TABS`/`_prepareBodyContext` shape exactly). Requirements: `static get type()` → `"session"`; tabs: `description` (recap, the page's html field), `notes` (MEJ's per-user notes partial — reuse MEJ's partial path `modules/monks-enhanced-journal/templates/sheets/partials/...` as EventSheet does), `session` (companion tab: sessionNumber input, campaignDate display, attendees list, secrets checklist with add/remove/toggle writing `flags["mej-campaign-companion"].session`); GM-only `gmNotes` editor gated on `isGM` in the template. Listeners write via `this.document.update({"flags.mej-campaign-companion.session": next})`.

- [ ] **Step 6: Register the type**

In `campaign-companion.mjs`'s `setupMonksEnhancedJournal` handler:

```javascript
import { SessionSheet } from "./sheets/SessionSheet.mjs";
// inside the hook:
api.registerSheetType({
  key: SESSION_TYPE,
  moduleId: MODULE_ID,
  sheetClass: SessionSheet,
  label: `${I18N}.sheettype.session`,
  icon: "fa-dice-d20",
  relationships: ["person", "place", "quest", "encounter", "event", "organization", "loot", "shop", "poi"]
});
```

- [ ] **Step 7: In-world verification**

In the test world: create a journal entry, convert/create as type "Session" (it must appear in MEJ's new-entry type list), open in the MEJ shell, fill sessionNumber + a secret, reload, confirm persistence; drag a Person entry onto it → relationship appears both ways. As a player user, confirm gmNotes is absent from the DOM.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: Session sheet registered through MEJ extension API"`

---

### Task 6: Timeline data layer (ported)

**Files:**
- Create: `scripts/logic/timeline-sort.mjs`, `scripts/logic/timeline-links.mjs`, `scripts/logic/campaign-date.mjs`, `scripts/logic/campaign-calendar.mjs`, `scripts/data/timepoints.mjs`, `scripts/data/timeline-journal.mjs`
- Create (copy): `test/timeline-sort.test.js`, `test/timeline-links.test.js`, `test/campaign-date.test.js`, `test/campaign-calendar.test.js`, `test/timepoints.test.js` from campaign-record's `test/` equivalents

**Interfaces:**
- Consumes: constants (Task 4).
- Produces:
  - `timeline-journal.mjs`: `getTimelineJournal()` → the world's singleton "Campaign Timeline" `JournalEntry` (found by world setting `TIMELINE_JOURNAL_SETTING`; `ensureTimelineJournal()` creates it GM-side, stores its id in the setting, flags it `{"mej-campaign-companion": {timeline: {timepoints: []}}}`).
  - `timepoints.mjs`: same API as campaign-record's (`getTimepoints(journal)`, `addTimepoint`, `editTimepoint`, `renameTimepoint`, `moveTimepoint`, `deleteTimepoint`, `addLink`, `removeLink`, `toggleLinkShowPlayers`, `resolveLinks(timepoint, user)`), with flag scope `MODULE_ID` and flag key `"timeline"` instead of campaign-record's `GROUP_FLAG`.
  - Ported pure modules keep their exact campaign-record export signatures (see `scripts/logic/*.mjs` in that repo): `sortKeyBetween`, `sortTimepoints`, `orderTimepoints`, `withLink`, `withoutLink`, `displayLink`, `classifyDropData`, `timepointIdsWithLink`, `campaignSortKey`, `parseCampaignDateInput`, `hasCalendar`, `getCalendarMonths`, `calendarBounds`, `formatCampaignDate`, `currentWorldComponents`.

- [ ] **Step 1: Copy the four pure logic modules**

```bash
CR=/Users/danbularzik/Claude/Projects/campaign-record/campaign-record
cp $CR/scripts/logic/timeline-sort.mjs $CR/scripts/logic/timeline-links.mjs \
   $CR/scripts/logic/campaign-date.mjs $CR/scripts/logic/campaign-calendar.mjs scripts/logic/
```

Then edit each: any `import ... from "../constants.mjs"` swaps to companion constants (check with `grep -n "constants" scripts/logic/*.mjs`); `timeline-links.mjs` imports `visibility.mjs` — inline the check instead: replace `isRecordVisible(user, doc)` usages with a companion version that treats MEJ hidden-relationship semantics as N/A (plain `true`) since MEJ has no per-page `system.hidden`; delete the import.

- [ ] **Step 2: Copy their tests and run**

```bash
cp $CR/test/timeline-sort.test.js $CR/test/timeline-links.test.js \
   $CR/test/campaign-date.test.js $CR/test/campaign-calendar.test.js test/
```

Fix import paths (`../scripts/logic/...` unchanged if layout matches) and any `campaign-record` string fixtures. `campaign-calendar.test.js` stubs `game.time.calendar` — verify against Foundry **v14**: open the v14 API docs or run `game.time.calendar` in the test world console; if v14 renamed fields the module (not the test) gets a compat shim in `campaign-calendar.mjs`. Run `npm test` → all ported tests PASS.

- [ ] **Step 3: Write failing test for `timepoints.mjs` retarget** — copy `$CR/test/timepoints.test.js`, change the mocked flag scope/key to `("mej-campaign-companion", "timeline")`. Run → FAIL.

- [ ] **Step 4: Port `timepoints.mjs` + write `timeline-journal.mjs`**

Copy `$CR/scripts/data/timepoints.mjs`; replace `MODULE_ID, GROUP_FLAG` import with `import { MODULE_ID } from "../constants.mjs"; const TIMELINE_FLAG = "timeline";`; `getFlag(MODULE_ID, GROUP_FLAG)` → `getFlag(MODULE_ID, TIMELINE_FLAG)` (both read and write sites); keep every function name/signature. `timeline-journal.mjs`:

```javascript
import { MODULE_ID, TIMELINE_JOURNAL_SETTING } from "../constants.mjs";

export function getTimelineJournal() {
  const id = game.settings.get(MODULE_ID, TIMELINE_JOURNAL_SETTING);
  return id ? game.journal.get(id) ?? null : null;
}

export async function ensureTimelineJournal() {
  let journal = getTimelineJournal();
  if (journal) return journal;
  if (!game.user.isGM) return null;
  journal = await JournalEntry.create({
    name: "Campaign Timeline",
    flags: { [MODULE_ID]: { timeline: { timepoints: [] } } },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
  });
  await game.settings.set(MODULE_ID, TIMELINE_JOURNAL_SETTING, journal.id);
  return journal;
}
```

Register the world setting (`scope: "world", config: false, type: String, default: ""`) in `campaign-companion.mjs`'s `init`.

- [ ] **Step 5: Run tests** — `npm test` → PASS. **Step 6: Commit** — `git commit -am "feat: timeline data layer ported from campaign-record"`

---

### Task 7: Campaign Hub shell page (index + timeline UI)

**Files:**
- Create: `scripts/apps/CampaignHubPage.mjs`, `templates/hub.hbs`, `scripts/logic/doctype-filter.mjs` (copy), `scripts/logic/sort-menu.mjs` (copy), `test/doctype-filter.test.js` (copy), `test/sort-menu.test.js` (copy)
- Modify: `scripts/campaign-companion.mjs` (register shell page + toolbar), `styles/campaign-companion.css`, `lang/en.json`

**Interfaces:**
- Consumes: `api.registerShellPage` + `MonksEnhancedJournal.openShellPage` (Task 2); `timepoints.mjs`/`timeline-journal.mjs` (Task 6); MEJ's `openJournalEntry`; `MonksEnhancedJournal.getIcon`; the merged `getTypeLabels()` for type chips. Reference implementation: `$CR/scripts/apps/hub/hub-mixin.mjs` (1,318 lines) — mine it for the index-build and timeline drag handlers, do NOT copy wholesale (the record pane, nav rail, back/forward history, and inline-edit sections are dropped per spec §5).
- Produces:
  - `CampaignHubPage extends EnhancedJournalSheet` registered as shell page id `"campaign-hub"`; three panes: **Index** (all MEJ-typed entries: name, type icon, type-chip + text filters; row click → `game.MonksEnhancedJournal.openJournalEntry(entry)`), **Timeline** (timepoints with resolved links via `resolveLinks`, add/rename/delete/drag-reorder → `moveTimepoint`, drop documents → `addLink` using `classifyDropData`, order-mode menu using `orderTimepoints`), **Search bar** (placeholder input this task; wired in Task 8).
  - Index row source: `game.journal.filter(j => game.MonksEnhancedJournal.getMEJType(j))` mapped to `{ uuid, name, type, icon }`.

- [ ] **Step 1: Copy + retarget the two small logic modules and their tests**; type labels come from `getTypeLabels()` merged map (pass `labelOf = k => game.i18n.localize(labels[k])` into `buildDoctypeFilter`). Run `npm test` → PASS.
- [ ] **Step 2: Build `CampaignHubPage` + `hub.hbs`** per the Produces block. Follow MEJ sheet conventions (`PARTS`, `_prepareBodyContext`, `activateListeners`) so the shell renders it like any subsheet. GM-only controls (timepoint CRUD) gated on `isGM`; player view shows player-visible links only (`resolveLinks(tp, game.user)`).
- [ ] **Step 3: Register + entry points.** In the setup hook: `api.registerShellPage({ id: HUB_PAGE_ID, label: \`${I18N}.hub.title\`, icon: "fa-timeline", appClass: CampaignHubPage })`. Add a toolbar button via `Hooks.on("activateControls", (ej, ctrls) => ctrls.push({ id: "campaign-hub", label: i18n(\`${I18N}.hub.title\`), icon: "fa-timeline", type: "button", visible: true, callback: () => game.MonksEnhancedJournal.openShellPage(HUB_PAGE_ID) }))` plus a scene-controls note button GM-side. `ensureTimelineJournal()` runs lazily on first hub open (GM only).
- [ ] **Step 4: In-world verification.** GM: open hub from toolbar → tab appears alongside journal tabs and persists across reload; add 3 timepoints, drag-reorder, drop a Person entry and an image onto one; click an index row → entry opens in a new MEJ tab. Player client: hub opens, GM-hidden image links invisible, no CRUD controls.
- [ ] **Step 5: Commit** — `git commit -am "feat: Campaign Hub shell page with index and timeline"`

---

### Task 8: Search subsystem

**Files:**
- Create: `scripts/logic/search-index.mjs` (verbatim copy), `scripts/logic/field-extractors.mjs`, `scripts/search/live-index.mjs`, `test/search-index.test.js` (copy), `test/field-extractors.test.js`
- Modify: `scripts/apps/CampaignHubPage.mjs` + `templates/hub.hbs` (wire the search pane)

**Interfaces:**
- Consumes: `createIndex/indexRecord/removeRecord/search` from `search-index.mjs` (exact campaign-record signatures — records are `{ uuid, name, type, tags?, fields?, gmFields? }`, results `{ uuid, name, type, matches: [{field, snippet}] }`).
- Produces:
  - `field-extractors.mjs`: `export const EXTRACTORS = { person: fn, place: fn, quest: fn, shop: fn, loot: fn, encounter: fn, event: fn, organization: fn, poi: fn, list: fn, journalentry: fn, picture: fn, slideshow: fn, session: fn }` and `export function extractRecord(page, type)` → the index-record object. Each `fn(page)` returns `{ fields, gmFields }`: `fields.text` = `page.text?.content ?? ""`, plus per-type flag fields (person: `attributes` values + `role`; quest: objective texts + `status`; shop/loot: item names from `flags["monks-enhanced-journal"].items`; session: recap + secrets texts). `gmFields`: session `gmNotes`; quest objectives with a GM-only marker if MEJ stores one (inspect a saved quest's flags in the test world — if objectives have no gm flag, gmFields for quest is `{}`). **Pluggable:** `export function registerExtractor(type, fn)` for Phase B.
  - `live-index.mjs`: module-singleton lazy index; `ensureIndex()` builds from all MEJ-typed pages + session pages on first call; hooks `updateJournalEntryPage`/`createJournalEntryPage`/`deleteJournalEntryPage` re-index incrementally (`extractRecord` → `indexRecord`/`removeRecord`); `searchAll(query)` → `search(index, query, { gm: game.user.isGM })` filtered to entries the user can see (`testUserPermission LIMITED`).
- [ ] **Step 1:** Copy `search-index.mjs` + its test verbatim; run → PASS (zero edits — it's dependency-free).
- [ ] **Step 2:** Write failing `field-extractors.test.js` (fixture fake pages with MEJ flag shapes for person/quest/shop/session asserting extracted `fields`/`gmFields`); implement; PASS.
- [ ] **Step 3:** Implement `live-index.mjs`; wire hub search pane: input → `searchAll`, render name/type/snippet rows, click opens entry.
- [ ] **Step 4:** In-world: search a word in a Person description → snippet row; search a word only in session gmNotes as player → no hit; as GM → hit. **Step 5: Commit.**

---

### Task 9: Auto-link

**Files:**
- Create: `scripts/logic/auto-link.mjs`, `scripts/logic/auto-link-candidates.mjs`, `scripts/logic/auto-link-baseline.mjs` (all verbatim copies), `scripts/hooks/auto-link.mjs` (adapted), tests copied: `test/auto-link.test.js`, `test/auto-link-candidates.test.js`, `test/auto-link-baseline.test.js`
- Modify: `scripts/campaign-companion.mjs` (settings + hook wiring), `lang/en.json`

**Interfaces:**
- Consumes: `autoLinkAdded(baselineHtml, newHtml, candidates)` and `selectCandidates({ pages, selfId, minLength })` (campaign-record signatures).
- Produces: world setting `autoLink` (Boolean, default false, `config: true`); page flag `flags["mej-campaign-companion"].noAutoLink` opt-out; a `preUpdateJournalEntryPage` hook that, when enabled and `changes.text?.content` present, rewrites the incoming HTML with links to MEJ entries (candidates = `game.journal` entries with an MEJ type, `{ id: entry.uuid, name: entry.name }`; baseline read from the pre-update `page.text.content`).
- [ ] **Step 1:** Copy the three logic files + three tests verbatim; run → PASS.
- [ ] **Step 2:** Write `hooks/auto-link.mjs` adapting `$CR/scripts/hooks/auto-link.mjs` (read it first): swap record-candidate sourcing to MEJ-typed JournalEntries; write link format `@UUID[JournalEntry.<id>]{Name}`.
- [ ] **Step 3:** In-world: enable setting; type an existing Person's name in another entry's text, save → it becomes a link; names inside existing links/code untouched; opt-out flag respected. **Step 4: Commit.**

---

### Task 10: Auto-capture

**Files:**
- Create: `scripts/logic/auto-capture.mjs` (copy), `scripts/hooks/auto-capture.mjs` (adapted), `test/auto-capture.test.js` (copy)
- Modify: `scripts/campaign-companion.mjs`, `scripts/constants.mjs` (`AUTO_CAPTURE_SETTING = "autoCaptureEncounters"`, `MEDIA_CAPTURE_SETTING = "autoCaptureSharedMedia"`), `lang/en.json`

**Interfaces:**
- Consumes: `collapseParticipants`, `mergeParticipants`, `matchPlaceForScene`, `summarizeOutcome`, `pickNewestTimepoint`, `appendGalleryImage`, `installShareImageWrap`, `resolveSharedMediaShare` (campaign-record signatures); `addTimepoint`/`addLink` (Task 6); MEJ's Encounter conventions.
- Produces: on `deleteCombat` (setting on, GM): create a `JournalEntry` + page of MEJ type `encounter` — flags `{"monks-enhanced-journal": {type: "encounter", actors: <collapsed participants as MEJ encounter actor rows>}}` (FIRST inspect a hand-created MEJ Encounter's flags in the test world and mirror that exact `actors` row shape; also seed `EncounterSheet.defaultObject` keys `items:{}, dcs:{}`), name `"Encounter: <scene name> (<date>)"`, then `addLink(timeline, pickNewestTimepoint(...).id, { uuid: entry.uuid })`. On GM `shareImage` (setting on): wrap via `installShareImageWrap` with `libWrapperModule: game.modules.get("lib-wrapper")`, `moduleId: MODULE_ID` and file the src onto the newest timepoint as an image link (`addLink(..., { src, showPlayers: true })` — timeline gallery, not a Media page: the companion has no media type).
- [ ] **Step 1:** Copy logic + test verbatim; run → PASS. (The copied test covers `resolveTargetGroup` which the companion doesn't use — keep it; the function is harmless.)
- [ ] **Step 2:** Write the adapted hook file per Produces; register the two world settings (`config: true`, Boolean, default false).
- [ ] **Step 3:** In-world: run a 2-round combat with 3 monsters (2 dead) → end combat → Encounter entry exists with collapsed counts + outcome text, opens correctly in MEJ, timepoint link present. Share an image → appears on newest timepoint. With lib-wrapper active + Monk's Common Display active, confirm no libWrapper conflict warning names `mej-campaign-companion`. **Step 4: Commit.**

---

### Task 11: Docx import wizard

**Files:**
- Create: `vendor/mammoth.browser.min.js` (copy from `$CR/vendor/`), `scripts/logic/doc-import.mjs` (copy), `scripts/logic/import-images.mjs` (copy), `scripts/apps/import-wizard.mjs` (adapted from `$CR/scripts/apps/import-wizard.mjs` + `import-upload.mjs`), `templates/import-wizard.hbs`, tests copied: `test/doc-import.test.js`, `test/import-images.test.js`
- Modify: `scripts/campaign-companion.mjs` (hub toolbar button "Import Document", GM-only), `lang/en.json`

**Interfaces:**
- Consumes: `splitSections`, `detectSessionHeader`, `parseSectionDate`, `suggestType`, `buildImportPlan`, `mergeSections`, `splitSectionAt`, `RECORD_TYPE_MARKER_RE` (campaign-record signatures); `addTimepoint` (Task 6).
- Produces: the wizard flow — pick `.docx` → mammoth converts → `splitSections` → per-section rows with type dropdown seeded by `suggestType(section, COMPANION_IMPORT_TYPES)` where `COMPANION_IMPORT_TYPES = ["person","place","quest","shop","loot","encounter","organization","poi","event","list","session","journalentry"]` (this replaces campaign-record's `RECORD_TYPES` — `suggestType`'s internal keyword table maps npc-ish sections to `person`; extend its keyword map accordingly when copying: `npc→person`, `media→picture`, `pc→person`, `item→journalentry`, `checklist→list`) → confirm → per row create a `JournalEntry` with a page flagged `{"monks-enhanced-journal": {type}}` (or companion session flags for `session`), body into `text.content`; dated session headers each get `addTimepoint(timeline, label, null, parsedDate)` + a link to the created session entry; inline images extracted via `parseImageDataUri`/`imageExtension` and uploaded under `worlds/<world>/mej-campaign-companion/` then referenced. Document creation happens only on final confirm; per-section failures collect into a result dialog, no partial commit before confirm.
- [ ] **Step 1:** Copy logic + tests verbatim; adjust `doc-import.test.js` type expectations to the new type list; run → PASS.
- [ ] **Step 2:** Adapt the wizard app (read campaign-record's first; keep its section-merge/split UI); swap creation calls to MEJ entries.
- [ ] **Step 3:** In-world: import `~/Claude/Projects/campaign-record/examples/Radiant Citadel.docx` — sections detected, types suggested, entries created and openable, dated sessions on the timeline, images render. **Step 4: Commit.**

---

### Task 12: Docx export

**Files:**
- Create: `vendor/docx.iife.js` (copy), `scripts/logic/doc-export.mjs` (copy), `scripts/apps/export-dialog.mjs` (adapted from `$CR`), `test/doc-export.test.js` (copy)
- Modify: hub toolbar (GM-only "Export" button), `lang/en.json`

**Interfaces:**
- Consumes: `replaceUuidTags`, `htmlToNodes`, `snapshotToDocModel` (campaign-record signatures).
- Produces: export dialog: choose entries (default: all MEJ-typed + sessions, ordered by timeline then alphabetical), GM-content checkbox (off ⇒ session `gmNotes` and hidden relationship targets omitted); snapshot builder maps each entry to campaign-record's snapshot shape (`{ title, type, html }` — read `snapshotToDocModel`'s expected input in the source before writing this) with type markers (`Campaign Record type: person` lines) so round-trip re-import works via `RECORD_TYPE_MARKER_RE`; browser download of the generated `.docx`.
- [ ] **Step 1:** Copy logic + test verbatim; run → PASS. **Step 2:** Build the dialog + snapshot mapping. **Step 3:** In-world: export 5 mixed entries, open in Word/Pages (fields intact), re-import through Task 11 wizard → types re-detected from markers. **Step 4: Commit.**

---

### Task 13: Player collaboration (writable sessions + upload relay)

**Files:**
- Create: `scripts/logic/media-relay.mjs` (copy), `scripts/hooks/media-relay.mjs` (adapted), `test/media-relay.test.js` (copy)
- Modify: `scripts/campaign-companion.mjs` (setting `playersWriteSessions`, socket registration on `SOCKET`), `scripts/sheets/SessionSheet.mjs` (player recap section; image-drop calls relay when lacking FILES_UPLOAD), `lang/en.json`

**Interfaces:**
- Consumes: `chunkBase64`, `createRelayAssembler`, `chunkProblem`, `enforcedImageName`, `isRelayableImageType`, relay constants (campaign-record signatures); read `$CR/scripts/hooks/media-relay.mjs` for the GM-side assembler wiring and permission checks — port its structure, swapping socket channel and target: relayed uploads land in `worlds/<world>/mej-campaign-companion/uploads/` and the resulting path is returned to the requesting player over `UPLOAD_MEDIA_RESULT_ACTION`.
- Produces: with `playersWriteSessions` on — new Session entries created with `ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }`; every player gets an editable `playerRecaps[userId]` section on any session they can see (writes relayed GM-side over the socket when the player lacks entry ownership, mirroring MEJ's own `saveUserData` pattern); GM-side socket handlers validate `game.users.get(senderId)` exists and chunk limits before writing.
- [ ] **Step 1:** Copy logic + test verbatim; run → PASS. **Step 2:** Adapt hooks + SessionSheet. **Step 3:** Two-client in-world check: player writes their recap on a GM-owned session (persists, other player can read, only author can edit); player without upload perms drops an image → GM relay stores it and it renders; 11MB file → clean size-limit error. **Step 4: Commit.**

---

### Task 14: Playwright e2e suite

**Files:**
- Create: `playwright.config.mjs`, `tests/e2e/helpers/` (copy campaign-record's helpers wholesale, then retarget world/module ids), and specs: `tests/e2e/00-mej-api.spec.mjs`, `01-session.spec.mjs`, `02-hub-timeline.spec.mjs`, `03-search.spec.mjs`, `04-auto-capture.spec.mjs`, `05-docx-import.spec.mjs`, `06-player-collab.spec.mjs`
- Modify: `package.json` (restore `test:e2e` script)

**Interfaces:** Consumes the Foundry v14 test env (launch/login per `foundry-v14-test-env` memory — World A logins, GM + player). Base every spec on the closest campaign-record spec in `$CR/tests/e2e/` (38 to choose from).
- Produces: `00-mej-api.spec.mjs` is **the Stage-1 regression spec promised in the design doc §9**: asserts (a) `game.MonksEnhancedJournal.externalTypes.session` exists, (b) a person and a shop entry open with their MEJ sheets (built-ins unchanged), (c) a session entry opens with `SessionSheet`, (d) with the companion module disabled, an existing session page's `flags["monks-enhanced-journal"].type` survives a GM reload (the `fixType` foreign-subtype guard).
- [ ] **Step 1:** Copy + retarget helpers/config; get `00` green. **Step 2:** Write specs 01–06 covering each task's in-world verification steps (the manual checks above become assertions). **Step 3:** `npm run test:e2e` → all green, plus `npm test` full unit suite green. **Step 4: Commit.**

---

### Task 15: Companion docs + release polish

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `docs/manual-test-checklist.md`
- Modify: `lang/en.json` (sweep all templates for hardcoded strings), `module.json` (`url`, `manifest`, `download` placeholders pointing at a `bularzik/mej-campaign-companion` GitHub repo)

- [ ] **Step 1:** README: what it does (per spec §1 feature list), requirements (MEJ ≥ the API version), settings reference, docx round-trip notes, player-collaboration notes. CHANGELOG: `0.1.0` initial entry. Manual checklist: the non-automatable items (second-display behavior, non-dnd5e degradation, Word/Google Docs visual fidelity, libWrapper conflict scan with Monk's Common Display).
- [ ] **Step 2:** i18n sweep: `grep -rn '"[A-Z]' templates/ scripts/ | grep -v i18n` — every user-facing literal moves to `en.json`.
- [ ] **Step 3:** Full suite: `npm test && npm run test:e2e` → green. **Step 4: Commit.**

---

### Task 16: Integration wrap-up (MEJ repo)

**Files:**
- Modify (MEJ repo, `feat/extension-api` branch): none — verification only. Then merge bookkeeping.

- [ ] **Step 1:** Re-run MEJ's own regression surface against the API branch with the companion active: open every built-in sheet type, run one shop purchase (confirm flow), one quest objective toggle, one relationship add — unchanged behavior.
- [ ] **Step 2:** Merge `feat/extension-api` into `integration-14.07` (no fast-forward, matching existing merge style): `git checkout integration-14.07 && git merge --no-ff feat/extension-api`. Do NOT touch `main`, do NOT tag, do NOT open the upstream PR (user does both).
- [ ] **Step 3:** Push both repos: MEJ branches `feat/extension-api` + `integration-14.07`; companion `main` to its new GitHub remote if the user has created it (if no remote exists yet, note that in the completion report instead).

---

## Self-review notes (performed at plan-writing time)

- **Spec coverage:** §2 identity → Task 4; §3 API → Tasks 1–3 (regression spec relocated to Task 14's `00-mej-api.spec.mjs` — deliberate deviation from spec §9 item 3, since MEJ has no unit-test infra on `integration-14.07` and bolting one on would bloat the upstream PR); §4 Session/timeline → Tasks 5–6; §5 Hub → Task 7; §6 search/auto-capture/auto-link/docx/player-collab → Tasks 8–13; §8 error handling → embedded in Tasks 4 (guard), 11 (transactional import), 13 (socket validation), 9–10 (observer hooks: adapted hook files must wrap their bodies in try/catch that `console.error`s and returns — carry this into Tasks 9 & 10 step 2); §9 testing → per-task vitest + Task 14; §10 exclusions respected (no migration, no media type, no localization beyond en).
- **Type consistency:** timepoint/link shapes, search record/result shapes, and session flag shape are each defined once in their producing task's Interfaces block and referenced by exact name elsewhere.
- **Known risk:** Task 2's `BlankJournal` id handling is speculative until the model class is read — its step 1 explicitly instructs reading the class first and offers the `shellPageId` fallback.
