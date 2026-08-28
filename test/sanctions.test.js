import test from "node:test";
import assert from "node:assert/strict";

import {
  DECAY_MS,
  DISPOSITION,
  LADDER_STEPS,
  PERSISTENT_SANCTIONS_READY,
  SESSION_STRIKES_PER_TERMINATION,
  STRIKE_WINDOW_MS,
  STRIKES_PER_STEP,
  dispositionFor,
  emptyRecord,
  ladderHours,
  recordSessionViolation,
  strike,
  suspensionRemaining,
} from "../src/sanctions.js";

const HOUR = 60 * 60 * 1000;
const at = 1_000_000_000;

test("persistent punishment stays disabled until account identity is verifiable", () => {
  assert.equal(PERSISTENT_SANCTIONS_READY, false);
});

test("rule disposition separates proof from suspicion and operations", () => {
  assert.equal(
    dispositionFor("movement.endpoint_off_tile"),
    DISPOSITION.REJECT_AND_TERMINATE_PATTERN,
    "zero-false-positive tile containment may end a repeated abusive session"
  );
  assert.equal(
    dispositionFor("movement.segment_crossed_geometry"),
    DISPOSITION.OBSERVE,
    "wall geometry still has honest disagreements"
  );
  assert.equal(
    dispositionFor("movement.step_too_large"),
    DISPOSITION.REJECT_AND_TERMINATE_PATTERN,
    "three impossible teleport steps may end this socket without touching the account"
  );
  assert.equal(
    dispositionFor("movement.budget_exceeded"),
    DISPOSITION.REJECT_ONLY,
    "compressed waypoint bursts are rejected without persistent blame"
  );
  assert.equal(
    dispositionFor("combat.out_of_reach"),
    DISPOSITION.OBSERVE,
    "reach remains evidence rather than punishment"
  );
  assert.equal(
    dispositionFor("session.malformed_frame"),
    DISPOSITION.OPERATIONAL_CLOSE,
    "malformed transport closes for availability, not as an account verdict"
  );
});

test("three deterministic violations of the same rule end only this session", () => {
  const session = {};
  for (let index = 1; index < SESSION_STRIKES_PER_TERMINATION; index++) {
    const result = recordSessionViolation(session, "movement.endpoint_off_tile", at + index);
    assert.equal(result.terminate, false);
    assert.equal(result.strikes, index);
  }
  const tipped = recordSessionViolation(
    session,
    "movement.endpoint_off_tile",
    at + SESSION_STRIKES_PER_TERMINATION
  );
  assert.equal(tipped.terminate, true);
  assert.match(tipped.reason, /movement\.endpoint_off_tile/);
});

test("different deterministic rules do not combine into a punishment", () => {
  const session = {};
  for (const rule of [
    "combat.forged_attacker",
    "combat.malformed_proposal",
    "movement.endpoint_off_tile",
  ]) {
    assert.equal(recordSessionViolation(session, rule, at).terminate, false);
  }
  assert.equal(session.securityStrikes.size, 3, "each rule keeps its own evidence");
});

test("heuristic findings never request termination however often they repeat", () => {
  const session = {};
  for (let index = 0; index < 100; index++) {
    assert.equal(
      recordSessionViolation(session, "movement.segment_crossed_geometry", at + index).terminate,
      false
    );
  }
  assert.equal(session.securityStrikes, undefined, "shadow evidence leaves no punishment state");
});

/**
 * A suspension here does not identify a cheater — this server cannot. What it
 * does is take away the account they built, because changing the id to escape
 * one drops them onto a fresh empty one. That is the cost, and it is why the
 * account is the anchor rather than the connection: a VPN changes an address in
 * a second and cannot restore a maxed character.
 */
test("three of a thing an honest client cannot send earns the first step", () => {
  let sheet = emptyRecord();
  for (let i = 1; i < STRIKES_PER_STEP; i++) {
    const result = strike(sheet, "combat.forged_attacker", at + i);
    sheet = result.record;
    assert.equal(result.suspended, false, `${i} is not a pattern`);
    assert.equal(suspensionRemaining(sheet, at + i), 0, "and costs nothing yet");
  }

  const tipped = strike(sheet, "combat.forged_attacker", at + STRIKES_PER_STEP);
  assert.equal(tipped.suspended, true, "the third is");
  assert.equal(tipped.hours, 2, "and the first step is the short one");
  assert.equal(suspensionRemaining(tipped.record, at + STRIKES_PER_STEP), 2 * HOUR);
});

/** Spread out, they are not a pattern. The window is what makes it one. */
test("strikes outside the window do not accumulate", () => {
  let sheet = emptyRecord();
  for (let i = 0; i < 10; i++) {
    const result = strike(sheet, "combat.forged_attacker", at + i * (STRIKE_WINDOW_MS + 1));
    sheet = result.record;
    assert.equal(result.suspended, false, "one every eleven minutes is not three in ten");
  }
});

/** And a rule that is not trusted to drop a packet cannot end a session. */
test("only rules with no honest traffic behind them count", () => {
  let sheet = emptyRecord();
  for (let i = 0; i < 20; i++) {
    // Reach still counts rather than refuses; its false-positive rate is not zero.
    sheet = strike(sheet, "combat.out_of_reach", at + i).record;
  }
  assert.equal(suspensionRemaining(sheet, at + 100), 0, "counting is not sanctioning");
  assert.deepEqual(sheet, emptyRecord(), "and it leaves no mark");
});

/**
 * It keeps doubling rather than stopping somewhere modest, because each rung
 * costs three more violations of something an unmodified client cannot send. A
 * year is the cap because a permanent decision should be a person's.
 */
test("the ladder doubles all the way to a year", () => {
  let sheet = emptyRecord();
  const served = [];
  for (let step = 0; step < LADDER_STEPS + 2; step++) {
    // Each offence is its own three, the moment the last suspension lifts —
    // which is the only way anybody climbs, since clean time walks it back.
    const when = Math.max(at, sheet.until ?? 0) + 1;
    let result;
    for (let i = 0; i < STRIKES_PER_STEP; i++) {
      result = strike(sheet, "combat.malformed_proposal", when + i);
      sheet = result.record;
    }
    served.push(result.hours);
  }

  assert.deepEqual(served.slice(0, 5), [2, 4, 8, 16, 32], "two hours, doubling");
  assert.equal(served[served.length - 1], 365 * 24, "and a year at the top");
  assert.equal(ladderHours(LADDER_STEPS + 10), 365 * 24, "which it does not pass");

  // Getting there is the point: it is not somewhere anybody arrives by accident.
  assert.ok(LADDER_STEPS >= 14, `${LADDER_STEPS} rungs to the top`);
  assert.ok(
    LADDER_STEPS * STRIKES_PER_STEP >= 42,
    "and forty-two violations an honest client cannot produce"
  );
});

/**
 * Without decay the ladder only ever rises, so somebody caught once a year ago
 * starts their next mistake at the top. Counted from the last strike rather
 * than from the suspension: serving the time is not what earns it back.
 */
test("staying out of trouble walks it back down", () => {
  let sheet = emptyRecord();
  for (let i = 0; i < STRIKES_PER_STEP; i++) {
    sheet = strike(sheet, "combat.malformed_proposal", at + i).record;
  }
  assert.equal(sheet.step, 1);

  // Two clean periods after release, and the next offence starts from the
  // bottom again — the clock runs from when they could have done it, not from
  // when they did.
  const later = sheet.until + 2 * DECAY_MS + HOUR;
  let result;
  for (let i = 0; i < STRIKES_PER_STEP; i++) {
    result = strike(sheet, "combat.malformed_proposal", later + i);
    sheet = result.record;
  }
  assert.equal(result.hours, 2, "back to the short step");
});
