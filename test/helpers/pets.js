import { loadGameMaster } from "../../src/gamemaster.js";
import { equippedPetSpawn } from "../../src/pets.js";
import { experienceForLevel } from "../../src/progression.js";
import { loadNavigationLibrary } from "../../src/socket/navigation.js";
import { CLID, TEAM } from "../../src/socket/opcodes.js";

/**
 * A standalone floor session with one hero (102, at 1000,1000) who has the
 * pet row `npcId` equipped at `level`, and the context `spawnEquippedPet`
 * (dungeon.js) is given. No scenery unless the test hands it one.
 */
export const contextWithPet = async (level = 75, npcId = 3301) => {
  await loadNavigationLibrary();
  const gm = await loadGameMaster();
  const hero = gm.heroById.get(102);
  const avatar = {
    id: 7001,
    avatar_id: hero.Id,
    experience: experienceForLevel(gm, hero, level),
  };
  const account = {
    id: 9001,
    account_pets: [
      { id: 81, npc_id: npcId, equipped_hero: avatar.id, is_new: 0 },
    ],
  };
  const petSpawn = equippedPetSpawn(gm, account, avatar, hero);
  const sent = [];
  let nextDoid = 8000;
  const session = {
    id: 9,
    accountId: account.id,
    dungeonActive: true,
    dungeonEpoch: 1,
    floorDoid: 1002,
    heroDoid: avatar.id,
    heroPosition: { x: 1000, y: 1000 },
    petSpawn,
    objects: new Map([
      [1002, CLID.DistributedDungeonFloor],
      [avatar.id, CLID.HeroGameObject],
    ]),
    actors: new Map([
      [
        avatar.id,
        {
          hitPoints: 500,
          maxHitPoints: 500,
          collisionRadius: 26,
          position: { x: 1000, y: 1000 },
          team: TEAM.PLAYERS,
        },
      ],
    ]),
    sent,
    send: (frame) => sent.push(frame),
    allocateDoid(clid) {
      const doid = nextDoid++;
      this.objects.set(doid, clid);
      return doid;
    },
  };
  const context = {
    session,
    floorDoid: session.floorDoid,
    heroDoid: session.heroDoid,
    mapNodeId: 50002,
    gm,
    isActive: () => session.dungeonActive,
  };
  return { gm, hero, avatar, account, session, context, petSpawn };
};
