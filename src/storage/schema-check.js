/**
 * Whether the database this server is about to use is the one it was written
 * against.
 *
 * Twice a server has run against a database older than itself and said so only
 * when a query reached a column that was not there — "column is_new does not
 * exist", then "column tax does not exist". Each names a column and neither
 * says what to do about it, and the second arrived as a broken market page,
 * which is a long way from the schema.
 *
 * It happens because `docker-compose.yml` mounts `db/schema.sql` as an init
 * script: Postgres runs those once, when the data volume is created, and never
 * again. A database started before a column was added keeps its old shape
 * however many times it is restarted, and the schema file it is out of step
 * with is sitting in the repository unread.
 *
 * So the file is read and compared. It is the only description of the shape
 * there is, which also makes it the right one to compare against — a list kept
 * here would be a second copy to forget to update.
 */

/**
 * The tables and columns a schema file describes.
 *
 * Both forms count. A column added after the fact is added by an `ALTER`
 * rather than by editing the `CREATE`, so that databases which already exist
 * gain it, and the two together are what the code expects.
 */
export const schemaExpects = (sql) => {
  const expected = {};

  for (const [, name, body] of sql.matchAll(
    /CREATE TABLE IF NOT EXISTS (?:\w+\.)?(\w+)\s*\(([\s\S]*?)\n\);/g
  )) {
    expected[name] = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\w/.test(line))
      .map((line) => line.split(/\s+/)[0])
      // A table's own constraints are written like columns and are not columns.
      .filter((column) => !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|LIKE)$/i.test(column));
  }

  for (const [, table, column] of sql.matchAll(
    /ALTER TABLE (?:IF EXISTS )?(?:\w+\.)?(\w+) ADD COLUMN (?:IF NOT EXISTS )?(\w+)/g
  )) {
    if (!expected[table]) continue;
    if (!expected[table].includes(column)) expected[table].push(column);
  }

  return expected;
};

/**
 * What the database is missing, table by table, or an empty list.
 *
 * `missing: null` means the table itself is not there — a different thing to
 * be told from a table that is short a column, and a different thing to fix.
 * Columns the database has and the code does not are left alone: this asks
 * whether the code can run, not whether the two are identical.
 */
export const driftBetween = (expected, actual) => {
  const drift = [];
  for (const [table, columns] of Object.entries(expected)) {
    const present = actual[table];
    if (!present) {
      drift.push({ table, missing: null });
      continue;
    }
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length) drift.push({ table, missing });
  }
  return drift;
};

/**
 * The indexes a schema file creates, by name, with the table each is on.
 *
 * A column is not the only thing an old database can be short of. The table
 * of sold listings first carried a key; its next version replaced that with
 * two indexes, and a database made by the first version already had every
 * column — so it was called current, the file was never run, and startup then
 * dropped the old key with nothing in its place. Indexes are read and compared
 * for the same reason columns are.
 */
export const indexesExpected = (sql) => {
  const expected = {};
  for (const [, name, table] of sql.matchAll(
    /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON\s+(?:\w+\.)?(\w+)/g
  )) {
    expected[name] = table;
  }
  return expected;
};

/** The expected indexes the database lacks, as `{ index, table }`, or an empty list. */
export const missingIndexes = (expected, present) =>
  Object.entries(expected)
    .filter(([name]) => !present.has(name))
    .map(([index, table]) => ({ index, table }));

/**
 * Whether this file only ever adds, and so may be run without being read.
 *
 * A server applying its own schema is a convenience that rests entirely on
 * this being true: today the file is twelve `CREATE TABLE IF NOT EXISTS`,
 * fifteen indexes and four `ADD COLUMN IF NOT EXISTS`, and nothing that takes
 * anything away. The day a `DROP` is written into it, running it unattended
 * stops being a convenience and becomes a way to lose a table on a restart.
 *
 * So it is checked rather than remembered. Comments are stripped first, and
 * only the word that opens a statement counts — the schema's own prose says
 * "the tables the trade window used are dropped", and a rule that read that as
 * a `DROP` would refuse the file it is describing.
 */
export const isAdditiveOnly = (sql) => {
  const statements = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";");

  return statements.every((statement) => {
    const text = statement.trim();
    if (!text) return true;
    if (/^(DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(text)) return false;
    // An ALTER may add and may take away; only the adding kind passes.
    if (/^ALTER\b/i.test(text)) return /\bADD\s+(COLUMN|CONSTRAINT)\b/i.test(text);
    return true;
  });
};

/**
 * The schemas a connection's tables are looked for in when none are named: the
 * one it creates tables in, and the website's.
 *
 * That is `public` on every ordinary deployment, which is what this said
 * outright. Asked of the connection instead, a database reached through a
 * search path of its own — a test's scratch schema, an operator's — is checked
 * where its tables actually are, rather than found complete because some other
 * schema in the same database happens to be.
 */
const HERE = "(table_schema = current_schema() OR table_schema = 'web')";
const HERE_INDEXES = "(schemaname = current_schema() OR schemaname = 'web')";

/** The columns a live database actually has, in the shape `driftBetween` wants. */
export const columnsInDatabase = async (client, schemas = null) => {
  const { rows } = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE ${schemas ? "table_schema = ANY($1)" : HERE}`,
    schemas ? [schemas] : []
  );

  const actual = {};
  for (const row of rows) {
    (actual[row.table_name] ??= new Set()).add(row.column_name);
  }
  return actual;
};

/** The index names a live database has, in the shape `missingIndexes` wants. */
export const indexesInDatabase = async (client, schemas = null) => {
  const { rows } = await client.query(
    `SELECT indexname FROM pg_indexes WHERE ${schemas ? "schemaname = ANY($1)" : HERE_INDEXES}`,
    schemas ? [schemas] : []
  );
  return new Set(rows.map((row) => row.indexname));
};
