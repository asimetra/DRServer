/**
 * Who is allowed to do what, as a rank rather than a set of switches.
 *
 * A ladder rather than independent flags because that is how the permissions
 * actually fall out: everything a helper may do, an admin may do. Independent
 * bits would let you build a moderator who can grant items but not read a
 * position, which is not a configuration anybody wants and is one more thing to
 * get wrong.
 *
 * Adding a rank is one line here plus one `role:` on a command.
 */
export const ROLE = Object.freeze({
  PLAYER: 0,
  HELPER: 1,
  ADMIN: 2,
});

const NAMES = Object.freeze(
  Object.fromEntries(Object.entries(ROLE).map(([name, rank]) => [rank, name.toLowerCase()]))
);

export const roleName = (rank) => NAMES[rank] ?? String(rank);

export const roleFromName = (text) => {
  const wanted = String(text ?? "").trim().toUpperCase();
  return Object.hasOwn(ROLE, wanted) ? ROLE[wanted] : null;
};

/**
 * Where a rank is kept.
 *
 * `admin_flags` is a BIGINT that already exists on every account and whose bit
 * zero is the dungeon-entry override. Rather than add a column — this schema
 * has no migration runner, so a new column is a manual ALTER on every
 * deployment — the rank lives in its own byte, bits 8 through 15. The two never
 * collide and an operator setting one by hand cannot disturb the other.
 *
 *   admin_flags = 0x0200  ->  admin, no dungeon override
 *   admin_flags = 0x0201  ->  admin, with the override
 */
const ROLE_SHIFT = 8n;
const ROLE_MASK = 0xffn;

export const roleOf = (account) => {
  try {
    const flags = BigInt(account?.admin_flags ?? 0);
    if (flags < 0n) return ROLE.PLAYER;
    const rank = Number((flags >> ROLE_SHIFT) & ROLE_MASK);
    // An unknown rank is not a licence. A byte that says 7 on a server that
    // knows three ranks is a typo or a downgrade, and either way the safe
    // reading is the lowest one.
    return Object.values(ROLE).includes(rank) ? rank : ROLE.PLAYER;
  } catch {
    return ROLE.PLAYER;
  }
};

/** The same flags with a new rank in them, leaving every other bit alone. */
export const withRole = (adminFlags, rank) => {
  const flags = (() => {
    try {
      const value = BigInt(adminFlags ?? 0);
      return value < 0n ? 0n : value;
    } catch {
      return 0n;
    }
  })();
  return (flags & ~(ROLE_MASK << ROLE_SHIFT)) | (BigInt(rank) << ROLE_SHIFT);
};
