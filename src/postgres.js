const { Pool } = require("pg");
const logger = require("./logger");

const BLOCKED_KEYWORDS = [
  "DELETE",
  "UPDATE",
  "INSERT",
  "DROP",
  "ALTER",
  "TRUNCATE",
  "COPY",
  "GRANT",
  "REVOKE",
  "CREATE",
  "INTO",
];
const KEYWORD_PATTERN = new RegExp(
  `\\b(${BLOCKED_KEYWORDS.join("|")})\\b`,
  "i",
);

const BLOCKED_FUNCTIONS = [
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_ls_archive_statusdir",
  "lo_import",
  "lo_export",
  "lo_from_bytea",
  "lo_put",
  "lo_unlink",
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_promote",
  "set_config",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_advisory_lock",
  "pg_advisory_xact_lock",
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "cursor_to_xml",
];
const FUNCTION_PATTERN = new RegExp(
  `\\b(${BLOCKED_FUNCTIONS.join("|")})\\s*\\(`,
  "i",
);

function stripSql(sql) {
  return String(sql ?? "")
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function reject(reason, sql) {
  logger.warn(`[Bridge] Rejected query (${reason}): ${String(sql).slice(0, 200)}`);
  throw new Error(
    `Query blocked: ${reason} (BLOCK_WRITE_COMMANDS is enabled)`,
  );
}

function assertQuerySafe(sql, blockWriteCommands) {
  if (!blockWriteCommands) return;

  const code = stripSql(sql);
  const statements = code.split(";").filter((part) => part.trim() !== "");
  if (statements.length !== 1) {
    reject(statements.length ? "only one statement allowed" : "empty query", sql);
  }

  const first = code.trim().match(/^\(*\s*([A-Za-z]+)/);
  const keyword = first ? first[1].toUpperCase() : "";
  if (keyword !== "SELECT" && keyword !== "WITH") {
    reject(`only SELECT and WITH are allowed, got ${keyword || "nothing"}`, sql);
  }

  const blocked = code.match(KEYWORD_PATTERN);
  if (blocked) reject(`contains disallowed keyword "${blocked[1].toUpperCase()}"`, sql);

  const fn = code.match(FUNCTION_PATTERN);
  if (fn) reject(`calls disallowed function "${fn[1]}"`, sql);
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
    ...(blockWriteCommands
      ? { options: "-c default_transaction_read_only=on" }
      : {}),
  });

  pool.on("error", (err) => {
    logger.error("[Bridge] Unexpected Postgres pool error: " + err.message);
  });

  if (!blockWriteCommands) return pool;

  pool.query = async (text, params) => {
    const sql = typeof text === "string" ? text : text?.text;
    assertQuerySafe(sql, true);
    const timeoutMs = Math.floor(Number(text?.timeoutMs) || 0);

    const client = await pool.connect();
    try {
      if (client.timeoutMs !== timeoutMs) {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
        client.timeoutMs = timeoutMs;
      }
      return await client.query({
        text: sql,
        values: params ?? [],
        queryMode: "extended", // no multiple statements
      });
    } finally {
      client.release();
    }
  };

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

async function checkRole(pool) {
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
      );
      if (rows[0]?.rolsuper) {
        logger.warn(
          "[Bridge] PG_USER is a superuser, consider a read-only role instead (see README)",
        );
      }
    } finally {
      client.release();
    }
  } catch (error) {
    logger.warn("[Bridge] Could not check the Postgres role: " + error.message);
  }
}

module.exports = { createGuardedPool, testConnection, assertQuerySafe, checkRole };
