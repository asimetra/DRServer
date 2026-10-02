# Known limitations

DR Server implements the main play loop end to end. This page records the
remaining areas known to differ materially from the intended behaviour; it is
not a wishlist of possible features.

## Navigation and escape behaviour

NPC navigation includes grid pathfinding, collision-aware movement, cage
release paths, and a nearest-clear-position fallback. Some irregular authored
geometry can still expose gaps:

- an NPC spawned inside a concave or diagonal collision pocket may take too
  long to find the correct open face;
- unusual cage layouts can exhaust their preferred release path and fall back
  to a less natural exit;
- tightly crowded waves can make an otherwise valid escape appear stalled
  until another actor moves.

These are local escape/fallback problems rather than an absence of pathfinding.
A useful report names the map node and floor, the NPC or generator involved,
and the position where it stopped making progress.

## Trophy dungeon fidelity

Trophy dungeon plans, authored floors, completion wiring, boss rewards, and the
main encounter flow are implemented. Not every dungeon is guaranteed to match
the intended encounter exactly:

- wave timing, one-off transitions, or boss choreography may still differ on
  specialised floors;
- specialised NPC behaviour can still use a safe general implementation where
  an encounter-specific rule has not yet been implemented.

When a discrepancy is reproduced, it can be reduced to a focused test and fix.

## Infinite dungeon modifiers

An Infinite dungeon adds a modifier every few floors: enemies that resist a
type of damage, poison gas, no health drops, monsters that spawn more monsters
when they die. All thirty are read from the game data and applied, but they
have not been played through one by one against a live client, and the ones
that were looked at closely needed correcting — a hero under the poison gas was
immune to everything, and the gas itself did no damage.

Until each has been verified in play:

- a modifier may be stronger, weaker or different from what its description
  says;
- the modifiers that work by putting a buff on the enemies or on the heroes
  rest on a reading of the buff tables that few recordings confirm;
- several modifiers active together on a deep floor are untested.

A useful report names the modifier as the floor announces it, the floor number,
and what happened against what the description promised.

## Closing an item

A limitation can be removed once the affected behaviour has a reproducible
test, the fix passes the conformance suite, and a live-client run no longer
shows the discrepancy. Concrete defects should be filed as GitHub issues; this
page remains the short public summary rather than the full engineering backlog.
