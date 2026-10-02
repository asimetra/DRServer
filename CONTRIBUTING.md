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

## Pull requests

- Explain the problem and why the change is needed.
- Add or update regression tests for behavior changes.
- Report exactly what you tested and identify anything you could not test.
- Keep unrelated formatting or refactoring out of the same pull request.
