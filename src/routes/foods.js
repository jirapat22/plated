const express = require('express');
const { getDb } = require('../db');

const router = express.Router();
const OFF_BASE = 'https://world.openfoodfacts.org';

// Foods are shared across profiles; favourites + use-count are per profile and
// live in profile_food_stats. Select the shared columns explicitly so we can
// overlay this profile's is_favourite / use_count.
const FCOLS = `f.id, f.name, f.brand, f.barcode, f.calories_per_100g,
  f.protein_per_100g, f.carbs_per_100g, f.fat_per_100g, f.fiber_per_100g,
  f.serving_size_g, f.source, f.created_at, f.created_by_profile`;

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
       carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source, created_by_profile)
    VALUES
      ($name, $brand, $barcode, $calories_per_100g, $protein_per_100g,
       $carbs_per_100g, $fat_per_100g, $fiber_per_100g, $serving_size_g, $source, $created_by)
    ON CONFLICT(barcode) DO UPDATE SET
      name              = excluded.name,
      brand             = excluded.brand,
      calories_per_100g = excluded.calories_per_100g,
      protein_per_100g  = excluded.protein_per_100g,
      carbs_per_100g    = excluded.carbs_per_100g,
      fat_per_100g      = excluded.fat_per_100g,
      fiber_per_100g    = excluded.fiber_per_100g,
      serving_size_g    = excluded.serving_size_g,
      source            = excluded.source,
      hidden            = 0
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
    created_by:        food.created_by_profile ?? null,
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
      SELECT ${FCOLS},
             COALESCE(pfs.is_favourite, 0) AS is_favourite,
             COALESCE(pfs.use_count, 0)    AS use_count
      FROM foods f
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE (f.name LIKE $term OR f.brand LIKE $term)
        AND f.source != 'quick'
        AND f.hidden = 0
      ORDER BY
        is_favourite DESC,
        use_count DESC,
        CASE WHEN f.source IN ('nz_seed','custom') THEN 0 ELSE 1 END ASC,
        CASE WHEN f.brand IS NULL OR f.brand = '' THEN 0 ELSE 1 END ASC,
        LENGTH(f.name) ASC,
        f.name ASC
      LIMIT $limit
    `).all({ term, pid: req.profileId, limit: Math.min(parseInt(limit) || 20, 50) });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search Open Food Facts by text — English only, must have calories
router.get('/search/remote', async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (q.trim().length < 2) return res.json([]);

    // lc=en limits to English-labelled products
    const url = `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q.trim())}&json=1&page_size=24&lc=en&fields=product_name,brands,nutriments,serving_size,code,countries_tags`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json();

    // Only Latin characters (no Cyrillic, Chinese, Arabic, etc.)
    const latinOnly = /^[\u0000-ɏ\s\d.,()&'"\-\/]+$/;

    const mapped = (data.products || [])
      .filter(p => {
        if (!p.product_name) return false;
        if (!latinOnly.test(p.product_name)) return false;          // skip non-Latin names
        const n = p.nutriments || {};
        const hasCal = n['energy-kcal_100g'] != null || n['energy-kcal'] != null;
        return hasCal;                                               // must have energy data
      })
      .map(p => mapOFFProduct(p))
      .slice(0, 10);

    res.json(mapped);
  } catch {
    res.json([]);
  }
});

// Recent foods — sorted by frequency so regulars surface above one-off entries
router.get('/recent', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT ${FCOLS},
             COALESCE(pfs.is_favourite, 0) AS is_favourite,
             COALESCE(pfs.use_count, 0)    AS use_count
      FROM foods f
      INNER JOIN (
        SELECT me.food_id, MAX(me.logged_at) AS last_used
        FROM meal_entries me
        JOIN meal_sessions ms ON ms.id = me.meal_session_id
        WHERE ms.profile_id = $pid
        GROUP BY me.food_id
      ) latest ON latest.food_id = f.id
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE f.source != 'quick' AND f.hidden = 0
      ORDER BY use_count DESC, latest.last_used DESC
      LIMIT 10
    `).all({ pid: req.profileId });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Favourites
router.get('/favourites', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT ${FCOLS}, 1 AS is_favourite, COALESCE(pfs.use_count, 0) AS use_count
      FROM foods f
      JOIN profile_food_stats pfs
        ON pfs.food_id = f.id AND pfs.profile_id = $pid AND pfs.is_favourite = 1
      WHERE f.hidden = 0
      ORDER BY pfs.use_count DESC, f.name ASC
    `).all({ pid: req.profileId });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List foods by source — powers the Custom / Scanned tabs.
// source: 'custom' (user-created) or 'scanned' (openfoodfacts). Optional q filter.
router.get('/by-source', (req, res) => {
  try {
    const source = req.query.source === 'scanned' ? 'openfoodfacts'
                 : req.query.source === 'custom'  ? 'custom'
                 : null;
    if (!source) return res.status(400).json({ error: 'source must be custom or scanned' });

    const q = (req.query.q || '').trim();
    const rows = getDb().prepare(`
      SELECT ${FCOLS},
             COALESCE(pfs.is_favourite, 0) AS is_favourite,
             COALESCE(pfs.use_count, 0)    AS use_count
      FROM foods f
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE f.source = $source AND f.hidden = 0
        ${q ? 'AND (f.name LIKE $like OR f.brand LIKE $like)' : ''}
      ORDER BY f.name ASC
      LIMIT 200
    `).all(q ? { pid: req.profileId, source, like: `%${q}%` } : { pid: req.profileId, source });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Barcode lookup — local first, then Open Food Facts
// UPC-A (12 digits) is stored in OFF as EAN-13 (zero-padded to 13 digits),
// so we try both the raw barcode and the zero-padded variant.
router.get('/barcode/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    if (!/^\d{8,14}$/.test(barcode)) {
      return res.status(400).json({ error: 'Invalid barcode — must be 8–14 digits' });
    }
    const db = getDb();
    const ean13 = barcode.length === 12 ? '0' + barcode : barcode;
    const candidates = [...new Set([barcode, ean13])];

    // Local DB — check both forms
    const local = db.prepare(`
      SELECT ${FCOLS}, COALESCE(pfs.is_favourite, 0) AS is_favourite, COALESCE(pfs.use_count, 0) AS use_count
      FROM foods f
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE (f.barcode = $b1 OR f.barcode = $b2) AND f.hidden = 0
    `).get({ b1: barcode, b2: ean13, pid: req.profileId });
    if (local) return res.json({ food: local, source: 'local' });

    // Open Food Facts — try each candidate until one returns a product
    let productData = null;
    let usedCode = barcode;
    for (const code of candidates) {
      const resp = await fetch(
        `${OFF_BASE}/api/v2/product/${code}.json`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (resp.ok) {
        const d = await resp.json();
        if (d.status !== 0 && d.product) { productData = d.product; usedCode = code; break; }
      }
    }

    if (!productData) {
      return res.status(404).json({ error: 'Product not found in Open Food Facts' });
    }

    const mapped = mapOFFProduct({ ...productData, code: usedCode });
    mapped.created_by_profile = req.profileId;   // whoever first scanned it
    const food = upsertFood(db, mapped);
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
    const food = getDb().prepare(`
      SELECT ${FCOLS}, COALESCE(pfs.is_favourite, 0) AS is_favourite, COALESCE(pfs.use_count, 0) AS use_count
      FROM foods f
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE f.id = $id
    `).get({ id: req.params.id, pid: req.profileId });
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
    const saved = upsertFood(getDb(), { ...food, source: food.source || 'custom', created_by_profile: req.profileId });
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

    // Same rule as delete: only the creator (or admin) may edit a shared food.
    const admin = !!db.prepare('SELECT is_admin FROM profiles WHERE id = $id').get({ id: req.profileId })?.is_admin;
    if (!admin && food.created_by_profile !== req.profileId) {
      return res.status(403).json({ error: 'You can only edit foods you created' });
    }

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

// Toggle favourite (per profile)
router.patch('/:id/favourite', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const food = db.prepare('SELECT id FROM foods WHERE id = $id').get({ id: req.params.id });
    if (!food) return res.status(404).json({ error: 'Food not found' });

    const current = db.prepare(
      'SELECT is_favourite FROM profile_food_stats WHERE profile_id = $pid AND food_id = $fid'
    ).get({ pid, fid: food.id });
    const next = current?.is_favourite ? 0 : 1;

    db.prepare(`
      INSERT INTO profile_food_stats (profile_id, food_id, is_favourite)
      VALUES ($pid, $fid, $v)
      ON CONFLICT(profile_id, food_id) DO UPDATE SET is_favourite = $v
    `).run({ pid, fid: food.id, v: next });

    res.json({ id: food.id, is_favourite: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete food — soft delete (hide from search/lists; logged history is kept).
// You can delete foods you created; the admin can delete any.
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const food = db.prepare('SELECT id, created_by_profile FROM foods WHERE id = $id').get({ id: req.params.id });
    if (!food) return res.status(404).json({ error: 'Food not found' });

    const admin = !!db.prepare('SELECT is_admin FROM profiles WHERE id = $id').get({ id: req.profileId })?.is_admin;
    const isCreator = food.created_by_profile === req.profileId;
    if (!admin && !isCreator) {
      return res.status(403).json({ error: 'You can only delete foods you created' });
    }

    db.prepare('UPDATE foods SET hidden = 1 WHERE id = $id').run({ id: food.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
