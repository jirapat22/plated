// Macro goals derived from bodyweight ("g per kg") rather than a % of the
// calorie goal. In this mode protein and fat are multiples of bodyweight and
// carbs take whatever calories are left, so the goals have to be re-derived
// whenever the weight or the calorie goal moves — see recalcMacroGoals.

const { localDayOf, tzFor } = require('./tz');

const KCAL = { protein: 4, carbs: 4, fat: 9 };
const TREND_WINDOW = 7;
// Only weigh-ins this recent are averaged. stats.js guards the frontend copy
// the same way ("a week you never stepped on the scale inherits a stale
// average, and reports 'no change', which is a different claim from 'no
// data'") — but this is the copy that WRITES your macro goals, and it had no
// such guard. Come back after two months away, log once, and your protein
// target was set from the mean of that reading and six from before the break.
const TREND_MAX_AGE_DAYS = 30;

function getSetting(db, pid, key) {
  return db.prepare('SELECT value FROM profile_settings WHERE profile_id = $p AND key = $k')
    .get({ p: pid, k: key })?.value;
}

function setSetting(db, pid, key, value) {
  db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($p, $k, $v)')
    .run({ p: pid, k: key, v: String(value) });
}

// Smoothed bodyweight: mean of the last 7 weigh-ins, one per date (a same-day
// re-log shouldn't count twice). Mirrors movingAvg() in public/js/utils/stats.js
// — Today and Trends show this same number, so the goal matches what the user
// sees rather than yesterday's raw reading. Falls back to the bodyweight synced
// from IronLog when there are no weigh-ins yet.
function trendWeight(db, pid) {
  const pick = db.prepare(`
    SELECT weight_kg FROM (
      SELECT date, weight_kg FROM weight_log
      WHERE profile_id = $p
        AND id IN (SELECT MAX(id) FROM weight_log WHERE profile_id = $p GROUP BY date)
        AND ($since IS NULL OR date >= $since)
      ORDER BY date DESC LIMIT $n
    ) ORDER BY date ASC
  `);
  // weight_log.date is a LOCAL calendar day, so the cutoff has to be one too.
  // toISOString() gives the UTC day — behind local by one for half of every day
  // in NZ — which quietly made this a 31-day window rather than 30.
  const since = localDayOf(new Date(Date.now() - TREND_MAX_AGE_DAYS * 864e5).toISOString(), tzFor(db, pid));

  const rows = pick.all({ p: pid, n: TREND_WINDOW, since });
  if (rows.length) return rows.reduce((s, r) => s + r.weight_kg, 0) / rows.length;

  // Nothing recent. Fall back to the single most recent weigh-in rather than
  // returning null: null makes recalcMacroGoals a no-op, and then changing your
  // calorie goal would leave carbs still absorbing the OLD one, so the macros
  // stop adding up to the target shown above them. One stale reading is a
  // better basis than a stale average, and far better than an incoherent split.
  const last = pick.all({ p: pid, n: 1, since: null });
  if (last.length) return last[0].weight_kg;

  const fallback = parseFloat(getSetting(db, pid, 'bodyweight_kg'));
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

// Re-derives protein/carb/fat gram goals from the multipliers. No-op unless
// the profile is in 'gkg' macro mode — in '%' mode the goals are whatever the
// user applied from the percentage split and must not move on their own.
// Returns the new goals, or null if nothing was changed.
function recalcMacroGoals(db, pid) {
  if (getSetting(db, pid, 'macro_mode') !== 'gkg') return null;

  const bw = trendWeight(db, pid);
  const cal = parseFloat(getSetting(db, pid, 'calorie_goal'));
  const pMul = parseFloat(getSetting(db, pid, 'protein_multiplier'));
  const fMul = parseFloat(getSetting(db, pid, 'fat_multiplier'));
  if (!(bw > 0) || !(cal > 0) || !(pMul >= 0) || !(fMul >= 0)) return null;

  const protein = Math.round(bw * pMul);
  const fat     = Math.round(bw * fMul);
  // Carbs absorb the remainder. Protein+fat can exceed the calorie goal on an
  // aggressive cut with high multipliers; clamp at zero rather than writing a
  // negative goal, and let the UI show that the split doesn't fit.
  const carbs = Math.max(0, Math.round((cal - protein * KCAL.protein - fat * KCAL.fat) / KCAL.carbs));

  setSetting(db, pid, 'protein_goal', protein);
  setSetting(db, pid, 'fat_goal', fat);
  setSetting(db, pid, 'carb_goal', carbs);
  return { protein, fat, carbs, trend_weight_kg: Math.round(bw * 10) / 10 };
}

module.exports = { trendWeight, recalcMacroGoals, KCAL };
