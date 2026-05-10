const express = require('express');
const { getDb } = require('../db');

const router = express.Router();
const OFF_BASE = 'https://world.openfoodfacts.org';

function mapOFFProduct(p) {
  const n = p.nutriments || {};
  return {
    name: p.product_name || p.product_name_en || 'Unknown',
    brand: p.brands || null,
    barcode: p.code || p._id || null,
    calories_per_100g:
      n['energy-kcal_100g'] ?? n['energy-kcal'] ?? null,
    protein_per_100g: n.proteins_100g ?? n.proteins ?? null,
    carbs_per_100g:
      n.carbohydrates_100g ?? n.carbohydrates ?? null,
    fat_per_100g: n.fat_100g ?? n.fat ?? null,
    fiber_per_100g: n.fiber_100g ?? n.fiber ?? null,
    serving_size_g: parseServingG(p.serving_size) ?? 100,
    source: 'openfoodfacts',
  };
}

function parseServingG(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+\.?\d*)\s*g/i);
  return m ? parseFloat(m[1]) : null;
}

function upsertFood(db, food) {
  db.prepare(`
    INSERT INTO foods
      (name, brand, barcode, calories_per_100g, protein_per_100g,
       carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source)
    VALUES
      ($name, $brand, $barcode, $calories_per_100g, $protein_per_100g,
       $carbs_per_100g, $fat_per_100g, $fiber_per_100g, $serving_size_g, $source)
    ON CONFLICT(barcode) DO UPDATE SET
      name              = excluded.name,
      brand             = excluded.brand,
      calories_per_100g = excluded.calories_per_100g,
      protein_per_100g  = excluded.protein_per_100g,
      carbs_per_100g    = excluded.carbs_per_100g,
      fat_per_100g      = excluded.fat_per_100g,
      fiber_per_100g    = excluded.fiber_per_100g,
      serving_size_g    = excluded.serving_size_g,
      source            = excluded.source
  `).run({
    name:              food.name,
    brand:             food.brand             || null,
    barcode:           food.barcode           || null,
    calories_per_100g: food.calories_per_100g ?? null,
    protein_per_100g:  food.protein_per_100g  ?? null,
    carbs_per_100g:    food.carbs_per_100g    ?? null,
    fat_per_100g:      food.fat_per_100g      ?? null,
    fiber_per_100g:    food.fiber_per_100g    ?? null,
    serving_size_g:    food.serving_size_g    ?? 100,
    source:            food.source            || 'custom',
  });

  const lookup = food.barcode
    ? db.prepare('SELECT * FROM foods WHERE barcode = $barcode').get({ barcode: food.barcode })
    : db.prepare('SELECT * FROM foods WHERE name = $name ORDER BY id DESC LIMIT 1').get({ name: food.name });
  return lookup;
}

// Search local DB
router.get('/search', (req, res) => {
  try {
    const { q = '', limit = 20 } = req.query;
    if (!q.trim()) return res.json([]);
    const term = `%${q.trim()}%`;
    const rows = getDb().prepare(`
      SELECT * FROM foods
      WHERE name LIKE $term OR brand LIKE $term
      ORDER BY
        is_favourite DESC,
        use_count DESC,
        CASE WHEN source IN ('nz_seed','custom') THEN 0 ELSE 1 END ASC,
        CASE WHEN brand IS NULL OR brand = '' THEN 0 ELSE 1 END ASC,
        LENGTH(name) ASC,
        name ASC
      LIMIT $limit
    `).all({ term, limit: Math.min(parseInt(limit) || 20, 50) });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search Open Food Facts by text (remote fallback)
router.get('/search/remote', async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (q.trim().length < 2) return res.json([]);

    const url = `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q.trim())}&json=1&page_size=10&fields=product_name,brands,nutriments,serving_size,code`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();
    const mapped = (data.products || [])
      .filter(p => p.product_name)
      .map(p => mapOFFProduct(p));
    res.json(mapped);
  } catch {
    res.json([]);
  }
});

// Recent foods (last 10 distinct logged)
router.get('/recent', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT f.*
      FROM foods f
      JOIN meal_entries me ON me.food_id = f.id
      ORDER BY me.logged_at DESC
      LIMIT 10
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Favourites
router.get('/favourites', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT * FROM foods WHERE is_favourite = 1
      ORDER BY use_count DESC, name ASC
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Barcode lookup — local first, then Open Food Facts
router.get('/barcode/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const db = getDb();

    const local = db.prepare('SELECT * FROM foods WHERE barcode = $barcode').get({ barcode });
    if (local) return res.json({ food: local, source: 'local' });

    const resp = await fetch(
      `${OFF_BASE}/api/v2/product/${barcode}.json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return res.status(404).json({ error: 'Product not found' });

    const data = await resp.json();
    if (data.status === 0 || !data.product) {
      return res.status(404).json({ error: 'Product not found in Open Food Facts' });
    }

    const food = upsertFood(db, mapOFFProduct({ ...data.product, code: barcode }));
    res.json({ food, source: 'openfoodfacts' });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return res.status(503).json({ error: 'Open Food Facts unreachable' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get one food
router.get('/:id', (req, res) => {
  try {
    const food = getDb()
      .prepare('SELECT * FROM foods WHERE id = $id')
      .get({ id: req.params.id });
    if (!food) return res.status(404).json({ error: 'Food not found' });
    res.json(food);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create custom food
router.post('/', (req, res) => {
  try {
    const food = req.body;
    if (!food.name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const saved = upsertFood(getDb(), { ...food, source: 'custom' });
    res.status(201).json(saved);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A food with this barcode already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Update food fields
router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id });
    if (!food) return res.status(404).json({ error: 'Food not found' });

    const allowed = [
      'name', 'brand', 'calories_per_100g', 'protein_per_100g',
      'carbs_per_100g', 'fat_per_100g', 'fiber_per_100g', 'serving_size_g',
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        db.prepare(`UPDATE foods SET ${key} = $v WHERE id = $id`)
          .run({ v: req.body[key], id });
      }
    }

    res.json(db.prepare('SELECT * FROM foods WHERE id = $id').get({ id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle favourite
router.patch('/:id/favourite', (req, res) => {
  try {
    const db = getDb();
    const food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: req.params.id });
    if (!food) return res.status(404).json({ error: 'Food not found' });
    const next = food.is_favourite ? 0 : 1;
    db.prepare('UPDATE foods SET is_favourite = $v WHERE id = $id').run({ v: next, id: food.id });
    res.json({ id: food.id, is_favourite: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete food
router.delete('/:id', (req, res) => {
  try {
    const result = getDb()
      .prepare('DELETE FROM foods WHERE id = $id')
      .run({ id: req.params.id });
    if (result.changes === 0) return res.status(404).json({ error: 'Food not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
