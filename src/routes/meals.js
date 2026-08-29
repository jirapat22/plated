const express = require('express');
const { getDb, canView } = require('../db');
const { todayLocal, tzFor, isRealDate } = require('../utils/tz');
const { goalsOn, stampGoals } = require('../utils/goals');
const { replayOf, remember, isValidClientId } = require('../utils/idempotency');

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

// One sitting, in grams. There was a floor but no ceiling, so quantity_g
// 1000000000 was accepted and wrote a 5,189,000,000 kcal entry — which then
// counted in the day total, the 7-day average, the real-maintenance estimate
// behind Trends' verdict, and every chart, with nothing to say where it came
// from. 20 kg is far past any real portion and well short of a slipped decimal
// point, which is the mistake this catches.
const MAX_QTY_G = 20000;
function qtyError(value) {
  const q = parseFloat(value);
  if (!(q > 0)) return 'quantity_g > 0 required';
  if (q > MAX_QTY_G) return `That's over ${MAX_QTY_G.toLocaleString('en-NZ')} g in one go — check the decimal point`;
  return null;
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
    if (!isRealDate(date)) {
      return res.status(400).json({ error: 'Not a real date — use YYYY-MM-DD' });
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
      // Goals only for your own day. History tells the viewer in as many words
      // that someone else's goals stay private, and then renders their meals
      // without a goal bar — but the payload carried the goals regardless, so
      // the promise held only as far as the UI. One curl went round it.
      goals: pid === req.profileId ? goalsOn(db, pid, date) : null,
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
    if (!isRealDate(date || '')) {
      return res.status(400).json({ error: 'Not a real date — use YYYY-MM-DD' });
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

    // The calorie goal that was in force on each date, so Trends can judge a
    // day by what you were aiming at THEN. It only had today's goal, so after
    // the 4 Aug change from 2100 to 1760 every June day was scored against a
    // target that did not exist yet — days eaten on plan at 2100 counted as
    // under-logged, held streaks together, and drew the weekly goal marker at
    // the wrong height. The day route has always done this properly through
    // goalsOn; the one view that spans a goal change was the one flying blind.
    //
    // Resolved in JS from a single ordered read rather than calling goalsOn per
    // row: that is one query per day, and this route serves five years of them.
    // Both lists are ascending, so one pointer walks them together.
    const hist = getDb().prepare(
      `SELECT effective_from, calorie_goal FROM goal_history
       WHERE profile_id = $pid AND calorie_goal IS NOT NULL
       ORDER BY effective_from ASC`
    ).all({ pid });
    res.json(stampGoals(rows, hist));
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
      if (!isRealDate(date)) return res.status(400).json({ error: 'Not a real date — use YYYY-MM-DD' });
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
    // Replayed, this would mint "Meal 2", "Meal 3" for the same intent.
    const cid = isValidClientId(req.body.client_id) ? req.body.client_id : null;
    const prior = replayOf(db, pid, cid);
    if (prior) return res.status(prior.status).json(prior.body);
    // The one write route that took its date on trust. Every other one
    // format-checks, and for good reason: meal_sessions.date is the key every
    // read is looked up by, so a junk string creates a meal that no day view,
    // summary or export can ever reach again — invisible, undeletable, and
    // still counted by anything that aggregates without a date filter.
    if (req.body.date != null && !isRealDate(req.body.date)) {
      return res.status(400).json({ error: 'Not a real date — use YYYY-MM-DD' });
    }
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
    const created = { ...session, entries: [] };
    remember(db, pid, cid, 201, created);
    res.status(201).json(created);
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
      const date = isRealDate(req.body.date || '') ? req.body.date : todayLocal(tzFor(db, pid));
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

// POST /api/meals/entries/:id/leftover { left_g | left_kcal, to_batch? }
// "I served this and didn't finish it." Splits one logged entry in two: the
// part you ate stays in the log, and the rest becomes a leftover.
//
// You say what is LEFT, not what you ate — that is the number you get by
// putting the container back on the scale, which is the moment this happens.
//
// Today and yesterday only. Older days can still be edited entry-by-entry; what
// they cannot do is mint a leftover, because a portion you "saved" four days ago
// is not in the fridge, and marking it would move a day the 28-day average and
// any exported report have already counted.
//
// to_batch decides where the remainder goes when the food backs a batch: into
// the pot (its remaining_g goes back up) or out as a separate plated portion.
// The batch move is explicit here rather than inherited: PATCH /entries/:id
// hands grams back automatically on any shrink, which is right for a correction
// and wrong for this — the food left the pot and is sitting in a container.
router.post('/entries/:id/leftover', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const entry = db.prepare(`
      SELECT me.*, ms.date, f.name AS food_name, f.source AS food_source
      FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      LEFT JOIN foods f ON f.id = me.food_id
      WHERE me.id = $id AND ms.profile_id = $pid
    `).get({ id: req.params.id, pid });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const today = todayLocal(tzFor(db, pid));
    const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    if (entry.date !== today && entry.date !== yesterday) {
      return res.status(400).json({ error: "Leftovers can only be saved from today or yesterday — edit the entry instead" });
    }

    // A Quick Log stores the calories you typed against a bookkeeping 100g, so
    // its size is calories, not weight. Anything else is weighed.
    const isQuick = entry.food_source === 'quick';
    const whole = isQuick ? (entry.calories || 0) : (entry.quantity_g || 0);
    const left  = parseFloat(isQuick ? req.body?.left_kcal : req.body?.left_g);
    if (!(whole > 0)) return res.status(400).json({ error: 'That entry has nothing to split' });
    if (!(left > 0))  return res.status(400).json({ error: isQuick ? 'left_kcal must be greater than 0' : 'left_g must be greater than 0' });
    if (left >= whole) {
      return res.status(400).json({ error: "That's the whole thing — delete the entry instead of leaving all of it" });
    }
    // And enough of it has to survive rounding to be worth a row on the list.
    if (Math.round((entry.calories || 0) * (left / whole)) < 1) {
      return res.status(400).json({ error: "That's too little to save — it rounds to nothing" });
    }

    const keepRatio = (whole - left) / whole;          // the share you actually ate
    const slice = (v, r) => (v == null ? null : round1(v * r));
    const eaten = {
      calories: slice(entry.calories, keepRatio), protein: slice(entry.protein, keepRatio),
      carbs: slice(entry.carbs, keepRatio), fat: slice(entry.fat, keepRatio), fiber: slice(entry.fiber, keepRatio),
      // Scaled for BOTH kinds. For a weighed food this is just whole - left.
      // For a Quick Log it is the bookkeeping 100g scaled down, and it has to
      // be: leaving it at 100 while cutting the calories makes the entry
      // disagree with its own food, and every path that re-derives macros from
      // food x quantity then restores the full amount. Measured: split an 1,800
      // Quick Log to 1,200, copy the meal, and the copy came back 1,800.
      quantity_g: round1((entry.quantity_g || 0) * keepRatio),
    };
    const overRatio = 1 - keepRatio;
    const over = {
      calories: slice(entry.calories, overRatio), protein: slice(entry.protein, overRatio),
      carbs: slice(entry.carbs, overRatio), fat: slice(entry.fat, overRatio), fiber: slice(entry.fiber, overRatio),
      quantity_g: isQuick ? null : round1(left),
    };

    const toBatch = req.body?.to_batch === true && !!entry.food_id
      && !!db.prepare('SELECT 1 FROM batches WHERE food_id = $f AND profile_id = $p').get({ f: entry.food_id, p: pid });

    let leftoverId = null;
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE meal_entries SET quantity_g = $q, calories = $cal, protein = $p,
        carbs = $c, fat = $ft, fiber = $fb WHERE id = $id`).run({
        id: entry.id, q: eaten.quantity_g, cal: eaten.calories, p: eaten.protein,
        c: eaten.carbs, ft: eaten.fat, fb: eaten.fiber,
      });

      if (toBatch) {
        adjustBatchStock(db, pid, entry.food_id, left);   // straight back in the pot
      } else {
        leftoverId = db.prepare(`INSERT INTO leftovers (profile_id, name, food_id, quantity_g, calories, protein, carbs, fat, fiber)
          VALUES ($p, $n, $f, $q, $cal, $pr, $c, $ft, $fb)`).run({
          p: pid, n: String(entry.food_name || 'Leftover').slice(0, 80), f: entry.food_id,
          q: over.quantity_g, cal: over.calories, pr: over.protein, c: over.carbs, ft: over.fat, fb: over.fiber,
        }).lastInsertRowid;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    res.status(201).json({
      entry_id: entry.id, leftover_id: leftoverId, to_batch: toBatch,
      ate: isQuick ? { calories: eaten.calories } : { quantity_g: eaten.quantity_g },
      saved: isQuick ? { calories: over.calories } : { quantity_g: over.quantity_g },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions/:id/leftover { ate }  — ate is 0..1
// "I didn't finish this plate." Scales every food in the meal by the share you
// ate and saves the rest as ONE leftover, because it went into one container.
//
// A fraction, not a weight: you can weigh one food back, but not a mixed plate
// per-food. The cost is that it assumes you ate the same share of everything —
// finish the chicken and leave the rice and this will not know. That case is
// what the per-entry split is for, and it stays the accurate tool.
//
// The combined leftover gets a backing food minted for it, the same way a batch
// does. It has to: loadDay INNER JOINs foods, so an entry with a null food_id
// does not merely render oddly, it disappears from the day and takes its
// calories with it. Density comes from the remainder itself, so the entry this
// eventually creates agrees with its own food.
router.post('/sessions/:id/leftover', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const s = db.prepare('SELECT * FROM meal_sessions WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: pid });
    if (!s) return res.status(404).json({ error: 'Meal not found' });

    const today = todayLocal(tzFor(db, pid));
    const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    if (s.date !== today && s.date !== yesterday) {
      return res.status(400).json({ error: "Leftovers can only be saved from today or yesterday" });
    }

    const ate = parseFloat(req.body?.ate);
    if (!(ate > 0 && ate < 1)) {
      return res.status(400).json({ error: 'ate must be between 0 and 1 — eating none of it means deleting the meal, and all of it means nothing is left' });
    }

    const entries = db.prepare('SELECT * FROM meal_entries WHERE meal_session_id = $s').all({ s: s.id });
    if (!entries.length) return res.status(400).json({ error: 'That meal has no foods in it' });

    const rest = 1 - ate;
    const tot = { quantity_g: 0, calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    // Whether ANY food in the meal knew this macro. Summing with (e[k] || 0)
    // makes an unknown look like a zero, and the leftover then asserts "0g
    // fiber" about food whose fiber nobody knows — the turning-unknown-into-a-
    // confident-number this app keeps having to unlearn. The per-entry split
    // already preserves null via slice(); this path did not, and the two must
    // agree. Partial knowledge still reports the sum: one food known and one
    // unknown is "at least this much", which is what sumTotals does elsewhere.
    const known = { protein: false, carbs: false, fat: false, fiber: false };
    for (const e of entries) {
      for (const k in tot) tot[k] += (e[k] || 0) * rest;
      for (const k in known) if (e[k] != null) known[k] = true;
    }
    const kept = k => (known[k] ? round1(tot[k]) : null);
    // Has to round to at least one whole calorie. At ate = 0.999 the remainder
    // was 0.7 kcal, which passed a bare > 0 and produced a leftover displaying
    // as "1 kcal" plus a minted food to back it — a row that costs more to
    // clear than it describes.
    if (!(Math.round(tot.calories) >= 1)) {
      return res.status(400).json({ error: 'There is nothing measurable left of that meal' });
    }

    const name = String(s.name || 'Meal').slice(0, 80);
    let leftoverId = null;
    db.exec('BEGIN');
    try {
      const upd = db.prepare(`UPDATE meal_entries SET quantity_g = $q, calories = $cal, protein = $p,
        carbs = $c, fat = $ft, fiber = $fb WHERE id = $id`);
      for (const e of entries) {
        upd.run({
          id: e.id, q: round1((e.quantity_g || 0) * ate), cal: round1((e.calories || 0) * ate),
          p: e.protein == null ? null : round1(e.protein * ate),
          c: e.carbs   == null ? null : round1(e.carbs   * ate),
          ft: e.fat    == null ? null : round1(e.fat     * ate),
          fb: e.fiber  == null ? null : round1(e.fiber   * ate),
        });
      }

      // Grams can be fictional when the meal contained a Quick Log, so derive
      // the density from whatever the remainder actually is rather than
      // assuming a real weight. 100g keeps the per-100g maths coherent when
      // there is no weight at all.
      const grams = tot.quantity_g > 0 ? round1(tot.quantity_g) : 100;
      const per = v => round1(v / grams * 100);
      const foodId = db.prepare(`INSERT INTO foods
        (name, brand, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source, created_by_profile, hidden)
        VALUES ($n, NULL, $cal, $p, $c, $f, $fb, 100, 'leftover', $by, 1)`).run({
        n: name, cal: per(tot.calories),
        p: known.protein ? per(tot.protein) : null, c: known.carbs ? per(tot.carbs) : null,
        f: known.fat ? per(tot.fat) : null, fb: known.fiber ? per(tot.fiber) : null, by: pid,
      }).lastInsertRowid;

      leftoverId = db.prepare(`INSERT INTO leftovers (profile_id, name, food_id, quantity_g, calories, protein, carbs, fat, fiber)
        VALUES ($p, $n, $f, $q, $cal, $pr, $c, $ft, $fb)`).run({
        p: pid, n: name, f: foodId,
        q: tot.quantity_g > 0 ? round1(tot.quantity_g) : null,
        cal: round1(tot.calories), pr: kept('protein'), c: kept('carbs'),
        ft: kept('fat'), fb: kept('fiber'),
      }).lastInsertRowid;
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    res.status(201).json({
      leftover_id: leftoverId, name, foods: entries.length,
      saved: { calories: Math.round(tot.calories), quantity_g: tot.quantity_g > 0 ? round1(tot.quantity_g) : null },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions/:id/merge { target_session_id }
// Fold this meal's foods into another meal; this one stops existing.
//
// The move counterpart of /copy's target_session_id branch, and deliberately a
// fraction of its size, because a merge CREATES nothing. The entries are
// re-parented, not duplicated. That is why none of copy's bookkeeping belongs
// here: no macro recomputation (these rows already exist and keep the values
// they were logged with), no profile_food_stats bump, and — the one that would
// actually corrupt data — no adjustBatchStock. Copy has to draw stock down
// because a copied batch portion is a second helping. Merging is the same
// helping filed under a different heading, and charging the batch again would
// invent grams nobody ate.
//
// Order matters inside the transaction: re-parent first, then delete. The other
// way round, meal_entries' ON DELETE CASCADE takes the entries with it.
router.post('/sessions/:id/merge', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const src = db.prepare('SELECT * FROM meal_sessions WHERE id = $id AND profile_id = $p')
      .get({ id: req.params.id, p: pid });
    if (!src) return res.status(404).json({ error: 'Meal not found' });

    const targetId = parseInt(req.body.target_session_id) || null;
    if (!targetId) return res.status(400).json({ error: 'target_session_id required' });
    if (targetId === src.id) return res.status(400).json({ error: 'Pick a different meal to merge into' });
    const target = db.prepare('SELECT * FROM meal_sessions WHERE id = $s AND profile_id = $p')
      .get({ s: targetId, p: pid });
    if (!target) return res.status(404).json({ error: 'Target meal not found' });

    let merged = 0;
    db.exec('BEGIN');
    try {
      merged = db.prepare('UPDATE meal_entries SET meal_session_id = $t WHERE meal_session_id = $s')
        .run({ t: targetId, s: src.id }).changes;
      db.prepare('DELETE FROM meal_sessions WHERE id = $s AND profile_id = $p').run({ s: src.id, p: pid });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    res.json({ session_id: targetId, merged, date: target.date, name: target.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/log — log a food in ONE request.
//
// Exists because logging was a chain: create the session, then add the entry —
// and a Quick Log was three, since it mints a food first. Each link needs an id
// the previous one returned, which is fine online and impossible in a queue: a
// device with no signal cannot hold "add this to session 47" when 47 does not
// exist yet and never will.
//
// So the whole intent travels together and the server resolves the ids. That
// also collapses the ordinary online path from two or three round trips to one,
// which on mobile data is the difference people actually feel.
//
// Either `food_id` (something already in the library) or `quick` (a description
// and a calorie figure you couldn't weigh). Everything runs in one transaction,
// so a failure halfway cannot leave a session with no meal in it.
router.post('/log', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;

    const cid = isValidClientId(req.body.client_id) ? req.body.client_id : null;
    const prior = replayOf(db, pid, cid);
    if (prior) return res.status(prior.status).json(prior.body);

    const { food_id, quick, quantity_g, session_id, meal_name } = req.body || {};
    if (req.body.date != null && !isRealDate(req.body.date)) {
      return res.status(400).json({ error: 'Not a real date — use YYYY-MM-DD' });
    }
    const date = req.body.date || todayLocal(tzFor(db, pid));
    const qty = parseFloat(quantity_g);
    const qtyBad = qtyError(quantity_g);
    if (qtyBad) return res.status(400).json({ error: qtyBad });
    if (!food_id && !quick) return res.status(400).json({ error: 'food_id or quick required' });
    if (quick && !String(quick.name ?? '').trim()) {
      return res.status(400).json({ error: 'Enter a meal description' });
    }
    if (quick && !(parseFloat(quick.calories_per_100g) > 0)) {
      return res.status(400).json({ error: 'Enter the calories' });
    }

    let out;
    db.exec('BEGIN');
    try {
      // 1. The food. A quick log mints its own — deliberately not deduped, the
      //    way POST /api/foods also skips dedup for source 'quick': two dinners
      //    described the same way on different nights are two meals, not one
      //    library entry being reused.
      let fid = food_id;
      if (!fid) {
        const n = v => (v === '' || v == null ? null : Number(v));
        fid = db.prepare(`INSERT INTO foods
          (name, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g,
           serving_size_g, source, created_by_profile)
          VALUES ($n, $cal, $p, $c, $f, $fb, 100, 'quick', $by)`).run({
          n: String(quick.name).trim(), cal: n(quick.calories_per_100g),
          p: n(quick.protein_per_100g), c: n(quick.carbs_per_100g),
          f: n(quick.fat_per_100g), fb: n(quick.fiber_per_100g), by: pid,
        }).lastInsertRowid;
      }
      const food = db.prepare('SELECT * FROM foods WHERE id = $id').get({ id: fid });
      if (!food) throw Object.assign(new Error('Food not found'), { status: 404 });

      // 2. The session. An explicit session_id is honoured only if it is yours
      //    and on this date — a queued write can carry an id that has since been
      //    deleted, and silently logging into someone else's meal is worse than
      //    starting a new one.
      let sid = parseInt(session_id) || null;
      if (sid) {
        const s = db.prepare('SELECT id FROM meal_sessions WHERE id = $id AND profile_id = $p AND date = $d')
          .get({ id: sid, p: pid, d: date });
        if (!s) sid = null;
      }
      if (!sid) {
        const idx = db.prepare(
          'SELECT COALESCE(MAX(meal_index), 0) + 1 AS i FROM meal_sessions WHERE date = $d AND profile_id = $p'
        ).get({ d: date, p: pid }).i;
        sid = db.prepare('INSERT INTO meal_sessions (date, name, meal_index, profile_id) VALUES ($d, $n, $i, $p)')
          .run({ d: date, n: String(meal_name ?? '').trim() || `Meal ${idx}`, i: idx, p: pid }).lastInsertRowid;
      }

      // 3. The entry, plus the same bookkeeping the per-entry route does.
      const m = calcMacros(food, qty);
      const eid = db.prepare(`INSERT INTO meal_entries
        (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber)
        VALUES ($s, $f, $q, $cal, $p, $c, $ft, $fb)`).run({
        s: sid, f: fid, q: qty, cal: m.calories, p: m.protein, c: m.carbs, ft: m.fat, fb: m.fiber,
      }).lastInsertRowid;

      adjustBatchStock(db, pid, fid, -qty);
      db.prepare(`INSERT INTO profile_food_stats (profile_id, food_id, use_count, last_used, last_qty_g)
        VALUES ($p, $f, 1, datetime('now'), $q)
        ON CONFLICT(profile_id, food_id)
        DO UPDATE SET use_count = use_count + 1, last_used = datetime('now'), last_qty_g = excluded.last_qty_g`)
        .run({ p: pid, f: fid, q: qty });

      out = {
        session_id: sid, date,
        entry: db.prepare(`SELECT me.*, f.name AS food_name, f.brand AS food_brand, f.serving_size_g
          FROM meal_entries me JOIN foods f ON f.id = me.food_id WHERE me.id = $id`).get({ id: eid }),
      };
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (e.status === 404) return res.status(404).json({ error: e.message });
      throw e;
    }

    remember(db, pid, cid, 201, out);
    res.status(201).json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meals/sessions/:id/entries
router.post('/sessions/:id/entries', (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { food_id, quantity_g, client_id } = req.body;

    // Before anything else: has this exact write already been done? This route
    // is the sharpest case for it — it inserts an entry, draws down batch stock
    // and bumps a use count, and only the first of those is visible enough to
    // notice and undo.
    const cid = isValidClientId(client_id) ? client_id : null;
    const prior = replayOf(db, req.profileId, cid);
    if (prior) return res.status(prior.status).json(prior.body);

    if (!food_id) return res.status(400).json({ error: 'food_id and quantity_g > 0 required' });
    const addBad = qtyError(quantity_g);
    if (addBad) return res.status(400).json({ error: addBad });

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

    remember(db, req.profileId, cid, 201, entry);
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

    const editBad = qtyError(quantity_g);
    if (editBad) return res.status(400).json({ error: editBad });

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
