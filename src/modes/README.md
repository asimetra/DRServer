# Writing a game mode

A mode is code that changes what a dungeon run is — who gets in, what the
floors are, what the run pays, when it ends — without the core knowing the
mode exists. Ranked races (`src/ranked/`) are the first one and the worked
example; `docs/ranked.md` is its design. This page is what a second mode
needs.

## The seam

`src/modes/hooks.js` is the whole of it. The runtime calls `modeHooks.<name>`
at a fixed set of points; a mode installs its answers under its own name:

```js
import { installModeHooks } from "../modes/hooks.js";

const uninstall = installModeHooks("mymode", {
  routeEntry: (connection, request) => request,   // see below
  planFor: async (session, mapNodeId) => null,
  // ...only the hooks you need; the rest keep the game's own behaviour
});
```

Every hook has a default that leaves the runtime as it was, and more than one
mode may be installed at once: how their answers are put together is each
hook's rule (`COMBINE` in hooks.js — a chain, the first answer, all agreeing,
any saying yes, or every mode told). A mode's answer that throws is logged and
replaced by the default: a mode's fault never fails a dungeon.

The hooks, in the order a run meets them:

| Hook | Asked when | Answer |
|---|---|---|
| `routeEntry(connection, request)` | ClientRequestEntry arrives | The request to admit instead — typically the same with `mode: "mymode"` and a node of your own choosing. `mode` is the mark the rest reads; it is never read off the wire. |
| `entryAllowed(account, mode)` | Admission of a request in your mode | `{ ok }` or `{ ok: false, reason }`; a refusal is the client's own "not yet" popup. |
| `modeRules(mode)` | Before there is a run: admission, who may join | The run rules your mode plays by (below). |
| `planFor(session, mapNodeId)` | The run is being built | A floor plan, or null for the node's own. `session.modeEntry` is your mark. |
| `heroRequested(session)` | The client built a floor and asked for its hero | — |
| `floorCompleting(session)` | A floor is about to complete | `false` holds it. |
| `runRules(session)` | At every pay point of a run | The run rules, or null for the game's own. |
| `runFailed(session)`, `runLeft(session, how)` | The run is lost; the player left or dropped | — |
| `idle(session, marked)`, `idlingAllowed(session)` | Idle marked or cleared; before an idle player is sent home | `true` keeps them. |
| `heroEvent(session, event)` | Every accepted move, turn, swing, swing stop, chat line | — (`{ type, ... }`; cheap, called a lot) |
| `reportRows(recipient, rows, { success, reportOf })` | The end-of-run report is built | The rows as the recipient sees them; a row for somebody not in the run is `transient: true`. |
| `friendList(rows)`, `loggedIn(session)`, `isSystemAccount(id)` | The friend list is answered; a login; an id is checked | A list with your own rows; —; `true` for an id of yours that is never an account. |
| `drawOffered(session)` | `/draw` | `true` if you took it. |

## What a run pays

`src/socket/run-rules.js` is one object the core reads at every pay point:

```js
import { runRules } from "../socket/run-rules.js";

export const MY_RUN_RULES = runRules({
  mode: "mymode",
  unlockCheck: false,            // entry does not ask whether the hero opened the node
  pays: { experience: false },   // the rest stay as the game pays them
  mapCredit: false,              // the node is not marked done
  rankable: false,               // off the run boards
  joinable: false,               // friends cannot follow a player in
});
```

Answer it from `modeRules(mode)` (by name) and `runRules(session)` (for a run
of yours); everything unsaid is the game's own. These are the only knobs:
experience, gold, chests, keys, trophies, gems, the unlock check, map credit,
the boards, joining.

## The floor plan

What `planFor` returns is read by the core for any run:

```js
{
  floors: [
    { authored: "castle/arena/db_floor_TUTORIAL_LEVEL_final.json", quiet: { npc: [], spawn: { x, y } }, retile: [] },
    { generated: { tileLibrary, tier, tileCount, seed }, node, numbered: { index: 0, of: 2 } },
  ],
  preloadArtFloors: 1,          // the area preloads the art of the first floor only
  preloadTileLibraries: [],     // tile files to preload beyond the floors' own
}
```

- `quiet`: nothing on the floor that fights, pays or ends it; the NPCs and
  spawn you name instead. A quiet floor is `harmless`: nothing on it takes damage.
- `retile`: other tiles of the same library in place of the file's.
- `node`: the floor belongs to another map node; the run becomes that node's
  at the transition (experience budget, presence, the client's own HUD).
- `numbered`: what floor number the client shows.

A plan can be changed while the run goes on — ranked appends the race's floors
to a lobby's plan and ends the lobby floor — as long as `floorCount` is kept
with it.

## What the stock client can and cannot do

The client cannot be changed. What it does on the server's say-so, and what it
never does, is measured in `docs/ranked.md` ("What does not work, and why this
shape"): no new map nodes, no custom text, nobody moved out of town or across
dungeon areas by the server; but any floor transition within an area, a system
friend with a JOIN button, chat lines, and the effects in `config/ui-effects.json`
(banners, sounds, shakes, the countdown, floaters). A modded client declares
what it does itself in `Demographics.capabilities` (`src/socket/capabilities.js`).

## Where it runs

With match workers on, a mode's runs go to one worker (`RANKED_WORKER` in
`src/ranked/remote.js`) and the mode is started there (`match-worker-thread.js`);
the main thread installs only the hooks that answer on a connection. A second
mode shares that worker.

## Testing

A mode is testable without a socket: the hooks take plain objects, and
`test/ranked-stock-client.test.js` shows a harness that stands in for the
runtime (`sessionOf`, `completeFloor`, `raceFloors`) and turns time by hand.
