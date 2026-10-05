/**
 * The server's notice board: what the stock client shows on the way into town.
 *
 * The client asks `modrpc/getmod(networkId)` once per session, on its first
 * entry to town, and draws every row it gets as a popup — headline, body, a
 * picture, a button that opens a part of the game, and a link that opens the
 * browser — paging through them when there are several (`HomeState
 * .getWhatsNewRPC`, `UIWhatsNewPopup`). The live server answered with nothing,
 * so the channel sat unused; it is the most visible one the server has that
 * needs no content installed on the client, since the popup, its layouts and
 * its button labels (`WHATS_NEW_MAP` and the rest) ship with the game.
 *
 * What is shown is data, in `config/notices.json`, read again whenever the file
 * changes: an operator writes a notice and the next player into town sees it.
 * A notice has a window (`from`/`until`) so a season's note takes itself down.
 *
 * What the client reads of a row, and the names this server writes:
 *
 *   layout_type   "IMAGE_PORTRAIT" | "IMAGE_LANDSCAPE"   (`layout`: portrait | landscape)
 *   headline      drawn uppercased as the title           (`headline`)
 *   body          the text                                 (`body`)
 *   image_url     fetched as given, absolute URL           (`image`: a URL, or a path under /content)
 *   game_action   which button: MAP/BATTLE, SHOP/STORE, INVENTORY, TRAINING, GEMS, TAVERN, CLOSE
 *   web_link_name / web_link_url   a second button that opens the browser (`link: {name, url}`)
 *
 * The third client layout, MOVIE, plays a video through a player the web build
 * does not have, so a book may not ask for it. The image is loaded by URL with
 * no download root in front, which is why a path here is made absolute with
 * the server's own content address.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { info, warn, warnOnce } from "./log.js";

const LAYOUTS = Object.freeze({ portrait: "IMAGE_PORTRAIT", landscape: "IMAGE_LANDSCAPE" });
/** What the client's `getWhatsNewCallback` understands; anything else gives no button. */
export const ACTIONS = Object.freeze([
  "MAP", "BATTLE", "SHOP", "STORE", "INVENTORY", "TRAINING", "GEMS", "TAVERN", "CLOSE",
]);
const ABSOLUTE = /^https?:\/\//i;

const EMPTY = Object.freeze({ notices: [] });

const timeOf = (value, name, id) => {
  if (value === undefined || value === null || value === "") return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error(`notice "${id}": ${name} "${value}" is not a date`);
  return at;
};

const text = (value, name, id) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`notice "${id}" has no ${name}`);
  return value;
};

/** One notice, checked; throws with the field named so the book says which row. */
const parseNotice = (row, index) => {
  const id = typeof row?.id === "string" && row.id ? row.id : `#${index + 1}`;
  if (!row || typeof row !== "object") throw new Error(`notice ${id} is not an object`);
  const layout = LAYOUTS[row.layout ?? "portrait"];
  if (!layout) throw new Error(`notice "${id}": layout "${row.layout}" is not portrait or landscape`);
  const action = String(row.action ?? "CLOSE").toUpperCase();
  if (!ACTIONS.includes(action)) throw new Error(`notice "${id}": action "${row.action}" is not one the client has`);
  const link = row.link ?? null;
  if (link !== null && (typeof link !== "object" || !text(link.name, "link name", id) || !text(link.url, "link url", id))) {
    throw new Error(`notice "${id}": a link needs a name and a url`);
  }
  const networks = row.networks === undefined ? null : [].concat(row.networks).map(Number);
  if (networks?.some((n) => !Number.isFinite(n))) throw new Error(`notice "${id}": networks must be numbers`);
  return {
    id,
    layout,
    headline: text(row.headline, "headline", id),
    body: text(row.body, "body", id),
    image: typeof row.image === "string" ? row.image : "",
    action,
    link: link ? { name: link.name, url: link.url } : null,
    from: timeOf(row.from, "from", id),
    until: timeOf(row.until, "until", id),
    networks,
  };
};

/** The book, checked whole: one bad row and the file is not used. */
export const parseBook = (json) => {
  const rows = json?.notices;
  if (rows === undefined) return EMPTY;
  if (!Array.isArray(rows)) throw new Error("notices must be a list");
  return { notices: rows.map(parseNotice) };
};

/** A picture's address as the client will fetch it: absolute, or under this server's /content. */
export const imageUrlFor = (image, contentBaseUrl) => {
  if (!image) return "";
  if (ABSOLUTE.test(image)) return image;
  if (!contentBaseUrl) return "";
  return `${contentBaseUrl.replace(/\/+$/, "")}/${image.replace(/^\/+/, "")}`;
};

/** The rows the client draws, in the book's order, for one network at one moment. */
export const rowsFor = (book, { networkId = null, now = Date.now(), contentBaseUrl = "" } = {}) =>
  book.notices
    .filter((notice) => notice.from === null || now >= notice.from)
    .filter((notice) => notice.until === null || now < notice.until)
    .filter((notice) => notice.networks === null || networkId === null || notice.networks.includes(Number(networkId)))
    .map((notice) => ({
      layout_type: notice.layout,
      headline: notice.headline,
      body: notice.body,
      image_url: imageUrlFor(notice.image, contentBaseUrl),
      game_action: notice.action,
      web_link_name: notice.link?.name ?? "",
      web_link_url: notice.link?.url ?? "",
    }));

/**
 * The board over a file, re-read when the file changes. The stat is looked at
 * no more than once a second; a missing file is an empty board, said once.
 */
export const createNoticeBoard = (file, { checkEveryMs = 1000, now = Date.now } = {}) => {
  let book = EMPTY;
  let seen = null;
  let checkedAt = -Infinity;

  const refresh = () => {
    const at = now();
    if (at - checkedAt < checkEveryMs) return;
    checkedAt = at;
    let mtime;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      warnOnce(`notices:missing:${file}`, `notices: no book at ${file}; town shows none`);
      return;
    }
    if (mtime === seen) return;
    seen = mtime;
    try {
      book = parseBook(JSON.parse(fs.readFileSync(file, "utf8")));
      info(`notices: ${book.notices.length} notice(s) from ${file}`);
    } catch (problem) {
      warn(`notices: ${file} was not used (${problem.message}); keeping the last good book`);
    }
  };

  return {
    /** What `modrpc/getmod` answers. */
    rows({ networkId = null, at = now() } = {}) {
      refresh();
      return rowsFor(book, { networkId, now: at, contentBaseUrl: config.contentBaseUrl });
    },
    notices() {
      refresh();
      return book.notices;
    },
  };
};

const DEFAULT_FILE = fileURLToPath(new URL("../config/notices.json", import.meta.url));

/** The server's own board: `ODS_NOTICES_FILE`, or config/notices.json. */
export const noticeBoard = createNoticeBoard(process.env.ODS_NOTICES_FILE || DEFAULT_FILE);
