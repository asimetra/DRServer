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

-- account_chests and account_boosters are part of the payload but were empty in
-- every capture, so their row shape is unknown. They are left unmodelled rather
-- than invented; the API serves empty arrays until a capture shows otherwise.

-- Ids in the captures are server-assigned and unique per table. A shared
-- sequence keeps generated ids from colliding with any imported data.
-- 1,000,000..1,099,999 is reserved by the native client's LocalUniqueID.
-- Avatar instance ids become hero distributed-object ids, so account rows must
-- be allocated outside that range.
CREATE SEQUENCE IF NOT EXISTS account_object_id START 1200000000;
