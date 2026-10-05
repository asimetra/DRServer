# Server configuration

These JSON files are data contracts, not runtime state:

- `server.defaults.json` contains deployment and simulation defaults. `ODS_*`
  environment variables override them for a process; `DR_*` remains a legacy
  alias during migration.
- `account-template.json` is deep-cloned when an unknown account first logs in.
  `${ACCOUNT_ID}` preserves the numeric id when it is the whole value and can
  also be embedded in strings; `${NOW}` is the account creation timestamp.
- `serverName` is what the server calls itself when it answers a command. The
  reply arrives under that name rather than the player's own, coloured green for
  an answer and orange for a refusal — the client colours a chat name by its
  first character and the server prepends it, so the name here is written plain.

- `floors.json` maps stable server floor names and map-node ids to files in the
  user-supplied, gitignored compatibility-data directory.
- `notices.json` is the town notice board: what the client shows on its first
  entry to town each session, read again whenever the file changes
  (`docs/operations.md`, "Notices in town").
- `ui-effects.json` is the effect book: what a game event shows on a dungeon
  floor (banner, sound, shake, countdown, floater) and the chat lines that go
  with it, read again whenever the file changes.

The starter avatar (`101`/skin `151`) and weapon (`11001`) must exist in the
locally supplied compatibility dictionary; changing them without checking the
client's compatible hero/weapon models can crash the native client.
