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

// This assertion was narrowed on purpose, so the reason is recorded here.
//
// It used to read "a day already logged is never overwritten by the scale" and
// it re-imported 2026-08-23 — a row this file created THROUGH importBodyweight,
// so source is 'ironlog'. The rule it was protecting is that a weight typed in
// Plated outranks the scale, and that still holds (see the two tests further
// down). What it actually pinned was stronger and wrong: that IronLog could
// never correct its OWN row, so the first value we happened to see for a day
// was frozen for good and a mis-typed weight fixed in IronLog never arrived.
//
// A day is still never re-inserted, which is what the row count checks.
test('a day is never duplicated, and the scale may correct its own row', () => {
  const before = weights().length;
  assert.strictEqual(importBodyweight(db, PID, [{ date: '2026-08-23', weight_kg: 80 }]), 1,
    'the correction was ignored');
  assert.strictEqual(weights().length, before, 'a second row was inserted for a day already present');
  assert.strictEqual(weights().find(w => w.date === '2026-08-23').weight_kg, 80);
  // Put it back, so tests after this one see the reading the file set up.
  importBodyweight(db, PID, [{ date: '2026-08-23', weight_kg: 76.4 }]);
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

// A corrected weigh-in has to reach us.
//
// This importer runs on every /api/ironlog/today call, and the old rule was "a
// day you already have is never overwritten". That protects a manual
// correction, which is right — but it also froze the first value we happened to
// see for a day, so fixing a mis-typed weight in IronLog changed nothing here.
// IronLog 5432f8d made its own POST dedupe per local day with newest winning,
// so the correction now exists on their side; this is the half that lets it
// arrive.
//
// The line that must not move: a weight typed in Plated still outranks the
// scale. source is 'ironlog' for rows we wrote and 'manual' for anything
// entered here, including every pre-migration row, since the ALTER defaulted
// to 'manual'.
test('a corrected IronLog weight updates the row we wrote', () => {
  const date = '2026-09-10';
  db.prepare('DELETE FROM weight_log WHERE profile_id = $p').run({ p: PID });

  assert.strictEqual(importBodyweight(db, PID, [{ date, weight_kg: 81.4 }]), 1, 'first import did not land');
  const read = () => db.prepare('SELECT weight_kg, source FROM weight_log WHERE profile_id = $p AND date = $d')
    .get({ p: PID, d: date });
  assert.strictEqual(read().weight_kg, 81.4);

  // The same value again must not count as a change — this runs on every
  // Today render, and churning the row would make `added` lie and trigger a
  // pointless macro recalc each time.
  assert.strictEqual(importBodyweight(db, PID, [{ date, weight_kg: 81.4 }]), 0, 'an unchanged weight was re-written');

  // A genuine correction arrives.
  assert.strictEqual(importBodyweight(db, PID, [{ date, weight_kg: 78.1 }]), 1, 'the correction was ignored');
  assert.strictEqual(read().weight_kg, 78.1);
  assert.strictEqual(read().source, 'ironlog', 'the row changed hands');

  // Rounding noise on a float off a scale is not a correction.
  assert.strictEqual(importBodyweight(db, PID, [{ date, weight_kg: 78.105 }]), 0, '5 g of float noise counted as a change');
  assert.strictEqual(read().weight_kg, 78.1);
});

test('a weight typed in Plated is never overwritten by IronLog', () => {
  const date = '2026-09-11';
  db.prepare('DELETE FROM weight_log WHERE profile_id = $p').run({ p: PID });
  db.prepare("INSERT INTO weight_log (date, weight_kg, profile_id, source) VALUES ($d, 80.0, $p, 'manual')")
    .run({ d: date, p: PID });

  assert.strictEqual(importBodyweight(db, PID, [{ date, weight_kg: 62.5 }]), 0,
    'IronLog overwrote a manual entry');
  assert.strictEqual(
    db.prepare('SELECT weight_kg FROM weight_log WHERE profile_id = $p AND date = $d').get({ p: PID, d: date }).weight_kg,
    80.0, 'the manually entered weight was changed');
});

test('a pre-migration row counts as manual and is left alone', () => {
  // The source column was added with DEFAULT 'manual', so every row that
  // predates it reads as manual. That is the safe direction and the test says
  // so out loud, because the alternative — treating unknown as ours — would
  // quietly hand years of hand-entered history to the scale.
  const date = '2026-09-12';
  db.prepare('DELETE FROM weight_log WHERE profile_id = $p').run({ p: PID });
  db.prepare('INSERT INTO weight_log (date, weight_kg, profile_id) VALUES ($d, 79.3, $p)')
    .run({ d: date, p: PID });
  assert.strictEqual(importBodyweight(db, PID, [{ date, weight_kg: 70.0 }]), 0);
  assert.strictEqual(
    db.prepare('SELECT weight_kg FROM weight_log WHERE profile_id = $p AND date = $d').get({ p: PID, d: date }).weight_kg,
    79.3);
});
