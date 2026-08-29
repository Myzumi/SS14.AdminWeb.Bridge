const assert = require("assert");
const sentry = require("../src/sentry");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    failed++;
  }
}

console.log("Bridge crash reporting\n");

// ---------- DSN ----------

test("parses a DSN into an envelope endpoint", () => {
  const { endpoint, publicKey } = sentry.parseDsn(
    "https://abc123@bugsink.example.com/2",
  );
  assert.strictEqual(endpoint, "https://bugsink.example.com/api/2/envelope/");
  assert.strictEqual(publicKey, "abc123");
});

test("rejects a DSN with no project id", () => {
  assert.throws(() => sentry.parseDsn("https://abc123@bugsink.example.com/"));
});

test("rejects a DSN with no key", () => {
  assert.throws(() => sentry.parseDsn("https://bugsink.example.com/2"));
});

// ---------- Redaction ----------

const SECRETS = [
  [
    "connection string",
    "failed: postgres://ss14:hunter2@10.0.0.5:5432/ss14server",
    "hunter2",
  ],
  ["PG_PASSWORD", "PG_PASSWORD=supersecret rejected", "supersecret"],
  ["BRIDGE_TOKEN", "BRIDGE_TOKEN: abcdef123456", "abcdef123456"],
  ["api key", "api_key=zzz9999", "zzz9999"],
  ["a DSN itself", "SENTRY_DSN=https://key@host/1", "key@host"],
  ["spaced assignment", "password  =  spaced", "spaced"],
];

for (const [label, input, leak] of SECRETS) {
  test(`redacts ${label}`, () => {
    assert.ok(
      !sentry.redact(input).includes(leak),
      `leaked: ${sentry.redact(input)}`,
    );
  });
}

test("leaves ordinary messages untouched", () => {
  const message = "Query failed after 3 retries";
  assert.strictEqual(sentry.redact(message), message);
});

test("redaction tolerates non-strings", () => {
  assert.strictEqual(sentry.redact(undefined), undefined);
  assert.strictEqual(sentry.redact(42), 42);
});

// ---------- Stack parsing ----------

test("turns a stack into frames", () => {
  const frames = sentry.parseStack(new Error("boom").stack);
  assert.ok(frames.length > 0, "expected at least one frame");
  assert.strictEqual(typeof frames[0].lineno, "number");
  assert.ok(
    frames.some((f) => f.in_app === true),
    "expected an in-app frame",
  );
});

test("stack parsing survives a missing stack", () => {
  assert.deepStrictEqual(sentry.parseStack(undefined), []);
});

// ---------- Enable / refuse ----------

test("stays off unless BRIDGE_ENABLE_TELEMETRY is set", () => {
  delete process.env.BRIDGE_ENABLE_TELEMETRY;
  assert.strictEqual(sentry.init({ dsn: "https://k@h/1" }), false);
  assert.strictEqual(sentry.isEnabled(), false);
});

test("stays off when opted in but the server sends no DSN", () => {
  process.env.BRIDGE_ENABLE_TELEMETRY = "1";
  try {
    assert.strictEqual(sentry.init({}), false);
    assert.strictEqual(sentry.isEnabled(), false);
  } finally {
    delete process.env.BRIDGE_ENABLE_TELEMETRY;
  }
});

test("a malformed DSN disables reporting instead of throwing", () => {
  process.env.BRIDGE_ENABLE_TELEMETRY = "1";
  try {
    assert.strictEqual(sentry.init({ dsn: "not-a-url" }), false);
    assert.strictEqual(sentry.isEnabled(), false);
  } finally {
    delete process.env.BRIDGE_ENABLE_TELEMETRY;
  }
});

test("enables when opted in and a valid DSN arrives", () => {
  process.env.BRIDGE_ENABLE_TELEMETRY = "1";
  try {
    assert.strictEqual(
      sentry.init({
        dsn: "https://k@bugsink.example.com/2",
        serverId: "srv-1",
      }),
      true,
    );
    assert.strictEqual(sentry.isEnabled(), true);
  } finally {
    delete process.env.BRIDGE_ENABLE_TELEMETRY;
  }
});

test("captureException never throws", () => {
  sentry.captureException(new Error("test"));
  sentry.captureException("a string, not an Error");
  sentry.captureException(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
