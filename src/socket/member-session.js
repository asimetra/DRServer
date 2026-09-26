const MEMBER_SESSION = Symbol("member-session");

/**
 * Connection-owned state for one authenticated client.
 *
 * Gameplay shared by a party belongs to MatchState. This class intentionally
 * stays a small ownership marker while the legacy session fields are migrated;
 * existing socket closures can still attach their methods without a rewrite.
 */
export class MemberSession {
  constructor(initial = {}) {
    Object.defineProperty(this, MEMBER_SESSION, { value: true });
    Object.assign(this, initial);
  }
}

export const isMemberSession = (value) => Boolean(value?.[MEMBER_SESSION]);
