# Open Dungeon Server

An independent HTTP and game-socket compatibility server for a dungeon-crawler
client.

This repository contains independently written server code. It intentionally
does **not** distribute the original client, artwork, audio, game-data tables,
floor layouts, packet captures, or decompiled source. You must provide required
compatibility data locally from a copy you are lawfully entitled to use.

The project is unofficial and unaffiliated with the original game's developer,
publisher, or trademark owners. See [NOTICE.md](NOTICE.md) before
redistributing it.

## Requirements

- Node.js 20+
- a locally available compatible client installation or worktree
- the JSON compatibility data copied into the ignored `local-data/` directory

Install dependencies and import local data:

```bash
npm install
npm run sync:data -- --source /path/to/your/client
npm run check:data
```

The import command reads only the files listed in `game-data/manifest.json` and
copies them to `local-data/`. Neither directory contents nor capture logs should
be committed.

## Run

```bash
npm start
```

That listens on loopback, which is the right default for trying it out but not
for letting anybody else in. Defaults:

- HTTP service: `127.0.0.1:8080`
- game socket: `127.0.0.1:7198`
- account storage: one JSON document per account under ignored `data/`
- compatibility resources: ignored `local-data/Resources/`

Point a compatible client at `http://127.0.0.1:8080` through its own
configuration. The client executable and configuration are not part of this
repository; see [docs/client-setup.md](docs/client-setup.md) for which keys in
that file decide where it connects.

## Running it for other people

Two variables. Bind somewhere reachable, and advertise an address the players
can actually resolve:

```bash
ODS_HOST=0.0.0.0 ODS_PUBLIC_HOST=192.168.1.10 npm start
```

`ODS_HOST` is where both the HTTP service and the game socket bind.
`ODS_PUBLIC_HOST` is what the server hands out during service discovery, and
getting it wrong is the usual first failure: the client is told to connect to
`127.0.0.1`, tries to reach itself, and finds nothing. Check the startup log,
which prints exactly what it is advertising:

```
INFO  web services listening on http://0.0.0.0:8080
INFO  advertising webServicesUrl http://192.168.1.10:8080
INFO  advertising game socket 192.168.1.10:7198
```

Both ports have to be open, not just the HTTP one. Anything derived from the
public host follows it automatically, including the content-override URL, so
there is usually nothing else to set.

**There is no authentication.** An account is whatever number a client claims,
and the server creates one for any number it has not seen. That is fine among
people you know and unsafe on the open internet, where anyone who guesses a
number becomes that player. Until you add authentication yourself, keep this on
a LAN, a VPN, or behind something that decides who may connect.

## Configuration

`ODS_*` is the public-facing environment prefix. Existing `DR_*` deployments
remain supported as legacy aliases while the migration is completed.

| Variable | Default | Meaning |
|---|---|---|
| `ODS_HOST` / `ODS_PORT` | `127.0.0.1` / `8080` | Bind address |
| `ODS_PUBLIC_HOST` | `127.0.0.1` | Host advertised to the client |
| `ODS_SERVER_NAME` | `Server` | Name the server answers commands under |
| `ODS_SOCKET_PORT` | `7198` | Game socket port |
| `ODS_RESOURCES_DIR` | `local-data/Resources` | User-supplied compatibility data |
| `ODS_DATA_DIR` | `data/` | Local account storage |
| `ODS_STORAGE` | `file` | `file` or `postgres` |
| `ODS_ADMIN_ACCOUNTS` | empty | Bootstrap administrator account ids |
| `ODS_DUNGEON` | enabled | Set `0` to refuse dungeon entry cleanly |

See [config/README.md](config/README.md) for the complete configuration model.

## Tests

The full conformance suite uses locally imported compatibility data:

```bash
npm test
```

Without that data a large part of the suite cannot run, so a fresh clone should
use:

```bash
npm run test:public
```

That runs everything, reports the files that need imported data as skipped
rather than failed, and still fails on a real defect. Once you have imported
your own data it runs the full suite instead, so the two commands agree.

To check that nothing unpublishable has reached the working tree or the history:

```bash
npm run check:public
```

## Repository layout

```text
config/       server-owned defaults and account templates
db/           optional Postgres schema
docs/         public architecture and release notes
src/          independently written HTTP/socket server
test/         unit and local conformance tests
tools/        import, inspection and release utilities
game-data/    tracked import manifest only; no original file contents
local-data/   ignored user-supplied compatibility data
```

Protocol class names, numeric field ids, and required client-side filenames may
still appear in the compatibility layer. They identify an interface; they are
not project branding and are not bundled copies of the corresponding files.
`docs/dc-schema.json` is a generated table of those interface facts and contains
no client implementation bodies.

## Redistribution

This repository's history begins at a redistributable baseline rather than at
the beginning of the work, because Git preserves deleted files and the early
work involved material that is not ours to publish. What may and may not be
redistributed is in [NOTICE.md](NOTICE.md). `npm run check:public` checks the
working tree and the history against that boundary.

## License

The independently written source code is available under GPL-3.0-or-later.
That license does not grant rights to any third-party client, assets, game data,
captures, names, logos, or trademarks.
