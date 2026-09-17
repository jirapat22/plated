// Presets — a saved recipe, or a saved set of foods.
//
// Two kinds, one shape. A 'batch' preset is the ingredient list of something
// you cook again ("Sunday chilli": 800g mince, 400g beans, …) and using it
// opens the batch builder pre-filled, with the cooked weight left BLANK —
// the same recipe rarely cooks down to the same weight, and a stale weight
// would silently rescale every portion's macros. A 'meal' preset is a set of
// foods you eat together and using it lands them on a day.
//
// Deliberately not the old meal_templates, which were removed in July as
// unused. The difference this time is the batch half: re-logging a meal was
// already cheap (recent foods remember your last portion), but re-cooking
// meant retyping every ingredient and its weight.
const express = require('express');
const { getDb } = require('../db');
const { isRealDate, todayLocal, tzFor } = require('../utils/tz');
const { qtyError, trimName } = require('../utils/validate');
const { replayOf, remember, isValidClientId } = require('../utils/idempotency');
const { usableFood } = require('../utils/foodAccess');
const { adjustBatchStock } = require('../utils/batchStock');

const router = express.Router();

const KINDS = new Set(['batch', 'meal']);
const round1 = n => Math.round(n * 10) / 10;

// A preset with its items, food names attached for display. Items are read
// through a JOIN on foods so a food deleted out from under a preset drops the
// row rather than rendering a blank line with a live quantity.
function readPreset(db, pid, id) {
  const p = db.prepare('SELECT * FROM presets WHERE id = $id AND profile_id = $pid').get({ id, pid });
  if (!p) return null;
  p.items = db.prepare(`
    SELECT pi.id, pi.food_id, pi.quantity_g, f.name AS food_name, f.brand AS food_brand,
           f.calories_per_100g, f.protein_per_100g, f.carbs_per_100g, f.fat_per_100g, f.fiber_per_100g
    FROM preset_items pi
    JOIN foods f ON f.id = pi.food_id
    WHERE pi.preset_id = $id
    ORDER BY pi.sort, pi.id
  `).all({ id });
  // What the whole preset comes to, for the list. null in, null out: one
  // ingredient with no calorie data must not quietly make the total look exact.
  p.calories = p.items.reduce((s, i) =>
    (s == null || i.calories_per_100g == null ? null : s + i.calories_per_100g * i.quantity_g / 100), 0);
  if (p.calories != null) p.calories = round1(p.calories);
  return p;
}

// Validates and normalises the items of a create/replace. Throws with .status.
function cleanItems(db, pid, raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    const e = new Error('A preset needs at least one food'); e.status = 400; throw e;
  }
  if (raw.length > 60) {
    const e = new Error('That is more than 60 items'); e.status = 400; throw e;
  }
  const out = [];
  raw.forEach((it, i) => {
    const bad = qtyError(it?.quantity_g);
    if (bad) { const e = new Error(bad); e.status = 400; throw e; }
    // usableFood, not a bare id lookup: another profile's quick/batch/leftover
    // rows are private notes, and readPreset hands back the name and every
    // macro. This route was a second doorway to what GET /api/foods/:id gates.
    const food = usableFood(db, it.food_id, pid);
    if (!food) { const e = new Error('Food not found'); e.status = 404; throw e; }
    out.push({ food_id: food.id, quantity_g: parseFloat(it.quantity_g), sort: i });
  });
  return out;
}

// GET /api/presets — everything this profile has saved
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id FROM presets WHERE profile_id = $pid ORDER BY kind, name COLLATE NOCASE')
      .all({ pid: req.profileId });
    res.json(rows.map(r => readPreset(db, req.profileId, r.id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/presets { name, kind, items:[{food_id, quantity_g}] }
//
// One route for all three ways of making one — saved off an existing batch,
// saved off a meal you logged, or built from scratch. The client assembles the
// items; there is nothing different about them by the time they arrive, so
// three routes would be three copies of this validation.
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const name = trimName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const kind = String(req.body?.kind || '');
    if (!KINDS.has(kind)) return res.status(400).json({ error: "kind must be 'batch' or 'meal'" });

    const items = cleanItems(db, pid, req.body?.items);

    let id;
    db.exec('BEGIN');
    try {
      id = db.prepare('INSERT INTO presets (profile_id, name, kind) VALUES ($pid, $n, $k)')
        .run({ pid, n: name, k: kind }).lastInsertRowid;
      const ins = db.prepare(
        'INSERT INTO preset_items (preset_id, food_id, quantity_g, sort) VALUES ($p, $f, $q, $s)');
      for (const it of items) ins.run({ p: id, f: it.food_id, q: it.quantity_g, s: it.sort });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    res.status(201).json(readPreset(db, pid, id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/presets/:id { name?, items? } — rename, and/or replace the contents
router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const id = parseInt(req.params.id);
    const existing = db.prepare('SELECT id FROM presets WHERE id = $id AND profile_id = $pid').get({ id, pid });
    if (!existing) return res.status(404).json({ error: 'Preset not found' });

    const name = req.body?.name === undefined ? null : trimName(req.body.name);
    if (name !== null && !name) return res.status(400).json({ error: 'Name required' });
    // Items are REPLACED wholesale rather than merged. Editing one is "here is
    // the list now", and a merge would need per-row ids the client never sees.
    const items = req.body?.items === undefined ? null : cleanItems(db, pid, req.body.items);

    db.exec('BEGIN');
    try {
      if (name !== null) db.prepare('UPDATE presets SET name = $n WHERE id = $id').run({ n: name, id });
      if (items !== null) {
        db.prepare('DELETE FROM preset_items WHERE preset_id = $id').run({ id });
        const ins = db.prepare(
          'INSERT INTO preset_items (preset_id, food_id, quantity_g, sort) VALUES ($p, $f, $q, $s)');
        for (const it of items) ins.run({ p: id, f: it.food_id, q: it.quantity_g, s: it.sort });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    res.json(readPreset(db, pid, id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/presets/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const r = db.prepare('DELETE FROM presets WHERE id = $id AND profile_id = $pid')
      .run({ id: parseInt(req.params.id), pid: req.profileId });
    if (r.changes === 0) return res.status(404).json({ error: 'Preset not found' });
    res.json({ success: true });   // preset_items cascades (foreign_keys = ON)
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/presets/:id/log { date, items?, client_id } — meal presets only
//
// Writes one meal session holding every item, in one transaction, so a preset
// either lands whole or not at all. `items` is optional and overrides the saved
// quantities: the sheet lets you adjust a weight before confirming, and that
// adjustment is for today only — it does not rewrite the preset.
router.post('/:id/log', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const cid = isValidClientId(req.body?.client_id) ? req.body.client_id : null;
    const prior = replayOf(db, pid, cid, 'preset-log');
    if (prior) return res.status(prior.status).json(prior.body);

    const preset = readPreset(db, pid, parseInt(req.params.id));
    if (!preset) return res.status(404).json({ error: 'Preset not found' });
    if (preset.kind !== 'meal') {
      return res.status(400).json({ error: 'That is a batch recipe — use it from the batch builder' });
    }
    const date = isRealDate(req.body?.date || '') ? req.body.date : todayLocal(tzFor(db, pid));
    if (req.body?.date && !isRealDate(req.body.date)) {
      return res.status(400).json({ error: 'Not a real date — use YYYY-MM-DD' });
    }
    // Adjusted quantities are matched to the preset's own rows by food, so a
    // body naming a food the preset does not hold cannot smuggle in an extra.
    const override = new Map();
    if (Array.isArray(req.body?.items)) {
      for (const it of req.body.items) {
        const bad = qtyError(it?.quantity_g);
        if (bad) return res.status(400).json({ error: bad });
        override.set(parseInt(it.food_id), parseFloat(it.quantity_g));
      }
    }
    const rows = preset.items.map(i => ({ ...i, quantity_g: override.get(i.food_id) ?? i.quantity_g }));
    if (rows.length === 0) return res.status(400).json({ error: 'That preset has no foods left in it' });

    let sessionId;
    db.exec('BEGIN');
    try {
      // meal_index is the day's ordering, one past whatever is already there —
      // the same derivation POST /api/meals/sessions uses. It is NOT NULL, and
      // there is no meal_type column: the meal's identity is its name.
      const { max_idx } = db.prepare(`
        SELECT COALESCE(MAX(meal_index), 0) AS max_idx
        FROM meal_sessions WHERE date = $date AND profile_id = $pid
      `).get({ date, pid });
      sessionId = db.prepare(
        'INSERT INTO meal_sessions (date, name, meal_index, profile_id) VALUES ($date, $name, $idx, $pid)'
      ).run({ date, name: preset.name, idx: max_idx + 1, pid }).lastInsertRowid;

      const ins = db.prepare(`
        INSERT INTO meal_entries
          (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber)
        VALUES ($sid, $fid, $qty, $cal, $pro, $carb, $fat, $fib)
      `);
      const stat = db.prepare(`
        INSERT INTO profile_food_stats (profile_id, food_id, use_count, last_used, last_qty_g)
        VALUES ($pid, $fid, 1, datetime('now'), $qty)
        ON CONFLICT(profile_id, food_id)
        DO UPDATE SET use_count = use_count + 1, last_used = datetime('now'),
                      last_qty_g = excluded.last_qty_g
      `);
      // per-100g × grams, and null stays null — the same rule the rest of the
      // app follows, so a preset holding one macro-less food marks the day
      // partial rather than reporting a confident total.
      const per = (v, q) => (v == null ? null : round1(v * q / 100));
      for (const r of rows) {
        ins.run({
          sid: sessionId, fid: r.food_id, qty: r.quantity_g,
          cal: per(r.calories_per_100g, r.quantity_g), pro: per(r.protein_per_100g, r.quantity_g),
          carb: per(r.carbs_per_100g, r.quantity_g), fat: per(r.fat_per_100g, r.quantity_g),
          fib: per(r.fiber_per_100g, r.quantity_g),
        });
        stat.run({ pid, fid: r.food_id, qty: r.quantity_g });
        // A preset can hold a batch's backing food — saving a meal that
        // contained a batch portion puts one straight in — and logging it is
        // eating from the pot, exactly as /meals/log and /sessions/:id/entries
        // are. This route was the only entry-creating one that skipped the
        // draw-down, and because DELETE /entries/:id refunds unconditionally,
        // the pair MINTED grams: a 900 g pot, log a preset holding a 250 g
        // portion, pot still 900 g, delete the entry, pot 1000 g — fuller than
        // before the meal it was supposedly eaten from. Reproduced.
        adjustBatchStock(db, pid, r.food_id, -r.quantity_g);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    const out = { session_id: sessionId, date, name: preset.name, entries: rows.length };
    remember(db, pid, cid, 'preset-log', 201, out);
    res.status(201).json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
