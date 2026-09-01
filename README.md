# Open Dungeon Server

An independent HTTP and game-socket compatibility server for a dungeon-crawler
client.

Server code only: no client, no assets, no game data. You supply those locally
from a copy you are lawfully entitled to use. Unaffiliated with the original
game's developer, publisher, or trademark owners — see [NOTICE.md](NOTICE.md).

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
copies them to `local-data/`, which is ignored.

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

## Letting a player in

The client has no login screen. It reads `AccountId` and `API_ValidationToken`
from its own configuration and presents that pair on every request, so handing
somebody those two values *is* the act of signing them up:

```bash
node tools/token.js 1000000005
```

That prints the two lines to paste into their client configuration. Tokens are
signed with a secret written to `data/token-secret` on first run — keep it,
because replacing it signs everybody out — or set `ODS_TOKEN_SECRET` yourself
if you run more than one machine. Anything holding that secret can issue
tokens, so a web page or a bot can take this tool's place later without the
server changing.

A token is signed rather than remembered, checked on both the HTTP service and
the game socket, and one issued for an account opens no other. The client asks
for a fresh one during play, so the only token you have to hand out is a
player's first.

If one is exposed, invalidate every token for that account and issue a new one:

```bash
node tools/token.js --revoke 1000000005
node tools/token.js 1000000005
```

A running server observes the revocation within five seconds; an existing game
socket is removed on its next heartbeat.

`ODS_AUTH=0` turns the check off and accepts whatever a client claims, which is
a reasonable choice for a machine nobody else can reach. A server running that
way says so on startup.

**Traffic is not encrypted.** Signed tokens stop anyone claiming an account
they were not given, but the same bearer token crosses both HTTP and the raw
game socket in the clear. TLS in front of only the HTTP port is therefore not
enough. Bind the server to loopback and expose it through a trusted VPN or
tunnel that protects both ports.

For compatibility, a deliberately trusted LAN can opt into a remote cleartext
bind with `ODS_ALLOW_INSECURE_REMOTE=1`. Without that acknowledgement startup
refuses any non-loopback bind.

## The internal API

A web front end — a sign-up page, a trade screen, a lobby browser — needs this
server to act on accounts: to register one, to issue the validation token a
player pastes into their client, to invalidate every token it has issued. It
does not get to write the account tables itself. One process holds the accounts
that are in play and serialises the writers, and both of those are local to it,
so a second process writing the same rows would undo a change made while
somebody was in a dungeon. This is the door instead.

It is off until a secret is set, and it listens on a port of its own:

```bash
ODS_INTERNAL_TOKEN=$(openssl rand -hex 32) npm start
```

Loopback by default, deliberately. `ODS_HOST=0.0.0.0` above is how players are
let in, and an internal API sharing that listener would be published by the
same act. Callers present the secret as `X-Internal-Token`.

| Route | Does |
|---|---|
| `POST /internal/v1/accounts` | Registers an account, answering with its id and a token |
| `GET /internal/v1/accounts/:id` | The account as the client would receive it |
| `POST /internal/v1/accounts/:id/token` | Issues a replacement token |
| `DELETE /internal/v1/accounts/:id/token` | Invalidates every token issued for that account |
| `POST /internal/v1/trades` | Moves weapons and gold between two accounts, all of it or none |

Trading is one call because it has to be one transaction. The front end runs
the negotiation — who offered what, who has agreed — and none of that is game
state; this is the moment both sides said yes. The pair is locked in id order
and written on a single transaction, so the weapon cannot end up on neither
account or on both. A refusal carries a `reason` (`in_dungeon`, `equipped`,
`not_owned`, `no_room`, `not_enough_gold`, `bad_offer`) because the trade screen
has to act differently on each.

Holding the secret is holding every account, so it belongs on the same machine
or on a private network, never on the public interface. A non-loopback
cleartext bind is refused unless `ODS_ALLOW_INSECURE_INTERNAL=1` explicitly
acknowledges a trusted private network.

## Configuration

`ODS_*` is the public-facing environment prefix. Existing `DR_*` deployments
remain supported as legacy aliases while the migration is completed.

Settings can go on the command line or in a `.env` file beside `package.json`,
which `npm start` reads when it is there and starts without when it is not.
Copy [.env.example](.env.example) to begin; `.env` is ignored by git, which is
where a deployment's secrets belong. Typing them out each time is how a value
that has to match somewhere else — `ODS_INTERNAL_TOKEN` and the website's
`ODW_GAME_INTERNAL_TOKEN` are the same string — quietly stops matching.

| Variable | Default | Meaning |
|---|---|---|
| `ODS_HOST` / `ODS_PORT` | `127.0.0.1` / `8080` | Bind address |
| `ODS_PUBLIC_HOST` | `127.0.0.1` | Host advertised to the client |
| `ODS_ALLOW_INSECURE_REMOTE` | disabled | Permit acknowledged cleartext non-loopback binding |
| `ODS_SERVER_NAME` | `Server` | Name the server answers commands under |
| `ODS_SOCKET_PORT` | `7198` | Game socket port |
| `ODS_SOCKET_LOGIN_TIMEOUT_MS` | `15000` | Maximum time to authenticate a new socket |
| `ODS_SOCKET_IDLE_TIMEOUT_MS` | `120000` | Authenticated socket network-idle limit |
| `ODS_SOCKET_CLOSE_GRACE_MS` | `2000` | Final-frame flush window before forced close |
| `ODS_MAX_SOCKET_CONNECTIONS` | `2000` | Global simultaneous game-socket limit |
| `ODS_MAX_SOCKET_CONNECTIONS_PER_IP` | `64` | Simultaneous game sockets allowed per source IP |
| `ODS_RESOURCES_DIR` | `local-data/Resources` | User-supplied compatibility data |
| `ODS_DATA_DIR` | `data/` | Local account storage |
| `ODS_STORAGE` | `file` | `file` or `postgres` |
| `ODS_ADMIN_ACCOUNTS` | empty | Bootstrap administrator account ids |
| `ODS_AUTH` | enabled | Set `0` to accept whatever a client claims |
| `ODS_TOKEN_SECRET` | written on first run | Key every validation token is signed with |
| `ODS_INTERNAL_TOKEN` | empty | Shared secret (at least 32 characters); empty leaves the internal API off |
| `ODS_INTERNAL_HOST` / `ODS_INTERNAL_PORT` | `127.0.0.1` / `8081` | Internal API bind address |
| `ODS_ALLOW_INSECURE_INTERNAL` | disabled | Permit acknowledged cleartext internal binding outside loopback |
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
docs/         setup notes, and dc-schema.json: a generated table of protocol
              class names and field ids, with no implementation bodies
src/          HTTP and game-socket server
test/         unit and local conformance tests
tools/        import, inspection and release utilities
game-data/    tracked import manifest only; no original file contents
local-data/   ignored user-supplied compatibility data
```

## License

GPL-3.0-or-later.
