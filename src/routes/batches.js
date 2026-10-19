const express = require('express');
const { getDb } = require('../db');
const { todayLocal, tzFor, isRealDate } = require('../utils/tz');
const { VISIBLE_SQL, UNREFERENCED_SQL } = require('../utils/foodAccess');
const { replayOf, remember, isValidClientId } = require('../utils/idempotency');

const router = express.Router();
const round1 = n => Math.round(n * 10) / 10;
// round1 that keeps a null a null. Plain round1(null) is 0, which is exactly
// the confident-zero this file now goes out of its way to avoid.
const r1n = n => (n == null ? null : round1(n));
const safeParse = s => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

// Sum whole-batch nutrition from ingredients, using the foods table as the
// source of truth (don't trust client-sent macros).
// pid: ingredients come straight off the request, so another profile's private
// quick/batch/leftover rows must not resolve here — `ing` carries f.name back
// out. An unusable id is skipped exactly like a missing one, which is what the
// loop already did for a food that had been deleted.
function computeTotals(db, items, pid) {
  const get = db.prepare(`SELECT name, calories_per_100g, protein_per_100g, carbs_per_100g,
    fat_per_100g, fiber_per_100g FROM foods WHERE id = $id AND ${VISIBLE_SQL}`);
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
    const f = it.food_id != null ? get.get({ id: it.food_id, pid }) : null;
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
  // What is actually left, floored at zero for display.
  //
  // adjustBatchStock is allowed to store a negative — that is how a
  // subtract-then-add round trip conserves instead of minting grams (see the
  // comment on it in meals.js) — but a negative has no meaning on screen, and
  // a negative kcal_left would read as food you are owed. Everything derived
  // below uses this, so the UI sees "0 g left" while the database keeps the
  // honest figure that makes the arithmetic reversible.
  const stock  = Math.max(0, b.remaining_g);
  const per100 = k => (b[k] == null ? null : round1(b[k] / b.cooked_g * 100));
  const left   = k => (b[k] == null ? null : round1(b[k] * stock / b.cooked_g));

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
    id: b.id, name: b.name, cooked_g: b.cooked_g, remaining_g: round1(stock),
    last_portion_g: lastPortion,
    calories: b.calories, protein: b.protein, carbs: b.carbs, fat: b.fat, fiber: b.fiber,
    ingredients,
    // Whether the log says more has come out than went in. The pot is not
    // "empty", it is mis-recorded, and those are different things to be told.
    overdrawn_g: b.remaining_g < 0 ? round1(-b.remaining_g) : 0,
    kcal_left:     Math.round(b.calories * stock / b.cooked_g),
    kcal_per_100g: Math.round(b.calories / b.cooked_g * 100),
    per_100g: { protein: per100('protein'), carbs: per100('carbs'), fat: per100('fat'), fiber: per100('fiber') },
    left:     { protein: left('protein'),   carbs: left('carbs'),   fat: left('fat'),   fiber: left('fiber') },
  };
}

// GET / — every batch this profile has, emptied ones included.
//
// The filter was `remaining_g > 1`, and this is the ONLY batch list the client
// has — every other batch route needs an id that only this supplies. So the
// moment a pot read 0, whether because it really was finished or because a
// portion went in at the wrong weight, it vanished: no ⚖️ Fix to correct it,
// no edit, no delete, and no way to log from it, while the food was still in
// the fridge. Reproduced by over-drawing one.
//
// "Is there anything left" is a question about presentation, and it is now
// answered where presentation happens: the Batches tab shows an emptied pot
// with its Fix and Delete buttons, and the food-search picker filters them out
// because you cannot eat from an empty one.
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT * FROM batches WHERE profile_id = $p ORDER BY created_at DESC'
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

    const { t, ing } = computeTotals(db, items, req.profileId);
    if (t.calories <= 0) return res.status(400).json({ error: 'those ingredients have no calorie data' });

    // null in, null out — an unknown macro must not become a 0 in the food row.
    const per = k => (t[k] == null ? null : round1(t[k] / cg * 100));   // per-100g of the cooked batch
    // The food and the batch are one act. Unwrapped, a failure between them
    // left a source='batch' food with nothing pointing at it — and no sweep
    // anywhere touched 'batch' until now.
    let id, foodId;
    db.exec('BEGIN');
    try {
    foodId = db.prepare(`INSERT INTO foods
      (name, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source, created_by_profile)
      VALUES ($n, $cal, $p, $c, $f, $fb, 100, 'batch', $by)`).run({
      n: name.trim(), cal: per('calories'), p: per('protein'), c: per('carbs'), f: per('fat'), fb: per('fiber'), by: req.profileId,
    }).lastInsertRowid;

    id = db.prepare(`INSERT INTO batches
      (profile_id, name, food_id, calories, protein, carbs, fat, fiber, cooked_g, remaining_g, ingredients)
      VALUES ($p, $n, $fid, $cal, $pr, $cb, $ft, $fb, $cg, $cg, $ing)`).run({
      p: req.profileId, n: name.trim(), fid: foodId,
      // round1(null) is 0 — Math.round(null * 10) / 10 — so a bare round1 here
      // would undo the null tracking above at the last step, writing confident
      // zeros into the batch row itself.
      cal: round1(t.calories), pr: r1n(t.protein), cb: r1n(t.carbs), ft: r1n(t.fat), fb: r1n(t.fiber),
      cg, ing: JSON.stringify(ing),
    }).lastInsertRowid;
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    res.status(201).json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/portion { grams, meal_session_id?, date? } — log a portion into a
// meal and draw the batch down by that weight.
// GET /:id/portions — the portions logged against this pot, newest first.
//
// Exists for one question: "⚖️ Fix says 400 g came out that I never logged —
// which portion was wrong?" Fix could always correct the pot, but the grams it
// reconciled never reached the diary, so a 900 g pot weighed down to 200 g left
// 1,520 kcal unlogged with nothing flagging it (overdrawn_g stays 0, because
// the pot's own number is now right). To offer "my last portion was wrong"
// the sheet has to know which entry that was.
//
// Scoped twice: the batch must be this profile's, and so must the session each
// entry hangs off. Without the second one a batch id would read entries out of
// another profile's day — the food row is shared, the days are not.
router.get('/:id/portions', (req, res) => {
  try {
    const db = getDb();
    const b = db.prepare('SELECT id, food_id FROM batches WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: req.profileId });
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    // A pot with no backing food has no portions to find, and that is not an
    // error — pre-food_id batches exist.
    if (!b.food_id) return res.json([]);
    res.json(db.prepare(`
      SELECT me.id, me.quantity_g, me.calories, ms.date, ms.name AS meal_name
      FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      WHERE me.food_id = $f AND ms.profile_id = $p
      ORDER BY ms.date DESC, me.id DESC
      LIMIT 5
    `).all({ f: b.food_id, p: req.profileId }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/portion', (req, res) => {
  try {
    const db = getDb();
    // Draws down stock, so a replay eats the pot twice — the same hazard as
    // logging a food, and for the same reason.
    const cid = isValidClientId(req.body.client_id) ? req.body.client_id : null;
    const prior = replayOf(db, req.profileId, cid, 'batch-portion');
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
    // null in, null out. `(b[k] || 0)` was the same defect the PATCH route had:
    // a pot whose protein nobody recorded wrote 0 onto every portion's entry,
    // and because the entry then HAS a value, sumTotals stopped marking the day
    // partial — so the day reported "0 g protein" as a measurement. Found by a
    // test written for the PATCH fix, one route over.
    const m = k => (b[k] == null ? null : round1(b[k] * r));
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
        const idx = db.prepare('SELECT COALESCE(MAX(meal_index), 0) + 1 AS i FROM meal_sessions WHERE date = $d AND profile_id = $p').get({ d: date, p: req.profileId }).i;
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
    remember(db, req.profileId, cid, 'batch-portion', 201, body);
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
      const { t, ing } = computeTotals(db, req.body.items, req.profileId);
      if (t.calories <= 0) return res.status(400).json({ error: 'those ingredients have no calorie data' });
      // r1n on the macros, not round1 — the same distinction POST makes, and
      // for the same reason: round1(null) is 0, because Math.round(null * 10)
      // is 0. This line used round1, so EDITING a batch re-derived its honest
      // nulls into confident zeros, wrote them into the backing food a few
      // lines below, and every portion logged afterwards carried them. The day
      // then reported "0 g protein" with totals_partial.protein === false —
      // i.e. as a measurement — about food nobody has protein data for.
      // Reproduced: a calories-only batch went from per_100g all-null at
      // creation to all-zero after one PATCH.
      totals = { calories: round1(t.calories), protein: r1n(t.protein), carbs: r1n(t.carbs), fat: r1n(t.fat), fiber: r1n(t.fiber) };
      ingredients = JSON.stringify(ing);
    }

    // Validate what the CALLER sent, not what is already stored.
    //
    // This checked the resolved value, which falls back to b.remaining_g when
    // the field is absent — and since a9373d9 that value is allowed to be
    // negative, because storing the honest overdraw is what makes
    // subtract-then-add conserve grams instead of minting them. So a batch in
    // exactly the state the overdrawn warning exists to describe rejected every
    // edit that did not happen to mention remaining_g. The edit sheet only
    // sends it when the cooked weight changes, so renaming an overdrawn pot, or
    // correcting the ingredient that caused the overdraw, came back 400
    // "remaining_g must be 0 or more" — about a field the user never touched,
    // on the one pot they had just been told to go and fix. Reproduced.
    //
    // A stored negative therefore rides through an unrelated edit untouched,
    // which is also the truth: the pot is still over-drawn after a rename.
    if (req.body.remaining_g !== undefined && !(parseFloat(req.body.remaining_g) >= 0)) {
      return res.status(400).json({ error: 'remaining_g must be 0 or more' });
    }
    const rawRemaining = req.body.remaining_g !== undefined ? parseFloat(req.body.remaining_g) : b.remaining_g;
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
    // Both writes together, and the backing food goes when nothing needs it.
    //
    // The food was only ever HIDDEN, so history keeps rendering — which is
    // right while a logged portion still points at it. When none does, hiding
    // leaves an invisible row per binned pot forever. The DELETE after it is a
    // no-op in the common case (a portion is referencing it), so this is not a
    // change of behaviour for any pot you have eaten from.
    db.exec('BEGIN');
    try {
      if (b.food_id) db.prepare('UPDATE foods SET hidden = 1 WHERE id = $f').run({ f: b.food_id });
      db.prepare('DELETE FROM batches WHERE id = $id').run({ id: req.params.id });
      if (b.food_id) {
        db.prepare(`DELETE FROM foods
          WHERE id = $f AND source = 'batch' AND created_by_profile = $p AND ${UNREFERENCED_SQL}`)
          .run({ f: b.food_id, p: req.profileId });
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
// Exported for tests only. The null-vs-zero rule here is the kind that is
// invisible by inspection and expensive when wrong — it writes a backing food
// that every future portion copies from — so the test needs to exercise THIS
// function, not a hand-copied reimplementation of it that can drift silently.
module.exports.computeTotals = computeTotals;
