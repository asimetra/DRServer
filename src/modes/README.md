# Writing a game mode

A mode is code that changes what a dungeon run is — who gets in, what the
floors are, what the run pays, when it ends — without the core knowing the
mode exists. Ranked races (`src/ranked/`) are the first one and the worked
example; `docs/ranked.md` is its design. This page is what a second mode
needs. [A recorded 1v1 race](https://youtu.be/0fzvQxgv8YI) shows what the
first one looks like on the unmodified client.

## What a mode may rely on

The surface below is the contract: it changes only with a note in the commit
and a change to `test/mode-surface.test.js`, which pins it. Everything else in
`src/` is the core's own and may change without notice — a mode that reaches
into `src/socket/*` directly is reaching past the seam, and the core will not
keep still for it.

| Surface | Where | What is pinned |
|---|---|---|
| The hooks | `src/modes/hooks.js` — `installModeHooks`, `modeHooks`, `MODE_HOOK_NAMES`, `MODE_HOOK_COMBINE` | the 18 names, their arguments, and how several modes' answers combine |
| Run controls | `src/modes/runtime.js` — `runControls`, `installSessionLookup` | what a mode may ask the core to do: `party`, `sessionOf`, `win`, `lose`, `sendHome`, `planAhead`, `endFloor`, `reward`, `heal`, `gift`, `say`, `grantBuff` |
| Game data | `src/modes/game-data.js` — `mapNodes`, `mapNode`, `nodePlan`, `planTileLibraries`, `gameTable` | what a mode may read of the deployment's game data, to draw floors of its own |
| Records | `src/modes/records.js` — `createModeRecords` | what a mode keeps across restarts: `append`, `all`, `forAccount`, `version`; a record is `{ id, at, accounts, ... }` |
| Run rules | `src/socket/run-rules.js` — `runRules`, `STOCK_RUN_RULES` | the knobs: `mode`, `unlockCheck`, `pays.{experience,gold,chests,keys,trophies,gems}`, `revives`, `mapCredit`, `rankable`, `joinable`, `together` |
| The mark | `request.mode`, `match.mode`, `session.modeEntry` | a mode's name travels on these, set by `routeEntry`, never read off the wire |
| The floor plan | the shape `planFor` answers (below) | `floors[]` of `{ node, quiet, retile, numbered, harmless, npcLevel, tier, modifiers, healthBonus, damageBonus, attackSpeedBonus }`, `preloadArtFloors`, `preloadTileLibraries` |
| The effect book | `config/ui-effects.json` — `playEvent`, `EFFECT_SPEC_KEYS` | an event is `{ banner, sound, shake, zoom, countdown, floater, to, replacesChat }`; lines and parts; `strings` for installed clients |
| The notice board | `config/notices.json` — `src/notices.js` | a notice's fields (`ACTIONS` for the button) |
| Chat commands | `src/socket/commands.js` — `define({ name, role, summary, usage, run, mode })`, `undefineMode` | a mode's commands come and go with it |
| Content | `/content`, `Demographics` declarations, the policy below | the core never requires content; a mode offers it with a stock fallback |
| The test harness | `test/one-life.test.js`, `test/ranked-stock-client.test.js` — hooks driven with plain objects | a mode is testable without a socket |
| The registry | `src/modes/index.js` — `registerMode`, `registeredModes`, `startModes` | every mode as `{ name, together, start }`, started the same way on every thread |
| The seat | `src/modes/seat.js` — `seatRuns`, `seatSaid`, `tellMain`, `onTold` | whether a together mode runs on its worker now; and what a mode says to its main half from any thread — a command said in a dungeon, the seat's count of players waiting |

Internal, and used by ranked today, but not promised: the stock-client adapter's
copies and ghost (`src/ranked/stock-client/`), the system-friend row. The second
mode, one life, needed none of them;
what a third needs of them becomes surface when it does.

A mode that needs something the seam lacks adds a *knob the core reads*, never a
branch on the mode's name: `revives` came with one life, and the bomb, the
rescue and the defeat countdown read the rule without knowing who set it.

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
| `combatEvent(session, event)` | A credited hit or kill on an enemy; a hero going down or getting back up | — (`hit { target, amount }`, `killed { target }`, `downed { hero }`, `revived { hero, by }` — `by` "floor" for one down when the floor ended and up on the next; the report's own counts, src/socket/combat-events.js) |
| `reportRows(recipient, rows, { success, reportOf })` | The end-of-run report is built | The rows as the recipient sees them; a row for somebody not in the run is `transient: true`. |
| `friendList(rows)`, `loggedIn(session)`, `isSystemAccount(id)` | The friend list is answered; a login; an id is checked | A list with your own rows; —; `true` for an id of yours that is never an account. |
| `drawOffered(session)` | `/draw` | `true` if you took it. |

## Asking the core

The hooks are the core asking a mode. `src/modes/runtime.js` is the other way
round, and a mode reaches for nothing else in `src/socket` to do these:

| Control | Does | Answers |
|---|---|---|
| `runControls.party(session)` | Everybody in the player's run, the player included | Sessions, empty with no run |
| `runControls.sessionOf(accountId)` | Finds the player's session on this thread | The session, or null when their run is not here |
| `runControls.win(session)` | Wins the run now, without its last floor | `false` if it was already over |
| `runControls.lose(session)` | Loses the run now | `false` if it was already over |
| `runControls.sendHome(session)` | Sends the player back to town, as their own exit would | A promise; `false` when it was not sent, so try again |
| `runControls.planAhead(session, floors, { replace })` | Adds plan floors after the plan's last; with `replace`, in place of every floor after this one. The party shares one plan | A function that puts the plan back — only while no later `planAhead` has changed it (true if it did) — or null with no run |
| `runControls.endFloor(session)` | Ends this floor now, as its exit would: on to the next, or the run won on the last | `false` if it could not (already ending, or held) |
| `runControls.reward(session, { gold, experience })` | Pays the player now, shown on the report and kept with the account. Whole amounts as given: the run rules and legendaries are for the game's own pickups | `{ gold, experience }` paid |
| `runControls.heal(session, { health, mana })` | Gives back a share (0 to 1) of the hero's most health and mana, as food does. A hero that is down is not healed | `{ health, mana }` gained |
| `runControls.gift(session, offerId, { from })` | Leaves any offer from the game data waiting in town as a gift, said to be from account `from` (required) | A promise of the gift, or null (no `from`, no such offer, no account, too many waiting) |
| `runControls.say(session, text)` | A line from the server in the player's chat log, to them alone | `false` with nobody to tell |
| `runControls.grantBuff(session, constant)` | Puts a buff from the game data on the hero | A promise of the buff's doid, or null |

Each takes the session however the mode holds it, a hook's context or what
`sessionOf` found, and finds the run's context itself. A player whose
connection is closing has none left; the answer is then false or null, never a
throw. A match worker installs its own members as the lookup at start-up
(`installSessionLookup`), so `sessionOf` finds the runs on whichever thread
asks.

## What a mode keeps

`createModeRecords({ mode })` is a mode's own log, kept wherever the server
keeps things: the `mode_records` table on PostgreSQL, `data/modes/<mode>.jsonl`
otherwise. A record is written once and never changed:

```js
import { createModeRecords } from "../modes/records.js";

const records = createModeRecords({ mode: "delve" });
await records.append({ id: runId, at: Date.now(), accounts: [first, second], depth: 14 });
await records.all();                         // every record, oldest first
await records.forAccount(first, { limit: 20 }); // one player's, newest first
await records.version();                     // changes when one is added: cache on it
```

`id` is unique within the mode (the same one twice is kept once), `at` is a time
in ms, `accounts` are who it is about; everything else is the mode's. A record
missing one of those is not kept, and `append` answers false rather than
throwing. Ranked's match log (`src/ranked/records.js`) is the same idea and
predates it.

## What a run pays

`src/socket/run-rules.js` is one object the core reads at every pay point:

```js
import { runRules } from "../socket/run-rules.js";

export const MY_RUN_RULES = runRules({
  mode: "mymode",
  unlockCheck: false,            // entry does not ask whether the hero opened the node
  pays: { experience: false },   // the rest stay as the game pays them
  revives: false,                // no bomb, no rescue; nobody standing is lost at once
  mapCredit: false,              // the node is not marked done
  rankable: false,               // off the run boards
  joinable: false,               // friends cannot follow a player in
  together: false,               // true: every run of the mode on one worker (the seat)
});
```

Answer it from `modeRules(mode)` (by name) and `runRules(session)` (for a run
of yours); everything unsaid is the game's own. These are the only knobs:
experience, gold, chests, keys, trophies, gems, the unlock check, revives, map
credit, the boards, joining, the seat.

Answer `modeRules` on **every thread**, the main one included: with match
workers on, the main thread admits the entry (the unlock check), answers who
may follow a player in (joinable) and picks the worker (together) before any run
exists. `together` is for a mode whose runs reach each other — ranked moves two
runs on at once, so both must be in one thread; it puts every run of the mode on
`SEAT_WORKER`, however busy. A party is one run, so a party mode leaves it off
and its runs go by load like the game's own.

## The floor plan

What `planFor` returns is read by the core for any run:

```js
{
  floors: [
    { authored: "castle/arena/db_floor_TUTORIAL_LEVEL_final.json", quiet: { npc: [], spawn: { x, y } }, retile: [] },
    { generated: { tileLibrary, tier, tileCount, seed }, node, numbered: { index: 0, of: 2 } },
    { generated: { tileLibrary, tier, tileCount, seed }, npcLevel: 60, modifiers: [3, 7] },
  ],
  preloadArtFloors: 1,          // the area preloads the art of the first floor only
  preloadTileLibraries: [],     // tile files to preload beyond the floors' own
}
```

- `quiet`: nothing on the floor that fights, pays or ends it; the NPCs and
  spawn you name instead. A quiet floor is `harmless`: nothing on it takes damage.
- `retile`: other tiles of the same library in place of the file's.
- `node`: the floor belongs to another map node; the run becomes that node's
  at the transition (experience budget, presence, the client's own HUD) — or
  from the start, when it is the first floor. The match keeps the node it was
  entered by, which is what strangers are matched into it by.
- `numbered`: what floor number the client shows.
- `npcLevel`: the level this floor's NPCs are generated at, in place of the
  run's (the node's tier). What a run that gets harder floor by floor sets. Not
  a number is level 1.
- `tier`: the `ColiseumTiers` row that stocks this floor and prices its depth,
  in place of the run's. A floor from another node's plan brings that node's
  (ranked's race floors do, onto a lobby plan that has none).
- `healthBonus`, `damageBonus`, `attackSpeedBonus`: shares over 1 for this
  floor's monsters — 0.25 is a quarter more health, damage or attack speed —
  in place of Infinite's growth with depth. Attack speed is capped at three
  times authored, on the server's timing and the client's animation alike.
- `modifiers`: the `DungeonModifier` ids active on this floor, in place of the
  Infinite schedule's. They do what they do on an Infinite floor, server and
  client alike, and one the floor before did not have shows as new. An id the
  game data lacks is dropped with a warning: the client would have no row for it.

A plan can be changed while the run goes on, with `runControls.planAhead`
(above): ranked adds the race's floors after the lobby's and ends the lobby
floor with `endFloor`, putting the plan back if the floor would not end. A run
with no end adds the next floor from `floorCompleting`, which is asked before
the core decides whether the floor ending is the last.

## What the stock client can and cannot do

The client cannot be changed. What it does on the server's say-so, and what it
never does, is measured in `docs/ranked.md` ("What does not work, and why this
shape"): no new map nodes, no custom text, nobody moved out of town or across
dungeon areas by the server; but any floor transition within an area, a system
friend with a JOIN button, chat lines, and the effects in `config/ui-effects.json`
(banners, sounds, shakes, the countdown, floaters). A modded client declares
what it does itself in `Demographics.capabilities` (`src/socket/capabilities.js`).

## Commands

A mode's chat commands are the mode's: define them with `define({ ..., mode })`
(`src/socket/commands.js`) when the mode starts, on every thread that answers
chat (the main thread for town, the match worker for a dungeon), and take them
away with the uninstall when it stops. The core's command set keeps none of a
mode's; with the mode off, `/draw` is an unknown command, which is the truth.
`src/ranked/commands.js` is the shape.

## Content and visuals

The core never requires a picture, a string or a game-data row the stock client
does not ship with. What it does is *offer* content: the server serves its game
data and assets from `/content` (`docs/client-setup.md`), a client either fetches
them from the server (`gameMasterPath`) or declares what it holds
(`Demographics`, as `uiStrings` does in `src/socket/ui-strings.js`), and a
client that does neither gets the stock behaviour. The rules for a mode's
content are three:

- meaning lives in the mode, decoration in the content: a player on a stock
  client with none of it must still understand what happened, from the game's
  own banners, sounds and summary screen;
- every piece of content has a stock fallback, and nothing in the core or the
  mode branches on "is the picture there" beyond choosing the fallback;
- anything that would *break* a client without it (a map node the client does
  not have, as a lobby node would) is gated: the server advertises its content
  id, and the feature opens only to a client that fetched or declared it.

A mode's content sits with the mode (`src/<mode>/content/`), and it comes last:
rules, fair play and matchmaking before any of it. Ranked today needs none —
its lobby node is the game's own `ARENA_1` — and the one optional piece it has,
the banner strings, is gated exactly this way.

## Where it runs

`src/modes/index.js` holds every mode as `{ name, together, start }` — the
shipped ones, and any a deployment adds with `registerMode` before the server
starts — and starts each the same way, on every thread. `start({ where })`
installs the mode and answers its stop; each is off unless its setting asks for
it (`ODS_RANKED`, `ODS_ONELIFE`), and one that throws as it starts is that mode
off, in the log, never the server.

```js
import { registerMode } from "./index.js";

registerMode({ name: "delve", together: false, start: async ({ where }) => { /* install */ return async () => {}; } });
```

With match workers on a mode is started twice: on the main thread, where it
installs the hooks that answer on a connection (entry, the friend list, chat in
town, and `modeRules`, which admission and the pool read), and inside the
workers, where its runs are. A mode whose runs are anybody's — one life —
starts on every worker. A `together` mode (its run rules say so, and so does
its registration) starts on the seat only (`SEAT_WORKER`), and the pool sends
every one of its runs there.

The main thread knows the seat through `src/modes/seat.js`: `seatRuns(mode)`
is whether the seat worker said, as it became ready, that it runs the mode —
false again when it exits, until its replacement says — and admission turns
away a together mode's entry while it is false. `tellMain(mode, data)` on the
seat reaches `seatSaid(mode)` on the main thread: ranked's count of players
waiting, for MATCHMAKER's name. Without workers this thread is the seat, and
both read the same way. A run routed to a worker without its mode is refused
rather than played as an ordinary one.

## A mode from outside: delve

`examples/modes/delve/index.js` is a whole mode written against this surface
alone and loaded from outside `src/` (`ODS_MODES=examples/modes/delve/index.js`):
a boss rush for a party anybody may join. `/delve` arms the next entry; every
floor is a boss's own map, drawn from the game data (`game-data.js`), never the
same twice running, each harder (`npcLevel`, the three bonuses, a modifier every
few bosses) and added from `floorCompleting` with `planAhead`; every few bosses
leave a gift for the party (`party`, `gift`); how deep each player went is kept
(`createModeRecords`). It is the one to read for a mode that draws its own floors.

## The smallest mode: one life

`src/modes/one-life/index.js` is a whole mode in one file, and the shape to copy
first. A player says `/onelife` — in a dungeon, since the stock client has no
chat in town — and the command tells the thread that routes entries
(`tellMain`, heard there with `onTold`); their next entry is marked
`mode: "onelife"` by `routeEntry`; `modeRules` and `runRules` answer that mark
with the stock rules under `revives: false` and `joinable: false`; the first
floor's `heroRequested` plays `onelife.entered` from the book and `runFailed`
plays `onelife.lost`. It reaches into no socket code: what it needed of the core
— a hero who stays down — became a run rule the core reads. Its test,
`test/one-life.test.js`, drives the hooks with plain objects and checks the
core's side of the rule the same way.

## Testing

A mode is testable without a socket: the hooks take plain objects.
`test/one-life.test.js` is the short form; `test/ranked-stock-client.test.js`
shows a harness that stands in for the runtime (`sessionOf`, `completeFloor`,
`raceFloors`) and turns time by hand.
