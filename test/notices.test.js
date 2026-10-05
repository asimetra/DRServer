import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createNoticeBoard, imageUrlFor, parseBook, rowsFor } from "../src/notices.js";

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse("2026-10-05T12:00:00Z");

const notice = (extra = {}) => ({ id: "n", headline: "Ranked is open", body: "Press JOIN.", ...extra });

test("a notice becomes the row the client draws, with the names it reads", () => {
  const book = parseBook({ notices: [notice({ image: "notices/ranked.png", action: "map", link: { name: "Board", url: "https://x/y" } })] });
  assert.deepEqual(rowsFor(book, { contentBaseUrl: "http://host:8080/content/" }), [
    {
      layout_type: "IMAGE_PORTRAIT",
      headline: "Ranked is open",
      body: "Press JOIN.",
      image_url: "http://host:8080/content/notices/ranked.png",
      game_action: "MAP",
      web_link_name: "Board",
      web_link_url: "https://x/y",
    },
  ]);
});

test("the defaults: portrait, a CLOSE button, no picture, no link", () => {
  const [row] = rowsFor(parseBook({ notices: [notice()] }));
  assert.deepEqual(
    [row.layout_type, row.game_action, row.image_url, row.web_link_name, row.web_link_url],
    ["IMAGE_PORTRAIT", "CLOSE", "", "", ""]
  );
  assert.equal(rowsFor(parseBook({ notices: [notice({ layout: "landscape" })] }))[0].layout_type, "IMAGE_LANDSCAPE");
});

test("a notice shows inside its window and for its networks only", () => {
  const book = parseBook({
    notices: [
      notice({ id: "a", from: "2026-10-01", until: "2026-10-10" }),
      notice({ id: "b", from: "2026-10-20" }),
      notice({ id: "c", until: "2026-10-05T11:00:00Z" }),
      notice({ id: "d", networks: [3] }),
      notice({ id: "e", networks: 1 }),
    ],
  });
  const shown = (at, networkId = 3) => rowsFor(book, { now: at, networkId }).map((r) => r.headline).length;
  assert.equal(shown(T0), 2, "a (in window) and d (network 3)");
  assert.equal(shown(T0 + 20 * DAY), 2, "b opened, a closed");
  assert.equal(shown(T0, 1), 2, "a and e for network 1");
  assert.equal(rowsFor(book, { now: T0, networkId: null }).length, 3, "no network named: every network's");
});

test("a picture is fetched by URL, so a path is made absolute at the content address", () => {
  assert.equal(imageUrlFor("https://cdn/x.png", "http://host/content"), "https://cdn/x.png");
  assert.equal(imageUrlFor("/notices/x.png", "http://host/content"), "http://host/content/notices/x.png");
  assert.equal(imageUrlFor("notices/x.png", ""), "", "no content address: no picture rather than a broken one");
  assert.equal(imageUrlFor("", "http://host/content"), "");
});

test("the book is checked whole, and says which row is wrong", () => {
  assert.throws(() => parseBook({ notices: [notice({ headline: "" })] }), /notice "n" has no headline/);
  assert.throws(() => parseBook({ notices: [notice({ layout: "MOVIE" })] }), /layout "MOVIE"/);
  assert.throws(() => parseBook({ notices: [notice({ action: "QUIT" })] }), /action "QUIT"/);
  assert.throws(() => parseBook({ notices: [notice({ link: { name: "x" } })] }), /link/);
  assert.throws(() => parseBook({ notices: [notice({ from: "soon" })] }), /from "soon" is not a date/);
  assert.throws(() => parseBook({ notices: [{ body: "b" }] }), /notice "#1" has no headline/);
  assert.throws(() => parseBook({ notices: {} }), /must be a list/);
  assert.deepEqual(parseBook({}), { notices: [] }, "a book with no notices is empty, not wrong");
});

test("the board re-reads the file when it changes, and keeps the last good book over a bad save", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dr-notices-"));
  const file = path.join(dir, "notices.json");
  let clock = T0;
  const board = createNoticeBoard(file, { checkEveryMs: 0, now: () => clock });
  try {
    assert.deepEqual(board.rows({ networkId: 3 }), [], "no file yet");

    fs.writeFileSync(file, JSON.stringify({ notices: [notice({ id: "one" })] }));
    fs.utimesSync(file, new Date(T0), new Date(T0));
    assert.equal(board.rows({ networkId: 3 }).length, 1);

    fs.writeFileSync(file, "{not json");
    fs.utimesSync(file, new Date(T0 + 1000), new Date(T0 + 1000));
    clock += 2000;
    assert.equal(board.rows({ networkId: 3 }).length, 1, "a bad save took the board down");

    fs.writeFileSync(file, JSON.stringify({ notices: [notice({ id: "one" }), notice({ id: "two" })] }));
    fs.utimesSync(file, new Date(T0 + 2000), new Date(T0 + 2000));
    clock += 2000;
    assert.equal(board.rows({ networkId: 3 }).length, 2);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("the shipped book parses, and ships empty", () => {
  const shipped = JSON.parse(fs.readFileSync(new URL("../config/notices.json", import.meta.url), "utf8"));
  assert.deepEqual(parseBook(shipped), { notices: [] });
  assert.doesNotThrow(() => parseBook({ notices: [shipped._example] }), "the example row is a valid notice");
});
