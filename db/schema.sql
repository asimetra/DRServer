-- Account storage for the private server.
--
-- Every table here is transcribed from a live capture of the official server's
-- GET /api/dbAccountInfo/accountdetails response, so the column names are the
-- ones the client already knows. They are deliberately *not* tidied up:
-- `requiredlevel` and `legendarymodifier` really are single lowercase words,
-- and renaming them would only mean translating on every read and write.
--
-- The mask of completed map nodes lives on the avatar, not the account — the
-- account-level column exists because the payload carries it, but the live
-- server sends null there and keeps progress per hero.

CREATE TABLE IF NOT EXISTS accounts (
    id                     BIGINT PRIMARY KEY,
    name                   TEXT        NOT NULL,
    campaign               TEXT        NOT NULL DEFAULT '',
    ancestor_campaign      TEXT,
    demographic            TEXT        NOT NULL DEFAULT '',
    trophies               INTEGER     NOT NULL DEFAULT 0,
    completed_mapnode_mask TEXT,
    basic_currency         BIGINT      NOT NULL DEFAULT 0,
    premium_currency       BIGINT      NOT NULL DEFAULT 0,
    basic_keys             INTEGER     NOT NULL DEFAULT 0,
    uncommon_keys          INTEGER     NOT NULL DEFAULT 0,
    rare_keys              INTEGER     NOT NULL DEFAULT 0,
    legendary_keys         INTEGER     NOT NULL DEFAULT 0,
    highest_avatar         INTEGER     NOT NULL DEFAULT 1,
    buckets_weapon         INTEGER     NOT NULL DEFAULT 50,
    buckets_other          INTEGER     NOT NULL DEFAULT 15,
    active_avatar          BIGINT,
    admin_flags            BIGINT      NOT NULL DEFAULT 0,
    account_flags          BIGINT      NOT NULL DEFAULT 0,
    completed_dungeons     INTEGER     NOT NULL DEFAULT 0,
    matchmaker_group       TEXT        NOT NULL DEFAULT 'gen',
    concurrent_days        INTEGER     NOT NULL DEFAULT 1,
    last_reward_date       TIMESTAMPTZ,
    last_login             TIMESTAMPTZ,
    created                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per hero the player owns. `avatar_id` is the GameMaster hero type
-- (101..106); `id` is the instance the rest of the schema points at.
CREATE TABLE IF NOT EXISTS account_avatars (
    id                     BIGINT PRIMARY KEY,
    account_id             BIGINT      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    avatar_id              INTEGER     NOT NULL,
    skin_type              INTEGER     NOT NULL,
    experience             BIGINT      NOT NULL DEFAULT 0,
    completed_mapnode_mask TEXT        NOT NULL DEFAULT '',
    statupgrade1           INTEGER     NOT NULL DEFAULT 0,
    statupgrade2           INTEGER     NOT NULL DEFAULT 0,
    statupgrade3           INTEGER     NOT NULL DEFAULT 0,
    statupgrade4           INTEGER     NOT NULL DEFAULT 0,
    consumable1_id         INTEGER     NOT NULL DEFAULT 0,
    consumable1_count      INTEGER     NOT NULL DEFAULT 0,
    consumable2_id         INTEGER     NOT NULL DEFAULT 0,
    consumable2_count      INTEGER     NOT NULL DEFAULT 0,
    created                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_avatars_account ON account_avatars(account_id);

-- Weapons and gear. Equipping is exactly this: set avatar_id and avatar_slot.
-- Both are null while an item sits in the bag, which is how the live server
-- distinguishes equipped from stored.
CREATE TABLE IF NOT EXISTS account_items (
    id                BIGINT PRIMARY KEY,
    account_id        BIGINT      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    item_id           INTEGER     NOT NULL,
    power             INTEGER     NOT NULL DEFAULT 0,
    avatar_id         BIGINT      REFERENCES account_avatars(id) ON DELETE SET NULL,
    avatar_slot       SMALLINT,
    is_new            SMALLINT    NOT NULL DEFAULT 0,
    requiredlevel     INTEGER     NOT NULL DEFAULT 1,
    rarity            SMALLINT    NOT NULL DEFAULT 1,
    modifier1         INTEGER     NOT NULL DEFAULT 0,
    modifier2         INTEGER     NOT NULL DEFAULT 0,
    legendarymodifier INTEGER     NOT NULL DEFAULT 0,
    created           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_items_account ON account_items(account_id);
CREATE INDEX IF NOT EXISTS account_items_equipped ON account_items(avatar_id) WHERE avatar_id IS NOT NULL;

-- Consumables and other countable goods; stack_id points at GameMaster Stackables.
CREATE TABLE IF NOT EXISTS account_stackables (
    id         BIGINT PRIMARY KEY,
    account_id BIGINT   NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stack_id   INTEGER  NOT NULL,
    count      INTEGER  NOT NULL DEFAULT 0,
    is_new     SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS account_stackables_account ON account_stackables(account_id);

CREATE TABLE IF NOT EXISTS account_pets (
    id            BIGINT PRIMARY KEY,
    account_id    BIGINT   NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    npc_id        INTEGER  NOT NULL,
    equipped_hero BIGINT   REFERENCES account_avatars(id) ON DELETE SET NULL,
    is_new        SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS account_pets_account ON account_pets(account_id);

CREATE TABLE IF NOT EXISTS account_skins (
    id         BIGINT PRIMARY KEY,
    account_id BIGINT  NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    skin_type  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS account_skins_account ON account_skins(account_id);

-- Not game state: this is where the client parks its own UI preferences, such
-- as "editUI_chatLogContainer_s" = "0.6". Free-form on purpose.
CREATE TABLE IF NOT EXISTS account_attributes (
    id         BIGINT PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name       TEXT   NOT NULL,
    value      TEXT   NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS account_attributes_account ON account_attributes(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_attributes_unique ON account_attributes(account_id, name);

-- Chests a player holds unopened. The shape is not inferred from captures: this
-- server writes these rows itself, in awardTreasureChest and tools/grant.js, and
-- account/OpenChest and DropChest read them back.
--
-- They were left unmodelled once, on the grounds that every capture showed the
-- list empty. That was a symptom rather than evidence — a bug dropped the chest
-- flag between the pickup and the account, so no chest ever reached one. The
-- captures themselves are mostly on treasure-bearing nodes.
--
-- is_new was left out once, on the reasoning that the client computes
-- ChestInfo.isNew by diffing against the list it last held. The captures say
-- otherwise: every chest row the official sends carries it, and every one of
-- them is 1.
CREATE TABLE IF NOT EXISTS account_chests (
    id         BIGINT   PRIMARY KEY,
    account_id BIGINT   NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    chest_id   INTEGER  NOT NULL,
    is_new     SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS account_chests_account ON account_chests(account_id);

-- account_boosters is still unmodelled, and for the original reason: nothing in
-- this server writes one, so there is no shape to store yet. The API serves an
-- empty array until something does.

-- Ids in the captures are server-assigned and unique per table. A shared
-- sequence keeps generated ids from colliding with any imported data.
-- 1,000,000..1,099,999 is reserved by the native client's LocalUniqueID.
-- Avatar instance ids become hero distributed-object ids, so account rows must
-- be allocated outside that range.
CREATE SEQUENCE IF NOT EXISTS account_object_id START 1200000000;

-- Finished runs, and the boards read off them.
--
-- Append-only: a row is written when the report screen is generated and never
-- updated. Measured at 1.7 minutes a run, so a hundred players at an hour a day
-- is about 3,500 rows and 170 MB a year — the history is cheap to keep and can
-- be trimmed or rolled up later without the boards noticing, because nothing
-- queries it to draw one.
--
-- No foreign key to accounts. A run is a record of something that happened, and
-- deleting an account should not rewrite history; it also keeps this table off
-- the account write path entirely.
CREATE TABLE IF NOT EXISTS dungeon_runs (
    id          BIGSERIAL PRIMARY KEY,
    account_id  BIGINT      NOT NULL,
    name        TEXT,
    trophies    INTEGER     NOT NULL DEFAULT 0,
    avatar_id   BIGINT,
    hero_id     INTEGER     NOT NULL,
    map_node_id INTEGER     NOT NULL,
    party_size  SMALLINT    NOT NULL DEFAULT 1,
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ NOT NULL,
    duration_ms INTEGER,
    success     BOOLEAN     NOT NULL,
    floors      SMALLINT    NOT NULL DEFAULT 1,
    kills       INTEGER     NOT NULL DEFAULT 0,
    damage      BIGINT      NOT NULL DEFAULT 0,
    gold        BIGINT      NOT NULL DEFAULT 0,
    xp          BIGINT      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS dungeon_runs_account ON dungeon_runs(account_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS dungeon_runs_node ON dungeon_runs(map_node_id, finished_at DESC);

-- One row per thing being ranked, replaced when beaten.
--
-- Bounded by players times boards rather than by play, which is what makes a
-- board a small indexed read instead of an aggregate over the history above.
-- `board_key` carries the whole scope — the metric, and for speedrun the node,
-- hero and party size — so a board is one equality and an ORDER BY.
CREATE TABLE IF NOT EXISTS dungeon_bests (
    board_key   TEXT        NOT NULL,
    account_id  BIGINT      NOT NULL,
    name        TEXT,
    trophies    INTEGER     NOT NULL DEFAULT 0,
    value       BIGINT      NOT NULL,
    achieved_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (board_key, account_id)
);

CREATE INDEX IF NOT EXISTS dungeon_bests_board ON dungeon_bests(board_key, value);
