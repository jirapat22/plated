// Open Food Facts is crowd-sourced, unreviewed, and was trusted completely.
//
// Three defects on the one path that puts someone else's data into the foods
// table, found while auditing "the macros look wrong".
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const foods = require_('../src/routes/foods.js');

const { mapOFFProduct, offUnusable } = foods;

// The expensive one. `energy-kcal_100g` is per 100 g; the unsuffixed
// `energy-kcal` is per whatever basis the contributor used, and
// `nutrition_data_per` is the field that says which. The mapper fell back from
// the first to the second, so for every product entered per serving the
// serving figure was stored in a per-100g column.
//
// A 30 g muesli bar at 140 kcal/serving became 140 kcal per 100 g. Log the
// whole bar and it counts 42 kcal. Nothing on screen distinguishes it from a
// seeded food whose numbers really are per 100 g.
test('a per-serving figure is never stored as per-100g', () => {
  const perServing = {
    product_name: 'Muesli bar', brands: 'Test', code: '9400000000001',
    serving_size: '30 g',
    nutrition_data_per: 'serving',
    nutriments: { 'energy-kcal': 140, proteins: 3, carbohydrates: 18, fat: 6 },
  };
  const m = mapOFFProduct(perServing);
  assert.strictEqual(m.calories_per_100g, null,
    'a per-serving energy figure was copied into calories_per_100g');
  assert.strictEqual(m.protein_per_100g, null);
  assert.ok(offUnusable(m), 'a product with no per-100g data must not be storable');
});

test('a genuine per-100g figure still comes through', () => {
  const m = mapOFFProduct({
    product_name: 'Milk', brands: 'Anchor', code: '9400000000002',
    nutrition_data_per: '100g',
    nutriments: { 'energy-kcal_100g': 64, proteins_100g: 3.4, carbohydrates_100g: 4.8, fat_100g: 3.3, fiber_100g: 0 },
  });
  assert.strictEqual(m.calories_per_100g, 64);
  assert.strictEqual(m.protein_per_100g, 3.4);
  assert.strictEqual(offUnusable(m), null, 'a perfectly good product was rejected');
});

// The unsuffixed value IS usable when the product says its basis is 100g —
// plenty of older entries only carry that form.
test('the unsuffixed value is trusted only when the basis says 100g', () => {
  const base = {
    product_name: 'Yoghurt', code: '9400000000003',
    nutriments: { 'energy-kcal': 97, proteins: 9 },
  };
  assert.strictEqual(mapOFFProduct({ ...base, nutrition_data_per: '100g' }).calories_per_100g, 97);
  assert.strictEqual(mapOFFProduct({ ...base, nutrition_data_per: 'serving' }).calories_per_100g, null);
  assert.strictEqual(mapOFFProduct(base).calories_per_100g, null, 'no stated basis is not a promise of 100g');
});

// The barcode scan was the only route into `foods` that skipped badNutrition,
// and it writes ON CONFLICT(barcode) DO UPDATE — so garbage did not merely
// arrive, it overwrote a row someone may have corrected by hand.
test('impossible nutrition is refused rather than stored', () => {
  const cases = [
    ['5000 kcal per 100 g', { 'energy-kcal_100g': 5000 }],
    ['250 g of fat in 100 g', { 'energy-kcal_100g': 400, fat_100g: 250 }],
    ['negative protein', { 'energy-kcal_100g': 400, proteins_100g: -3 }],
    ['no energy at all', { proteins_100g: 5 }],
    ['zero energy', { 'energy-kcal_100g': 0 }],
  ];
  for (const [label, nutriments] of cases) {
    const m = mapOFFProduct({ product_name: label, code: '9400000000004', nutrition_data_per: '100g', nutriments });
    assert.ok(offUnusable(m), `${label} was accepted into the foods table`);
  }
});
