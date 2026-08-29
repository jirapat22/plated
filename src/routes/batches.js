const express = require('express');
const { getDb } = require('../db');
const { todayLocal, tzFor, isRealDate } = require('../utils/tz');
const { replayOf, remember, isValidClientId } = require('../utils/idempotency');

const router = express.Router();
const round1 = n => Math.round(n * 10) / 10;
// round1 that keeps a null a null. Plain round1(null) is 0, which is exactly
// the confident-zero this file now goes out of its way to avoid.
const r1n = n => (n == null ? null : round1(n));
const safeParse = s => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

// Sum whole-batch nutrition from ingredients, using the foods table as the
// source of truth (don't trust client-sent macros).
function computeTotals(db, items) {
  const get = db.prepare(`SELECT name, calories_per_100g, protein_per_100g, carbs_per_100g,
    fat_per_100g, fiber_per_100g FROM foods WHERE id = $id`);
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  // Which macros ANY ingredient actually knew. Summing `|| 0` alone cannot tell
  // "every ingredient had 0 g fiber" from "nothing in this pot recorded fiber",
  // and the difference gets frozen: the batch writes a backing food declaring
  // 0 g/100 g, and every portion logged from it stamps fiber: 0 into
  // meal_entries permanently. The session-split path in meals.js already tracks
  // this; computeTotals never did.
  const known = { protein: false, carbs: false, fat: false, fiber: false };
  const ing = [];
  for (const it of (items || [])) {
    const g = parseFloat(it.quantity_g);
    const f = it.food_id != null ? get.get({ id: it.food_id }) : null;
    if (!f || !(g > 0)) continue;
    const r = g / 100;
    t.calories += (f.calories_per_100g || 0) * r;
    t.protein  += (f.protein_per_100g  || 0) * r;
    t.carbs    += (f.carbs_per_100g    || 0) * r;
    t.fat      += (f.fat_per_100g      || 0) * r;
    t.fiber    += (f.fiber_per_100g    || 0) * r;
    for (const k of ['protein', 'carbs', 'fat', 'fiber']) {
      if (f[`${k}_per_100g`] != null) known[k] = true;
    }
    // food_id is kept so the batch can be re-opened for editing later; older
    // rows stored name+grams only and get resolved by name on read.
    ing.push({ food_id: it.food_id, name: f.name, grams: g });
  }
  // Collapse anything nothing knew to NULL before it leaves here, so callers
  // can't accidentally persist a summed zero. Calories are exempt: a batch with
  // no calorie data is rejected outright by the routes below.
  for (const k of ['protein', 'carbs', 'fat', 'fiber']) if (!known[k]) t[k] = null;
  return { t, ing, known };
}

// Shape a batch row for the client. Nutrition is stored as whole-batch totals,
// so both the per-100g density (what you need to pick a portion size) and the
// what's-left figures are derived here rather than re-done in the frontend.
function shapeBatch(b, db = null, pid = null) {
  // A stored NULL means no ingredient in this pot recorded that macro. Kept as
  // null all the way to the client so the UI can omit it rather than print a 0
  // it can't stand behind. (Rows written before computeTotals tracked this hold
  // a real 0 and are indistinguishable — only new batches get the honest null.)
  const per100 = k => (b[k] == null ? null : round1(b[k] / b.cooked_g * 100));
  const left   = k => (b[k] == null ? null : round1(b[k] * b.remaining_g / b.cooked_g));

  // Batches created before ingredients carried food_id can still be edited —
  // resolve those by name, since that's where the name came from.
  let ingredients = safeParse(b.ingredients);
  if (db && ingredients.some(i => i.food_id == null)) {
    const find = db.prepare('SELECT id FROM foods WHERE name = $n ORDER BY id ASC LIMIT 1');
    ingredients = ingredients.map(i =>
      i.food_id != null ? i : { ...i, food_id: find.get({ n: i.name })?.id ?? null });
  }

  // How big your last portion of THIS batch's food was, so the portion sheet
  // can offer it instead of a hardcoded 220g.
  const lastPortion = db && pid && b.food_id
    ? db.prepare('SELECT last_qty_g FROM profile_food_stats WHERE profile_id = $p AND food_id = $f')
        .get({ p: pid, f: b.food_id })?.last_qty_g ?? null
    : null;

  return {
    id: b.id, name: b.name, cooked_g: b.cooked_g, remaining_g: round1(b.remaining_g),
    last_portion_g: lastPortion,
    calories: b.calories, protein: b.protein, carbs: b.carbs, fat: b.fat, fiber: b.fiber,
    ingredients,
    kcal_left:     Math.round(b.calories * b.remaining_g / b.cooked_g),
    kcal_per_100g: Math.round(b.calories / b.cooked_g * 100),
    per_100g: { protein: per100('protein'), carbs: per100('carbs'), fat: per100('fat'), fiber: per100('fiber') },
    left:     { protein: left('protein'),   carbs: left('carbs'),   fat: left('fat'),   fiber: left('fiber') },
  };
}

// GET / — active batches (something still left) for this profile
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM batches WHERE profile_id = $p AND remaining_g > 1 ORDER BY created_at DESC'
    ).all({ p: req.profileId });
    res.json(rows.map(b => shapeBatch(b, db, req.profileId)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST / — create a batch + a backing food (source 'batch', kept out of search)
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { name, cooked_g, items } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const cg = parseFloat(cooked_g);
    if (!(cg > 0)) return res.status(400).json({ error: 'cooked weight must be greater than 0' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'add at least one ingredient' });

    const { t, ing } = computeTotals(db, items);
    if (t.calories <= 0) return res.status(400).json({ error: 'those ingredients have no calorie data' });

    // null in, null out — an unknown macro must not become a 0 in the food row.
    const per = k => (t[k] == null ? null : round1(t[k] / cg * 100));   // per-100g of the cooked batch
    const foodId = db.prepare(`INSERT INTO foods
      (name, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source, created_by_profile)
      VALUES ($n, $cal, $p, $c, $f, $fb, 100, 'batch', $by)`).run({
      n: name.trim(), cal: per('calories'), p: per('protein'), c: per('carbs'), f: per('fat'), fb: per('fiber'), by: req.profileId,
    }).lastInsertRowid;

    const id = db.prepare(`INSERT INTO batches
      (profile_id, name, food_id, calories, protein, carbs, fat, fiber, cooked_g, remaining_g, ingredients)
      VALUES ($p, $n, $fid, $cal, $pr, $cb, $ft, $fb, $cg, $cg, $ing)`).run({
      p: req.profileId, n: name.trim(), fid: foodId,
      // round1(null) is 0 — Math.round(null * 10) / 10 — so a bare round1 here
      // would undo the null tracking above at the last step, writing confident
      // zeros into the batch row itself.
      cal: round1(t.calories), pr: r1n(t.protein), cb: r1n(t.carbs), ft: r1n(t.fat), fb: r1n(t.fiber),
      cg, ing: JSON.stringify(ing),
    }).lastInsertRowid;

    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/portion { grams, meal_session_id?, date? } — log a portion into a
// meal and draw the batch down by that weight.
router.post('/:id/portion', (req, res) => {
  try {
    const db = getDb();
    // Draws down stock, so a replay eats the pot twice — the same hazard as
    // logging a food, and for the same reason.
    const cid = isValidClientId(req.body.client_id) ? req.body.client_id : null;
    const prior = replayOf(db, req.profileId, cid);
    if (prior) return res.status(prior.status).json(prior.body);

    const b = db.prepare('SELECT * FROM batches WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: req.profileId });
    if (!b) return res.status(404).json({ error: 'Batch not found' });

    let grams = parseFloat(req.body.grams);
    if (!(grams > 0)) return res.status(400).json({ error: 'grams must be greater than 0' });
    // Checked BEFORE the clamp below, because the clamp can produce a zero.
    // An empty batch took Math.min(anything, 0) = 0 and went on to write a 0 g,
    // 0 kcal entry — inventing a meal card for food that no longer exists — and
    // answered 201, so the UI reported it as a successful log.
    if (!(b.remaining_g > 0)) {
      return res.status(409).json({ error: `There's none of ${b.name} left — the batch is finished` });
    }
    grams = Math.min(grams, b.remaining_g);   // can't take more than is left

    const date = isRealDate(req.body.date || '')
      ? req.body.date : todayLocal(tzFor(db, req.profileId));

    // Resolve (or create) the meal session this portion goes into.
    let sid = parseInt(req.body.meal_session_id) || null;
    if (sid) {
      const own = db.prepare('SELECT 1 FROM meal_sessions WHERE id = $s AND profile_id = $p').get({ s: sid, p: req.profileId });
      if (!own) sid = null;
    }
    const r = grams / b.cooked_g;
    const m = k => round1((b[k] || 0) * r);
    const remaining = Math.max(0, round1(b.remaining_g - grams));

    // Creating the meal, logging the entry, taking the stock off and recording
    // the use are one act. Ungrouped, a failure partway left the portion logged
    // against a batch that still claimed to hold the food — free calories, and
    // a stock number nobody would think to doubt — or an empty meal session with
    // nothing in it. PATCH on this same resource already worked this way.
    //
    // ponytail: safe from double-spend only because this handler is fully
    // synchronous. node:sqlite is sync and nothing awaits between reading
    // remaining_g and writing it, so two taps cannot interleave. Introduce an
    // await in here and that stops being true — the fix then is
    // `remaining_g = MAX(0, remaining_g - $g)` computed in SQL rather than an
    // absolute value derived from a stale read.
    db.exec('BEGIN');
    try {
      if (!sid) {
        const idx = db.prepare('SELECT COALESCE(MAX(meal_index), -1) + 1 AS i FROM meal_sessions WHERE date = $d AND profile_id = $p').get({ d: date, p: req.profileId }).i;
        sid = db.prepare('INSERT INTO meal_sessions (date, name, meal_index, profile_id) VALUES ($d, $n, $i, $p)')
          .run({ d: date, n: b.name, i: idx, p: req.profileId }).lastInsertRowid;
      }

      db.prepare(`INSERT INTO meal_entries (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber)
        VALUES ($s, $f, $q, $cal, $p, $c, $ft, $fb)`).run({
        s: sid, f: b.food_id, q: round1(grams), cal: m('calories'), p: m('protein'), c: m('carbs'), ft: m('fat'), fb: m('fiber'),
      });

      db.prepare('UPDATE batches SET remaining_g = $r WHERE id = $id').run({ r: remaining, id: b.id });

      // Every other entry-creation path bumps use_count/last_used (meals.js) —
      // batch portions skipped it, so a food you eat from a batch weekly never
      // showed up under "recent" the way the same food logged manually would.
      if (b.food_id) {
        db.prepare(`
          INSERT INTO profile_food_stats (profile_id, food_id, use_count, last_used, last_qty_g)
          VALUES ($pid, $fid, 1, datetime('now'), $qty)
          ON CONFLICT(profile_id, food_id)
          DO UPDATE SET use_count = use_count + 1, last_used = datetime('now'),
                        last_qty_g = excluded.last_qty_g
        `).run({ pid: req.profileId, fid: b.food_id, qty: round1(grams) });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // logged_g is the CLAMPED amount, which can be less than what was asked for
    // when the batch is nearly empty. The client shows this figure rather than
    // the request, so "log 300g" from a batch with 90g left reads as 90g.
    const body = { logged_g: round1(grams), remaining_g: remaining };
    remember(db, req.profileId, cid, 201, body);
    res.status(201).json(body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /:id { name?, cooked_g?, items?, remaining_g? } — edit a batch. Every
// field is optional, so the same route serves both a full re-edit and the
// lightweight "⚖️ Fix" that only corrects how much is left (the tracked amount
// drifts from reality when a portion goes in at the wrong weight, some is given
// away, or a chunk gets eaten unlogged).
//
// Changing the ingredients or cooked weight re-derives the batch's nutrition
// and re-syncs the backing food's per-100g values. Portions already logged keep
// the macros they were stored with, so history stays as it was actually
// recorded — only future portions use the new numbers. Callers decide what
// happens to remaining_g on a weight change by sending it explicitly.
router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const b = db.prepare('SELECT * FROM batches WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: req.profileId });
    if (!b) return res.status(404).json({ error: 'Batch not found' });

    let name = b.name;
    if (req.body.name !== undefined) {
      name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
    }

    const cooked = req.body.cooked_g !== undefined ? parseFloat(req.body.cooked_g) : b.cooked_g;
    if (!(cooked > 0)) return res.status(400).json({ error: 'cooked weight must be greater than 0' });

    let totals = { calories: b.calories, protein: b.protein, carbs: b.carbs, fat: b.fat, fiber: b.fiber };
    let ingredients = b.ingredients;
    if (req.body.items !== undefined) {
      if (!Array.isArray(req.body.items) || !req.body.items.length) {
        return res.status(400).json({ error: 'add at least one ingredient' });
      }
      const { t, ing } = computeTotals(db, req.body.items);
      if (t.calories <= 0) return res.status(400).json({ error: 'those ingredients have no calorie data' });
      totals = { calories: round1(t.calories), protein: round1(t.protein), carbs: round1(t.carbs), fat: round1(t.fat), fiber: round1(t.fiber) };
      ingredients = JSON.stringify(ing);
    }

    const rawRemaining = req.body.remaining_g !== undefined ? parseFloat(req.body.remaining_g) : b.remaining_g;
    if (!Number.isFinite(rawRemaining) || rawRemaining < 0) {
      return res.status(400).json({ error: 'remaining_g must be 0 or more' });
    }
    const remaining = round1(Math.min(rawRemaining, cooked));

    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE batches SET name = $n, cooked_g = $cg, remaining_g = $rg,
        calories = $cal, protein = $pr, carbs = $cb, fat = $ft, fiber = $fb, ingredients = $ing
        WHERE id = $id`).run({
        n: name, cg: cooked, rg: remaining,
        cal: totals.calories, pr: totals.protein, cb: totals.carbs, ft: totals.fat, fb: totals.fiber,
        ing: ingredients, id: b.id,
      });
      if (b.food_id) {
        const per = k => (totals[k] == null ? null : round1(totals[k] / cooked * 100));
        db.prepare(`UPDATE foods SET name = $n, calories_per_100g = $cal, protein_per_100g = $p,
          carbs_per_100g = $c, fat_per_100g = $f, fiber_per_100g = $fb WHERE id = $fid`).run({
          n: name, cal: per('calories'), p: per('protein'), c: per('carbs'), f: per('fat'), fb: per('fiber'),
          fid: b.food_id,
        });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const updated = db.prepare('SELECT * FROM batches WHERE id = $id').get({ id: b.id });
    res.json(shapeBatch(updated, db, req.profileId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /:id — drop the batch; hide its backing food (logged history stays).
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const b = db.prepare('SELECT food_id FROM batches WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: req.profileId });
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    if (b.food_id) db.prepare('UPDATE foods SET hidden = 1 WHERE id = $f').run({ f: b.food_id });
    db.prepare('DELETE FROM batches WHERE id = $id').run({ id: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
// Exported for tests only. The null-vs-zero rule here is the kind that is
// invisible by inspection and expensive when wrong — it writes a backing food
// that every future portion copies from — so the test needs to exercise THIS
// function, not a hand-copied reimplementation of it that can drift silently.
module.exports.computeTotals = computeTotals;
