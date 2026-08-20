const express = require('express');
const { getDb } = require('../db');
const { todayLocal, tzFor } = require('../utils/tz');

const router = express.Router();
const round1 = n => Math.round(n * 10) / 10;

// The part of a served portion you didn't eat. Distinct from a batch: a batch
// is bulk food measured out over days, a leftover is one plated portion that
// goes back in the fridge and gets eaten in one go. That is why there is no
// remaining_g here — logging a leftover consumes all of it.

const shape = r => ({
  id: r.id, name: r.name, food_id: r.food_id,
  quantity_g: r.quantity_g == null ? null : round1(r.quantity_g),
  calories: Math.round(r.calories || 0),
  protein: round1(r.protein || 0), carbs: round1(r.carbs || 0),
  fat: round1(r.fat || 0), fiber: round1(r.fiber || 0),
  created_at: r.created_at,
});

// GET / — everything still in the fridge, newest first.
router.get('/', (req, res) => {
  try {
    res.json(getDb().prepare('SELECT * FROM leftovers WHERE profile_id = $p ORDER BY created_at DESC, id DESC')
      .all({ p: req.profileId }).map(shape));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /:id { name } — rename. Two chilli leftovers from different days look
// identical otherwise, and the point of the name is telling them apart.
router.patch('/:id', (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const info = getDb().prepare('UPDATE leftovers SET name = $n WHERE id = $id AND profile_id = $p')
      .run({ n: name.slice(0, 80), id: req.params.id, p: req.profileId });
    if (!info.changes) return res.status(404).json({ error: 'Leftover not found' });
    res.json({ success: true, name: name.slice(0, 80) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /:id — binned. Deliberately logs nothing: food you threw out is not
// food you ate, and without this the only way to clear one would be to pretend
// otherwise and put its calories into a day.
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const l = db.prepare('SELECT * FROM leftovers WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: req.profileId });
    if (!l) return res.status(404).json({ error: 'Leftover not found' });
    db.prepare('DELETE FROM leftovers WHERE id = $id AND profile_id = $p').run({ id: l.id, p: req.profileId });
    // A whole-meal leftover mints a food of its own, 1:1, hidden from search.
    // Binning the leftover leaves that food with nothing pointing at it — an
    // invisible row that accumulates one per binned plate. Only ever removes a
    // minted one that nothing references; a real food is shared and stays.
    if (l.food_id) {
      const f = db.prepare("SELECT source FROM foods WHERE id = $i").get({ i: l.food_id });
      const used = db.prepare('SELECT COUNT(*) c FROM meal_entries WHERE food_id = $i').get({ i: l.food_id }).c
        + db.prepare('SELECT COUNT(*) c FROM leftovers WHERE food_id = $i').get({ i: l.food_id }).c
        + db.prepare('SELECT COUNT(*) c FROM batches WHERE food_id = $i').get({ i: l.food_id }).c;
      if (f?.source === 'leftover' && used === 0) {
        db.prepare('DELETE FROM foods WHERE id = $i').run({ i: l.food_id });
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/log { date?, meal_session_id? } — eat it. All of it: the row is
// deleted in the same transaction that writes the entry, so a leftover can
// never be logged twice or survive a half-finished write.
router.post('/:id/log', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const l = db.prepare('SELECT * FROM leftovers WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: pid });
    if (!l) return res.status(404).json({ error: 'Leftover not found' });

    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '')
      ? req.body.date : todayLocal(tzFor(db, pid));

    let sid = parseInt(req.body?.meal_session_id) || null;
    if (sid && !db.prepare('SELECT 1 FROM meal_sessions WHERE id = $s AND profile_id = $p').get({ s: sid, p: pid })) sid = null;

    db.exec('BEGIN');
    try {
      if (!sid) {
        const idx = db.prepare('SELECT COALESCE(MAX(meal_index), -1) + 1 AS i FROM meal_sessions WHERE date = $d AND profile_id = $p')
          .get({ d: date, p: pid }).i;
        sid = db.prepare('INSERT INTO meal_sessions (date, name, meal_index, profile_id) VALUES ($d, $n, $i, $p)')
          .run({ d: date, n: l.name, i: idx, p: pid }).lastInsertRowid;
      }
      // A Quick Log leftover has no weight — that is the honest thing to store
      // and to show. But the ENTRY it creates needs one that agrees with the
      // food's per-100g, or anything that later re-derives macros from
      // food x quantity restores the whole meal instead of this slice. So the
      // weight is worked out here from the calories rather than defaulted to
      // the bookkeeping 100g.
      // The entry MUST have a food that exists. loadDay INNER JOINs foods, so a
      // dangling food_id doesn't render oddly — the row is written and then
      // never shown, and the calories quietly do not count. Belt and braces
      // alongside the export fix: whatever route left this leftover without a
      // usable food, mint one now from the macros it is carrying.
      let foodId = l.food_id;
      let food = foodId ? db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: foodId }) : null;
      if (!food) {
        const grams = l.quantity_g > 0 ? l.quantity_g : 100;
        const per = v => round1((v || 0) / grams * 100);
        foodId = db.prepare(`INSERT INTO foods
          (name, brand, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source, created_by_profile, hidden)
          VALUES ($n, NULL, $cal, $p, $c, $f, $fb, 100, 'leftover', $by, 1)`).run({
          n: l.name, cal: per(l.calories), p: per(l.protein), c: per(l.carbs),
          f: per(l.fat), fb: per(l.fiber), by: pid,
        }).lastInsertRowid;
        food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: foodId });
      }

      let q = l.quantity_g;
      if (q == null) {
        const per100 = food?.calories_per_100g;
        q = per100 > 0 ? round1((l.calories || 0) / per100 * 100) : 100;
      }
      db.prepare(`INSERT INTO meal_entries (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber)
        VALUES ($s, $f, $q, $cal, $p, $c, $ft, $fb)`).run({
        s: sid, f: foodId, q: round1(q),
        cal: l.calories, p: l.protein, c: l.carbs, ft: l.fat, fb: l.fiber,
      });
      db.prepare('DELETE FROM leftovers WHERE id = $id AND profile_id = $p').run({ id: l.id, p: pid });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    res.status(201).json({ logged: true, date, session_id: sid, calories: Math.round(l.calories || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
