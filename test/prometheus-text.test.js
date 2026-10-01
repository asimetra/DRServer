import assert from "node:assert/strict";
import test from "node:test";

import { prometheusText } from "../src/prometheus-text.js";

/**
 * The same numbers the status route gives, in the one format every monitoring
 * tool reads. The server does not keep history, draw graphs or send alerts;
 * it says what is true now, in a form something else can collect.
 */
test("a metric is its help, its type and its samples", () => {
  const text = prometheusText([
    { name: "ods_players_online", help: "Players connected.", type: "gauge", value: 7 },
    {
      name: "ods_saves_failed_total",
      help: "Dungeon saves that did not reach storage.",
      type: "counter",
      value: 2,
    },
  ]);
  assert.equal(
    text,
    [
      "# HELP ods_players_online Players connected.",
      "# TYPE ods_players_online gauge",
      "ods_players_online 7",
      "# HELP ods_saves_failed_total Dungeon saves that did not reach storage.",
      "# TYPE ods_saves_failed_total counter",
      "ods_saves_failed_total 2",
      "",
    ].join("\n")
  );
});

test("one metric can carry a sample per label", () => {
  const text = prometheusText([
    {
      name: "ods_health_check",
      help: "1 when the check passes.",
      type: "gauge",
      samples: [
        { labels: { check: "web" }, value: 1 },
        { labels: { check: "storage" }, value: 0 },
      ],
    },
  ]);
  assert.match(text, /^ods_health_check\{check="web"\} 1$/m);
  assert.match(text, /^ods_health_check\{check="storage"\} 0$/m);
  assert.equal(text.match(/# TYPE/g).length, 1, "declared once, however many samples");
});

test("a label value is escaped, so a version string cannot break the line", () => {
  const text = prometheusText([
    {
      name: "ods_build_info",
      help: "What is running.",
      type: "gauge",
      samples: [{ labels: { version: 'a"b\\c\nd' }, value: 1 }],
    },
  ]);
  assert.match(text, /ods_build_info\{version="a\\"b\\\\c\\nd"\} 1/);
});

test("a value that is not a number is left out rather than written as one", () => {
  const text = prometheusText([
    { name: "ods_a", help: "a", type: "gauge", value: Number.NaN },
    { name: "ods_b", help: "b", type: "gauge", value: undefined },
    { name: "ods_c", help: "c", type: "gauge", value: 0 },
    { name: "ods_d", help: "d", type: "gauge", samples: [] },
  ]);
  assert.doesNotMatch(text, /ods_a|ods_b|ods_d/);
  assert.match(text, /^ods_c 0$/m);
});
