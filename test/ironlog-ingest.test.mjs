// IronLog is a remote server whose JSON was written straight into weight_log
// and profile_settings with nothing checking it — the same columns that have
// had guards at the form since someone could type 700 kg.
//
// The expensive one is not the obviously silly value. A "70abc" landing as TEXT
// in a REAL column makes trendWeight return NaN, which fails the `bw > 0` guard
// inside recalcMacroGoals — so in g/kg mode the macro goals silently stop
// tracking bodyweight for good, and nothing on any screen says why. It fails
// closed, which is exactly why it would go unnoticed.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-iron-'));
process.env.DATA_DIR = dataDir;

const { initDb, getDb } = require('../src/db.js');
const { importBodyweight, getBaseUrl } = require('../src/routes/ironlog.js');
const { trendWeight } = require('../src/utils/macros.js');

const PID = 1;
let db;

before(() => {
  initDb();
  db = getDb();
  db.prepare("INSERT INTO profiles (id, name, pass_hash, pass_salt) VALUES ($p, 'IRONTEST', 'x', 'y')")
    .run({ p: PID });
});

after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

const setSetting = (k, v) =>
  db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($p, $k, $v)')
    .run({ p: PID, k, v });

// node:sqlite hands back null-prototype rows, which deepStrictEqual will not
// match against object literals — spread them into plain objects.
const weights = () =>
  db.prepare('SELECT date, weight_kg FROM weight_log WHERE profile_id = $p ORDER BY date')
    .all({ p: PID }).map(r => ({ ...r }));

test('only weigh-ins a person could have takes root in weight_log', () => {
  const added = importBodyweight(db, PID, [
    { date: '2026-08-20', weight_kg: '70abc' },   // TEXT into a REAL column
    { date: '2026-02-30', weight_kg: 74 },        // a day that does not exist
    { date: '2026-08-21', weight_kg: 99999 },     // past the 20-400 band
    { date: '2026-08-22', weight_kg: -12 },
    { date: '2026-08-23', weight_kg: 76.4 },      // the one plainly real reading
  ]);
  // '70abc' SURVIVES, as the number 70 — deliberately. badWeight validates
  // parseFloat and the row stores parseFloat, which is exactly what
  // POST /api/weight does with the same input, and what a numeric string from a
  // form relies on. Making this path stricter than that one would reject data
  // the app already accepts elsewhere. The property that matters is that a
  // STRING never reaches the REAL column, which the next test pins down.
  assert.strictEqual(added, 2, `imported ${added} rows: ${JSON.stringify(weights())}`);
  assert.deepStrictEqual(weights(), [
    { date: '2026-08-20', weight_kg: 70 },
    { date: '2026-08-23', weight_kg: 76.4 },
  ]);
});

test('a stored reading is a number, so the trend stays a number', () => {
  // The whole point: one TEXT row poisons the average, and the NaN is then
  // swallowed by a guard far away from the write that caused it.
  for (const row of weights()) {
    assert.strictEqual(typeof row.weight_kg, 'number', 'a string reached the REAL column');
  }
  const t = trendWeight(db, PID);
  assert.ok(Number.isFinite(t) && t > 0, `trendWeight came back ${t}`);
});

test('a numeric string still imports, the way the manual route accepts one', () => {
  // '76.4' is what a form posts; it is not the same thing as '70abc'. An import
  // stricter than POST /api/weight would reject data that route accepts.
  const added = importBodyweight(db, PID, [{ date: '2026-08-24', weight_kg: '75.2' }]);
  assert.strictEqual(added, 1);
  const row = weights().find(w => w.date === '2026-08-24');
  assert.strictEqual(row.weight_kg, 75.2);
  assert.strictEqual(typeof row.weight_kg, 'number');
});

test('a day already logged is never overwritten by the scale', () => {
  const before = weights().length;
  assert.strictEqual(importBodyweight(db, PID, [{ date: '2026-08-23', weight_kg: 80 }]), 0);
  assert.strictEqual(weights().length, before);
  assert.strictEqual(weights().find(w => w.date === '2026-08-23').weight_kg, 76.4);
});

// ── where the server will actually send a request ───────────────────────────
test('an unsafe URL already in the database is refused at the point of use', () => {
  // The PATCH handler has refused these for a while and the import path does
  // now too — but a URL stored before either guard existed is still sitting in
  // the table, and this is the line that decides where a request goes.
  for (const url of ['http://127.0.0.1:3520', 'http://[::1]:3520', 'http://169.254.169.254/latest/meta-data/',
                     'http://192.168.1.10', 'file:///etc/passwd']) {
    setSetting('ironlog_api_url', url);
    assert.throws(() => getBaseUrl(PID), /public http\(s\) address/, `${url} was allowed through`);
  }
});

test('an ordinary IronLog URL still works, without its trailing slash', () => {
  setSetting('ironlog_api_url', 'https://ironlog.example.com/');
  assert.strictEqual(getBaseUrl(PID), 'https://ironlog.example.com');
});
