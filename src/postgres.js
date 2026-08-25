const { Pool } = require("pg");
const logger = require("./logger");

const BLOCKED_KEYWORDS = [
  "DELETE",
  "UPDATE",
  "INSERT",
  "DROP",
  "ALTER",
  "TRUNCATE",
];
const KEYWORD_PATTERN = new RegExp(
  `\\b(${BLOCKED_KEYWORDS.join("|")})\\b`,
  "i",
);

function assertQuerySafe(sql, blockWriteCommands) {
  if (!blockWriteCommands) return;

  const match = sql.match(KEYWORD_PATTERN);
  if (!match) return;

  logger.warn(
    `[Bridge] Rejected query, contains "${match[1]}": ${sql.slice(0, 200)}`,
  );
  throw new Error(
    `Query blocked: contains disallowed keyword "${match[1]}" (BLOCK_WRITE_COMMANDS is enabled)`,
  );
}

function createGuardedPool(pgConfig, blockWriteCommands) {
  const pool = new Pool({
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  const realQuery = pool.query.bind(pool);
  pool.query = (text, params) => {
    const sql = typeof text === "string" ? text : text.text;
    assertQuerySafe(sql, blockWriteCommands);
    return realQuery(text, params);
  };

  pool.on("error", (err) => {
    logger.error("[Bridge] Unexpected Postgres pool error: " + err.message);
  });

  return pool;
}

async function testConnection(pool) {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch (error) {
    logger.error("[Bridge] Postgres connection test failed: " + error.message);
    return false;
  }
}

module.exports = { createGuardedPool, testConnection, assertQuerySafe };
