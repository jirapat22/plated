import { test, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-idem-'));
const { initDb, getDb } = require_('../src/db.js');
const { replayOf, remember, isValidClientId, pruneIdempotency } =
  require_('../src/utils/idempotency.js');

let db, A, B;
before(() => {
  initDb();
  db = getDb();
  const mk = n => Number(db.prepare(
    "INSERT INTO profiles (name, pass_hash, pass_salt) VALUES ($n,'x','y')").run({ n }).lastInsertRowid);
  A = mk('A'); B = mk('B');
});

test('an unseen id is new; a seen one replays the exact status and body', () => {
  assert.strictEqual(replayOf(db, A, 'first-write-001'), null);
  remember(db, A, 'first-write-001', 201, { id: 7, logged_g: 100 });
  assert.deepStrictEqual(replayOf(db, A, 'first-write-001'),
    { status: 201, body: { id: 7, logged_g: 100 } });
});

test('the same id under a different profile is a different write', () => {
  remember(db, A, 'shared-id-xyz', 201, { weight: 75.5 });
  assert.strictEqual(replayOf(db, B, 'shared-id-xyz'), null,
    'B must not read back A stored response');
  remember(db, B, 'shared-id-xyz', 201, { weight: 62.1 });
  assert.deepStrictEqual(replayOf(db, A, 'shared-id-xyz').body, { weight: 75.5 });
  assert.deepStrictEqual(replayOf(db, B, 'shared-id-xyz').body, { weight: 62.1 });
});

test('the first answer wins — a second remember cannot overwrite it', () => {
  remember(db, A, 'race-id-0001', 201, { v: 'first' });
  remember(db, A, 'race-id-0001', 500, { v: 'second' });
  assert.deepStrictEqual(replayOf(db, A, 'race-id-0001'), { status: 201, body: { v: 'first' } });
});

test('no client_id means no replay protection, and never a crash', () => {
  assert.strictEqual(replayOf(db, A, null), null);
  assert.strictEqual(replayOf(db, A, undefined), null);
  assert.doesNotThrow(() => remember(db, A, null, 201, { a: 1 }));
});

test('only well-formed ids are accepted', () => {
  assert.ok(isValidClientId('abcd1234'));
  assert.ok(isValidClientId('a'.repeat(64)));
  assert.ok(isValidClientId('with-dash_and_underscore'));
  assert.ok(!isValidClientId('short'),           'under 8 chars');
  assert.ok(!isValidClientId('a'.repeat(65)),    'over 64 chars');
  assert.ok(!isValidClientId('has spaces!!'),    'non-alphanumeric');
  assert.ok(!isValidClientId(12345678),          'not a string');
  assert.ok(!isValidClientId(null));
});

test('a corrupt stored row is treated as new rather than throwing', () => {
  db.prepare(`INSERT INTO idempotency (client_id, profile_id, status, response)
              VALUES ('corrupt-row-1', $p, 201, '{not json')`).run({ p: A });
  assert.strictEqual(replayOf(db, A, 'corrupt-row-1'), null);
});

test('pruning drops old records and keeps recent ones', () => {
  db.prepare(`INSERT INTO idempotency (client_id, profile_id, status, response, created_at)
              VALUES ('ancient-id-01', $p, 201, '{}', datetime('now','-60 days'))`).run({ p: A });
  remember(db, A, 'recent-id-001', 201, { ok: true });
  pruneIdempotency(db);
  assert.strictEqual(replayOf(db, A, 'ancient-id-01'), null, 'old record pruned');
  assert.ok(replayOf(db, A, 'recent-id-001'), 'recent record kept');
});
