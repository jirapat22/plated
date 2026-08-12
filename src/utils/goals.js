// Goal history: what you were aiming at on a given day, rather than what you
// are aiming at now.
//
// profile_settings stores one value per key, so every goal change rewrote the
// past. A week eaten against a 2,000 goal was re-judged against the 1,760 set
// afterwards, and turned into a shortfall that never happened. Comparisons are
// only meaningful against the target that was actually live at the time.

const KEYS = ['calorie_goal', 'protein_goal', 'carb_goal', 'fat_goal', 'fiber_goal'];

function currentGoals(db, pid) {
  const rows = db.prepare(
    `SELECT key, value FROM profile_settings WHERE profile_id = $pid AND key IN (${KEYS.map(k => `'${k}'`).join(',')})`
  ).all({ pid });
  const out = {};
  for (const k of KEYS) out[k] = null;
  for (const r of rows) {
    const v = parseFloat(r.value);
    out[r.key] = Number.isFinite(v) ? v : null;
  }
  return out;
}

const same = (a, b) => !!a && !!b && KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));

function latestRow(db, pid) {
  return db.prepare(
    'SELECT * FROM goal_history WHERE profile_id = $pid ORDER BY effective_from DESC LIMIT 1'
  ).get({ pid }) || null;
}

// Record today's goals if they differ from the most recent entry. Safe to call
// after any write that might have moved a goal — it no-ops when nothing
// changed, so callers don't have to work out whether anything did.
//
// Upserts on (profile_id, effective_from): several edits in one day collapse to
// the goal you finished the day with, which is the one that describes it.
function snapshotGoals(db, pid, today) {
  try {
    const now = currentGoals(db, pid);
    if (now.calorie_goal == null) return false;        // nothing meaningful to record yet
    const prev = latestRow(db, pid);
    if (prev && same(prev, now) && prev.effective_from <= today) return false;
    db.prepare(`
      INSERT INTO goal_history (profile_id, effective_from, calorie_goal, protein_goal, carb_goal, fat_goal, fiber_goal)
      VALUES ($pid, $d, $cal, $pro, $carb, $fat, $fib)
      ON CONFLICT(profile_id, effective_from) DO UPDATE SET
        calorie_goal = excluded.calorie_goal, protein_goal = excluded.protein_goal,
        carb_goal = excluded.carb_goal, fat_goal = excluded.fat_goal, fiber_goal = excluded.fiber_goal
    `).run({ pid, d: today, cal: now.calorie_goal, pro: now.protein_goal,
             carb: now.carb_goal, fat: now.fat_goal, fib: now.fiber_goal });
    return true;
  } catch {
    return false;                                       // never fail a write over bookkeeping
  }
}

// The goals in force on `date`: the latest entry at or before it.
//
// Before the first recorded entry there is genuinely no answer — the app wasn't
// keeping one — so this reports `recorded: false` alongside the current goals
// rather than pretending today's target applied back then. Callers that care
// about honesty (the report) say so; callers that just need a number to draw a
// ring can use it regardless.
function goalsOn(db, pid, date) {
  const row = db.prepare(`
    SELECT * FROM goal_history
    WHERE profile_id = $pid AND effective_from <= $d
    ORDER BY effective_from DESC LIMIT 1
  `).get({ pid, d: date });
  if (row) {
    return {
      recorded: true, effective_from: row.effective_from,
      calorie_goal: row.calorie_goal, protein_goal: row.protein_goal,
      carb_goal: row.carb_goal, fat_goal: row.fat_goal, fiber_goal: row.fiber_goal,
    };
  }
  return { recorded: false, effective_from: null, ...currentGoals(db, pid) };
}

module.exports = { snapshotGoals, goalsOn, currentGoals, GOAL_KEYS: KEYS };
