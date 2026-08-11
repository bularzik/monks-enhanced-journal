# MEJ Test Harness

Playwright scripts that drive the live local Foundry v14 install. **Agents: use
this instead of Playwright-MCP browsing** — a scripted check runs in seconds;
MCP round-trips take minutes each. Reserve MCP for exploratory looks only, and
even then batch via `browser_evaluate` and never take full-page snapshots.

## Run

    cd test
    node run.mjs              # all specs
    node run.mjs smoke        # specs matching a substring
    node specs/connect.mjs    # a single spec directly

The harness boots Foundry itself if it's down (`~/FoundryVTT-14/start-foundry.command`)
and activates `world-a` if another world is live. First-time setup:
`npm install && npx playwright install chromium`.

**Ordering note:** `run.mjs` runs specs alphabetically in one Node process.
`zz-currency-systems.mjs` switches the live server through two other worlds
and back (see its own header comment) - it's prefixed `zz-` specifically so
it sorts and runs *last*, after every other spec, rather than immediately
before whichever spec would otherwise follow it alphabetically (this used to
land right before `deep-search.mjs`, and its world-switch-then-restore
occasionally raced that spec's session connect - a pre-existing test-infra
flake, not a product bug). Keep it named so it sorts last if you ever rename
it. `node run.mjs currency-systems` (a substring match) still finds it.

## Writing a throwaway check (fix sessions)

Put it in `scratch/` (gitignored). Template:

    import assert from 'node:assert/strict';
    import { withSession, createEntry, openEntry } from '../helpers/mej.js';
    await withSession('my-check', { users: ['Gamemaster'] }, async ({ pages }) => {
      const gm = pages['Gamemaster'];
      // page.evaluate against Foundry's API; DOM clicks only to test UI wiring
    });

Run with `node scratch/my-check.mjs`. If a throwaway check guards a real fix,
promote it to `specs/`.

## Rules

- Test entities are named `TT-...` and are auto-swept; never touch hand-made
  entries (`Baseline Test`, `T-*`, ...).
- Headless only; timeouts ≤15s; single browser per spec (8GB RAM).
- Clients join with `core.noCanvas` forced on (see `helpers/foundry.js`
  `join()`) — the scene canvas never initializes, since these specs only
  exercise journal sheets (DOM), which are canvas-independent.
- On failure you get the assertion, screenshots in `screenshots/`, and the
  buffered browser console.
- **Shared-server displacement**: Foundry only allows one connection per user;
  logging in as Gamemaster/User 1/User 2 displaces any existing connection for
  that same user, and symmetrically another session logging in as one of
  those users mid-spec displaces the harness (symptom: `game is not defined`
  errors mid-spec, or the page finds itself back at `/join`). Before running,
  check `curl -s localhost:30000/api/status` — a nonzero `users` count means
  other sessions are connected and mutual displacement is possible. Fixture
  names are also fixed (`TT-shop`, `TT-quest-objectives`, ...), so never run
  two harness instances concurrently — they'd sweep each other's fixtures.

## Release zips

**Before uploading any release, run**

    node release-smoke.mjs <manifest-url-or-local-module.json>

e.g. `node release-smoke.mjs https://github.com/<owner>/monks-enhanced-journal/releases/download/<tag>/module.json`,
or against a freshly built artifact: `node release-smoke.mjs /tmp/mej-release/<tag>/module.json`
(it uses the `module.zip` beside a local manifest, otherwise the manifest's own
`download` URL). Exit 0 = safe to upload; exit 1 = do not upload; exit 2 = usage
or pre-flight refusal.

It installs the artifact the way a user does — manifest → download → unzip into
`Data/Data/modules/` — in a throwaway `tt-release-smoke` world with only
`monks-enhanced-journal` + `lib-wrapper` enabled, and asserts the sidebar
*Create Journal Entry* → *Shop* path really opens MEJ's own sheet (twice in one
session, to catch a libWrapper wrapper that stops chaining), that the persisted
page type stays openable across a reload, that bug-era `text`+flags pages still
open, and that a plain Text entry still gets the core sheet. It is the
regression test for the 14.04 "shop opens the plain journal note" defect.

It is **not** a spec and `run.mjs` never picks it up (that only scans `specs/`):
it hits the network, stops and starts the Foundry server, swaps the live module
directory aside and creates/deletes a world. It refuses to start unless
`/api/status` reports `users: 0`, and it restores everything — module directory
back, world deleted, Foundry restarted on `world-a` — from a `finally`, even
when an assertion throws mid-world. All machine-specific paths are in the
`CONFIG` block at the top of the file.

`test/` must never ship. The canonical release zip command (run at repo root):

    zip -r module.zip . -x 'test/*' '.git/*' '.claude/*' 'docs/*' 'node_modules/*' '.superpowers/*' '*.png' '.DS_Store' 'packs/.DS_Store' '.remember/*' '.github/*'

Adjust the exclusion list against what previous releases shipped (compare with
`unzip -l` of the prior release's module.zip) before uploading.

## `test-mythras` / `test-symbaroum` worlds (added 2026-08-10, currency-config validation)

Two more permanent test worlds, alongside the existing seven (`test-pf2e`,
`test-dsa5`, `test-dcc`, `test-dnd4e`, `test-wfrp4e`, `test-sfrpg`,
`test-fallout`): **Test Mythras** (`test-mythras`, system `mythras` 2.3.0) and
**Test Symbaroum** (`test-symbaroum`, system `symbaroum` 6.1.6). Both have
`monks-enhanced-journal` + `lib-wrapper` enabled, a blank-password Gamemaster,
and a blank-password `User 1` player (added explicitly — fresh Foundry-created
worlds only auto-create the Gamemaster). Both also have the world setting
`monks-enhanced-journal.allow-player` set `true` (default `false`) — without
it, `MonksEnhancedJournal.isAllowedToUseEnhancedJournal()` refuses every
non-GM `openJournalEntry` call, which every other `test-*` world already had
enabled from earlier sessions but these two didn't until `currency-systems.mjs`
needed a player-side shop flow.

**Installing a system package while a world is running**: the obvious `/join`
"Return to Setup" form 403s with `ERROR.InvalidAdminKey` on this dev box —
`JoinView.handlePost`'s `shutdown` case requires a server admin password to be
*configured at all* (`Config/admin.txt`), which this box has none of, so that
gate always rejects it regardless of what's submitted. `helpers/foundry.js`
`ensureWorld()` used to drive exactly that broken form (nothing had ever
exercised a world-to-world switch before this session — every prior spec only
ever used `world-a`); it's fixed now to reproduce what the in-game GM "Return
to Setup" control actually does: log in as Gamemaster, then
`POST /setup {shutdown:true}` from that authenticated session
(`World#deactivate` only needs the requesting session to resolve to a
GAMEMASTER-role user — no admin password involved). From an inactive server,
package installs and world creation are the plain setup/create POST actions
(`POST /setup {action:"installPackage", type:"system", id, manifest}`,
`POST /create {action:"createWorld", id, title, system}`), both effectively
unauthenticated here since `config.adminPassword` is null.

**Symbaroum's published manifest (6.1.6) caps `compatibility.maximum` at 13**
— Foundry refuses to launch a world using it as installed (`World.get` throws
"package ... is not available for use"). Worked around for this dev box only
by hand-patching `compatibility.maximum` to `"14"` in both the installed
`Data/Data/systems/symbaroum/system.json` and `Data/Data/worlds/test-symbaroum/world.json`,
then `POST /setup {action:"resetPackages"}` to drop Foundry's in-memory
package cache before relaunching. The system otherwise loads and runs cleanly
on v14 (no console errors). Mythras (2.3.0) advertises v11–v13 verified but
has no hard `maximum` cap and launched as published.

### Discovered schemas (enh/currency-config Task 5)

Both worlds' actor/item schemas were dumped by creating a real `Actor` +
`Item` as GM and inspecting `.system` (see the (gitignored) probe scripts this
session used, `scratch/tt-discover-*.mjs`, for the exact repro if needed
again).

**Symbaroum** — a plain object path, exactly as anticipated:
- currency: `actor.system.money` = `{ thaler, shilling, orteg }` (flat
  numbers, no `{value:}` wrapper)
- item price: `item.system.cost` (string, e.g. `""` — not the module's
  `price` default)
- item quantity: `item.system.number` (not `quantity`)

**Mythras** — **not** a plain object path. `actor.system` has no currency
field of any kind (keys: `characteristics`, `trackedStats`, `attributes`,
`currentLuckPoints`, ... — see the probe script output). Currency is instead
held as embedded `Item` documents of `type: "currency"` on the actor (e.g. a
"Silver Pieces" item with `system.quantity` = the amount), matched by name —
this is exactly what the pre-existing hardcoded `case 'mythras':` branch in
`EnhancedJournalSheet.getCurrency`/`addCurrency` already assumes
(`actor.items.find(i => i.type == "currency" && i.name == currency.name)`,
`monks-enhanced-journal/sheets/EnhancedJournalSheet.js:1002-1007`). Item
price/quantity are plain paths (`item.system.value`, `item.system.quantity`),
but currency is not.

### Validation outcome (ruling: validate both systems, zero new product code)

The initial stop-condition flag on Mythras was overruled: since MEJ already
has a working, Task-4-independent hardcoded branch for Mythras's embedded-item
currency (cited above), the ruling was to validate both systems against it as
configured (`currency-attribute` left **blank** for Mythras — that setting is
irrelevant there, the hardcoded branch bypasses `currencyname()` entirely) and
treat any failure *inside* that pre-existing branch as a documented, not-fixed
outcome. `test/specs/zz-currency-systems.mjs` does this, parameterized over both
worlds:

- **Symbaroum**: `price-attribute: "cost"`, `quantity-attribute: "number"`,
  `currency-attribute: "money"`, Edit Currency denomination ids
  `thaler`/`shilling`/`orteg` (must equal the `system.money` object keys) —
  fully validated end-to-end, every currency mutation is a hard assertion
  (price renders on drop, purchase deducts, sell credits).
- **Mythras**: `price-attribute: "value"`, `quantity-attribute`/
  `currency-attribute` left blank, Edit Currency denomination **name** set to
  match the actor's embedded `currency`-type Item's name exactly (that's how
  `getCurrency`'s mythras branch finds it) — price-on-drop and "item lands on
  actor" are hard assertions; the two currency-mutation assertions
  (purchase-deducts, sell-credits) are soft/logged rather than thrown, because
  `EnhancedJournalSheet.addCurrency`'s mythras branch has a real, pre-existing
  bug: `EnhancedJournalSheet.js:1162` compares `i.name == currency` (the whole
  currency-row object from `MonksEnhancedJournal.currencies`) instead of
  `i.name == currency.name`, so it can never match the embedded Item and
  silently no-ops. `getCurrency` (the read/affordability side, used to decide
  whether a purchase/sell is even allowed) is correct and unaffected — only
  the write side is broken. Not fixed here (zero new product code per the
  ruling on this task); see `task-5-report.md` in the same directory for the
  full writeup and two more tolerated-but-unrelated bugs the spec's console
  filter documents (a `ShopSheet` sell-emit missing `actorId`, and two
  Symbaroum-system-side data-preparation reentrancy quirks).

`node run.mjs currency-systems` passes green (both cases); full suite is
10/12 (`internal-followups.mjs`/`price-tiers-world.mjs` fail as expected —
sibling-branch specs not present on `enh/currency-config`).
