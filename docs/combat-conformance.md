# Generated combat conformance

`tools/combat-matrix.js` turns the imported GameMaster into test cases. It does
not maintain a hand-written list of monsters or weapons, so a new row or attack
slot joins the matrix automatically.

```bash
npm run test:combat-matrix
node tools/combat-matrix.js --json
node tools/combat-matrix.js --static --json
node tools/combat-matrix.js --owner SAVAGE_BOW
node tools/combat-matrix.js --attack EN_POISON_ARROW --json
```

The command exits non-zero when any check fails. `--json` is the stable input
for an agent or a future MCP adapter. A failure includes the owner, slot,
attack, check name and measured evidence.

## NPC matrix

Every `Attack1` through `Attack6` belonging to a moving `ENEMY`, `BEAST` or
`PET` row is resolved through the same `npcAttackChoices` and
`performNpcAttack` functions used by a live dungeon. The matrix uses a virtual
clock, so a four-second dragon timeline executes immediately without changing
its authored times.

Each case checks:

- Attack, timeline, projectile and buff references resolve.
- `AttackSpd` becomes the choreography's `playSpeed`.
- Every collider or projectile action is scheduled on its authored frame.
- A target inside the authored shape or projectile path is hit.
- A target outside it is not hit.
- Moving away during a non-zero windup avoids the hit.
- Hostile `TargetBuff1` and `TargetBuff2` effects appear on a landed hit.
- `SelfBuff` appears on the caster.
- The report records the cadence interval implied by `AttackTimer`,
  `AttackTimeRand` and `AttackSpd`.

Multi-frame colliders share one per-cast victim set. Each authored window is
active at the right time, but a stationary hero is not charged repeatedly by
the same cast.

## Weapon matrix

Every authored attack column on every `WeaponItem` is checked for valid attack,
timeline, projectile and buff references. Hostile combat-result attacks are
then passed through the real authoritative result handler with the weapon that
grants them. The matrix verifies damage and hostile target buffs rather than
reimplementing their formulas in the test.

Weapon animation, input gating and local collider generation remain client
responsibilities. The matrix reports their timeline actions and server-owned
actions, but cannot prove that an unmodified graphical client drew them. That
boundary still needs a smaller real-client sample or a capture-backed
comparison; it does not require manually testing every weapon.

## Automation boundary

An MCP server should wrap this JSON command rather than duplicate combat
logic. Useful tools would be:

- `combat_matrix_run(owner?, attack?, static?)`
- `combat_matrix_failures(owner?, attack?)`
- `capture_compare(attack, referenceDirectory)`
- `probe_run(scenario)`

Keep those tools on a disposable account and test database. The existing live
protocol probe defaults to a real account id and is not an appropriate mutation
surface for an unattended model until its setup is isolated.
