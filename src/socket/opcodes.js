/**
 * Message codes from networkCode/DcSocket.hx. Names kept identical to the
 * client's constants so the two sides can be grepped together.
 */
export const OP = {
  CLIENT_HEART_BEAT: 52,
  CLIENT_LOGIN_DUNGEONBUSTER: 118,
  CLIENT_OBJECT_UPDATE_FIELD: 124,
  CLIENT_OBJECT_DISABLE_RESP: 125,
  CLIENT_OBJECT_DISABLE_OWNER_RESP: 126,
  CLIENT_OBJECT_DELETE_RESP: 127,
  CLIENT_CREATE_OBJECT_REQUIRED_RESP: 134,
  CLIENT_CREATE_OBJECT_REQUIRED_OTHER_RESP: 135,
  CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP: 136,
  CLIENT_LOGOUT: 137,
  CLIENT_LOGOUT_RESP: 140,
  CLIENT_INTEREST_CONTEXT: 148,
};

export const opcodeName = (code) =>
  Object.keys(OP).find((key) => OP[key] === code) ?? `UNKNOWN(${code})`;

/** Class ids from generatedCode/GeneratedDcSocket.hx. */
export const CLID = {
  DistributedDistrict: 19,
  ObjectServer: 23,
  StatAccumulator: 25,
  AreaManager: 26,
  DistributedNPCGameObject: 27,
  HeroGameObject: 28,
  PlayerGameObject: 29,
  PresenceManager: 30,
  DistributedDungeonFloor: 32,
  DistributedTownFloor: 33,
  DistributedDungionArea: 36,
  DistributedDungeonSummary: 38,
  DistributedTownArea: 39,
  DistributedDooberGameObject: 40,
  DistributedBuffGameObject: 41,
  MatchMaker: 42,
};

/**
 * Schema hash the client sends at login (GeneratedDcSocket.DcHash). It pins the
 * generated protocol definition; a mismatch means client and server were built
 * from different .dc files.
 */
export const DC_HASH = 1351928210;

/**
 * Teams, from DBGlobal. These are not cosmetic: collision is a Box2D category
 * mask derived from the team, and DBGlobal.b2dMaskForTeam only accepts
 * 1, 5, 6 and 7. Anything else logs "Unable to determine box2D team mask" and
 * yields mask 0 — an actor that passes through walls and everything else.
 */
export const TEAM = {
  ENVIRONMENT: 1,
  PLAYERS: 5,
  ENEMIES: 6,
  THIRD: 7,
};
