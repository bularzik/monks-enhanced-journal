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

`test/` must never ship. The canonical release zip command (run at repo root):

    zip -r module.zip . -x 'test/*' '.git/*' '.claude/*' 'docs/*' 'node_modules/*' '.superpowers/*' '*.png' '.DS_Store' 'packs/.DS_Store' '.remember/*' '.github/*'

Adjust the exclusion list against what previous releases shipped (compare with
`unzip -l` of the prior release's module.zip) before uploading.
