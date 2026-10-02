# Content packs: custom skins, summons and attack effects

A content pack is content some players have installed and others have not: a
custom skin, the look of the summons a hero in that skin calls up, and the
effects of the attacks that hero swings. This server lets players with and
without a pack play together without either client changing, and without the
player without it crashing.

The code is `src/content-packs.js`; this page is how it works and how to add to
it.

## Why it is needed

The C++ client takes every skin, NPC, weapon and attack id it is sent and looks
it up in its own `Resources/Levels/DB_GameMaster.json`. Tested against the real
client:

| The client is told about… | …and its GameMaster | Result |
|---|---|---|
| a hero in a skin | lacks the `Skins` row | **segfault** in `HeroGameObject.set_skinType` — its own fall-back to the hero's default skin reads the hero row before the object has one |
| a friend wearing a skin | lacks the row | **segfault** drawing the friend list icon |
| its own account wearing a skin | lacks the row | **segfault** about a second after login |
| a hero in a skin | has the row, but not the skin's `lib/` bundles | no crash; the loads fail through `handleIOError` and nothing is drawn |

So an id is only safe to send to a client whose GameMaster has it, and the
server cannot see the client's GameMaster. It has to be told.

## How it works

**The client says what it has.** A pack's installer writes, alongside the
pack's rows and bundles, one line into the client's
`DbConfiguration/Config.json`:

```json
"Demographics": { "contentPacks": ["my-pack@1"] }
```

The client forwards its `Demographics` object unread — no client change — with
every dungeon entry request (`MatchMaker.hx:81`) and with
`AskAboutDailyReward`, `getFriendData` and `PurchaseOffer`. A client without the
line sends `{}`, which says it has no packs. That is the same idea as Forge's
mod list and Polymer's handshake in Minecraft.

**The server keeps the game's own content and tells each client its part.**
The game state never changes: a hero in a pack's skin holds the base weapon and
swings the base attacks, and every hit is priced, timed and audited as the base
attack. Only what each client is told differs, chosen where a frame is sent:

| Content | Told to a client with the pack | Told to a client without it |
|---|---|---|
| a pack skin | the skin | the hero's default skin |
| a summon `<npc>__<skin>` | the variant | the base `<npc>` |
| the weapon of a hero in the skin, when `<weapon>__<skin>` exists | the variant | the base weapon |
| that hero's attack, when `<attack>__<skin>` exists | the variant | the base attack |

The client then looks up the id it was told in its own files and draws what it
finds. A client with the pack plays the skin's timeline and effects; a client
without it is never told an id it does not have. The server never sends an
effect or an animation, only which id to name.

Incoming, a client with the pack swings the variant attacks. The server reads
the attack id out of the choreography and the combat results and replaces it
with the base before anything else sees it, so the rest of the server has one
of each attack.

This covers dungeons (heroes, summons, relayed attacks, the report screen) and
HTTP (friend lists, requests, boards, the account's own details).

**Across launches.** The first thing a launching client asks for is its own
account, before any request that carries its declaration, and a client without
a pack does not survive its own account naming the pack's skin. So each
account's last declaration is kept, in `<dataDir>/content-declarations.json` or
on PostgreSQL in the database, and answers that first request. A launch that asks for its account again without
having declared anything in between is taken to have crashed on that guess, and
gets the game's own content until it declares again. A wrong guess costs one
crash, never a loop of them.

## Adding a pack

1. **Client files** — the preprocessed bundles in the client's `lib/` folder,
   one per `.swf` the pack adds. The C++ client reads art only from these.
2. **GameMaster rows** — the same rows in the server's
   `content/Resources/Levels/DB_GameMaster.json` and in the client's own copy.
3. **Timelines** — for attack effects, the variant timelines in the client's
   `Resources/Combat/AttackTimeline.json`.
4. **The declaration line** in the client's `Config.json`, as above.
5. **The server's pack list**, `config/content-packs.json` (or
   `ODS_CONTENT_PACKS`), local to the deployment like `content/`:
   ```json
   {
     "packs": {
       "my-pack": { "version": 2, "skins": ["MY_SKIN", { "constant": "MY_SKIN_2", "since": 2 }] }
     }
   }
   ```
   A skin added in a later version lists `since`; a client declaring an older
   version is not told about it.
6. **Restart the server.** It logs what it withholds, and why it refused
   anything:
   ```
   content packs: my-pack@2 — 2 skin(s), 1 summon, 1 weapon and 1 attack variant(s) withheld …
   ```

A skin listed in no pack is sent to every client as it is. List every skin a
deployment adds.

### A skin

A `Skins` row with a new `Id`, its `ForHero`, and its own `AssetClassName`,
`SwfFilepath`, `PortraitName`, `IconSwfFilepath`, `UISwfFilepath`, `IconName`
and `CardName`. To sell it, an `Offers` row (`Tab: "SKIN"`,
`Location: "STORE"`) and an `OfferDetails` row carrying its `SkinId`.

The hero's own attack animations are already per skin. The client loads the
hero holding a weapon from `<skin SwfFilepath minus .swf>_<weapon ModelName>.swf`
(`WeaponRenderer.hx`), so the skin's bundles include one per weapon model the
hero can hold, and those frames can look however the skin wants.

### A skin's summons

An `Npc` row named `<summon>__<skin Constant>`, for example
`GHOST_SAMURAI_CLONE__MY_SKIN`. Heroes wearing the skin summon it instead of
the timeline's NPC (`summonForSkin`).

### A skin's attack effects

Effects are not per skin in the client: it picks them by attack, and only the
official Dark Mage skin has hard-coded overrides. But the client picks its
attacks from the weapon it is told a hero holds, so a skin gets its own effects
through a variant of the weapon:

- a `WeaponItem` row `<weapon>__<skin Constant>` whose `Attack1…9`,
  `ChargeAttack` and `HoldingAttack` each name the base weapon's attack or that
  attack's `<attack>__<skin Constant>` variant;
- a copy of every `WeaponAesthetics` row of the base weapon, with
  `WeaponItemConstant` set to the variant; the client finds the weapon's model
  through these;
- the `Attack` variants, pointing `AttackTimeline` at a variant timeline;
- the variant timelines in the client's `AttackTimeline.json`: the base
  timeline frame for frame, with only the `attackEffect` actions' `path` and
  `name` changed. An effect may come from any `.swf` the pack ships;
  `db_fx_library.swf` stays as it is;
- the same variant timelines in the server's
  `content/Resources/Combat/AttackTimeline.json`, which holds only the pack's
  timelines, `{ "attacks": [ … ] }`. The server reads it to check them (below).

## What the server refuses

A variant may only change how something looks. At startup, a variant whose
other columns differ from its base is refused with a warning and never used.
Otherwise it would be one monster, weapon or attack to one client and another
to the next.

| Table | May differ from the base |
|---|---|
| `Npc` | `Id`, `Constant`, `Name`, `Description`, `AssetClassName`, `SwfFilepath`, `HDSwfFilepath`, `IconSwfFilepath`, `IconName`, `PortraitName`, `CardName`, `UISwfFilepath` |
| `Attack` | `Id`, `Constant`, `Name`, `Description`, `AttackTimeline`, `SwordTrail`, `SwordTrailSize`, `TrailTint`, `TrailSaturation`, `HitEffect`, `HitEffectFilepath`, `HitEffectNoRotation`, `AttackVol`, `AttackSound`, `ImpactVol`, `ImpactSound`, `IconName`, `IconFilepath` |
| `WeaponItem` | `Id`, `Constant`, `Name`, `Description`, the tap/hold icons, titles and help text, `SpeedDisplay`, and its attacks as described above |

Also refused:

- a skin whose hero has no default skin to stand in for it;
- a variant whose `<skin>` is in no pack;
- a weapon variant short of `WeaponAesthetics` rows;
- an attack variant whose timeline the server does not have, or whose timeline
  plays differently from its base's. The server times every hit from the base,
  but a hero's hits arrive as the client's own proposals, so a wider, earlier
  or extra collider in the variant would hit what the base cannot. The two are
  compared frame by frame on everything but the looks: `totalFrames`,
  `choreographed`, and every action other than animation, effects, sound,
  shake, colour, zoom and visibility. A projectile may change only what it is
  drawn with.

A pack's timeline file adds names; it never replaces a timeline the game
ships. A row named after a shipped one is ignored, with a warning when it
differs.

## Verified with the real client

These were run against the C++ client with a test server, protocol bots and
copies of the client:

- **Crashes, before this code:**
  - a client lacking a skin's rows crashed on a hero, a friend and its own
    account wearing it;
  - with this code, the same clients stayed up.
- **Skins across clients:**
  - a client with the pack saw the skin;
  - a client without it saw the hero's default, in the dungeon and in the
    friend list.
- **Attack effects:**
  - with a samurai skin's katana and combo variant, a client with the pack
    loaded the variant's effect library as soon as the skinned hero swung, and
    the skinned player saw it on their own swings;
  - a client without the pack was told the base weapon and attack, loaded
    nothing new and did not crash;
  - a plain samurai beside the skinned one stayed plain for everybody.
- **Mixed pack and non-pack clients:** both played together in one dungeon,
  and each client's own socket log showed it was told only the ids it has.
- **The owner's client** accepted being told it holds the variant weapon while
  its inventory lists the base one.

## Limits

- The first launch of an account before the server has ever heard its
  declaration shows its own pack skin as the default once, until the client
  declares. The store refuses to sell an owned skin again, so nothing is
  charged for trying.
- Gift lists do not yet translate pack offer ids.
- A hit's impact effect (`HitEffect`) comes from the base attack for everybody;
  only the timeline's effects are per skin.

## Tests

- `test/content-packs.test.js`: the registry, declarations, projection of
  frames and HTTP answers, weapon and attack variants, launches.
- `test/content-packs-worker.test.js`: the same through a real match worker
  thread.
- `test/skin-summons.test.js`: summon variants.
