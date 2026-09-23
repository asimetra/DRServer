# Monster behavior conformance audit

Date: 2026-09-23  
Scope: moving `ENEMY`, `BEAST`, and `PET` rows and their `Attack1`–`Attack6` behavior  
Mode: audit only — no gameplay fix was made as part of this audit

## Executive summary

The current GameMaster contains 107 moving combat NPC constants and 212 attack
references (128 unique attacks). The generated runtime matrix executes all 212,
but the official log corpus directly observes only 49 of the 107 constants and
60 unique attacks. Therefore “all monsters” can be exercised locally, but only
the observed subset can be differentially proven against the original server.

Three findings were confirmed against both the official corpus and the audited
runtime; the first was resolved immediately after the audit:

1. `EN_ICE_IMP_ATTACK_SHOWOFF`, `EN_ICE_IMP_ATTACK_BACKOFF`, and
   `EN_SHAMAN_IMP_SPAWN` were animation/movement/spawn actions on the official
   server but dealt unavoidable local damage. Fixed after this audit by making
   geometry/projectile-less NPC attacks `no-impact` actions.
2. `KITE_AI` was only a fixed standoff locally and `TELEPORT_AI` was treated as
   one too. Both authored state machines were implemented after this audit.
3. NPC movement replication is emitted every 100 ms locally versus a 250 ms
   median on the official server. Measured movement speed does not differ by
   one global multiplier; some constants are much faster and others much
   slower locally.

Several severe historical discrepancies are also present in the local capture
corpus: almost no NPC debuffs, immediate ranged hits, first-attack dominance,
and the poison archer running at four times its authored speed. Current source
and synthetic tests contain fixes for much of that surface, but there is no
fresh post-fix real-client capture proving those corrections. They are reported
as “fixed in code, capture verification missing”, not as closed.

## Evidence sources

| Corpus | Identification | Files | Moving NPC instances | Moving constants | NPC casts | NPC results | NPC buff generates |
|---|---|---:|---:|---:|---:|---:|---:|
| Official | Client config targets `https://api.blue.prod.dr.g17s.net` | 81 | 19,989 | 49 | 17,566 | 9,754 | 870 |
| Local historical | Workspace `logs/`, client-perspective wire captures | 107 | 17,474 | 48 | 20,070 | 18,558 | 2 |
| Current synthetic | `npm run test:combat-matrix` | generated | 107 constants | 107 | 212 attack references | runtime assertions | 64 hostile-buff cases |

Official capture directory used during the audit (shown as an environment
variable because the reference client data is intentionally outside this
repository):

```text
$OFFICIAL_CAPTURE_DIR
```

Local historical path:

```text
logs
```

The two wire corpora overlap on 36 moving NPC constants and 46 attacks. Raw
damage magnitude is not compared as an invariant because level, party size,
infinite depth, hero defence, and buffs differ between sessions. Presence or
absence of a result, timing, attack id, play speed, and buff generation are
safe comparisons.

## Findings

### F-01 — Resolved: non-hit actions dealt unavoidable damage

Severity: **high**  
Confidence: **high**  
Status: **fixed after the audit; regression-covered**

| Attack | Official casts | Official results | Audited resolution | Audited synthetic damage |
|---|---:|---:|---|---:|
| `EN_ICE_IMP_ATTACK_SHOWOFF` | 1,055 | 0 | `direct-fallback` | 4 |
| `EN_ICE_IMP_ATTACK_BACKOFF` | 808 | 0 | `direct-fallback` | 4 |
| `EN_SHAMAN_IMP_SPAWN` | 179 | 0 | `direct-fallback` | 7 |

All three rows have negative `DamageMod`, but their timelines contain neither a
combat collider nor a projectile launch. The official server never emits a
result for them. The current server treats a negative, unshaped NPC attack as a
direct hit on its selected target, independent of position.

This explains a class of reports where a monster appears to show off, back
away, or spawn something and the hero takes damage with no visible contact.

It also exposes an oracle flaw in the generated matrix: the matrix currently
accepts “negative `DamageMod` + no geometry” as a valid direct hit. The official
corpus disproves that assumption for these three attacks.

Post-audit resolution: the runtime and matrix now classify these three, plus
the same-shaped `EN_YETI_SPAWN_BABIES`, as `no-impact`; their observed
synthetic damage is zero.

### F-02 — Confirmed structural: KITE and TELEPORT behavior is incomplete

Severity: **high**  
Confidence: **high**  
Status: **KITE and TELEPORT fixed after the audit; regression-covered**

Current GameMaster combat rows:

| AI type | Rows | Current behavior |
|---|---:|---|
| `CHASE_AI` | 86 | chase/contact behavior |
| `KITE_AI` | 13 | standoff plus finite, edge-triggered flee windows |
| `TELEPORT_AI` | 8 | recurrent disable/regenerate/teleport lifecycle |

At audit time the source did not consume `FleeTimer` or `FleeTimerRand`. KITE
rows now enter a generic flee window when their target crosses the authored
standoff, retreat through navigation while facing the target, withhold attacks
for the authored duration, and resume afterward. Rows authoring a zero flee
timer retain stationary standoff behavior. A flee window cannot immediately
chain into itself: a cornered kiter fights when the authored timer expires and
is re-armed only after it genuinely regains its standoff. This preserves
repeated retreat on later approaches without allowing permanent attack denial.

TELEPORT rows now consume `TeleportRange`, `TeleportRecurT`,
`TeleportRecurRand`, `PreTeleportAttack`, `PostTeleportAttack`, and the
`TeleportInTimeline` metadata. The implementation follows the official lifecycle: disable
the same doid, remain absent for the recur window, regenerate the same doid at
a clear point around the target, emit `TELEPORT_IN`, and hold the next attack
for the authored pre-attack delay. Hidden actors cannot be targeted or damaged.
Recurring official cycles disable directly rather than consistently emitting
`TeleportOutTimeline`; the out value is retained in runtime data but is not
invented on every cycle.

The official evidence behind the timing is large: 1,041 observed Purple
Specter cycles have a 2,500 ms hidden median and a 1,584 ms regenerate-to-attack
median; 363 Red Specter cycles measure 2,426 ms and 1,043 ms. Those match their
2–3 second recur and 1.5/1.0 second pre-attack fields.

Official/local cadence supports the same conclusion:

| NPC | AI type | Official p05 | Historical local p05 | Local / official |
|---|---|---:|---:|---:|
| `PURPLE_SPECTER` | `TELEPORT_AI` | 5,515 ms | 1,497 ms | 0.27× |
| `KNIGHT_THROWING` | `KITE_AI` | 4,992 ms | 1,491 ms | 0.30× |
| `SAVAGE_BOW` | `KITE_AI`, plus `AttackSpd=.25` | 6,192 ms | 1,602 ms | 0.26× |

The official corpus covers 8 KITE constants and 4 TELEPORT constants. The local
corpus covers 8 KITE constants but only one TELEPORT constant, so teleport
conformance is especially thin.

Affected TELEPORT rows:

`PURPLE_SPECTER`, `RED_SPECTER`, `BLUE_SPECTER`, `GREEN_SPECTER`,
`SHADOW_SPECTER`, `PURPLE_SPECTER_HEAVY`, `RED_SPECTER_HEAVY`,
`SHADOW_WOLF_PET`.

Affected KITE rows:

`SKELETON_ARCHER`, `KNIGHT_MARKSMAN`, `KNIGHT_HALBERD`,
`KNIGHT_THROWING_PRISON`, `KNIGHT_THROWING`, `RIVAL_SORCERER`,
`RIVAL_VAMPIRE_HUNTER_MASTER_TRAPPER`, `SAVAGE_BOW`, `SAVAGE_SPEAR`,
`MINI_BOSS_IMP`, `SKELETON_ARCHER_HEAVY`, `SKELETON_ARCHER_BOMB`,
`WARTHOG_GREEN`.

### F-03 — Confirmed historical: NPC debuffs were almost entirely absent locally

Severity: **high**  
Confidence: **high for the historical corpus; medium for the current build**  
Status: **combat and weapon-modifier paths regression-covered; fresh live capture required**

The official corpus contains 870 buff objects whose attacker is a moving NPC,
across 16 NPC/buff pairs. The historical local corpus contains only two, both
`FREEZE_IMP -> CHILL_L1`.

Examples observed on the official server:

| Source NPC | Buff/debuff | Generates |
|---|---|---:|
| `BRUTE_CAVE` | `POISON_L2` | 264 |
| `SUICIDE_BABY_YETI` | `CHILL_L1` | 100 |
| `SUICIDE_BABY_YETI` | `FREEZE` | 79 |
| `SHAMAN_IMP` | `CHILL_L1` | 97 |
| `MINI_BOSS_IMP` | `CHILL_L2` | 55 |
| `MINI_BOSS_IMP` | `FREEZE` | 40 |
| `RED_SPECTER` | `FIRE_L1` | 42 |
| `SAVAGE_BOW` | `POISON_L1` | 28 |
| `SAVAGE_SPEAR` | `POISON_L1` | 21 |
| `JUGGERNAUT` | `STUN_L0` | 17 |
| `FROST_TROLL_MINIBOSS` | `CHILL_L1` | 8 |
| `LIGHTNING_ORB_SHOOTER` | `SHOCK_L1` | 1 |

The current generated matrix executes 64 NPC attack references carrying 23
unique hostile buffs and reports no synthetic failure. That proves the current
server code calls its buff path; it does not prove the real client receives the
right generates, durations, stacks, or effects after all recent changes.

Post-audit buff/modifier resolution now also covers the effect behind the
object, not merely its generate packet:

- all eight weapon-debuff families retain their semantic effect (`STUN`,
  `SLOW`, `CRIPPLE`, `ROOT`, `CHILL`, `FIRE`, `SHOCK`, `POISON`);
- NPC-authored and Infinite-mode immunity abilities suppress the gameplay
  effect while keeping the official-visible buff object/VFX;
- this distinction is capture-backed: the official grants nine root buffs to
  `ROOT_IMMUNE` NPCs in the available corpus, and those actors continue sending
  movement throughout the buff lifetime;
- fire/poison resistance suppresses DoT ticks; crit, knockback, and pull
  immunity suppress the corresponding weapon-modifier result;
- stun, shock, paralysis, or disabled controls applied during an NPC windup
  cancel its pending melee impact/projectile release;
- `MP_REGEN` and `BUSTER` buff multipliers now feed the authoritative mana and
  Crowd-point calculations;
- authored duration, expiry grace, `MaxStacks`, attack/movement/speed/defence
  multipliers, and modifier-carried debuff application remain covered by the
  existing regression suite.

Two adjacent systems remain outside this combat fix: selecting/applying
`DungeonModifier` rows for Infinite runs, and persistent account/store boosters
whose `HP_BOOST`, `MP_BOOST`, `LUCK`, `EXP`, or `Gold` lifetime crosses dungeon
sessions. Their rows are present, but they need their own ownership/persistence
work rather than being guessed into a transient combat buff.

Required verification: one new local real-client corpus containing at least
`SAVAGE_BOW`, `BRUTE_CAVE`, `SUICIDE_BABY_YETI`, and `JUGGERNAUT`.

### F-04 — Resolved in code: attack selection distributions diverged historically

Severity: **high**  
Confidence: **high for historical behavior and current selection policy**  
Status: **range/recharge selection is regression-covered; fresh capture remains**

The largest observed distribution differences:

#### `LION`

| Attack | Official | Historical local |
|---|---:|---:|
| `EN_LION_ROAR` | 71.9% | 4.0% |
| `EN_MONSTER_CLAW` | 11.8% | 96.0% |
| `EN_LION_TACKLE` | 16.2% | 0% |

#### `MINI_BOSS_IMP`

| Attack | Official | Historical local |
|---|---:|---:|
| `EN_AREA_PULL_PULSE_ATTACK` | 19.0% | 97.6% |
| `EN_ICE_IMP_ATTACK_SHOWOFF` | 29.6% | 0.9% |
| `EN_ICE_IMP_ATTACK` | 26.6% | 0.3% |
| `EN_ICE_IMP_ATTACK_BACKOFF` | 24.8% | 1.2% |

#### `FREEZE_IMP`

| Attack | Official | Historical local |
|---|---:|---:|
| `EN_ICE_IMP_ATTACK_SHOWOFF` | 42.9% | 1.9% |
| `EN_FREEZE_IMP_ATTACK` | 18.6% | 2.3% |
| `EN_ICE_IMP_ATTACK` | 38.5% | 95.8% |

Post-audit resolution: selection is now one explicit, deterministic-testable
operation. It first filters every authored attack slot by `MinRange`, `Range`,
body contact, and that attack's own `AI_RechargeT`, then chooses uniformly from
the remaining set. The live AI supplies the session RNG, so capture/replay
tests can reproduce the decision without adding NPC-specific weights.

That generic rule is supported by the official corpus rather than guessed from
the aggregate percentages:

- `FREEZE_IMP`'s observed mix decomposes into uniform choice over its authored
  one- or two-attack distance bands.
- Official fifth-percentile same-attack gaps closely match the authored
  recharge floors: freeze-imp attacks are approximately 4.3/4.4/5.0 seconds
  for 4/4/5-second rows; lion roar and tackle are 9.992/6.009 seconds for
  10/6-second rows; mini-boss pull, basic, backoff, and showoff are
  15.209/4.334/6.008/5.174 seconds for 15/4/6/5-second rows.
- Game-master-backed regressions cover the close/middle/far eligible sets for
  `FREEZE_IMP`, `LION`, and `MINI_BOSS_IMP`, plus independent per-attack
  cooldown removal and restoration.

The historical local corpus predates the complete multi-slot/range/recharge
path. A fresh real-client capture is still required to close end-to-end
conformance, but the previously suspected missing weight table is not supported
by the evidence and was not introduced.

Smaller but measurable historical drift also exists for `MINOTAUR`,
`JUGGERNAUT`, `RAPTOR`, `WOLF_PET`, `DRAGON_PET`, `ICE_IMP`, and
`CRAZED_YETI`.

### F-05 — Historical: many ranged results arrived too early locally

Severity: **high**  
Confidence: **high for historical behavior; medium for current build**  
Status: **current projectile/collider matrix passes; fresh live capture required**

Median delay from NPC choreography to its result:

| Attack | Official median | Historical local median | Difference |
|---|---:|---:|---:|
| `EN_AREA_PULL_PULSE_ATTACK` | 1,342 ms | 0 ms | −1,342 ms |
| `EN_TROLL_DRILL` | 1,065 ms | 0 ms | −1,065 ms |
| `EN_ICE_IMP_ATTACK` | 1,000 ms | 0 ms | −1,000 ms |
| `THROW_AXE_KN` | 859 ms | 0 ms | −859 ms |
| `EN_ARROW_SHOT` | 566 ms | 0 ms | −566 ms |
| `EN_FART_ATTACK` | 815 ms | 333 ms | −482 ms |
| `EN_POISON_ARROW` | 825 ms | 459 ms | −366 ms |
| `EN_FREEZE_IMP_ATTACK` | 1,665 ms | 1,329 ms | −336 ms |
| `SPECTER_LIGHTNING` | 1,675 ms | 1,377 ms | −298 ms |

Ordinary melee timings were much closer: sword slash was about 500 ms
official versus 458 ms local, bites/claws about 167 ms versus 125 ms, and
several charged attacks were within one server tick.

A post-fix trace rules out one global "damage at animation start" bug. Of 71
unique moving-NPC melee attacks with authored contact geometry, 65 begin on a
later frame. Six begin on frame zero. The two well-sampled frame-zero attacks
also resolve immediately on the official server:

| Attack | Official median | Historical local median | Authored first frame |
|---|---:|---:|---:|
| `EN_BABY_YETI_SCRATCH` | 0 ms (629 samples) | 1 ms (320) | 0 |
| `EN_YETI_PUNCH` | 0 ms (28 samples) | 0 ms (27) | 0 |
| `EN_SWORD_SLASH` | 507 ms (296 samples) | 458 ms (1,102) | 11 |
| `EN_MACE_CHOP` | 167 ms (434 samples) | 125 ms (318) | 3 |

Thus an immediate Baby Yeti scratch/Yeti punch is authored and production-
matched, even if its artwork reads as a telegraph. Applying a minimum melee
windup would be a deliberate gameplay change rather than a conformance fix.

The current code now has projectile flight and per-frame collider scheduling,
and the generated inside/outside/windup tests pass. The official corpus still
shows that the generated matrix needs a capture-backed timing oracle; F-01 is
the concrete example where a self-consistent synthetic test accepted the wrong
behavior.

### F-06 — Confirmed current configuration: movement replication is 2.5× denser

Severity: **medium**  
Confidence: **high for packet cadence, medium for perceived movement speed**  
Status: **fixed after the audit; default tick is now 250 ms**

Across 34 well-sampled shared constants:

- Official NPC position update median: approximately 250 ms.
- Historical local update median: approximately 100 ms.
- Audited `npcAiTickMs`: 100 ms.

Post-audit resolution: the default is now 250 ms. The ordinary-walk
acceleration was recalibrated to 0.9 seconds so four 250 ms turns retain the
official first-second travel envelope (approximately 0.67 of top-speed
distance) rather than slowing movement merely because packets are less dense.

Corpus totals:

| Metric | Official | Historical local |
|---|---:|---:|
| Position-pair samples | 421,428 | 1,295,523 |
| Non-zero speed samples | 420,390 | 1,272,241 |
| Heading-gap samples | 165,574 | 758,201 |

This is not merely a network bandwidth difference. Median measured movement
speed varies by constant and direction:

| NPC | Official median | Historical local median | Local / official |
|---|---:|---:|---:|
| `KNIGHT_THROWING` | 78.3 | 147.6 | 1.89× |
| `KNIGHT` | 94.3 | 160.2 | 1.70× |
| `JUGGERNAUT` | 75.6 | 125.0 | 1.65× |
| `BRUTE` | 97.4 | 156.8 | 1.61× |
| `SKELETON_ARCHER` | 95.4 | 45.1 | 0.47× |
| `MINOTAUR` | 71.4 | 35.1 | 0.49× |
| `SAVAGE_SPEAR` | 114.9 | 57.7 | 0.50× |
| `SKELETON_WARRIOR` | 108.6 | 66.2 | 0.61× |

These medians include pathing, acceleration, avoidance, retreat behavior, and
sampling differences, so they do not justify one global speed multiplier. They
do show that current movement cannot be certified by checking `BaseMove` alone.

### F-07 — Historical: poison archer ignored authored attack speed

Severity: **high historically**  
Confidence: **high**  
Status: **fixed in current source/matrix; post-fix capture missing**

`EN_POISON_ARROW` authors `AttackSpd = 0.25`.

| Metric | Official | Historical local |
|---|---:|---:|
| Casts | 100 | 78 |
| Median `playSpeed` | 0.25 | 1.0 |
| NPC cadence p05 | 6,192 ms | 1,602 ms |

This is the only well-sampled attack whose median choreography play speed
differs between the two corpora. Current runtime data and unit tests preserve
0.25 and extend the interval accordingly, but a new capture is still needed.

### F-08 — Deferred: aggro and pathfinding are a separate design track

Severity: **out of scope for combat-behavior conformance**  
Confidence: **high**  
Status: **current safe contract covered; original-server matching intentionally deferred**

Older client captures truncate many owner generates, leaving only 35 official
NPC casts with both attacker and target positions reconstructable. Thirty-three
belong to `KNIGHT_TUTORIAL`:

| Metric | Official | Historical local | Authored attack range |
|---|---:|---:|---:|
| Median cast distance | 69.0 | 69.5 | 80 |
| p95 cast distance | 80.0 | 80.0 | 80 |

That fixture matches exactly. It is not enough to certify the other 106 moving
constants, especially KITE and TELEPORT rows. The current code reads authored
`AggroRadius`; measuring official acquisition distance would require a
controlled solo run in which an untriggered enemy is approached across its
boundary and the first movement/attack is retained with full position telemetry.

Post-audit investigation makes the limitation more precise. Across 77 official
sessions, all 27,952 NPC choreography packets put `0xBEBEBEBE` in the authored
target slot rather than the target doid. A later `ReceiveCombatResult` can join
5,204 of those casts back to a victim, but that join crosses the client/server
round trip and usually follows melee windup or projectile travel. It can measure
an approximate cast/result distance; it cannot recover the distance at which
the server first acquired the target. Likewise, a first NPC position update is
not an acquisition oracle because generator releases and scripted cages start
already engaged and are not identified as such on the wire.

The safe local contract is now regression-covered instead:

- all 107 moving combatant rows retain their authored `AggroRadius`; the global
  setting is only a missing-data fallback;
- an idle enemy stays still immediately outside its radius and engages on the
  boundary;
- an engaged enemy remains engaged through `DisengageDist` and releases beyond
  it;
- the deliberately passive `WARTHOG_WHITE_FAT` keeps its authored zero radius.

No global radius multiplier or per-NPC override is justified by the available
official stream, so none was introduced. More importantly, exact production
aggro-radius parity is no longer a goal of this combat pass. Acquisition,
target switching, leash/return behavior, navigation and encounter pacing affect
one another and should be designed and tested together as a separate
AI/pathfinding track rather than tuned one radius at a time from incomplete
captures.

### F-09 — Raw damage magnitude is not a safe corpus-wide comparison yet

Severity: **coverage/methodology gap**  
Confidence: **high**  
Status: **core NPC formula is capture-backed; full-roster differential remains**

Official and local median damage values often differ, but their sessions do not
hold level, party size, infinite depth, hero defence, and buffs constant. A raw
ratio would mix formula errors with different encounters.

High-confidence damage conclusions from this audit are limited to:

- the three attacks in F-01 must produce no result;
- zero-damage roars/growls must not be converted to one-point hits;
- spatial attacks must miss outside their collider/projectile path;
- hostile buffs must be generated only when their hit is accepted.

The current matrix verifies the latter two synthetically. A true damage
differential needs matched fixtures grouped by NPC constant, level, attack,
party size, depth, and target defence.

The current suite does contain four such matched fixtures, which were omitted
from the first audit summary:

| Fixture | Official | Current |
|---|---:|---:|
| Level-43 `KNIGHT` → level-43 `LION_WILD`, `EN_SWORD_SLASH` | 15 (23/23 hits) | 15 |
| Level-59 `BABY_YETI` → level-74 `WOLF_PET`, scratch | 5 (44/44 hits) | 5 |
| Level-51 `BRUTE_CAVE`, four-player scaling, fart attack | 31 | 31 |
| Level-100 Infinite depth 1 `BRUTE`, mace chop | 36 | 36 |

Together they pin the major server-owned branches: attacker level, upward NPC
rounding, party scaling of the NPC stat without scaling its weapon, and Infinite
damage growth. The formula is therefore not an open defect on present evidence.
The remaining gap is breadth: hero defence/buff state and every monster/attack
combination are not controlled across the historical sessions, so their raw
medians still must not be treated as expected values.

## Areas that match or are promising

- All 17,566 official moving-NPC choreographies resolve to known attacks; no
  unowned/unknown attack was observed.
- The current matrix resolves all 212 authored moving-NPC attack references.
- Most well-sampled ordinary monster cadence floors are within about 10%:
  `ICE_IMP`, `FREEZE_IMP`, `SHAMAN_IMP`, `KNIGHT_HALBERD`,
  `KNIGHT_MARKSMAN`, `KNIGHT_THROWING_PRISON`, `BABY_YETI`, `BRUTE`,
  `SKELETON_ARCHER`, `RAPTOR`, and `WOLF_PET`.
- Tutorial knight melee range matches the official corpus to less than one
  unit at the median and p95.
- Current synthetic coverage includes 42 projectile cases, 143 collider cases,
  27 no-impact cases, inside/outside checks, windup dodges, self buffs,
  and 64 hostile-buff references.
- Current source schedules every authored collider frame and prevents the same
  cast from repeatedly charging one stationary target.
- NPC movement now sweeps attack lunges against the hero body. A fast melee
  lunge can no longer start on one side and land outside the body on the other
  side in a single position packet, which previously looked like the monster
  teleported onto or through the player at attack time.
- Once an NPC attack begins, ordinary chase and target-facing pause through its
  last authored collider/projectile frame. Only that attack's `MoveAmount`
  remains active, so stepping out during a melee windup can produce a real miss
  instead of the collider following the hero until impact.

## Coverage limits

The official corpus covers 49 of 107 moving constants. These 58 have no direct
official observation in the available logs:

`AAA_NEW_BRUTE`, `AAA_NEW_KNIGHT`, `AAA_NEW_MINOTAUR`, `ALPHA_TIGER`,
`ALPHA_TIGER_BUFF`, `AZTECH_STATUE_BLUE`, `AZTECH_STATUE_PURPLE`,
`AZTECH_STATUE_RED`, `BARREL_MONSTER`, `BASIC_WARHOG`, `BIG_LEECH`,
`BLUE_DRAGON`, `BOMB_MONSTER`, `BRUTE_MINIBOSS`, `CHARGE_WARHOG`,
`DARK_MINOTAUR`, `DRAGON_POISON`, `ENEMY_GHOST_SAMURAI_CLONE`,
`FROST_MINOTAUR`, `FROST_TROLL`, `FROST_TROLL_MINIBOSS_VILLAGE`,
`GIANT_LEECH`, `HARASSMENT_SPECTER`, `ICE_TIGER`, `ICE_TIGER_HEAVY`,
`KNIGHT_BOXERS_ST_DOWN`, `KNIGHT_BOXERS_ST_LEFT`,
`KNIGHT_BOXERS_ST_RIGHT`, `KNIGHT_BOXERS_ST_UP`, `KNIGHT_SHIELD`,
`MINOTAUR_CHAMPION`, `NEMESIS`, `PURPLE_SPECTER_HEAVY`, `RABID_LION`,
`RAPTOR_WILD`, `RED_DRAGON`, `RED_SPECTER_HEAVY`, `RIVAL_BERSERKER`,
`RIVAL_BERSERKER_BLUE`, `RIVAL_GHOST_SAMURAI`, `RIVAL_SORCERER`,
`RIVAL_VAMPIRE_HUNTER_MASTER_TRAPPER`, `SHADOW_SPECTER`,
`SHADOW_WOLF_PET`, `SKELETON_ARCHER_BOMB`, `SKELETON_ARCHER_HEAVY`,
`SKELETON_DANCER`, `SKELETON_WARRIOR_BEAST`,
`SKELETON_WARRIOR_HEAVY`, `SKELETON_WARRIOR_SWARM`, `SMALL_LEECH`,
`STATIONARY_BRUTE`, `STATIONARY_BRUTE_MINIBOSS`, `TINY_LEECH`,
`WARTHOG_BROWN`, `WARTHOG_GREEN`, `WARTHOG_GREEN_HEAVY`,
`WARTHOG_WHITE_FAT`.

Several are debug/variant rows rather than ordinary campaign encounters, but
they remain unverified rather than implicitly passing.

## Recommended next capture set

No fix is proposed here. The minimum capture set needed to turn the uncertain
findings into verified current-state results is:

1. `FREEZE_IMP` and `MINI_BOSS_IMP`: attack-choice distribution, projectile
   delay, `CHILL`/`FREEZE`, showoff/backoff false hits.
2. `SAVAGE_BOW`: `playSpeed=.25`, six-second cadence floor, poison generation.
3. `KNIGHT_THROWING`: real flee cycle and throw cadence.
4. `PURPLE_SPECTER`: teleport-out/in cycle and attack cadence.
5. `LION`: roar/tackle/claw distribution.
6. `BRUTE_CAVE` and `SUICIDE_BABY_YETI`: poison plus dual chill/freeze effects.
7. One four-player run: target selection, collateral melee, and party scaling.

Each run should retain both client and server capture sides and use the current
commit/worktree identity in its filename or metadata.

## Reproduction commands

```bash
# Current synthetic coverage
npm run test:combat-matrix

# Official and local attack cadence
node tools/cadence.js "$OFFICIAL_CAPTURE_DIR"
node tools/cadence.js logs

# Choreography-to-impact delay
node tools/npc-impact-delay.js "$OFFICIAL_CAPTURE_DIR" --official
node tools/npc-impact-delay.js logs

# Choreography/toggle behavior comparison
node tools/behaviour-conformance.js \
  "$OFFICIAL_CAPTURE_DIR" \
  logs \
  --only-differences

# Inspect one current runtime attack
node tools/combat-matrix.js --attack EN_ICE_IMP_ATTACK_SHOWOFF --json
```

## Audit conclusion

The project now has exhaustive local execution, but not exhaustive official
conformance. The geometry-free phantom hits, KITE and TELEPORT states, and the
generic attack-selection policy found in F-01/F-02/F-04 are now fixed or
regression-covered. Fresh real-client verification is the next open behavior
work. Historical logs also show severe debuff, projectile timing, and
poison-archer speed failures; current code appears to address several, but they
must remain open verification items until a fresh real-client corpus is
captured.
