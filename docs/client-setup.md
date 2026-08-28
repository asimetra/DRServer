# Pointing a client at your server

This page assumes you already have a client you are lawfully entitled to use.
This project does not distribute one, does not link to one, and cannot help you
obtain one. If you do not have a copy, this page is not useful to you.

Everything below is a change to **your own configuration file, on your own
machine**. Nothing here modifies, patches, or redistributes the client.

## The short version

The client reads a JSON configuration file at startup:

```
DbConfiguration/Config.json
```

Three keys decide which server it talks to and who it logs in as:

| Key | Set it to | Why |
|---|---|---|
| `ServiceDiscoveryUrl` | `http://127.0.0.1:8080` | Where the client looks for services |
| `UseSteamLogin` | `false` | Otherwise Steam replaces `AccountId` |
| `AccountId` | any number, e.g. `1000000005` | Which account you log in as |

A minimal working file keeps the client's other existing keys and changes these:

```json
{
  "ServiceDiscoveryUrl": "http://127.0.0.1:8080",
  "UseSteamLogin": false,
  "AccountId": 1000000005
}
```

Start the server first (`npm start`), then the client.

## Why each key matters

**`ServiceDiscoveryUrl` is the only address you need.** The client asks that URL
for everything else, and the server answers with its own public host and game
socket port — you will see both in its startup log:

```
INFO  advertising webServicesUrl http://127.0.0.1:8080
INFO  advertising game socket 127.0.0.1:7198
```

So you do not configure the socket port on the client side. If you run the
server somewhere other than loopback, set `ODS_PUBLIC_HOST` so the address it
advertises is one your client can actually reach; otherwise the client will be
told to connect to `127.0.0.1` and will try to reach itself.

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

## Accounts and admin

There is no password. Whoever sets an `AccountId` is that account, which is fine
for a server you run for yourself or for friends, and is not fine for one
exposed to the internet. Bind to loopback or to a private network unless you
have added authentication yourself.

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
[../README.md](../README.md) for the rest of the setup and
[../NOTICE.md](../NOTICE.md) for what may and may not be redistributed.
