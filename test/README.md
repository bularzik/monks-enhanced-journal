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
