# Pointing a client at your server

This page assumes you already have a client you are lawfully entitled to use;
it is not distributed or linked here. Everything below is a change to one JSON
file in your own copy — nothing is patched or replaced.

## The short version

The client reads a JSON configuration file at startup:

```
DbConfiguration/Config.json
```

Three keys decide which server it talks to and who it logs in as:

| Key | Set it to | Why |
|---|---|---|
| `ServiceDiscoveryUrl` | the server's address | Where the client looks for services |
| `UseSteamLogin` | `false` | Otherwise Steam replaces `AccountId` |
| `AccountId` | any number, e.g. `1000000005` | Which account you log in as |

`http://127.0.0.1:8080` is used throughout this page because it is the default
for a server on the same machine. If you are joining somebody else's, use the
address they give you instead — everywhere `127.0.0.1:8080` appears below.

A minimal working file keeps the client's other existing keys and changes these:

```json
{
  "ServiceDiscoveryUrl": "http://127.0.0.1:8080",
  "UseSteamLogin": false,
  "AccountId": 1000000005
}
```

Start the server first (`npm start`), then the client.

Three further keys are optional and covered below: `download_root` and
`gameMasterPath` let the server supply game data the player does not have on
disk, and `ALLOW_HACKS_TO_PLAY_MAP_NODE` is a debug shortcut the client already
ships. None of them is needed to play.

## Why each key matters

**`ServiceDiscoveryUrl` is the only address you need.** The client asks that URL
for everything else, and the server answers with its own public host and game
socket port — you will see both in its startup log:

```
INFO  advertising webServicesUrl http://127.0.0.1:8080
INFO  advertising game socket 127.0.0.1:7198
```

So you do not configure the socket port on the client side, and a server that
moves or changes ports does not need every client edited.

If you are the one running it for other people, that is also where the usual
first failure shows: the server has to be started with `ODS_PUBLIC_HOST` set to
an address the players can reach, or it will advertise `127.0.0.1` and every
client will try to connect to itself. See the README for the two variables that
matter.

**`UseSteamLogin` has to be set, not left out.** The client reads it as
`getConfigBoolean("UseSteamLogin", true)` — the default is `true`, so an absent
key means Steam wins. When the Steam login succeeds the client overwrites the
account with whichever Steam account is signed in, and the `AccountId` you set
is silently ignored. Setting it to `false` is a switch the client already has;
it skips the login and leaves the rest of the Steamworks integration running.

**`AccountId` does not have to exist first.** The server creates an account for
any id it has not seen before, with a fresh hero and an empty inventory. Two
different numbers are two different players, which is how you test anything that
needs more than one.

## Letting the server supply game data

By default the client loads its game data off the player's own disk. Two keys
change that, which is what makes a server able to run a floor the player has
never downloaded.

| Key | Set it to | Effect |
|---|---|---|
| `download_root` | `""` | Stop the client prefixing asset paths |
| `gameMasterPath` | `http://127.0.0.1:8080/content/Resources/Levels/DB_GameMaster.json` | Fetch the game-master table from the server |

On the server side both settings default to the repository's own `content/`
directory when it exists, and the URL is derived from `ODS_PUBLIC_HOST`, so a
server started for other people already advertises the right address:

```
INFO  serving 4 content files at http://192.168.1.10:8080/content
```

Override either only if you keep the content somewhere else, or serve it from a
different host such as a CDN:

```bash
ODS_CONTENT_DIR=/srv/dungeon-content \
ODS_CONTENT_URL=https://content.example.net/content \
npm start
```

Whatever the server advertises is the address that belongs in `gameMasterPath`.

**Why `download_root` must be empty.** The client builds every asset path by
plain concatenation — `buildFullDownloadPath(p)` returns `download_root + p` —
and the shipped default is `"./"`. Leave it at the default and an absolute
`gameMasterPath` becomes `./http://127.0.0.1:8080/...`, which resolves to
nothing. Emptying it makes the client use each path exactly as given.

**Only what you override comes from the server.** `download_root` is prefixed to
three loads: the game-master table, `library_server.json` and
`AttackTimeline.json`. Of those, only the first has its own configurable key, so
emptying `download_root` leaves the other two loading from the player's disk as
before. That is the point — overriding one path is how a floor gets a tile
library the player does not have, while everything else keeps coming off their
own copy. Pointing this at a full mirror of the game would turn joining a server
into downloading it again.

## The map-node shortcut

The client ships a debug switch, off by default:

```json
"ALLOW_HACKS_TO_PLAY_MAP_NODE": true
```

With it on, four keys on the world-map screen enter a map node directly, skipping
whatever would normally gate it:

| Key | Node |
|---|---|
| `Q` | 50150 |
| `W` | 50151 |
| `E` | 50153 |
| `R` | 50200 |

The node ids are fixed in the client and cannot be configured. This is useful for
reaching a floor you are building without playing up to it, and it is a debug
aid rather than a feature — a player who turns it on is choosing to skip content
on your server. Leave it out of the configuration you hand to other people.

## Accounts and admin

There is no password. Whoever sets an `AccountId` is that account, and the
server creates one for any number it has not seen. Among people you know that
is the whole point — a friend picks a number and has a character. On a server
anyone can reach it means anyone who guesses a number can be that player, so
keep it on a LAN or a VPN until you have added authentication yourself.

To give yourself the first admin rank, name your account id when starting the
server:

```bash
ODS_ADMIN_ACCOUNTS=1000000005 npm start
```

Ranks are otherwise granted by an in-game command, which a fresh database has
nobody to run — this flag is the way out of that. It is an environment variable
rather than a stored row so that revoking it is restarting without it.

## Running a second client

Two accounts need two configuration files, not two installations. There is a
tool for this:

```bash
ODS_CLIENT_BINARY=<your client executable name> \
  node tools/second-client.js 1000000006 --run
```

It builds a directory with its own `DbConfiguration` and its own copy of the
executable, links the large read-only material, and leaves your original install
untouched.

## Compatibility data

The server needs interface data that this repository does not ship. Import it
from your own copy:

```bash
npm run sync:data -- --source /path/to/your/client
npm run check:data
```

The server starts without it and will tell you at startup that it is missing,
but dungeons will not load until it is imported. See
[../README.md](../README.md) for the rest of the setup.

## A complete example

Every key on this page at once, for a server on the same machine. Keep whatever
else your configuration already has:

```json
{
  "ServiceDiscoveryUrl": "http://127.0.0.1:8080",
  "UseSteamLogin": false,
  "AccountId": 1000000005,
  "download_root": "",
  "gameMasterPath": "http://127.0.0.1:8080/content/Resources/Levels/DB_GameMaster.json",
  "ALLOW_HACKS_TO_PLAY_MAP_NODE": true
}
```

Joining somebody else's server is the same file with their address in both
places, and usually without the debug switch:

```json
{
  "ServiceDiscoveryUrl": "http://192.168.1.10:8080",
  "UseSteamLogin": false,
  "AccountId": 1000000005,
  "download_root": "",
  "gameMasterPath": "http://192.168.1.10:8080/content/Resources/Levels/DB_GameMaster.json"
}
```

If the operator is not overriding content, drop `download_root` and
`gameMasterPath` too and only the first three lines matter.

The last three are optional. Drop `download_root` and `gameMasterPath` to load
all game data from your own disk, and drop `ALLOW_HACKS_TO_PLAY_MAP_NODE` unless
you are building a floor and want to reach it directly.
