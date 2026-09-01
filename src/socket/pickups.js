import { PacketWriter } from "./packet.js";
import { CLID, OP } from "./opcodes.js";
import { config } from "../config.js";
import { info } from "../log.js";
import { grantBuff, hasBuff } from "./buffs.js";
import { applyDooberReward, applyProgressReward } from "./rewards.js";
import { membersOf, worldOf } from "./match-world.js";

/**
 * Doober pickup.
 *
 * Nothing on the client asks for a pickup — DistributedDooberGameObject has no
 * send_ methods at all. It only reacts to `collectedBy` (field 291, u32 hero
 * doid), which plays the collection effect and destroys the object.
 *
 * So proximity detection is the server's job: it already receives the hero's
 * position (field 147 on HeroGameObjectOwner, two floats) several times a
 * second, and decides from that when something has been walked over.
 */

const FLID_DOOBER_COLLECTED_BY = 291;

/** Field 147: send_position on HeroGameObjectOwner — f32 x, f32 y. */
export const FLID_HERO_POSITION = 147;

const collectedBy = (dooberDoid, heroDoid) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(dooberDoid)
    .u16(FLID_DOOBER_COLLECTED_BY)
    .u32(heroDoid)
    .frame();

/**
 * The original pickup radius is not in the game data — it lived on the server —
 * so this is a judgement call. Tiles are 900 units across and a character is
 * roughly a tenth of that, which makes ~120 feel like walking over something
 * rather than magnetising it from across the room.
 */
const withinReach = (a, b, radius) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= radius * radius;
};

/**
 * How much of what a pickup offers you could actually use before it is worth
 * taking.
 *
 * Four fifths was too careful. It kept a player off a sausage above 84% health
 * and off a meatbone above 76%, which in practice meant walking past food
 * while hurt because the piece was slightly larger than the wound. Half is the
 * same idea with a lighter hand: a steak is still for a bad wound, but a
 * scratch is enough reason to eat something small.
 */
const USABLE_SHARE = 0.5;

/**
 * And below this, size stops mattering — anything missing is reason enough.
 *
 * The bottom of the ladder is scraps: the chef's on-hit crumb at 2% of the bar,
 * a sausage at 20%, a sandwich and a cooked meatbone at 25%. Refusing those for
 * being slightly too big for the wound is how a full-health rule reads to a
 * player at 97%, so a quarter of the bar or less is taken whenever anything at
 * all is gone. Only being genuinely full turns them down.
 */
const SCRAP_SHARE = 0.25;

const shareMissing = (current, maximum) => {
  const top = Number(maximum ?? 0);
  if (!(top > 0)) return 1;
  return Math.max(0, Math.min(1, (top - Number(current ?? 0)) / top));
};

/**
 * Whether the hero would waste it.
 *
 * Walking over a full-health restore at nearly full health is the case this
 * exists for: in a party the food is shared, and a healthy player hoovering up
 * a steak takes it from whoever needed it. The captured runs show exactly that
 * restraint — the chef stood on his own cooked ham and steak, six and ten units
 * away, and left every piece of it.
 *
 * Stated as a share rather than a threshold so it scales with the size of the
 * food: you must be able to use four fifths of what it offers. A sausage at a
 * fifth of the bar is worth taking below about eighty-four percent health, a
 * steak at three quarters only below forty. Anything restoring nothing — the
 * chef's buff soups — is never refused, since there is nothing to waste.
 *
 * Health and Mana are asked separately and either is reason enough, so a
 * sandwich is still worth taking for its Mana when only Mana is short.
 */
const worthTaking = (session, doober) => {
  // Health lives on the hero actor, Mana on the session — the same two places
  // healHero and restoreMana read.
  const hero = session.actors?.get(session.heroDoid);
  const offers = [
    [Number(doober.hpPercentage ?? 0), shareMissing(hero?.hitPoints, hero?.maxHitPoints)],
    [Number(doober.mpPercentage ?? 0), shareMissing(session.heroManaPoints, session.maxHeroManaPoints)],
  ].filter(([offered]) => offered > 0);

  /**
   * A soup you are already under is not yours to take.
   *
   * All three of the chef's carry `MaxStacks` 1, so a second one does nothing
   * for him — but nothing stopped him walking over it, and in a party that is
   * the buff taken out of somebody else's reach. He cooks for the table.
   */
  if (doober.buffGranted && hasBuff(session, session.heroDoid, doober.buffGranted)) return false;

  if (!offers.length) return true;
  return offers.some(([offered, missing]) => {
    if (missing <= 0) return false;
    // A scrap needs only somewhere to go; anything larger has to be worth it.
    return offered <= SCRAP_SHARE || missing >= offered * USABLE_SHARE;
  });
};

/**
 * Called on every hero position update. Collects anything in range and reports
 * how many were taken.
 */
export const collectNearby = (session, position) => {
  if (!session.doobers?.size) return 0;

  const radius = config.pickupRadius;
  const taken = [];

  for (const [doid, doober] of session.doobers) {
    if (!withinReach(position, doober, radius)) continue;
    if (!worthTaking(session, doober)) continue;
    taken.push([doid, doober]);
  }

  collectTracked(session, taken);
  return taken.length;
};

const collectTracked = (
  session,
  taken,
  { collectorDoid = session.heroDoid, progressOnly = false, label = "picked up" } = {}
) => {
  for (const [doid, doober] of taken) {
    const timer = session.dooberTimers?.get(doid);
    if (timer) clearTimeout(timer);
    session.dooberTimers?.delete(doid);
    // Class lookup must still exist while MatchWorld routes this field. Deleting
    // first downgraded it to a collector-only direct send and left a ghost loot
    // object on every peer.
    session.send(collectedBy(doid, collectorDoid));
    session.world?.forgetObject?.(doid);
    session.doobers.delete(doid);
    session.objects.delete(doid);

    const world = worldOf(session);
    if (world && (doober.gold || doober.xp || doober.crowd)) {
      for (const member of membersOf(world)) {
        applyProgressReward(member.world?.contextFor(member) ?? member, doober);
      }
      // Health, Mana, treasure and buffs still belong to the collector; only
      // the three progression currencies above are party-wide.
      if (!progressOnly) {
        applyDooberReward(session, { ...doober, gold: 0, xp: 0, crowd: 0 });
      }
    } else if (progressOnly) {
      applyProgressReward(session, doober);
    } else {
      applyDooberReward(session, doober);
    }
    if (!progressOnly && doober.buffGranted) {
      grantBuff(session, doober.buffGranted).catch((error) =>
        info(`[${session.id}] could not grant ${doober.buffGranted}: ${error.message}`)
      );
    }
    info(`[${session.id}] ${label} ${doober.constant}`);
  }
};

/**
 * Wolves collect only the progression stars their GameMaster row permits.
 * No persistent pet doid appears as `collectedBy` in the capture corpus, so
 * the owner hero remains the wire collector and reward ownership stays
 * unambiguous in multiplayer.
 */
export const collectNearbyForPet = (session, position, collects = {}) => {
  if (!session.doobers?.size) return 0;
  const radius = config.pickupRadius;
  const taken = [];
  for (const [doid, doober] of session.doobers) {
    if (!withinReach(position, doober, radius)) continue;
    if (
      doober.treasure ||
      doober.hpPercentage ||
      doober.mpPercentage ||
      doober.buffGranted
    ) continue;
    const eligible =
      (collects.gold && doober.gold) ||
      (collects.xp && doober.xp) ||
      (collects.crowd && doober.crowd);
    if (eligible) taken.push([doid, doober]);
  }
  collectTracked(session, taken, {
    collectorDoid: session.heroDoid,
    progressOnly: true,
    label: "pet picked up",
  });
  return taken.length;
};

/** Records a doober so it can be picked up later. */
export const trackDoober = (
  session,
  doid,
  {
    x,
    y,
    constant,
    gold = 0,
    xp = 0,
    crowd = 0,
    hpPercentage = 0,
    mpPercentage = 0,
    buffGranted = null,
    /**
     * The chest this pickup stands for, if it is one.
     *
     * Dropped on the floor here for a long time: both producers set it —
     * `spawnBossReward` marks the twelve BOSS nodes' rewards and the tiles'
     * own reward placements mark theirs — and this destructuring listed every
     * other field, so the flag never survived into the tracked doober.
     * `collectDoober` asks `if (doober.treasure)` before awarding, and it was
     * asking a question that could not be true. Every chest a player ever
     * picked up vanished on contact, which is why accounts stayed empty.
     */
    treasure = 0,
  }
) => {
  session.doobers ??= new Map();
  session.doobers.set(doid, {
    x,
    y,
    constant,
    gold,
    xp,
    crowd,
    hpPercentage,
    mpPercentage,
    buffGranted,
    treasure,
  });
};

export const isDoober = (clid) => clid === CLID.DistributedDooberGameObject;
