# Chat commands

The server answers commands typed into the game's own chat box. Chat exists
only inside a dungeon, so that is where they work. A reply goes to the player
who asked and to nobody else.

| Command | What it does |
|---|---|
| `/help [command]` | List the commands you can run, or say what one does |
| `/g <message>` | Say something to everyone, wherever they are |
| `/where` | Say where you are: node, floor, map, tile and position |
| `/floor` | Say what this floor is still waiting for |
| `/near [reach]` | List the monsters and props around you |
| `/party` | List who is on this run |
| `/xp` | Say what this run has paid and what a kill is worth |
| `/online` | Say how many players are on, and on which nodes |
| `/who` | Say who you are to this server |
| `/stats` | Read your hero's live numbers, buffs included |

`/where`, `/floor` and `/near` are there for bug reports. A report that carries
their output names the map, the tile and what the floor was waiting for, which
is usually what it takes to reproduce a fault.

A game mode brings its own commands while it is on and takes them away when it
is off (`src/modes/README.md`, "Commands"). With ranked on (`ODS_RANKED=1`):

| Mode command | What it does |
|---|---|
| `/rank` | Say your ranked rating and place, and who leads |
| `/draw` | Offer to call your ranked race off; both offering ends it with no rating moved |

With one life on (`ODS_ONELIFE=1`):

| Mode command | What it does |
|---|---|
| `/onelife` | Make your next dungeon a one-life run: no revives, and a fall ends it. Said again, call it off |

Accounts listed in `ODS_ADMIN_ACCOUNTS` (comma-separated account ids) also have:

| Command | What it does |
|---|---|
| `/hp [amount]` | Set your health, or read it |
| `/complete` | End this floor as though it had been cleared |

`/complete` moves the whole party to the next floor, or wins the run on the
last one. A run that used it is kept off the leaderboards, and an Infinite
dungeon pays no floor rewards and records no depth for the rest of it.
