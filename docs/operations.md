# Operations

This guide covers the parts of running DR Server that are deliberately kept
out of the quick-start README: remote access, player credentials, the internal
API, running as a service, backups, worker threads, storage ownership, and load
testing.

## Network model

The server exposes two player-facing listeners:

- HTTP services on `127.0.0.1:8080` by default
- the game socket on `127.0.0.1:7198` by default

With those defaults only clients on the same machine can connect. Three
settings open the server to other machines, and all three are needed:

| Setting | Purpose |
|---|---|
| `ODS_HOST` | Where both listeners bind: `0.0.0.0` for every interface, or one interface's address |
| `ODS_PUBLIC_HOST` | The address advertised to clients during service discovery |
| `ODS_ALLOW_INSECURE_REMOTE=1` | Acknowledges that both listeners are cleartext |

For a server on a trusted LAN:

```bash
ODS_HOST=0.0.0.0 ODS_PUBLIC_HOST=192.168.1.10 ODS_ALLOW_INSECURE_REMOTE=1 npm start
```

The startup log prints the acknowledgement, then the bind and advertised
addresses:

```text
WARN  transport: cleartext HTTP and game socket exposed on 0.0.0.0; use only inside a trusted VPN or tunnel
INFO  web services listening on http://0.0.0.0:8080
INFO  advertising webServicesUrl http://192.168.1.10:8080
INFO  advertising game socket 192.168.1.10:7198
INFO  game socket listening on 0.0.0.0:7198
```

Without `ODS_ALLOW_INSECURE_REMOTE=1` a non-loopback bind is refused and the
server exits before listening. Only the value `1` counts.

Both ports must be reachable, including through the host's firewall.
`ODS_PUBLIC_HOST` is not checked against the bind address: leave it out and the
server starts normally while advertising `127.0.0.1`, which tells every remote
client to connect to itself. That is the most common remote setup error, and
the `advertising` lines above are where it shows.

Anything derived from the public host follows `ODS_PUBLIC_HOST`, including the
content-override URL. An IPv6 address is given bare (`2001:db8::1`); the server
brackets it where it goes into a URL.

### Port forwarding and tunnels

By default the server advertises the ports it listens on. When players reach it
through different ones — a router forwarding public port 9000 to 8080, or a
tunnel that hands out a host and port of its own for each listener — say what
they should be told instead. These three settings change only what is
advertised; nothing listens on them:

| Setting | Advertised as | Defaults to |
|---|---|---|
| `ODS_PUBLIC_PORT` | the port in `webServicesUrl` | `ODS_PORT` |
| `ODS_PUBLIC_SOCKET_PORT` | `gameSocketPort` | `ODS_SOCKET_PORT` |
| `ODS_PUBLIC_SOCKET_HOST` | `gameSocketAddress` | `ODS_PUBLIC_HOST` |

```bash
# A router forwards 203.0.113.7:9000 -> 8080 and 203.0.113.7:9001 -> 7198
ODS_HOST=0.0.0.0 ODS_ALLOW_INSECURE_REMOTE=1 \
  ODS_PUBLIC_HOST=203.0.113.7 ODS_PUBLIC_PORT=9000 ODS_PUBLIC_SOCKET_PORT=9001 npm start
```

Players then set `ServiceDiscoveryUrl` to `http://203.0.113.7:9000`. A tunnel
client running on the same machine connects to the server over loopback, so
with one of those `ODS_HOST` and `ODS_ALLOW_INSECURE_REMOTE` are not needed.
The web service is advertised as `http://`; a TLS-terminating proxy in front of
it is not supported.

### Behind a tunnel or reverse proxy

When every player reaches the server through one tunnel endpoint, the server
sees them all as one address, and two per-address limits then apply to
everybody at once. Raise both to suit the number of players:

```bash
ODS_HTTP_RATE_LIMIT=2000                  # requests per address per ten seconds (default 320)
ODS_MAX_SOCKET_CONNECTIONS_PER_IP=500     # game sockets per address (default 64)
```

## Player credentials

The compatible client has no login screen. It reads `AccountId` and
`API_ValidationToken` from its configuration and presents that pair on every
request. Generate the values for a player with:

```bash
node tools/token.js 1000000005
```

A token lasts 365 days unless it is issued with `--days N`; the tool prints the
expiry. Nothing warns a player beforehand, so an expired token shows up as a
login error and is fixed by issuing a new one.

Tokens are signed with `data/token-secret`, created by the server on first run.
Keep that file: replacing it signs every player out. The tool only reads it —
if it reports no signing secret, it is looking at a different data directory
from the server's. Set `ODS_TOKEN_SECRET` explicitly when multiple deployments
must share the same signing key.

If a token is exposed, invalidate the account's current tokens and issue a new
one:

```bash
node tools/token.js --revoke 1000000005
node tools/token.js 1000000005
```

A running server observes revocation within five seconds. Existing game sockets
are removed on their next heartbeat.

`ODS_AUTH=0` accepts the account identity claimed by the client. It is suitable
only for a machine that is not reachable by untrusted users; startup reports
when authentication is disabled.

### Transport security

Signed tokens prevent one player from claiming another account, but the bearer
token crosses both HTTP and the raw game socket in cleartext. TLS in front of
only the HTTP listener is therefore insufficient. Keep the server on loopback
or expose both ports through a trusted VPN or tunnel.

## Internal API

The internal API lets a web front end register accounts, issue or revoke
tokens, and perform account-safe trades without writing storage directly. It is
disabled until a secret is configured:

```bash
ODS_INTERNAL_TOKEN=$(openssl rand -hex 32) npm start
```

It listens on `127.0.0.1:8081` by default. Callers present the secret as
`X-Internal-Token`.

| Route | Purpose |
|---|---|
| `POST /internal/v1/accounts` | Register an account and return its id and token |
| `GET /internal/v1/accounts/:id` | Read the account as the client receives it |
| `GET /internal/v1/accounts/:id/summary` | Read a web-ready account and active-hero summary |
| `GET /internal/v1/accounts/:id/inventory` | Read items eligible for web inventory/market views |
| `POST /internal/v1/accounts/:id/token` | Issue a replacement token |
| `DELETE /internal/v1/accounts/:id/token` | Invalidate the account's issued tokens |
| `GET /internal/v1/players/:name` | Read a public player profile by name |
| `GET /internal/v1/leaderboards/:metric` | Read a paged leaderboard |
| `POST /internal/v1/trades` | Move weapons and gold atomically between two accounts |
| `GET /internal/v1/market` | Search paged listings with item details and facets |
| `POST /internal/v1/market` | List an inventory weapon for sale |
| `POST /internal/v1/market/:id/buy` | Buy an active listing |
| `POST /internal/v1/market/:id/cancel` | Withdraw an unsold listing |
| `GET /internal/v1/accounts/:id/stall` | Read one seller's listings and proceeds |
| `GET /internal/v1/accounts/:id/sales` | Read the account's market history |
| `POST /internal/v1/accounts/:id/stall/claim` | Collect proceeds from sold listings |

Trade refusals carry a machine-readable reason such as `in_dungeon`,
`equipped`, `not_owned`, `no_room`, `not_enough_gold`, or `bad_offer` so a user
interface can respond correctly.

Holding the internal token means holding every account. Keep it on the same
machine or a private network. A non-loopback cleartext internal bind requires
`ODS_ALLOW_INSECURE_INTERNAL=1`.

## Process and storage ownership

DR Server is deliberately single-process. Live accounts, match state, and
transaction queues are held in that process, so startup claims an exclusive
storage lock:

- `.server.lock` in file-storage mode
- a PostgreSQL advisory lock in PostgreSQL mode

A second server or a write-side maintenance tool refuses to use the same live
store. A lock file left behind by a server that was killed does not block the
next start. Where the new process can see the old one — same machine, same
boot, same container — the lock is recognised as stale at once when that
process is gone or its id now belongs to something else. Where it cannot — a
new container, a tool run on the host against a server in a container, a
directory shared between machines — it watches the lock instead: a running
server touches it every five seconds, so a lock that stays untouched for twenty
is taken, and one that is touched is refused. That is the only case in which a
start waits. Use the internal API for account changes while players are connected;
stop the server before running maintenance tools such as `tools/grant.js` or an
account-ID repair.

## Running as a service

`npm start` in a terminal stops when the terminal does. For a server that
should survive a logout, a crash, or a reboot, run it under a supervisor. A
systemd unit:

```ini
[Unit]
Description=DR Server
After=network-online.target
Wants=network-online.target

[Service]
User=drserver
WorkingDirectory=/srv/dr-server
ExecStart=/usr/bin/node --env-file-if-exists=.env src/index.js
Restart=on-failure
RestartSec=2
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`ExecStart` is the `npm start` script written out, so `.env` is read the same
way. Started as plain `node src/index.js` the server does not read `.env`; it
says so at startup if one is sitting beside it.

What the server does with the signals a supervisor sends:

- `SIGTERM`, `SIGINT` and `SIGHUP` all start the same shutdown: listeners stop
  accepting, sessions are closed, dungeon and account writes are flushed, the
  storage lock is released, and the process exits 0. A server started under
  `nohup` keeps ignoring `SIGHUP`, as `nohup` intends.
- Connections that have not finished two seconds after that are closed, and a
  shutdown that has not finished after 25 seconds exits anyway, with status 1.
  Keep the supervisor's stop timeout above that (`TimeoutStopSec=30`; Docker's
  default of ten seconds is too short — use `stop_grace_period: 30s`).
- An exception nothing handled is logged, the same shutdown runs, and the exit
  status is 1, so `Restart=on-failure` brings the server back.

## Backups

What has to be copied depends on where accounts live.

| Storage | Copy |
|---|---|
| File (`ODS_STORAGE=file`) | The whole data directory (`data/` by default) |
| PostgreSQL | A `pg_dump` of the database **and** three files from the data directory: `token-secret`, `token-generations.json`, `content-declarations.json` |

The three files matter in PostgreSQL mode too. Without `token-secret` a
restored server makes a new signing key and every player's token stops working;
without `token-generations.json` every token that was ever revoked works again.

In file mode each account is written whole and atomically, so a copy taken
while the server runs is never a half-written account — but two accounts
changed by one trade may be caught either side of it. Stop the server first
when that matters.

```bash
# PostgreSQL, with the bundled container
podman exec ods-postgres pg_dump -U ods -d open_dungeon > backup.sql   # or: docker exec
cp data/token-secret data/token-generations.json data/content-declarations.json /your/backup/
```

There is no tool yet that moves a deployment from PostgreSQL back to files, and
`tools/import-accounts.js` (files to PostgreSQL) carries accounts only:
leaderboards and market history start empty on the new backend.

## Configuration

Settings use the `ODS_*` prefix. Existing `DR_*` deployments remain supported
as legacy aliases while migration is completed. Values may be supplied through
the environment or an ignored `.env` file beside `package.json`:

```bash
cp .env.example .env
```

A setting the server cannot make sense of stops it at startup with one line
naming the variable: a port that is not a number between 1 and 65535, an
`ODS_STORAGE` other than `file` or `postgres`, or a switch (`ODS_AUTH`,
`ODS_MIGRATE`, `ODS_DUNGEON`, `ODS_STRICT`, the two `ODS_ALLOW_INSECURE_*`
flags) set to anything but `0` or `1`.

File storage is the default and needs no external service. PostgreSQL is an
operator choice: point `ODS_DATABASE_URL` at an existing compatible database,
or start the repository's local PostgreSQL 16 container before selecting it:

```bash
npm run db:up
ODS_STORAGE=postgres npm start
```

The helper uses Docker when available and otherwise Podman, preserves its named
volume across `npm run db:down`, and applies `db/schema.sql` when first creating
the container. The database is published on `127.0.0.1` only; a container
created by an earlier version of the helper keeps the address it was created
with until it is removed and created again (`npm run db:up` after removing the
container reuses the same volume, so the data stays).

`npm run db:reset` deletes the container **and its volume** — every account.
It asks for the volume name first, or for `-- --yes` when there is no terminal,
and writes a dump to `data/db-before-reset-<time>.sql` before removing anything.
If the dump cannot be taken it stops there; `-- --yes --no-dump` deletes
without a copy.

`docker compose up -d` starts the same image, but keeps its data in a volume of
its own (`<directory>_ods-pgdata`, not the helper's `ods-pgdata`). Use one or
the other; switching between them lands on an empty database.

If the database restarts while the server is running, the server logs the lost
connections and carries on, taking its storage lock again as soon as the
database answers; requests made in between fail. If the lock cannot be had back
within thirty seconds, or another server has taken it, the server shuts down
with status 1.

See [`.env.example`](../.env.example) for the environment-variable reference and
[`config/README.md`](../config/README.md) for the tracked JSON data contracts.

## Match workers

`ODS_MATCH_WORKERS` moves whole dungeon matches onto worker threads. Each worker
owns the world's AI, traps, rewards, and the accounts leased to that match; the
main thread retains sockets, login, matchmaking, and presence.

The feature is disabled by default. `auto` uses up to four workers while
leaving one core to the main thread, and uses none on a single-core machine.
`ODS_MATCH_WORKER_HANG_MS` controls how long an unresponsive worker is allowed
before it is replaced and its players are returned to town.

In the synthetic 500-player/200-dungeon workload, four workers reduced
heartbeat p99 from 41 ms to 1–3 ms. The implementation and lifecycle limits are
documented at the top of `src/socket/match-worker-pool.js` and
`src/socket/match-worker-thread.js`.

## Load testing

`tools/load-sim.js` drives synthetic players and measures heartbeat round trips,
monster-update gaps, dungeon entry, HTTP latency, CPU, and memory.

Start a local server in audit mode:

```bash
ODS_MOVEMENT_MODE=audit ODS_LOG_LEVEL=error \
  ODS_MAX_SOCKET_CONNECTIONS_PER_IP=5000 npm start
```

Then run a workload:

```bash
npm run load -- --players 500 --dungeons 200 --rpc --source-ips 50 \
  --pid <server-pid> --token-secret-file data/token-secret \
  --slo "heartbeat.p99<200,npc.p95<400,entry.p95<3000"
```

Available scenarios are:

- `dungeon`: players fight across multiple matches and start new runs
- `churn`: players repeatedly enter, remain for `--stay`, and leave
- `lobby`: connected players remain idle

`--reconnect` performs a fresh login during churn. `--rpc` adds HTTP calls at
the measured client rate. `--slow-readers 0.1` makes ten percent of players stop
reading to test backpressure isolation. An unmet SLO exits non-zero, allowing a
load run to gate CI. Remote targets are refused unless
`--allow-remote-target` is supplied.
