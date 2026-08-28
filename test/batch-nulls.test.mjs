import { test, before } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plated-batch-'));
const { initDb, getDb } = require_('../src/db.js');

let db, computeTotals, mkFood;
before(() => {
  initDb();
  db = getDb();
  // The real shipped function, not a copy of it.
  computeTotals = require_('../src/routes/batches.js').computeTotals;
  mkFood = (name, cols) => Number(db.prepare(
    `INSERT INTO foods (name, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g)
     VALUES ($n, $cal, $p, $c, $f, $fb)`
  ).run({ n: name, cal: cols.cal ?? 100, p: cols.p ?? null, c: cols.c ?? null,
          f: cols.f ?? null, fb: cols.fb ?? null }).lastInsertRowid);
});

test('a macro no ingredient recorded comes out NULL, not 0', () => {
  const oil  = mkFood('Oil, olive',  { cal: 884, f: 100 });   // knows fat, not fiber
  const rice = mkFood('Rice, plain', { cal: 130 });           // knows only calories
  const { t } = computeTotals(db, [
    { food_id: oil, quantity_g: 100 }, { food_id: rice, quantity_g: 200 },
  ]);
  assert.strictEqual(t.fiber, null, 'nothing in the pot knew fiber');
  assert.strictEqual(t.protein, null, 'nothing in the pot knew protein');
  assert.strictEqual(t.fat, 100, 'fat was known and must survive');
  assert.ok(t.calories > 1100, `calories still summed, got ${t.calories}`);
});

test('a genuine zero is preserved as zero, not turned into unknown', () => {
  const water = mkFood('Water', { cal: 0, p: 0, c: 0, f: 0, fb: 0 });
  const { t } = computeTotals(db, [{ food_id: water, quantity_g: 500 }]);
  assert.strictEqual(t.fiber, 0, 'a recorded 0 is a fact, not a gap');
  assert.strictEqual(t.protein, 0);
});

test('one knowing ingredient is enough to make the total real', () => {
  const oats = mkFood('Oats', { cal: 380, fb: 10 });
  const milk = mkFood('Milk', { cal: 64 });
  const { t } = computeTotals(db, [
    { food_id: oats, quantity_g: 100 }, { food_id: milk, quantity_g: 200 },
  ]);
  assert.strictEqual(t.fiber, 10, 'known from one ingredient, absent from the other');
});

test('ingredients with no food row or no weight are skipped, not counted as zero', () => {
  const oats = mkFood('Oats 2', { cal: 380, fb: 10 });
  const { t, ing } = computeTotals(db, [
    { food_id: oats, quantity_g: 100 },
    { food_id: 999999, quantity_g: 50 },   // no such food
    { food_id: oats, quantity_g: 0 },      // no weight
  ]);
  assert.strictEqual(ing.length, 1);
  assert.strictEqual(t.fiber, 10);
});

test('round1 turns null into 0 — the persist step must not use it bare', () => {
  const round1 = n => Math.round(n * 10) / 10;
  assert.strictEqual(round1(null), 0, 'this is the trap the insert has to dodge');
  const r1n = n => (n == null ? null : round1(n));
  assert.strictEqual(r1n(null), null);
  assert.strictEqual(r1n(2.55), 2.6);
  assert.strictEqual(r1n(0), 0, 'a real zero still rounds to zero');
});
