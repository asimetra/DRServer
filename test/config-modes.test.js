import test from "node:test";
import assert from "node:assert/strict";

import { loadServerConfig } from "../src/config.js";

/**
 * Three rules, three switches, and one rule about which variable wins.
 *
 * `DR_CAST_MODE=enfore` alongside a legacy `DR_REQUIRE_CAST=1` used to fall
 * through to `enforce`, so a typo left enforcement on while its author believed
 * they had just changed it. Someone reaching for the new name is making a
 * decision about that rule; a misspelling should cost them the rule.
 */
test("the named mode decides when it is there, and the old flag when it is not", () => {
  const of = (environment) => loadServerConfig(environment);

  assert.equal(of({}).castMode, "off", "nothing set is off");
  assert.equal(of({ DR_CAST_MODE: "audit" }).castMode, "audit");
  assert.equal(of({ DR_CAST_MODE: "ENFORCE" }).castMode, "enforce", "case does not matter");
  assert.equal(of({ ODS_CAST_MODE: "audit" }).castMode, "audit");

  // The old names still work for a deployment that already sets them.
  assert.equal(of({ DR_REQUIRE_CAST: "1" }).castMode, "enforce");
  assert.equal(of({ DR_REQUIRE_CAST: "1" }).placementMode, "enforce", "both shared that flag");
  assert.equal(of({ DR_ENFORCE_REACH: "1" }).reachMode, "enforce");

  // And the named one wins, spelled right or not.
  assert.equal(of({ DR_CAST_MODE: "off", DR_REQUIRE_CAST: "1" }).castMode, "off");
  assert.equal(
    of({ ODS_CAST_MODE: "audit", DR_CAST_MODE: "enforce" }).castMode,
    "audit",
    "the public prefix wins over its legacy alias"
  );
  assert.equal(
    of({ DR_CAST_MODE: "enfore", DR_REQUIRE_CAST: "1" }).castMode,
    "off",
    "a typo costs the rule rather than keeping the old answer"
  );

  // Set to nothing is a decision about that rule, not a fall-through.
  assert.equal(of({ DR_CAST_MODE: "", DR_REQUIRE_CAST: "1" }).castMode, "off");

  /**
   * Reach is on unless it is turned off. It only ever drops the one hit, and
   * across 14479 of the official's hit claims and 4689 of this server's own
   * not one landed beyond the bound — while with it off, a client that claims
   * a hit on every monster on the floor from where it stands kills all of them.
   */
  assert.equal(of({}).reachMode, "enforce", "nothing set is enforcing");
  assert.equal(of({ ODS_REACH_MODE: "off" }).reachMode, "off", "and it can be stood down");
  assert.equal(of({ ODS_REACH_MODE: "audit" }).reachMode, "audit");
  assert.equal(of({ ODS_REACH_MODE: "enfore" }).reachMode, "off", "a typo still costs the rule");

  // They are separate switches now: one may enforce while another audits.
  const split = of({ DR_PLACEMENT_MODE: "enforce", DR_CAST_MODE: "audit" });
  assert.equal(split.placementMode, "enforce");
  assert.equal(split.castMode, "audit");
});
