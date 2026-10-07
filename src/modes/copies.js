/**
 * Copies: other players' heroes drawn in a viewer's world, standing and moving
 * where those players really are. Ranked's lobbies are the first use — every
 * lobby is a private world, so nobody waiting would see anybody else — and its
 * race ghost the second (docs/ranked.md, "Waiting: a lobby floor").
 *
 * A copy carries no name unless asked for (an empty screen name draws no
 * text), no balloon (a mode relays lines itself, runControls.relay), is never
 * hit (a hero does not collide with its own team), and is gone when its
 * player leaves the view or the mode says so.
 *
 * A copy is a player object and a hero of the viewer's own world, sent to the
 * viewer alone. The hero points at the player object, which is how the client
 * looks a hero's player up; speech.js gives a speaker a body the same way.
 * Both are kept among the world's objects so that the floor's end disables them
 * with everything else of it, and they are only made while the viewer's floor
 * stands, since a child generated under a floor that has gone is an orphan on
 * the client.
 *
 * `frames` are the core's builders by default: hero and player generates,
 * position, heading, AFK, a remote attack and its stop, a buff and a disable.
 * A test hands in its own.
 *
 * The stock client draws an HP bar over every hero but the player's own, and
 * nothing on the wire turns it off. Generating a copy large and resizing it at
 * once (field 149) does shrink the bar, which is sized only at init, but the
 * nav collider is sized there too, and its offset (22 units above the feet on
 * every hero) grows with it: the client then puts the copy's centre thousands
 * of units up, and the edge arrow points there for good. Tried on 2026-10-05
 * and taken out; only a client change hides the bar.
 */
import { CLID } from "../socket/opcodes.js";
import { buffGenerate, heroGenerate, heroHeadingUpdate, heroPositionUpdate, objectDisable, playerGenerate } from "../socket/objects.js";
import { heroAfkUpdate } from "../socket/afk.js";
import { remoteAttackChoreography, remoteStopChoreography } from "../socket/buster.js";

/** How a copy is drawn and moved: what a party member is. */
export const COPY_FRAMES = Object.freeze({
  player: playerGenerate,
  hero: heroGenerate,
  position: heroPositionUpdate,
  heading: heroHeadingUpdate,
  afk: heroAfkUpdate,
  attack: remoteAttackChoreography,
  stopAttack: remoteStopChoreography,
  buff: buffGenerate,
  disable: (doid) => objectDisable(doid),
});

/**
 * Where an attack choreography names other objects (generatedCode/
 * AttackChoreography.hx): the Attack's target, after the weapon slot, the
 * consumable flag and the attack type; and the combat results, after the loop
 * byte and two floats, as a u16 byte length and the rows.
 */
const TARGET_AT = 6;
const RESULTS_LENGTH_AT = 19;

/**
 * A swing as a copy plays it: the same attack, aimed at nothing and hitting
 * nothing. The doids in it are the swinger's world's, and in the viewer's the
 * same numbers are other objects — a result naming one would draw a hit there.
 */
export const swingWithoutTargets = (payload) => {
  if (payload.length < TARGET_AT + 4) return payload;
  const end = payload.length >= RESULTS_LENGTH_AT + 2 ? RESULTS_LENGTH_AT + 2 : payload.length;
  const copy = Buffer.from(payload.subarray(0, end));
  copy.writeUInt32LE(0, TARGET_AT);
  if (end === RESULTS_LENGTH_AT + 2) copy.writeUInt16LE(0, RESULTS_LENGTH_AT);
  return copy;
};

const moved = (a, b) => Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5;

/**
 * `visibleTo(viewer, subject)` says whether a subject may stand in a viewer's
 * world now; a copy that may not any more goes at the next sync. `name` is on
 * every copy's tag ("" draws none), or a function of the subject's account id
 * giving each copy its own. `buff` is a buff type to put on each copy —
 * the client colours the body and plays the buff's effect for as long as the
 * buff object lives, so a race's ghost can be drawn as a shade. `onShown` is
 * told each time a copy is made.
 */
export const createLobbyCopies = ({
  most,
  sessionOf,
  contextOf,
  frames = COPY_FRAMES,
  random = Math.random,
  visibleTo = () => true,
  name = "",
  buff = null,
  onShown = () => {},
}) => {
  /**
   * viewer -> { floor, shown }: the lobby floor the viewer's client has built
   * and asked for its hero on, and subject -> { hero, player, at, skinType } —
   * the copy's two doids, the position it was last sent, and its skin.
   */
  const views = new Map();
  /**
   * subject -> the viewers it is shown to: whom to tell when it moves, and how
   * seen it is when a free place is filled.
   */
  const watchers = new Map();

  /**
   * A player's context, or null. Null too for one whose connection is closing
   * as this runs — players leaving together, each one's leave walking the
   * others' views — since a closed member cannot be given a context, and has no
   * floor left to draw a copy on.
   */
  const live = (accountId) => {
    const session = sessionOf(accountId);
    if (!session) return null;
    try {
      return contextOf(session);
    } catch {
      return null;
    }
  };

  /** Whether copies can stand on this viewer's floor now. */
  const standing = (view, context) =>
    Boolean(context) && view.floor != null && context.floorDoid === view.floor && !context.floorFinished;

  const watch = (subject, viewer) => {
    let set = watchers.get(subject);
    if (!set) watchers.set(subject, (set = new Set()));
    set.add(viewer);
  };
  const unwatch = (subject, viewer) => {
    const set = watchers.get(subject);
    if (!set) return;
    set.delete(viewer);
    if (!set.size) watchers.delete(subject);
  };
  const seenBy = (subject) => watchers.get(subject)?.size ?? 0;
  const nameFor = typeof name === "function" ? name : () => name;

  const make = (viewer, view, context, subject, of) => {
    const spawn = of.heroSpawn;
    const at = of.heroPosition;
    if (!spawn || !at) return false;
    const tag = String(nameFor(subject) ?? "");
    const player = context.allocateDoid?.(CLID.PlayerGameObject);
    const hero = context.allocateDoid?.(CLID.HeroGameObject);
    if (!player || !hero) return false;
    context.objects?.set(player, CLID.PlayerGameObject);
    context.objects?.set(hero, CLID.HeroGameObject);
    const zone = context.dungeonZone ?? 10;
    context.sendDirect(frames.player({ doid: player, parent: context.areaDoid ?? 0, zone, screenName: tag }));
    context.sendDirect(
      frames.hero({
        ...spawn,
        doid: hero,
        parent: context.floorDoid,
        zone,
        position: at,
        playerId: player,
        screenName: tag,
        afk: Boolean(of.idleState?.marked),
      })
    );
    if (Number.isFinite(of.heroHeading) && of.heroHeading !== 0) context.sendDirect(frames.heading(hero, of.heroHeading));
    let shade = null;
    if (buff && frames.buff) {
      shade = context.allocateDoid?.(CLID.DistributedBuffGameObject) ?? null;
      if (shade) {
        context.objects?.set(shade, CLID.DistributedBuffGameObject);
        context.sendDirect(
          frames.buff({ doid: shade, parent: context.floorDoid, zone, buffType: buff, affectedActor: hero, attackerActor: hero })
        );
      }
    }
    view.shown.set(subject, { hero, player, shade, at: { ...at }, skinType: spawn.skinType });
    watch(subject, viewer);
    onShown(viewer, subject);
    return true;
  };

  /** Off the viewer's floor; when that floor has already gone, it took the copy with it. */
  const unmake = (viewer, view, context, subject) => {
    const copy = view.shown.get(subject);
    view.shown.delete(subject);
    unwatch(subject, viewer);
    if (!copy || !standing(view, context)) return;
    for (const doid of [copy.shade, copy.hero, copy.player].filter(Boolean)) {
      context.objects?.delete(doid);
      context.sendDirect(frames.disable(doid));
    }
  };

  /** A viewer's copies, forgotten unsent: their floor took them, or the viewer has gone. */
  const forget = (viewer, view) => {
    for (const subject of view.shown.keys()) unwatch(subject, viewer);
    view.shown.clear();
  };

  /** To each standing copy of `subject`, the frame `build(copy)` makes. */
  const toCopiesOf = (subject, build) => {
    for (const viewer of watchers.get(subject) ?? []) {
      const view = views.get(viewer);
      const copy = view?.shown.get(subject);
      if (!copy) continue;
      const context = live(viewer);
      if (standing(view, context)) context.sendDirect(build(copy));
    }
  };

  /**
   * Whom a viewer's free places go to: those seen least first — a newcomer,
   * wherever there is room — at random among equals. Nobody waits unseen while
   * others are seen by everybody, and nobody stands in a fixed group.
   */
  const choose = (viewer, view, here, free) => {
    const candidates = [];
    for (const subject of here) {
      if (subject === viewer || view.shown.has(subject) || !views.get(subject)?.floor) continue;
      if (!visibleTo(viewer, subject)) continue;
      candidates.push({ subject, seen: seenBy(subject), draw: random() });
    }
    candidates.sort((a, b) => a.seen - b.seen || a.draw - b.draw);
    return candidates.slice(0, free).map((candidate) => candidate.subject);
  };

  return {
    /** The viewer's client has built this lobby floor and asked for its hero on it. */
    floorUp(accountId, floorDoid) {
      const viewer = Number(accountId);
      const old = views.get(viewer);
      if (old) forget(viewer, old);
      views.set(viewer, { floor: floorDoid ?? null, shown: new Map() });
    },

    /**
     * Once a second, with the lobby's players: a copy whose player has gone
     * goes, a position a copy missed is sent, and each viewer's free places,
     * up to `most`, are filled (choose). Seeing is not mutual: B may stand in
     * A's lobby and A not in B's.
     */
    sync(lobby) {
      const here = new Set(lobby.map(Number));
      for (const [viewer, view] of views) {
        const context = live(viewer);
        if (!here.has(viewer) || !context) {
          forget(viewer, view);
          views.delete(viewer);
          continue;
        }
        if (context.floorDoid !== view.floor) {
          // A new floor under them: the old one's end disabled its copies.
          forget(viewer, view);
          view.floor = null;
          continue;
        }
        if (!standing(view, context)) continue;
        for (const [subject, copy] of [...view.shown]) {
          const of = here.has(subject) && views.get(subject)?.floor && visibleTo(viewer, subject) ? live(subject) : null;
          if (!of) {
            unmake(viewer, view, context, subject);
          } else if (of.heroPosition && moved(copy.at, of.heroPosition)) {
            copy.at = { ...of.heroPosition };
            context.sendDirect(frames.position(copy.hero, copy.at));
          }
        }
        const free = most - view.shown.size;
        if (free <= 0) continue;
        for (const subject of choose(viewer, view, here, free)) {
          const of = live(subject);
          if (of) make(viewer, view, context, subject, of);
        }
      }
    },

    moved(subject, position) {
      toCopiesOf(Number(subject), (copy) => {
        copy.at = { x: position.x, y: position.y };
        return frames.position(copy.hero, copy.at);
      });
    },
    turned: (subject, heading) => toCopiesOf(Number(subject), (copy) => frames.heading(copy.hero, heading)),
    swung: (subject, payload) =>
      toCopiesOf(Number(subject), (copy) => frames.attack(copy.hero, swingWithoutTargets(payload), copy.skinType)),
    swingStopped: (subject) => toCopiesOf(Number(subject), (copy) => frames.stopAttack(copy.hero)),
    afk: (subject, marked) => toCopiesOf(Number(subject), (copy) => frames.afk(copy.hero, marked)),

    /**
     * The viewer's floor is about to end: whatever stands on it for them goes
     * now, by its own disable, while the floor is still there to send it from.
     * A copy left to the floor's end is torn down by the client with the floor
     * rather than by its disable, and one generated in the run's last instant
     * went on drawing after the run (adapter.js, finishLine). Their view is
     * kept, with no floor, until the next floorUp.
     */
    clear(accountId) {
      const viewer = Number(accountId);
      const view = views.get(viewer);
      if (!view) return 0;
      const context = live(viewer);
      let gone = 0;
      for (const subject of [...view.shown.keys()]) {
        unmake(viewer, view, context, subject);
        gone += 1;
      }
      view.floor = null;
      return gone;
    },

    /**
     * Out of the lobby — into a race, or out of the run: their copies go from
     * every other lobby, and theirs of the others go with their floor.
     */
    leave(accountId) {
      const subject = Number(accountId);
      const own = views.get(subject);
      if (own) forget(subject, own);
      views.delete(subject);
      for (const viewer of [...(watchers.get(subject) ?? [])]) {
        const view = views.get(viewer);
        if (view) unmake(viewer, view, live(viewer), subject);
      }
      watchers.delete(subject);
    },

    /** Whom a viewer is shown, and how many are shown a subject: for tests and an operator asking. */
    shownTo: (viewer) => [...(views.get(Number(viewer))?.shown.keys() ?? [])],
    seenBy: (subject) => seenBy(Number(subject)),
  };
};
