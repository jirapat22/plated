import { test, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-idem-'));
const { initDb, getDb } = require_('../src/db.js');
const TAG = 'entry-add';   // one route's tag; cross-route isolation has its own test below
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
  assert.strictEqual(replayOf(db, A, 'first-write-001', TAG), null);
  remember(db, A, 'first-write-001', TAG, 201, { id: 7, logged_g: 100 });
  assert.deepStrictEqual(replayOf(db, A, 'first-write-001', TAG),
    { status: 201, body: { id: 7, logged_g: 100 } });
});

test('the same id under a different profile is a different write', () => {
  remember(db, A, 'shared-id-xyz', TAG, 201, { weight: 75.5 });
  assert.strictEqual(replayOf(db, B, 'shared-id-xyz', TAG), null,
    'B must not read back A stored response');
  remember(db, B, 'shared-id-xyz', TAG, 201, { weight: 62.1 });
  assert.deepStrictEqual(replayOf(db, A, 'shared-id-xyz', TAG).body, { weight: 75.5 });
  assert.deepStrictEqual(replayOf(db, B, 'shared-id-xyz', TAG).body, { weight: 62.1 });
});

test('the first answer wins — a second remember cannot overwrite it', () => {
  remember(db, A, 'race-id-0001', TAG, 201, { v: 'first' });
  remember(db, A, 'race-id-0001', TAG, 500, { v: 'second' });
  assert.deepStrictEqual(replayOf(db, A, 'race-id-0001', TAG), { status: 201, body: { v: 'first' } });
});

test('no client_id means no replay protection, and never a crash', () => {
  assert.strictEqual(replayOf(db, A, null, TAG), null);
  assert.strictEqual(replayOf(db, A, undefined, TAG), null);
  assert.doesNotThrow(() => remember(db, A, null, TAG, 201, { a: 1 }));
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
  // Stored under the real key shape (route tag + id), since that is what
  // replayOf looks up.
  db.prepare(`INSERT INTO idempotency (client_id, profile_id, status, response)
              VALUES ($c, $p, 201, '{not json')`).run({ c: `${TAG}:corrupt-row-1`, p: A });
  assert.strictEqual(replayOf(db, A, 'corrupt-row-1', TAG), null);
});

test('pruning drops old records and keeps recent ones', () => {
  db.prepare(`INSERT INTO idempotency (client_id, profile_id, status, response, created_at)
              VALUES ($c, $p, 201, '{}', datetime('now','-60 days'))`).run({ c: `${TAG}:ancient-id-01`, p: A });
  remember(db, A, 'recent-id-001', TAG, 201, { ok: true });
  pruneIdempotency(db);
  assert.strictEqual(replayOf(db, A, 'ancient-id-01', TAG), null, 'old record pruned');
  assert.ok(replayOf(db, A, 'recent-id-001', TAG), 'recent record kept');
});

// One id, five routes. The key used to be the id alone and every route reads
// the same table, so an id spent on one route answered for all of them — a
// meal_entry replayed as a batch portion's response, which the batch sheet
// reads for `logged_g`/`remaining_g` and would report as a successful portion
// that never happened. Reproduced across five live routes before this.
test('an id spent on one route does not answer for another', () => {
  remember(db, A, 'cross-route-01', 'entry-add', 201, { id: 7, quantity_g: 100 });

  assert.deepStrictEqual(replayOf(db, A, 'cross-route-01', 'entry-add').body,
    { id: 7, quantity_g: 100 }, 'the route that stored it must still replay');
  for (const other of ['batch-portion', 'preset-log', 'meal-log', 'session-create', 'weight']) {
    assert.strictEqual(replayOf(db, A, 'cross-route-01', other), null,
      `${other} was handed another route's stored response`);
  }
  // And each route can hold its own answer under the same id.
  remember(db, A, 'cross-route-01', 'batch-portion', 201, { logged_g: 250, remaining_g: 750 });
  assert.deepStrictEqual(replayOf(db, A, 'cross-route-01', 'batch-portion').body,
    { logged_g: 250, remaining_g: 750 });
  assert.deepStrictEqual(replayOf(db, A, 'cross-route-01', 'entry-add').body,
    { id: 7, quantity_g: 100 }, 'storing one route clobbered another');
});
