# Operations

This guide covers the parts of running DR Server that are deliberately kept
out of the quick-start README: remote access, player credentials, the internal
API, running as a service, monitoring, backups, worker threads, storage
ownership, and load testing.

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

### When a run is written down

Gold and experience picked up in a dungeon go into the account in memory at
once, which is what the player is shown, and reach storage at the run's
endings:

| When | What is written |
|---|---|
| A floor ends | Every account on the run that changed |
| The run ends, or a player leaves, quits or is disconnected | That player's account, always |
| A chest, an Infinite floor's reward, a spent bomb | That account, at once |
| The server is stopped | Every account still in a dungeon |
| Every 30 seconds while a run lasts | Every account on it that changed |

The last row is for the endings that cannot save on the way out: a match
worker that dies, or a server that is killed rather than stopped. Those lose
whatever was picked up since the last write, which the interval bounds.
`ODS_RUN_CHECKPOINT_SECONDS` sets it; `0` turns the clock off and leaves only
the rows above it.

In PostgreSQL mode a save sends only the rows that differ from what the server
last read or wrote, so a pickup's worth of change is one small statement
whatever the account holds. The `version` column on `accounts` is how the
server knows its picture of an account is still true; it rises with every save.
Changing an account's rows directly in the database while the server is
running is not supported — stop the server, or use the internal API.

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

## Monitoring

The server answers questions about itself on a listener of its own,
`127.0.0.1:8082` by default:

| Route | Answers | Use it for |
|---|---|---|
| `GET /livez` | 200 as long as the process responds | Deciding whether to restart |
| `GET /healthz` | 200 when every check passes, 503 naming the ones that do not; warnings ride along | A supervisor, a container health check, an uptime monitor |
| `GET /status` | Version and commit, uptime, players, memory, event-loop delay, counters, and the health report | Looking at a running server |
| `GET /players` | Who is connected: account, name, map node, how long, from where, when their token expires | Knowing who is on before a restart |
| `GET /metrics` | The numbers of `/status` in the Prometheus text format | A monitoring system that keeps history, draws graphs and raises alerts |

```bash
curl -s http://127.0.0.1:8082/healthz
# {"status":"ok","checks":{"web":"ok","socket":"ok","storage":"ok","saves":"ok","workers":"ok","running":"ok"}}
```

### Checks

A check failing means players cannot play, and turns `/healthz` into a 503:
both player-facing listeners are accepting connections; the storage can be
written and this server still holds its lock on it (for PostgreSQL, the
database answers a query); no dungeon save is waiting to reach storage; at
least one match worker is up when workers are enabled; and the server is not
shutting down. A failing check carries its reason:

```json
{"status":"failing","checks":{"web":"ok","socket":"ok","storage":"the database does not answer: connect ECONNREFUSED 127.0.0.1:5432","workers":"ok","running":"ok"}}
```

`/livez` stays 200 through that: the database being away is not something a
restart of the game server fixes.

### Warnings

A warning is something that is not a failure yet. It appears under `warnings`
and leaves the status code alone:

| Warning | Raised when |
|---|---|
| `disk` | The data directory's filesystem has under 5% or under 256 MB free |
| `tokens` | A connected player's token expires within 14 days |
| `workers` | Some match workers are down while others carry on |
| `event_loop` | Timers have been firing more than 250 ms late (p99 over the last minute) |

```json
{"status":"ok","checks":{"...":"ok"},"warnings":{"tokens":"1 online player's token expires within 14 days: account 1000000005 in 5 days"}}
```

The server keeps no list of the tokens it has issued, so the token warning can
only speak for players who are connected. Each login with a token that close to
expiry is also logged.

Whether or not anything is polling, the server looks at its own health every
thirty seconds and writes a change to the log once, when it happens:

```text
ERROR health: storage is failing — the database does not answer: ...
INFO  health: storage is ok again
WARN  health: warning from disk — 3% free (1.2 GB) on /srv/dr-server/data
```

### Status and counters

`event_loop_delay` in `/status` is how late the server's timers are firing over
the last minute. Every dungeon runs on that loop, so a `p99_ms` in the hundreds
is lag the players can feel.

`counters` are totals since the server started, including what match workers
counted. A monitor that wants a rate subtracts two readings.

| Counter | Counts |
|---|---|
| `auth_refused` | Logins and requests refused for a missing, expired, revoked or forged token |
| `sockets_refused` | Connections turned away at the connection limits |
| `http_rate_limited` | Requests dropped by the per-address rate limit |
| `http_errors` | Requests that ended in the server's own failure |
| `packets_failed` | Game packets whose handler threw |
| `saves_failed` | Attempts to write a dungeon save that storage refused, retries included |
| `timer_failures` | Gameplay timers that threw |
| `unhandled_rejections` | Promise rejections nothing handled |
| `database_connections_lost` | PostgreSQL connections closed from the other end |
| `worker_restarts` | Match workers replaced after a crash or a hang |

A rising `saves_failed` is the one to act on first: storage is refusing
writes, and progress is being kept in memory until it stops.

### When storage refuses a save

A full disk, a database that is away: the save a dungeon makes fails. The
server does not drop it. The account stays in memory as the one in play, so
nothing reads a stale copy, and the save is tried again after one second, then
two, five, ten, and every thirty from then on, until it lands. Players already
in a dungeon keep playing and are not told anything, because nothing they have
is at risk while the server stays up.

Meanwhile nobody new is let into a dungeon — the client is told the game cannot
be entered — `/healthz` fails its `saves` check with the number of accounts
waiting, and the log says so once per account:

```text
ERROR account 1000000005: dungeon save failed (ENOSPC: no space left on device); the account stays in memory and the save is retried
INFO  account 1000000005: dungeon save landed after 3 retries
```

What cannot be kept is a server stopped while storage is still refusing: each
waiting save gets one last attempt, and one that fails is reported as lost.
Fix the storage before restarting the server, not after.

### Graphs, history and alerts

The server says what is true now. It does not keep history, draw graphs or
send notifications — that is what monitoring tools are for, and `/metrics` is
the format they read. How much to set up depends on the server:

- **A small server for friends.** Point any uptime monitor at `/healthz`: it
  polls the URL, and tells you — by chat message, by e-mail — when the answer
  stops being 200. Nothing else is needed.
- **Graphs and history.** The repository carries a ready-made Prometheus and
  Grafana pair:

  ```bash
  npm run monitor:up      # dashboard on http://127.0.0.1:3000/
  npm run monitor:down    # stop; the collected history is kept
  ```

  Prometheus reads `/metrics` every fifteen seconds and keeps thirty days;
  Grafana opens on a dashboard of health, players, event-loop delay, memory,
  disk, and every counter. Both listen on loopback only, and Grafana is
  read-only without a login; its administrator account still has Grafana's
  default password, which is acceptable only because nothing off this machine
  can reach it. Everything it uses is in `monitoring/`:

  | File | What it is |
  |---|---|
  | `prometheus.yml` | What is collected and how often. Change the target here if the status listener is not on `127.0.0.1:8082`; add the status token here if one is set |
  | `alerts.yml` | When something is worth attention: the server not answering, a failing check, a save that did not reach storage, sustained lag, a worker down, a standing warning |
  | `grafana/dashboards/dr-server.json` | The dashboard |

  `ODS_PROMETHEUS_PORT` and `ODS_GRAFANA_PORT` move them off 9090 and 3000.
  After editing a file or a port, `./tools/monitor.sh recreate` restarts both
  on the new configuration with the history intact.

The alert rules fire inside Prometheus and show on the dashboard. They are not
delivered anywhere: sending one to a phone or a chat channel needs an
Alertmanager or Grafana's own alerting, configured for whoever should hear it.

The containers run on the host's network, because the status listener is bound
to loopback and a container's own network cannot reach that. This is a Linux
arrangement; on other systems, run Prometheus where it can reach the listener
and point it at `monitoring/prometheus.yml`.

### Who may ask

The routes need no credential by default, so the address they are bound to is
the access control. That is why they are not on the players' port: behind a
tunnel every player arrives from `127.0.0.1`. `ODS_STATUS_PORT=0` turns the
listener off. If the port is already in use the server starts without the
listener and says so.

To watch the server from another machine, give it a token of its own and move
the listener:

```bash
ODS_STATUS_HOST=0.0.0.0 ODS_STATUS_TOKEN=$(openssl rand -hex 32) npm start
curl -s -H "X-Status-Token: $TOKEN" http://192.168.1.10:8082/status
```

With a token set, `/status`, `/players`, `/metrics` and the detail of `/healthz` require it
(`X-Status-Token`, or `Authorization: Bearer`). `/livez` and the bare verdict of
`/healthz` — the status code and `{"status":"ok"}` — do not, so a supervisor
that can only read a code still works, without being told a path or a database
address. The token is read-only: nothing on this listener changes anything. It
must not be the internal token, which acts for every account, and it crosses
the network in cleartext like everything else here, so the same advice applies
— a trusted network or a tunnel. `ODS_ALLOW_REMOTE_STATUS=1` allows a
non-loopback bind with no token at all, for a network that does the
restricting itself.

As a container health check:

```bash
podman run ... \
  --health-cmd 'wget -q -O /dev/null http://127.0.0.1:8082/healthz' \
  --health-interval 10s --health-retries 3 ...
```

One caveat: a server running as root can write to anything, so the storage
check cannot notice a read-only data directory for it.

Every log line starts with a full UTC timestamp, and the first line names the
version and commit that is running.

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
