const express = require('express');
const { getDb, canView } = require('../db');
const { todayLocal, tzFor } = require('../utils/tz');
const { goalsOn } = require('../utils/goals');

const router = express.Router();

// Resolves the effective profile id for a read: your own, or a connected
// profile's via ?profile=X (Today/History viewing only — never used by any
// write route, and never wired into weight/trends, so those stay private).
// Returns null (and writes the 403) if the caller isn't connected to X.
function resolveViewedProfile(req, res) {
  const q = req.query.profile;
  if (!q) return req.profileId;
  const targetId = parseInt(q);
  if (!canView(getDb(), req.profileId, targetId)) {
    res.status(403).json({ error: 'Not connected to that profile' });
    return null;
  }
  return targetId;
}

function round1(n) { return Math.round(n * 10) / 10; }

function calcMacros(food, qty) {
  const r = qty / 100;
  return {
    calories: food.calories_per_100g != null ? round1(food.calories_per_100g * r) : null,
    protein:  food.protein_per_100g  != null ? round1(food.protein_per_100g  * r) : null,
    carbs:    food.carbs_per_100g    != null ? round1(food.carbs_per_100g    * r) : null,
    fat:      food.fat_per_100g      != null ? round1(food.fat_per_100g      * r) : null,
    fiber:    food.fiber_per_100g    != null ? round1(food.fiber_per_100g    * r) : null,
  };
}

function sumTotals(sessions) {
  return sessions.reduce(
    (acc, s) => {
      for (const e of s.entries) {
        acc.calories += e.calories || 0;
        acc.protein  += e.protein  || 0;
        acc.carbs    += e.carbs    || 0;
        acc.fat      += e.fat      || 0;
        acc.fiber    += e.fiber    || 0;
      }
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  );
}

// A batch portion is stored as an ordinary meal_entry pointing at the batch's
// backing food, so editing or deleting that entry has to put the grams back
// into (or take them out of) the batch. Without this, fixing a mis-logged
// portion left the batch's "how much is left" permanently wrong — the entry
// was corrected but the stock never was, and nothing in the UI could reconcile
// them. deltaG is grams to give back (negative to take more out).
function adjustBatchStock(db, pid, foodId, deltaG) {
  if (!foodId || !deltaG) return;
  const b = db.prepare('SELECT id, cooked_g, remaining_g FROM batches WHERE food_id = $f AND profile_id = $p')
    .get({ f: foodId, p: pid });
  if (!b) return;                                   // not a batch food (or batch since deleted)
  const next = Math.max(0, Math.min(b.cooked_g, b.remaining_g + deltaG));
  db.prepare('UPDATE batches SET remaining_g = $r WHERE id = $id').run({ r: round1(next), id: b.id });
}

// Read the per-day logging-completeness override ('confirmed' = user said they
// genuinely ate light, so the day should count as fully logged).
function logStatus(db, date, pid) {
  return db.prepare(
    "SELECT value FROM daily_overrides WHERE profile_id = $pid AND date = $date AND key = 'log_status'"
  ).get({ pid, date })?.value || null;
}

function loadDay(db, date, pid) {
  const sessions = db.prepare(`
    SELECT * FROM meal_sessions WHERE date = $date AND profile_id = $pid ORDER BY meal_index ASC
  `).all({ date, pid });
  if (!sessions.length) return [];

  // One query for all entries across the day's sessions instead of one per
  // session (N+1). Session ids are our own integer PKs, so inlining the IN
  // list is injection-safe and avoids dynamic placeholder juggling.
  const ids = sessions.map(s => s.id);
  const entries = db.prepare(`
    SELECT me.*, f.name AS food_name, f.brand AS food_brand, f.source AS food_source,
           f.calories_per_100g, f.protein_per_100g, f.carbs_per_100g,
           f.fat_per_100g, f.fiber_per_100g, f.serving_size_g
    FROM meal_entries me
    JOIN foods f ON f.id = me.food_id
    WHERE me.meal_session_id IN (${ids.join(',')})
    ORDER BY me.logged_at ASC
  `).all();

  const bySession = {};
  for (const e of entries) (bySession[e.meal_session_id] ||= []).push(e);
  return sessions.map(s => ({ ...s, entries: bySession[s.id] || [] }));
}

// GET /api/meals/day/:date
router.get('/day/:date', (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
    }
    const pid = resolveViewedProfile(req, res);
    if (pid == null) return;
    const db = getDb();
    const sessions = loadDay(db, date, pid);
    // The goals that were live on THIS date, not the ones live now. Scrolling
    // back through History used to judge a day in July against a goal set in
    // August, turning an on-plan day into a blowout after the fact.
    res.json({
      date, sessions, totals: sumTotals(sessions),
      log_status: logStatus(db, date, pid),
      goals: goalsOn(db, pid, date),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/log-status { date, status } — mark a day's logging as
// 'confirmed' (user genuinely ate light) or clear it (status null/empty).
router.post('/log-status', (req, res) => {
  try {
    const { date, status } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
    }
    const db = getDb();
    if (status == null || status === '') {
      db.prepare("DELETE FROM daily_overrides WHERE profile_id = $pid AND date = $date AND key = 'log_status'")
        .run({ pid: req.profileId, date });
    } else {
      db.prepare("INSERT OR REPLACE INTO daily_overrides (profile_id, date, key, value) VALUES ($pid, $date, 'log_status', $status)")
        .run({ pid: req.profileId, date, status: String(status) });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meals/summary?days=30  — aggregate totals per date
router.get('/summary', (req, res) => {
  try {
    const pid = resolveViewedProfile(req, res);
    if (pid == null) return;
    // days=all lifts the window entirely (Trends' "All" range); anything else
    // clamps to ~5 years so a junk query can't ask for an unbounded scan. The
    // old 90-day ceiling meant week 13 and older were unreachable from Trends
    // no matter what the client asked for. One row per logged day, so even a
    // multi-year account is a few hundred rows.
    const all  = req.query.days === 'all';
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 1825);
    const rows = getDb().prepare(`
      SELECT
        ms.date,
        COALESCE(SUM(me.calories), 0) AS calories,
        COALESCE(SUM(me.protein),  0) AS protein,
        COALESCE(SUM(me.carbs),    0) AS carbs,
        COALESCE(SUM(me.fat),      0) AS fat,
        COALESCE(SUM(me.fiber),    0) AS fiber,
        COUNT(DISTINCT me.meal_session_id) AS meal_count,
        MAX(ovr.value) AS log_status
      FROM meal_sessions ms
      LEFT JOIN meal_entries me ON me.meal_session_id = ms.id
      LEFT JOIN daily_overrides ovr
        ON ovr.profile_id = ms.profile_id AND ovr.date = ms.date AND ovr.key = 'log_status'
      WHERE ms.profile_id = $pid ${all ? '' : 'AND ms.date >= date($today, $offset)'}
      GROUP BY ms.date
      ORDER BY ms.date ASC
    `).all(all ? { pid } : { offset: `-${days} days`, today: todayLocal(tzFor(getDb(), pid)), pid });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/meals/sessions/:id — rename and/or move date
router.patch('/sessions/:id', (req, res) => {
  try {
    const { name, date } = req.body;
    if (!name && !date) return res.status(400).json({ error: 'name or date required' });
    const db = getDb();
    const pid = req.profileId;
    const owned = db.prepare('SELECT 1 FROM meal_sessions WHERE id = $id AND profile_id = $pid')
      .get({ id: req.params.id, pid });
    if (!owned) return res.status(404).json({ error: 'Session not found' });

    if (name?.trim()) {
      db.prepare('UPDATE meal_sessions SET name = $name WHERE id = $id AND profile_id = $pid')
        .run({ name: name.trim(), id: req.params.id, pid });
    }
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      // Recalculate meal_index so it doesn't collide with existing sessions on target date
      const { max_idx } = db.prepare(
        'SELECT COALESCE(MAX(meal_index), 0) AS max_idx FROM meal_sessions WHERE date = $date AND profile_id = $pid AND id != $id'
      ).get({ date, id: req.params.id, pid });
      db.prepare('UPDATE meal_sessions SET date = $date, meal_index = $idx WHERE id = $id AND profile_id = $pid')
        .run({ date, idx: max_idx + 1, id: req.params.id, pid });
    }
    const session = db.prepare('SELECT * FROM meal_sessions WHERE id = $id').get({ id: req.params.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions — create new meal session for a date
router.post('/sessions', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const date = req.body.date || todayLocal(tzFor(db, pid));

    const { max_idx } = db.prepare(`
      SELECT COALESCE(MAX(meal_index), 0) AS max_idx
      FROM meal_sessions WHERE date = $date AND profile_id = $pid
    `).get({ date, pid });

    const meal_index = max_idx + 1;
    const name = (req.body.name?.trim()) || `Meal ${meal_index}`;
    const result = db.prepare(
      'INSERT INTO meal_sessions (date, name, meal_index, profile_id) VALUES ($date, $name, $meal_index, $pid)'
    ).run({ date, name, meal_index, pid });

    const session = db.prepare('SELECT * FROM meal_sessions WHERE id = $id')
      .get({ id: result.lastInsertRowid });
    res.status(201).json({ ...session, entries: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions/:id/copy { date?, target_session_id? }
// Copies every food in a meal to a new meal on `date`, or merges them into an
// existing meal (target_session_id). Entries are copied verbatim (same macros).
router.post('/sessions/:id/copy', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const src = db.prepare('SELECT * FROM meal_sessions WHERE id = $id AND profile_id = $p').get({ id: req.params.id, p: pid });
    if (!src) return res.status(404).json({ error: 'Meal not found' });
    const entries = db.prepare('SELECT * FROM meal_entries WHERE meal_session_id = $s').all({ s: src.id });
    if (!entries.length) return res.status(400).json({ error: 'That meal has no foods to copy' });

    let targetId = parseInt(req.body.target_session_id) || null;
    if (targetId) {
      if (targetId === src.id) return res.status(400).json({ error: 'Pick a different meal to merge into' });
      const own = db.prepare('SELECT 1 FROM meal_sessions WHERE id = $s AND profile_id = $p').get({ s: targetId, p: pid });
      if (!own) return res.status(404).json({ error: 'Target meal not found' });
    } else {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : todayLocal(tzFor(db, pid));
      const idx = db.prepare('SELECT COALESCE(MAX(meal_index), 0) + 1 AS i FROM meal_sessions WHERE date = $d AND profile_id = $p').get({ d: date, p: pid }).i;
      targetId = db.prepare('INSERT INTO meal_sessions (date, name, meal_index, profile_id) VALUES ($d, $n, $i, $p)')
        .run({ d: date, n: src.name, i: idx, p: pid }).lastInsertRowid;
    }

    // Recompute macros from each food's CURRENT nutrition data (same as the
    // single-entry POST route below) instead of copying the source entries'
    // old stored values verbatim — otherwise copying a whole meal could carry
    // forward macros for a food whose data has since been corrected, while
    // copying a single food from that same meal would not.
    const getFood = db.prepare('SELECT * FROM foods WHERE id = $id');
    const ins = db.prepare(`INSERT INTO meal_entries (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber)
      VALUES ($s, $f, $q, $cal, $p, $c, $ft, $fb)`);
    const bumpStats = db.prepare(`
      INSERT INTO profile_food_stats (profile_id, food_id, use_count, last_used, last_qty_g)
      VALUES ($pid, $fid, 1, datetime('now'), $qty)
      ON CONFLICT(profile_id, food_id)
      DO UPDATE SET use_count = use_count + 1, last_used = datetime('now'),
                    last_qty_g = excluded.last_qty_g
    `);
    for (const e of entries) {
      const food = getFood.get({ id: e.food_id });
      const m = food ? calcMacros(food, e.quantity_g) : e;   // food gone (rare) — fall back to the old snapshot
      ins.run({ s: targetId, f: e.food_id, q: e.quantity_g, cal: m.calories, p: m.protein, c: m.carbs, ft: m.fat, fb: m.fiber });
      bumpStats.run({ pid, fid: e.food_id, qty: e.quantity_g });
      // Copying a meal that contains a batch portion eats more of that batch.
      // Deleting the copy already handed grams back, so without this a
      // copy-then-delete round trip minted stock that was never taken.
      adjustBatchStock(db, pid, e.food_id, -e.quantity_g);
    }
    res.status(201).json({ session_id: targetId, copied: entries.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions/:id/entries
router.post('/sessions/:id/entries', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { food_id, quantity_g } = req.body;

    if (!food_id || !quantity_g || quantity_g <= 0) {
      return res.status(400).json({ error: 'food_id and quantity_g > 0 required' });
    }

    const session = db.prepare('SELECT * FROM meal_sessions WHERE id = $id AND profile_id = $pid')
      .get({ id, pid: req.profileId });
    if (!session) return res.status(404).json({ error: 'Meal session not found' });

    const food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: food_id });
    if (!food) return res.status(404).json({ error: 'Food not found' });

    const macros = calcMacros(food, quantity_g);
    const result = db.prepare(`
      INSERT INTO meal_entries
        (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber)
      VALUES
        ($sid, $food_id, $quantity_g, $calories, $protein, $carbs, $fat, $fiber)
    `).run({
      sid: id, food_id, quantity_g,
      calories: macros.calories, protein: macros.protein,
      carbs: macros.carbs, fat: macros.fat, fiber: macros.fiber,
    });

    // Batch foods are hidden from search, so the only way one reaches this route
    // is copying an existing portion — which is still eating the batch. DELETE
    // and PATCH both adjust stock already; creation was the missing half.
    adjustBatchStock(db, req.profileId, food_id, -quantity_g);

    db.prepare(`
      INSERT INTO profile_food_stats (profile_id, food_id, use_count, last_used, last_qty_g)
      VALUES ($pid, $fid, 1, datetime('now'), $qty)
      ON CONFLICT(profile_id, food_id)
      DO UPDATE SET use_count = use_count + 1, last_used = datetime('now'),
                    last_qty_g = excluded.last_qty_g
    `).run({ pid: req.profileId, fid: food_id, qty: quantity_g });

    const entry = db.prepare(`
      SELECT me.*, f.name AS food_name, f.brand AS food_brand, f.serving_size_g
      FROM meal_entries me
      JOIN foods f ON f.id = me.food_id
      WHERE me.id = $id
    `).get({ id: result.lastInsertRowid });

    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/meals/entries/:id — update quantity
router.patch('/entries/:id', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { quantity_g } = req.body;

    if (!quantity_g || quantity_g <= 0) {
      return res.status(400).json({ error: 'quantity_g must be > 0' });
    }

    const entry = db.prepare(`
      SELECT me.* FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      WHERE me.id = $id AND ms.profile_id = $pid
    `).get({ id, pid: req.profileId });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    // An entry can reference a food that's since gone (or was never set, e.g. a
    // batch portion restored without its backing food). calcMacros dereferences
    // it, so guard here rather than throwing a 500 the caller can't act on.
    const food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: entry.food_id });
    if (!food) return res.status(409).json({ error: "That food no longer exists — delete this entry and re-add it" });
    const macros = calcMacros(food, quantity_g);

    db.prepare(`
      UPDATE meal_entries
      SET quantity_g = $qty, calories = $calories, protein = $protein,
          carbs = $carbs, fat = $fat, fiber = $fiber
      WHERE id = $id
    `).run({ id, qty: quantity_g, ...macros });

    // Resizing a batch portion moves stock: shrinking gives grams back.
    adjustBatchStock(db, req.profileId, entry.food_id, entry.quantity_g - quantity_g);

    const updated = db.prepare(`
      SELECT me.*, f.name AS food_name, f.brand AS food_brand, f.serving_size_g
      FROM meal_entries me
      JOIN foods f ON f.id = me.food_id
      WHERE me.id = $id
    `).get({ id });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/meals/entries/:id
router.delete('/entries/:id', (req, res) => {
  try {
    const db = getDb();
    // Read the row first (rather than deleting blind) so a batch portion can
    // hand its grams back to the batch it came from.
    const entry = db.prepare(`
      SELECT me.* FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      WHERE me.id = $id AND ms.profile_id = $pid
    `).get({ id: req.params.id, pid: req.profileId });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    db.prepare('DELETE FROM meal_entries WHERE id = $id').run({ id: req.params.id });
    adjustBatchStock(db, req.profileId, entry.food_id, entry.quantity_g);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/meals/sessions/:id (cascades to entries)
router.delete('/sessions/:id', (req, res) => {
  try {
    const db = getDb();
    const owned = db.prepare('SELECT 1 FROM meal_sessions WHERE id = $id AND profile_id = $pid')
      .get({ id: req.params.id, pid: req.profileId });
    if (!owned) return res.status(404).json({ error: 'Session not found' });

    // Each portion logged from a batch goes back to that batch. This is the
    // main undo path for a mis-logged portion, since "Log a portion" puts each
    // one in its own meal — deleting that meal is how you take it back.
    const entries = db.prepare('SELECT food_id, quantity_g FROM meal_entries WHERE meal_session_id = $s')
      .all({ s: req.params.id });

    db.prepare('DELETE FROM meal_sessions WHERE id = $id AND profile_id = $pid')
      .run({ id: req.params.id, pid: req.profileId });
    for (const e of entries) adjustBatchStock(db, req.profileId, e.food_id, e.quantity_g);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
