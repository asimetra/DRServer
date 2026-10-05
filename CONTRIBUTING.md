# Contributing

Contributions are welcome. Bug fixes, tests, documentation, protocol research,
and compatibility improvements are all useful.

## Before starting

- Search the existing issues and pull requests first.
- Open an issue before beginning a large or behavior-changing contribution.
- Keep changes focused; small pull requests are easier to review and merge.
- Never commit a game client, game assets, compatibility data, captures, tokens,
  account data, private logs, or material derived from decompiled client code.

## Development

Use Node.js 20.19+ or 22.9+:

```bash
npm ci
npm run test:public
```

While editing, `npm run test:changed` runs the tests the working tree's changes
reach, read from the files' imports (`tools/related-tests.js`); `--direct`
narrows it to the tests that import a changed file themselves, `--list` only
names them. The full suite is still the answer before a pull request.

The public test suite runs without private client data. Contributors who have a
compatible client copy they are lawfully entitled to use can additionally
import local compatibility data and run the full suite:

```bash
npm run sync:data -- --source /path/to/your/client
npm test
```

The suite runs on file storage. To run it against PostgreSQL as well — which
is where the storage layer's own tests and the inventory endpoints' are held —
point it at any database you can create schemas in:

```bash
npm run db:up
ODS_STORAGE=postgres ODS_DATABASE_URL=postgres://ods:ods@127.0.0.1:5432/open_dungeon npm test
```

Each test file works in a schema of its own, made for it and dropped when the
run ends, so nothing already in that database is read or changed. Use one that
no server is running against, though: the storage lock a server holds is the
database's, not a schema's, and the tests that take it would be refused. The
tests that are about account files themselves are skipped in this mode.

## Where a change goes

The core is the game as shipped, and nothing else. The rule for everything
that is not that game is: **the core takes seams, not features.**

- A gameplay change that the shipped game does not have — a new way to enter,
  a different pay, a run that ends on its own terms, a lobby — is a mode
  (`src/modes/README.md`). It lives in its own directory, is off unless its
  setting asks for it, and takes its commands and hooks away with it when it
  stops. `src/modes/one-life/` is the whole shape in one file; `src/ranked/`
  is the large one.
- A mode reaches the core only through the surface that page names: the
  hooks, the run rules, the effect book, the notice board, `define({ mode })`.
  Not through `src/socket/*` directly. If what a mode needs is not on the
  surface, the surface grows by a *knob the core reads* — `revives` in the run
  rules came with one life — never by a branch on the mode's name inside the
  core. The knob's default is the game as shipped.
- Changing the surface is allowed and is a deliberate act: the same commit
  changes `src/modes/README.md` ("What a mode may rely on") and
  `test/mode-surface.test.js`, which pins it, and says in its message what
  changed and why. A change that fails that test without touching it is not a
  surface change; it is a mistake.
- A behaviour of the shipped game is claimed from evidence, not memory: a
  capture of the official server, a measurement on the client, a reading of
  the client code — and the commit says which. One capture is enough to notice
  a behaviour and not enough to copy an odd one: say how many runs you have,
  and where the official server was wrong (a bug of theirs), prefer the design
  intent and say so.
- A fix stays a fix: the smallest change that makes the behaviour the game's,
  with a test that would have failed before it. A feature that arrives inside a
  fix is a second pull request.

## Pull requests

- Explain the problem and why the change is needed.
- Say where the change goes by the rule above: core, a mode, or the surface
  between them.
- Add or update regression tests for behavior changes.
- Report exactly what you tested and identify anything you could not test.
- Keep unrelated formatting or refactoring out of the same pull request.
