/**
 * The one owner of a connection's way into and out of dungeons.
 *
 * Entering, exiting, walking through a door and going away were four pieces
 * of code, each with its own flag — `entryPromise`, `exitPromise`, an attempt
 * counter, `walkingThrough` — and each guard looked at a different few of
 * them. That is how an entry could start while an exit was still leaving, and
 * be accepted after ExitComplete had been sent.
 *
 * Here a connection does one transition at a time:
 *
 *   town ──entry──▶ admitting ──▶ loading ──▶ active ──exit──▶ leaving ──▶ town
 *                                   ▲           │
 *                                   └───door────┘  (checking ▶ leaving ▶ admitting ▶ loading)
 *
 * `active` and `town` are not stored: they are whether the connection is in a
 * match, which the registry and the match executor own. What is stored is the
 * transition under way, if any. A request that arrives while one is under way
 * is refused, except an exit, which cancels it: the exit answers, the exit
 * tears down, and the cancelled transition gives back what it held and says
 * nothing. Nothing new begins until the cancelled one has finished, so its
 * clean-up can never reach a later entry.
 *
 * Admission hands back a `Reservation` (matches.js); every path that ends an
 * entry short of the run aborts it.
 */
import { error, info, warn } from "../log.js";
import {
  ENTRY_ERROR,
  buildEntryResponse,
  buildExitComplete,
  entryErrorCodeFor,
  rememberMatchMakerGroup,
} from "./entry-protocol.js";
import { EntryRefusedError, admitEntry, checkDestination } from "./match-entry.js";
import { matchExecutor } from "./match-runtime.js";
import { dungeonMatches } from "./matches.js";
import { runSavesFailing } from "./run-saves.js";
import { modeHooks } from "../modes/hooks.js";

const controllers = new WeakMap();

/** The controller of the connection behind a session or a floor context. */
export const transitionsOf = (session) => {
  const connection = session?.member ?? session;
  let controller = controllers.get(connection);
  if (!controller) controllers.set(connection, (controller = new SessionTransitions(connection)));
  return controller;
};

/** In a match, as far as this thread can tell: counted by the registry, or routed to a worker. */
const inDungeon = (connection) =>
  Boolean(connection.dungeonMatch || connection.world || connection.dungeonActive || connection.matchRoute);

/** The request a doorway makes on the player's behalf: the shape the client sends. */
const doorRequest = (connection, mapNodeId) => ({
  demographics: "",
  sCode: 0,
  mapNodeId,
  friendId: 0,
  mapId: 0,
  friendOnly: 0,
  matchMakerGroup: connection.matchMakerGroup ?? "",
});

const refusalCodeOf = (problem) =>
  problem instanceof EntryRefusedError ? entryErrorCodeFor({ error: problem.reason }) : null;

export class SessionTransitions {
  constructor(connection) {
    this.connection = connection;
    this.current = null;
    this.generation = 0;
  }

  /** What the connection is doing now. */
  get phase() {
    if (this.current) return this.current.phase;
    return inDungeon(this.connection) ? "active" : "town";
  }

  /** Resolves once no transition is under way, including cancelled ones still finishing. */
  async idle() {
    while (this.current) await this.current.done;
  }

  answer(code, value = 0) {
    this.connection.send(buildEntryResponse(this.connection.matchMakerDoid, code, value));
  }

  /** Starts `work` as the connection's transition; it stops being current when it finishes. */
  run(kind, phase, work) {
    const transition = { kind, phase, generation: ++this.generation, cancelled: false, done: null };
    this.current = transition;
    transition.done = (async () => {
      try {
        return await work(transition);
      } catch (problem) {
        error(`[${this.connection.id}] ${kind} transition failed: ${problem.stack ?? problem}`);
        return false;
      } finally {
        if (this.current === transition) this.current = null;
      }
    })();
    return transition.done;
  }

  /**
   * ClientRequestEntry. Refused while in a dungeon or while anything else is
   * under way — an exit still leaving included.
   */
  requestEntry(rawRequest, { admit = admitEntry, executor = matchExecutor } = {}) {
    const request = modeHooks.routeEntry(this.connection, rawRequest);
    if (this.current || inDungeon(this.connection)) {
      warn(
        `[${this.connection.id}] refusing dungeon entry while ${this.phase}` +
          (this.current ? ` (${this.current.kind})` : "")
      );
      this.answer(ENTRY_ERROR.GAME_NOT_ENTERABLE);
      return null;
    }
    /**
     * Not while storage is refusing saves. Whoever is already in a dungeon is
     * kept — their account stays in memory until it can be written — but a run
     * started now would be played on the same hope, so it is not started. Only
     * here: a door is somebody mid-run, and refusing that strands them.
     */
    const unsaved = runSavesFailing();
    if (unsaved) {
      warn(
        `[${this.connection.id}] refusing dungeon entry: ${unsaved} account(s) have a dungeon save ` +
          "that has not reached storage"
      );
      this.answer(ENTRY_ERROR.GAME_NOT_ENTERABLE);
      return null;
    }
    return this.run("entry", "admitting", async (transition) => {
      let result;
      try {
        result = await admit(this.connection, request);
      } catch (problem) {
        if (transition.cancelled) return false;
        const refusal = refusalCodeOf(problem);
        if (refusal) warn(`[${this.connection.id}] refusing entry with ${refusal}: ${problem.message}`);
        else error(`[${this.connection.id}] entry admission failed: ${problem.stack ?? problem}`);
        this.answer(refusal ?? ENTRY_ERROR.INTERNAL);
        return false;
      }
      if (transition.cancelled) {
        result.reservation?.abort();
        return false;
      }
      if (!result.match) {
        const code = entryErrorCodeFor(result);
        warn(`[${this.connection.id}] refusing dungeon entry with ${code}: ${result.error ?? "no match"}`);
        this.answer(code);
        return false;
      }
      // The match carries its mode: whether anybody may join it is the mode's
      // rules' to say (DungeonMatchRegistry.explicitTarget).
      if (request.mode) result.match.mode = request.mode;
      return this.load(transition, result, request, executor);
    });
  }

  /**
   * RequestExit. Cancels whatever is under way and is the one that answers:
   * the run's teardown, then ExitComplete. A second exit while one is leaving
   * waits for the first.
   *
   * A teardown that throws has stopped somewhere unknown: the disables may not
   * all have gone, and ExitComplete over live dungeon objects is what crashes
   * the native client in town. So there is no ExitComplete then. What this
   * thread holds of the run is let go, so no match keeps a member who has
   * left, and the connection closes; its disconnect retries the teardown.
   */
  requestExit({ executor = matchExecutor, registry = dungeonMatches } = {}) {
    if (this.current?.kind === "exit") return this.current.done;
    const cancelled = this.current;
    if (cancelled) cancelled.cancelled = true;
    return this.run("exit", "leaving", async () => {
      try {
        await this.connection.rewardSavePromise;
      } catch (problem) {
        warn(`[${this.connection.id}] exiting after reward persistence failed: ${problem.message}`);
      }
      // The disables first, wherever the dungeon runs; ExitComplete after.
      try {
        await executor.leave(this.connection, { notifyClient: true });
      } catch (problem) {
        error(`[${this.connection.id}] exit teardown failed: ${problem.stack ?? problem}`);
        this.abandon(registry);
        this.connection.close?.("exit teardown failed");
        await cancelled?.done;
        return false;
      }
      this.connection.send(buildExitComplete(this.connection.matchMakerDoid));
      await cancelled?.done;
      return true;
    });
  }

  /** Out of the match and its world as far as this thread is concerned, after a teardown that did not finish. */
  abandon(registry) {
    const { connection } = this;
    try {
      registry.remove(connection);
    } catch (problem) {
      error(`[${connection.id}] could not leave the match registry: ${problem.stack ?? problem}`);
    }
    try {
      connection.world?.detachMember?.(connection);
    } catch (problem) {
      error(`[${connection.id}] could not leave the match world: ${problem.stack ?? problem}`);
    }
    connection.world = null;
  }

  /**
   * A door: from one floor to another node, as an ordinary entry.
   *
   * The destination is asked about before anything is left, so a door that
   * goes nowhere for this hero leaves them standing where they are. False when
   * the crossing did not happen, including when one is already under way —
   * a threshold is a place you can stand, and standing in it is not walking
   * through it twice.
   */
  async walkThrough(
    destination,
    {
      check = checkDestination,
      admit = admitEntry,
      join = (...args) => matchExecutor.join(...args),
      leave = (...args) => matchExecutor.leave(...args),
    } = {}
  ) {
    const node = Number(destination);
    if (!Number.isFinite(node) || node <= 0) return false;
    if (this.current) return false;
    const executor = { join, leave };
    return this.run("door", "checking", async (transition) => {
      let refusal;
      try {
        refusal = await check(this.connection, node);
      } catch (problem) {
        refusal = problem.message;
      }
      if (transition.cancelled) return false;
      if (refusal) {
        info(`[${this.connection.id}] door to ${node} refused before leaving: ${refusal}`);
        return false;
      }

      transition.phase = "leaving";
      await leave(this.connection, { notifyClient: true });
      if (transition.cancelled) return false;

      transition.phase = "admitting";
      const request = doorRequest(this.connection, node);
      let result;
      try {
        result = await admit(this.connection, request);
      } catch (problem) {
        if (transition.cancelled) return false;
        const refusal = refusalCodeOf(problem);
        if (refusal) warn(`[${this.connection.id}] refusing door to ${node} with ${refusal}: ${problem.message}`);
        else error(`[${this.connection.id}] door admission to ${node} failed: ${problem.stack ?? problem}`);
        try {
          // Admission may have failed after reserving or partially routing the
          // connection. A second leave is idempotent and clears either case.
          await leave(this.connection, { notifyClient: true });
        } catch (cleanupProblem) {
          error(`[${this.connection.id}] door admission cleanup failed: ${cleanupProblem.stack ?? cleanupProblem}`);
        }
        this.answer(refusal ?? ENTRY_ERROR.INTERNAL);
        return false;
      }
      if (transition.cancelled) {
        result.reservation?.abort();
        return false;
      }
      if (!result.match) {
        // Answered the way a refused map click is answered, so the client
        // shows the popup it already owns.
        const code = entryErrorCodeFor(result);
        info(`[${this.connection.id}] door to ${node} refused: ${result.error ?? "no match"}`);
        this.answer(code);
        return false;
      }
      const crossed = await this.load(transition, result, request, executor);
      if (crossed) info(`[${this.connection.id}] walked through to ${node}`);
      return crossed;
    });
  }

  /** The socket is gone: whatever was under way stops, and the run is let go. */
  disconnect({ executor = matchExecutor } = {}) {
    if (this.current) this.current.cancelled = true;
    // Called from socket close handlers, which have nothing above them to catch.
    const failed = (problem) => {
      error(`[${this.connection.id}] disconnect teardown failed: ${problem?.stack ?? problem}`);
      return false;
    };
    try {
      return Promise.resolve(executor.leave(this.connection)).catch(failed);
    } catch (problem) {
      return Promise.resolve(failed(problem));
    }
  }

  /**
   * From an admitted place to the run: the world built or joined, the owner
   * player's acceptance sent, the reservation used. On any failure the run is
   * torn down and the place given back; a cancelled transition does both
   * without a word, since the exit that cancelled it has answered.
   */
  async load(transition, result, request, executor) {
    const { reservation } = result;
    transition.phase = "loading";
    let accepted = false;
    try {
      await executor.join(this.connection, reservation ?? result, request, {
        onPlayerReady: () => {
          if (accepted || transition.cancelled) return;
          accepted = true;
          this.answer(0, result.match.mapNodeId);
        },
      });
      if (transition.cancelled) {
        // Finished after the exit had already torn it down: let it go quietly.
        await executor.leave(this.connection);
        reservation?.abort();
        return false;
      }
      if (!accepted) throw new Error(`match ${result.match.id} did not create the owner player`);
      reservation?.commit();
      rememberMatchMakerGroup(this.connection, result.match);
      return true;
    } catch (problem) {
      if (transition.cancelled) {
        info(`[${this.connection.id}] ${transition.kind} ended by the exit: ${problem.message}`);
        reservation?.abort();
        return false;
      }
      // Refused once the account was held — a hero switched since admission —
      // which the client has a sentence for.
      const refusal = refusalCodeOf(problem);
      if (refusal) warn(`[${this.connection.id}] refusing ${transition.kind} with ${refusal}: ${problem.message}`);
      else error(`[${this.connection.id}] ${transition.kind} failed: ${problem.stack ?? problem}`);
      // Awaited: with match workers the teardown frames arrive later, and the
      // refusal has to follow them rather than overtake them.
      await executor.leave(this.connection, { notifyClient: true });
      reservation?.abort();
      this.answer(refusal ?? ENTRY_ERROR.INTERNAL);
      return false;
    }
  }
}
