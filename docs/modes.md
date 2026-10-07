# Game modes

A game mode changes what a dungeon run is — who gets in, what the floors are,
what the run pays, when it ends — while the rest of the game stays the one the
client ships. Three come with the server. Each is off until its setting turns
it on, and all three run on the **unmodified client**: nothing is installed on
the player's side.

| Mode | What it is | How a player enters | Turned on by |
|---|---|---|---|
| [Ranked races](#ranked-races) | Two players, one randomly drawn dungeon, the faster clear wins; rated, with leagues | **JOIN** on `MATCHMAKER` in the friend list | `ODS_RANKED=1` |
| [Delve](#delve) | A boss rush with no end: every floor a trophy boss, each harder, until the party falls | **JOIN** on `DELVE` in the friend list, or `/delve` | `ODS_DELVE=1` |
| [One life](#one-life) | An ordinary dungeon with no revives: a fall is final | `/onelife`, then enter a dungeon | `ODS_ONELIFE=1` |

To write a new one, see [Writing a game mode](../src/modes/README.md).

## Getting in

The stock client has no way to pick a mode, so the server offers one in the
place every player already looks: **the friend list**. A mode with a door puts
a row at the top of every player's list — `MATCHMAKER` for ranked, `DELVE` for
delve — shown online and in a dungeon, so the client draws its own **JOIN**
button beside it. Pressing it enters the mode. The row's name carries how many
are waiting or inside (`DELVE (3)`).

A mode can also be armed by a chat command for the player's **next** dungeon.
The stock client has no chat in town, so the command is said in a dungeon; the
run after it is the mode's. `/<command> off` disarms it, and joining a friend
does not use it up.

A mode's commands exist only while the mode is on; with it off, they are
unknown commands. All of them are listed in [Chat commands](chat-commands.md).

## Ranked races

Two players are paired by rating and sent into the same dungeon, drawn at
random with the same seed for both, and the first to clear it wins. Everything
is the game's own: the lobby is a game floor, the countdown and results are the
game's banners, the rival is drawn as a shade on the floor, and the prize
arrives as an in-game gift.

- **Queueing:** JOIN on `MATCHMAKER` takes the player to the lobby floor.
  Standing in the ring is being in the queue; walking out of it is leaving.
  The others waiting are shown in the lobby as nameless copies of their heroes.
- **The race:** both runs start together; the rival's progress is announced as
  they clear floors. `/draw`, said by both, calls a broken race off with no
  rating moved. Leaving or dropping loses it.
- **What it pays:** the gold and loot picked up on the floor. No experience,
  chests, keys, trophy or gems, and no map credit: the dungeon is drawn, not
  chosen, and a mode that paid in full would be a way to farm the end of the map
  from level one.
- **The prize:** a gift from `MATCHMAKER`, waiting in town, by result and by the
  league the race left the player in (`rewards` in the settings).
- **Rating and leagues:** Elo from 1000; Wooden, Silver from 1050, Gold from
  1200, and Dragon for the top 3% of the board. `/rank` says the player's place
  and who leads. The board and each player's standing are on the internal API
  for a website (`/internal/v1/ranked/board`, and `ranked` on every profile).
- **Who may enter:** anybody, unless the operator sets a least hero level or
  requires the tutorial done (`ODS_RANKED_MIN_HERO_LEVEL`,
  `ODS_RANKED_REQUIRE_TUTORIAL`).

The code is `src/modes/ranked/`: the queue, the race's state machine and the
rating are plain modules there, each with its reasoning at the top, and the
stock-client adapter — lobby, ring, ghost, notices — is `stock-client/`.

## Delve

A boss rush for a party anybody may join. Every floor is one of the game's
trophy bosses, drawn at random and never the same twice in a row, and each is
harder than the last. The run goes on until the whole party is down, or walks
out.

- **Getting in:** JOIN on `DELVE`, or `/delve` in a dungeon for the next run.
  Strangers are matched in before the first boss; a friend may JOIN a friend's
  delve at any point.
- **The bosses:** every boss map in the game data but the tutorial's and the
  village defence, which is not a boss fight.
- **How it hardens, per boss after the first:** monster level +6 (from 10),
  health +12%, damage +8%, attack speed +5% (never past three times); from the
  third boss the floor's toughest monsters heal a share of the damage they deal
  (5%, rising 5% a boss, 40% at most); and every third boss adds one of the
  game's own dungeon modifiers, which stays for the rest of the run.
- **Falling:** a downed party has 10 seconds to get back up, not the minute an
  ordinary dungeon gives.
- **What it pays:** gold and experience as any run does. The bosses' treasure
  is item boxes — small ones, royal ones from the sixth boss — never chests, and
  each is the player's the moment it is picked up, since a delve has no report
  until it ends. No keys, trophy or gems, and no map credit.
- **Gifts in town:** every third boss beaten leaves a gift for each player who
  fought at least three bosses of the run: 5 Health Bombs at the third, a Party
  Bomb at the sixth, and 5 gems from the ninth on — a few, since a delve can be
  run again and again.
- **Weapons:** from the tenth boss, every fifth may drop a weapon for each such
  player (one chance in two): uncommon, rare from the fifteenth, legendary from
  the twenty-fifth, at that boss's monster level (never above what the hero can
  reach). It waits in town as a gift, and a full storage only keeps it waiting.
- **What is kept:** how deep each player went, once a run.

The numbers are `DELVE_DEFAULTS` in `src/modes/delve/index.js`.

## One life

An ordinary dungeon, played for keeps: no Health Bomb, no rescue by a friend,
and a floor with nobody left standing is lost at once rather than after the
countdown. Everything else is the game as shipped — the same nodes, the same
pay, the same map credit.

- **Getting in:** `/onelife` in a dungeon makes the player's next run one life;
  `/onelife off` calls it off. Joining a friend's run keeps it for the player's
  own next one.
- **Nobody walks in by accident:** a one-life run takes no one who did not
  choose it — friends cannot JOIN it, and no stranger is matched in.

It is the smallest mode there is, and the one to read first when writing one
([Writing a game mode](../src/modes/README.md), "The smallest mode").

## Settings

Each mode reads its own settings: its section of the config file, with
`ODS_*` environment overrides. The core keeps none of them.

| Mode | Turned on by | Config file section | Overrides |
|---|---|---|---|
| Ranked | `ODS_RANKED=1` | `"ranked"` — lobby, ring, copies, ghost, leagues, rating, entry, rewards ([defaults](../config/server.defaults.json)) | `ODS_RANKED_*`: `LOBBY_NODE`, `LOBBY_FLOOR`, `COUNTDOWN_MS`, `LOBBY_IDLE_MS`, `MAX_DURATION_MS`, `FORFEIT_WINDOW_MS`, `DRAW_WINDOW_MS`, `LOAD_TIMEOUT_MS`, `LOBBY_COPIES`, `MIN_HERO_LEVEL`, `REQUIRE_TUTORIAL`, `RATING_START`, `RATING_K`, `RATING_FLOOR` |
| Delve | `ODS_DELVE=1` | `"delve": { "enabled": true }` | — |
| One life | `ODS_ONELIFE=1` | `"oneLife": { "enabled": true }` | — |

The environment wins over the file. See the [Environment reference](../.env.example).

### With match workers

With `ODS_MATCH_WORKERS` above 0 each mode runs where its runs are. Delve and
one life run on every worker. Ranked runs all of its runs on one worker,
because a race starts two runs together and both have to be in the thread that
does it; the main thread only answers the friend list and entry. If that
worker restarts, `MATCHMAKER` leaves the list until it is back.

### Records

What a mode keeps — ranked's match log, how deep each delve went — is in the
`mode_records` table under the mode's name with `ODS_STORAGE=postgres`, or in
`modes/<mode>.jsonl` under the data directory otherwise. A ranked log from
before that (the `ranked_matches` table, or `ranked-matches.jsonl`) is carried
over once with `node tools/migrate-ranked-records.js`; it is safe to run again.

## A mode of your own

A mode is a folder under `src/modes/` written against the seam that page
describes — hooks the core calls, run rules it reads, controls a mode may ask
of it — and a test holds the line both ways: a mode reaches the core only
through the seam, and the core never names a mode. One kept outside the
repository is named in `ODS_MODES` (comma-separated module paths), loaded on
every thread, and default-exports `{ name, together, start }`. Start at
[Writing a game mode](../src/modes/README.md).
