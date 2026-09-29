# Operations

This guide covers the parts of running DR Server that are deliberately kept
out of the quick-start README: remote access, player credentials, the internal
API, worker threads, storage ownership, and load testing.

## Network model

The server exposes two player-facing listeners:

- HTTP services on `127.0.0.1:8080` by default
- the game socket on `127.0.0.1:7198` by default

`ODS_HOST` controls where both listeners bind. `ODS_PUBLIC_HOST` is the address
the server advertises to clients during service discovery. For a server on a
trusted LAN:

```bash
ODS_HOST=0.0.0.0 ODS_PUBLIC_HOST=192.168.1.10 npm start
```

The startup log prints the bind and advertised addresses:

```text
INFO  web services listening on http://0.0.0.0:8080
INFO  advertising webServicesUrl http://192.168.1.10:8080
INFO  advertising game socket 192.168.1.10:7198
```

Both ports must be reachable. Advertising `127.0.0.1` to another machine tells
that client to connect to itself, which is the most common remote setup error.

Anything derived from the public host follows `ODS_PUBLIC_HOST`, including the
content-override URL. A non-loopback cleartext bind is refused unless
`ODS_ALLOW_INSECURE_REMOTE=1` explicitly acknowledges that the network is
trusted.

## Player credentials

The compatible client has no login screen. It reads `AccountId` and
`API_ValidationToken` from its configuration and presents that pair on every
request. Generate the values for a player with:

```bash
node tools/token.js 1000000005
```

Tokens are signed with `data/token-secret`, created on first run. Keep that
file: replacing it signs every player out. Set `ODS_TOKEN_SECRET` explicitly
when multiple deployments must share the same signing key.

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
store. Use the internal API for account changes while players are connected;
stop the server before running maintenance tools such as `tools/grant.js` or an
account-ID repair.

## Configuration

Settings use the `ODS_*` prefix. Existing `DR_*` deployments remain supported
as legacy aliases while migration is completed. Values may be supplied through
the environment or an ignored `.env` file beside `package.json`:

```bash
cp .env.example .env
```

File storage is the default and needs no external service. PostgreSQL is an
operator choice: point `ODS_DATABASE_URL` at an existing compatible database,
or start the repository's local PostgreSQL 16 container before selecting it:

```bash
npm run db:up
ODS_STORAGE=postgres npm start
```

The helper uses Docker when available and otherwise Podman, preserves its named
volume across `npm run db:down`, and applies `db/schema.sql` when first creating
the container.

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
