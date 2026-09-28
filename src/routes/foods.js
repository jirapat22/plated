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

// Per-100g figures only, ever.
//
// This used to fall back from `energy-kcal_100g` to `energy-kcal`, and from
// `proteins_100g` to `proteins`, and so on for every macro. Those unsuffixed
// fields are not per-100g: they carry whatever basis the contributor entered
// the product in, and `nutrition_data_per` is the field that says which. For a
// large share of Open Food Facts products that basis is the SERVING.
//
// So a 30 g muesli bar labelled 140 kcal per serving was stored as 140
// kcal_per_100g, and every gram logged against it counted about a third of
// what it should. Nothing anywhere said so — the row looked perfectly ordinary
// next to seeded foods whose figures really are per 100 g. This is the most
// likely source of "the macros look wrong", because it is the one path that
// writes a plausible-looking number that is silently on the wrong scale.
//
// When only the unsuffixed value exists it is used ONLY if the product states
// its basis is 100g. Otherwise the field is null, and the guard below turns an
// unusable product into hand-entry rather than a confident wrong number.
const off100 = (n, key, dataPer) => {
  const suffixed = n[`${key}_100g`];
  if (suffixed != null && Number.isFinite(Number(suffixed))) return Number(suffixed);
  if (dataPer === '100g' && n[key] != null && Number.isFinite(Number(n[key]))) return Number(n[key]);
  return null;
};

function mapOFFProduct(p) {
  const n = p.nutriments || {};
  const per = p.nutrition_data_per || null;
  return {
    name: p.product_name || p.product_name_en || 'Unknown',
    brand: p.brands || null,
    barcode: p.code || p._id || null,
    calories_per_100g: off100(n, 'energy-kcal', per),
    protein_per_100g:  off100(n, 'proteins', per),
    carbs_per_100g:    off100(n, 'carbohydrates', per),
    fat_per_100g:      off100(n, 'fat', per),
    fiber_per_100g:    off100(n, 'fiber', per),
    serving_size_g: parseServingG(p.serving_size) ?? 100,
    source: 'openfoodfacts',
  };
}

// Is this product safe to put in the foods table?
//
// Open Food Facts is crowd-sourced and unreviewed: products carry 5,000 kcal
// per 100 g, negative protein, 250 g of fat in 100 g of food. Every typed path
// into this table runs badNutrition; the barcode scan was the one that did not,
// and it writes with ON CONFLICT(barcode) DO UPDATE — so a re-scan overwrote a
// food that had been fine. Returns an error string, or null when usable.
function offUnusable(food) {
  if (!(food.calories_per_100g > 0)) {
    return 'Open Food Facts has this product but no usable per-100g nutrition for it';
  }
  return badNutrition(food, 'openfoodfacts');
}

// Nutrition fields are per 100 g, so anything above 900 kcal is impossible
// (pure fat is 900) and any macro above 100 g is more than the 100 g it
// describes. PATCH used to write req.body values straight into the column, so
// a stray letter landed in a REAL field and every future log of that food
// silently came out as 0 — the entry looked fine, the day's total didn't.
const NUM_LIMITS = {
  calories_per_100g: 900,
  protein_per_100g:  100,
  carbs_per_100g:    100,
  fat_per_100g:      100,
  fiber_per_100g:    100,
  serving_size_g:    5000,
};
// Returns an error string, or null when every supplied field is usable.
// Absent fields are fine; null/'' clears a value, which is a legitimate edit.
//
// `source` matters. For a QUICK LOG the per-100g columns don't hold per-100g
// values at all: log.js posts the meal's whole calorie count as
// calories_per_100g with serving_size_g 100, then logs exactly 100g, so the
// numbers cancel and the total comes out right. Production has ten of these
// above 900 (a 1800 kcal Mookata, a 1620 kcal Musashi meal), so applying the
// per-100g ceiling to them rejects perfectly ordinary meals. Ranges are skipped
// for that source; type and sign are still enforced, since those are what
// actually corrupt the column.
function badNutrition(body, source) {
  if (body.name !== undefined && !String(body.name ?? '').trim()) {
    return 'Name cannot be empty';
  }
  const perHundred = source !== 'quick' && source !== 'batch';
  for (const [key, max] of Object.entries(NUM_LIMITS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${key.replace(/_/g, ' ')} must be a number`;
    if (n < 0) return `${key.replace(/_/g, ' ')} cannot be negative`;
    if (perHundred && n > max) return `${key.replace(/_/g, ' ')} looks wrong — max ${max} per 100g`;
  }
  return null;
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
    // Every word has to appear, in either the name or the brand, in any order.
    // One LIKE over the whole phrase meant "greek yoghurt" missed "Yoghurt,
    // Greek style" — the seeded names are mostly "Ingredient, qualifier", so
    // typing them the way anyone says them out loud found nothing. Capped at 6
    // terms so a pasted paragraph can't build a monstrous query.
    const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const params = { pid: req.profileId, limit: Math.min(parseInt(limit) || 20, 50) };
    // % and _ are LIKE wildcards, and this data is full of them: "Yoghurt,
    // natural, greek style (~10% fat)", "Milk, 2%". Unescaped, searching
    // "10% fat" asked for "10", then anything, then " fat" — so it matched
    // things that have nothing to do with 10% fat. Backslash first, or it
    // would escape the escapes we just added.
    const lit = w => w.replace(/[\\%_]/g, c => '\\' + c);
    const clauses = words.map((w, i) => {
      params[`t${i}`] = `%${lit(w)}%`;
      return `(f.name LIKE $t${i} ESCAPE '\\' OR f.brand LIKE $t${i} ESCAPE '\\')`;
    }).join(' AND ');
    // Did the query name a BRAND? Used as a ranking tier below.
    //
    // Every one of the 4,804 seeded foods has brand NULL — checked — and the
    // tier after this one sorts an unbranded row ABOVE a branded one. That is
    // right for a generic query ("milk" should find milk, not a milk drink),
    // and exactly wrong when the word typed IS the brand: searching "anchor"
    // put an AUSNUT row called "Liquid breakfast ... Anchor™" above the Anchor
    // milk actually in the fridge, and "weet-bix" did the same. Those are the
    // two searches most likely to be a brand and nothing else.
    //
    // Only fires when a term matches the brand column, so a generic query is
    // untouched — measured on 15 searches, 2 fixed and 13 unchanged.
    const brandHit = words.map((_, i) => `f.brand LIKE $t${i} ESCAPE '\\'`).join(' OR ');
    // Still NO bonus for matching the typed phrase contiguously anywhere in the
    // name. That sounds right and measures wrong on this data: the seed names
    // things "Ingredient, qualifier", so the literal phrase turns up almost
    // only in composite dish names. Boosting it put "Watercress, sautéed with
    // olive oil" above "Oil, olive" and "Chicken wrap, chicken breast, with
    // salad" above "Chicken, breast, lean, raw" — worse on 4 of 7 common
    // searches and better on none.
    //
    // What DOES work is the narrower version: the name IS the query, or the
    // name STARTS with the query followed by a comma. That is the seed's own
    // convention for "this row is the plain ingredient" — "Banana, yellow,
    // ripened, raw" against "Banana chip", "Chicken, lean, raw" against "Sushi,
    // chicken". It cannot promote a dish that merely mentions the word, which
    // is what sank the contiguous-phrase version.
    //
    // Measured the same way, on 14 common searches: better on 9, unchanged on
    // 5, worse on none. The ones it fixes were bad:
    //   rice    -> was Flour, rice / Oil, rice bran / Licorice, black
    //   egg     -> was Eggplant, raw / Bacon & egg roll / Eggplant, pickled
    //   butter  -> was Buttermilk
    //   banana  -> was Banana chip (519 kcal) / Banana split
    // Multi-word queries like "olive oil" match no name's opening, so they all
    // fall to the last tier and keep exactly the order they had.
    params.base  = `${lit(q.trim())},%`;
    params.exact = lit(q.trim());
    const rows = getDb().prepare(`
      SELECT ${FCOLS},
             COALESCE(pfs.is_favourite, 0) AS is_favourite,
             COALESCE(pfs.use_count, 0)    AS use_count,
             pfs.last_qty_g
      FROM foods f
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE (${clauses})
        AND f.source NOT IN ('quick', 'batch')
        AND f.hidden = 0
      ORDER BY
        is_favourite DESC,
        use_count DESC,
        CASE WHEN LOWER(f.name) = LOWER($exact) THEN 0
             WHEN LOWER(f.name) LIKE LOWER($base) ESCAPE '\\' THEN 1
             ELSE 2 END ASC,
        CASE WHEN ${brandHit} THEN 0 ELSE 1 END ASC,
        CASE WHEN f.source IN ('nz_seed','custom') THEN 0 ELSE 1 END ASC,
        CASE WHEN f.brand IS NULL OR f.brand = '' THEN 0 ELSE 1 END ASC,
        LENGTH(f.name) ASC,
        f.name ASC
      LIMIT $limit
    `).all(params);
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
    const url = `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q.trim())}&json=1&page_size=24&lc=en&fields=product_name,brands,nutriments,serving_size,code,countries_tags,nutrition_data_per`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    // "Busy" is not "not there", and this route used to report them the same.
    //
    // Open Food Facts rate-limits this endpoint hard and answers with a 503
    // HTML page, not JSON. The catch below turned that — and a timeout, and a
    // DNS failure — into `[]`, which the UI renders as "no results". So the
    // honest outcome "we could not reach the branded-food database" was shown
    // as the false one "that product does not exist", and the only sensible
    // response to it is the wrong one: give up and type the food by hand.
    // Measured while auditing this: three consecutive 503s on an ordinary
    // query, then a 200. Retrying would have worked; nothing said to.
    if (!resp.ok) {
      return res.status(503).json({ error: 'Open Food Facts is busy right now — try that again in a moment' });
    }
    const data = await resp.json();

    // Only Latin characters (no Cyrillic, Chinese, Arabic, etc.)
    const latinOnly = /^[\u0000-ɏ\s\d.,()&'"\-\/]+$/;

    const mapped = (data.products || [])
      .filter(p => p.product_name && latinOnly.test(p.product_name))  // skip non-Latin names
      .map(p => mapOFFProduct(p))
      // Same gate the scan uses. Offering a row whose numbers are unusable only
      // moves the failure later: picking it POSTs to /api/foods, which runs
      // badNutrition and refuses with a validation error mid-log. Filtering
      // here means the list only ever contains things that can be logged.
      .filter(f => !offUnusable(f))
      .slice(0, 10);

    res.json(mapped);
  } catch (err) {
    // Same reasoning as the !resp.ok branch: say it failed rather than
    // answering "nothing found".
    const timedOut = err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT';
    res.status(503).json({
      error: timedOut
        ? 'Open Food Facts took too long to answer — try again in a moment'
        : 'Could not reach Open Food Facts just now',
    });
  }
});

// Recent foods — sorted by frequency so regulars surface above one-off entries
router.get('/recent', (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT ${FCOLS},
             COALESCE(pfs.is_favourite, 0) AS is_favourite,
             COALESCE(pfs.use_count, 0)    AS use_count,
             pfs.last_qty_g
      FROM foods f
      INNER JOIN (
        SELECT me.food_id, MAX(me.logged_at) AS last_used
        FROM meal_entries me
        JOIN meal_sessions ms ON ms.id = me.meal_session_id
        WHERE ms.profile_id = $pid
        GROUP BY me.food_id
      ) latest ON latest.food_id = f.id
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE f.source NOT IN ('quick', 'batch') AND f.hidden = 0
      ORDER BY use_count DESC, latest.last_used DESC
      LIMIT 40
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
      SELECT ${FCOLS}, 1 AS is_favourite, COALESCE(pfs.use_count, 0) AS use_count, pfs.last_qty_g
      FROM foods f
      JOIN profile_food_stats pfs
        ON pfs.food_id = f.id AND pfs.profile_id = $pid AND pfs.is_favourite = 1
      WHERE f.hidden = 0 AND f.source NOT IN ('batch', 'quick')
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
             COALESCE(pfs.use_count, 0)    AS use_count,
             pfs.last_qty_g
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
      SELECT ${FCOLS}, COALESCE(pfs.is_favourite, 0) AS is_favourite, COALESCE(pfs.use_count, 0) AS use_count, pfs.last_qty_g
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
    // Check BEFORE storing. This was the only route that wrote into foods
    // without running badNutrition, and it writes with ON CONFLICT(barcode) DO
    // UPDATE — so an unusable product did not just arrive, it overwrote a row
    // that may have been corrected by hand. 422 rather than 404 because the
    // product does exist; the client tells the two apart and reopens quick-add
    // with the barcode kept and this message shown, which is the same path a
    // genuinely unknown barcode already takes.
    const unusable = offUnusable(mapped);
    if (unusable) return res.status(422).json({ error: `${unusable} — add it by hand from the label` });
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

// Get one food.
//
// The shared library is genuinely shared — every profile can read a seeded or
// custom food, and the batch editor fetches ingredients through here. But three
// sources are NOT library entries: 'quick' stores the free text you typed for a
// meal you couldn't weigh, 'batch' the name of something you cooked, 'leftover'
// what you saved for later. Those are private notes that happen to live in the
// foods table for bookkeeping, and every other route excludes them — search
// (`source NOT IN ('quick','batch')`), the by-source list, the dedup lookup.
// This route filtered on nothing but the id, so walking /api/foods/1..N read
// every household member's meal descriptions straight out. PATCH and DELETE
// already gate on created_by_profile; this is the same gate on the read.
router.get('/:id', (req, res) => {
  try {
    const food = getDb().prepare(`
      SELECT ${FCOLS}, COALESCE(pfs.is_favourite, 0) AS is_favourite, COALESCE(pfs.use_count, 0) AS use_count, pfs.last_qty_g
      FROM foods f
      LEFT JOIN profile_food_stats pfs ON pfs.food_id = f.id AND pfs.profile_id = $pid
      WHERE f.id = $id
        AND (f.source NOT IN ('quick', 'batch', 'leftover')
             OR f.created_by_profile = $pid)
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
    const badNum = badNutrition(food, food.source || 'custom');
    if (badNum) return res.status(400).json({ error: badNum });

    // Foods are shared across every profile, and only a barcode collision was
    // ever detected — so each person who typed "Chicken breast" by hand got
    // their own row. Invisible at two users, a list of near-duplicates at ten.
    // Same 409-with-the-food shape as the barcode case below, which the client
    // already knows how to fall back on.
    // Quick-log and batch foods are exempt: they're per-entry throwaways hidden
    // from search, and they collide by design (every "Quick log" shares a name).
    const src = food.source || 'custom';
    if (!food.barcode && src !== 'quick' && src !== 'batch') {
      const twin = getDb().prepare(`
        SELECT ${FCOLS} FROM foods f
        WHERE LOWER(TRIM(f.name)) = LOWER(TRIM($n))
          AND LOWER(TRIM(COALESCE(f.brand, ''))) = LOWER(TRIM(COALESCE($b, '')))
          AND f.hidden = 0 AND f.source NOT IN ('quick', 'batch')
        ORDER BY f.id ASC LIMIT 1
      `).get({ n: food.name, b: food.brand || '' });
      if (twin) {
        return res.status(409).json({
          error: `"${twin.name}" already exists — using that one`,
          food: twin,
        });
      }
    }
    // upsertFood does INSERT ... ON CONFLICT(barcode) DO UPDATE, which never
    // throws a UNIQUE error — it just silently overwrites the existing food's
    // name/macros instead (the catch below for that error was unreachable
    // dead code). That let anyone clobber a food they didn't create just by
    // reusing its barcode here, bypassing the ownership check PATCH /:id
    // enforces. Reject the collision up front instead of upserting into it.
    if (food.barcode) {
      const existing = getDb().prepare(`SELECT ${FCOLS} FROM foods f WHERE f.barcode = $b`).get({ b: food.barcode });
      // Include the existing row: a caller creating a food they typed by hand
      // should be blocked, but one selecting a search result that happens to
      // already exist under this barcode (e.g. found via a text search that
      // returned a different product_name than when it was first scanned)
      // just needs that food's real id back, not a dead end.
      if (existing) return res.status(409).json({ error: 'A food with this barcode already exists', food: existing });
    }
    const saved = upsertFood(getDb(), { ...food, source: food.source || 'custom', created_by_profile: req.profileId });
    res.status(201).json(saved);
  } catch (err) {
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

    // The stored source, not one the caller can claim — otherwise the ceiling
    // is opt-out by sending source:'quick' with an edit.
    const badNum = badNutrition(req.body, food.source);
    if (badNum) return res.status(400).json({ error: badNum });

    const allowed = [
      'name', 'brand', 'calories_per_100g', 'protein_per_100g',
      'carbs_per_100g', 'fat_per_100g', 'fiber_per_100g', 'serving_size_g',
    ];
    // One UPDATE per field, so a multi-field edit has to be one transaction —
    // otherwise a throw partway leaves the calories changed and the protein
    // not, which is a food that describes nothing that exists.
    db.exec('BEGIN');
    try {
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          db.prepare(`UPDATE foods SET ${key} = $v WHERE id = $id`)
            .run({ v: req.body[key], id });
        }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

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
// Exported for tests only. These two decide what a scan is allowed to write
// into the shared foods table, and the cost of getting either wrong is a
// plausible-looking number on the wrong scale — which is invisible by
// inspection and wrong in every meal logged against it afterwards. The test
// has to exercise THESE, not a hand-copied reimplementation that can drift.
module.exports.mapOFFProduct = mapOFFProduct;
module.exports.offUnusable   = offUnusable;
