const express = require('express');
const { getDb } = require('../db');
const { todayLocal, isValidTz, tzFor } = require('../utils/tz');
const { recalcMacroGoals, trendWeight } = require('../utils/macros');

const router = express.Router();

const ALLOWED = new Set([
  'calorie_goal', 'protein_goal', 'carb_goal', 'fat_goal',
  'fiber_goal', 'ironlog_api_url', 'ironlog_api_key',
  'phase', 'tdee', 'cut_deficit', 'bulk_surplus', 'energy_unit', 'ironlog_last_synced',
  'target_weight_kg',
  'weight_display',   // Today's bodyweight card: 'raw' (default) or 'trend'
  // Macro targets: 'pct' (a % split of the calorie goal, applied once) or
  // 'gkg' (multiples of trend bodyweight, re-derived whenever weight moves).
  'macro_mode', 'protein_multiplier', 'fat_multiplier',
  // Inputs to the Mifflin-St Jeor TDEE estimate. Stored so the estimator can be
  // reopened pre-filled and re-run; birth_year rather than age so it doesn't go
  // stale. They feed the estimate only — nothing reads them to change a goal.
  'height_cm', 'birth_year', 'sex', 'activity_level',
  'bodyweight_kg',
  // '1' once the first-run flow has been completed OR skipped — either way the
  // wizard has had its turn and must not reappear.
  'onboarded',
  // Accessibility. Per profile rather than per device so a shared phone can run
  // at 150% for one person and 100% for the other. ui_scale is a percentage
  // ('100'|'115'|'130'|'150'); the rest are '0'/'1'.
  'ui_scale', 'bold_text', 'high_contrast', 'big_targets',
  // IANA zone, auto-detected by the client. Validated in the PATCH handler —
  // an unknown name would throw from whichever route next asked for the date,
  // not from the write that stored it.
  'timezone',
]);

// Settings that feed the g/kg macro formula — changing any of them has to
// re-derive the gram goals, or the goals silently disagree with the inputs
// shown right above them.
const MACRO_INPUTS = ['macro_mode', 'protein_multiplier', 'fat_multiplier', 'calorie_goal'];

// ironlog_api_url is fetched server-side (src/routes/ironlog.js) and its raw
// response is echoed back verbatim via GET /api/ironlog/raw — without this
// check, any profile could point it at an internal address (cloud metadata,
// localhost, another service on the private network) and use that route as
// an SSRF read oracle. Blocks the obvious cases (literal internal
// hosts/IPs); doesn't defend against DNS rebinding, which is out of scope
// for this app's threat model (household members, not remote attackers).
function isSafeExternalUrl(str) {
  let u;
  try { u = new URL(str); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return false;             // loopback, 10.0.0.0/8, "this" network
    if (a === 172 && b >= 16 && b <= 31) return false;               // 172.16.0.0/12
    if (a === 192 && b === 168) return false;                       // 192.168.0.0/16
    if (a === 169 && b === 254) return false;                       // link-local incl. cloud metadata (169.254.169.254)
  }
  return true;
}

function allSettings(db, pid) {
  const rows = db.prepare(
    'SELECT key, value FROM profile_settings WHERE profile_id = $pid'
  ).all({ pid });
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

router.get('/', (req, res) => {
  try {
    const db = getDb();
    const bw = trendWeight(db, req.profileId);
    // trend_weight_kg is derived, not stored — the macro settings UI needs the
    // same number the formula uses. Deliberately added here and not inside
    // allSettings(), so it stays out of the export/import payload.
    res.json({
      ...allSettings(db, req.profileId),
      trend_weight_kg: bw != null ? Math.round(bw * 10) / 10 : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/', (req, res) => {
  try {
    if (req.body.ironlog_api_url !== undefined && req.body.ironlog_api_url !== ''
        && !isSafeExternalUrl(req.body.ironlog_api_url)) {
      return res.status(400).json({ error: 'IronLog URL must be a public http(s) address' });
    }
    // Reject an unknown zone here rather than storing it: every date the server
    // derives for this profile would then throw from a route that looks
    // unrelated to the write that caused it. '' is allowed — it means
    // "not detected", and falls back to APP_TZ.
    if (req.body.timezone !== undefined && req.body.timezone !== '' && !isValidTz(req.body.timezone)) {
      return res.status(400).json({ error: 'Unknown timezone' });
    }
    const db = getDb();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)'
    );
    // Read before writing: we need the OLD tdee to tell a real change from a
    // re-save of the same number.
    const prevTdee = db.prepare(
      "SELECT value FROM profile_settings WHERE profile_id = $pid AND key = 'tdee'"
    ).get({ pid: req.profileId })?.value;

    for (const [key, value] of Object.entries(req.body)) {
      if (ALLOWED.has(key)) stmt.run({ pid: req.profileId, key, value: String(value) });
    }

    // Stamp when TDEE actually moves, so the UI can say how many days of data
    // sit behind the current figure. Deliberately not in ALLOWED — it records
    // what happened, so the client must not be able to set it.
    if ('tdee' in req.body && String(prevTdee ?? '') !== String(req.body.tdee)) {
      stmt.run({ pid: req.profileId, key: 'tdee_set_at', value: todayLocal(tzFor(db, req.profileId)) });
    }
    // Re-derive the gram goals if an input to the g/kg formula just changed.
    // Skipped when the request itself set protein/carb/fat directly (the %
    // split's Apply), so an explicit write is never overwritten.
    const setsGramsDirectly = ['protein_goal', 'carb_goal', 'fat_goal'].some(k => k in req.body);
    if (!setsGramsDirectly && MACRO_INPUTS.some(k => k in req.body)) {
      recalcMacroGoals(db, req.profileId);
    }
    res.json(allSettings(db, req.profileId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete this profile's logged data (meals, weight, batches) — keeps foods + settings
router.delete('/data', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM meal_sessions  WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM weight_log     WHERE profile_id = $pid').run({ pid });
      // Batches are logged data too — clear them the same way the single-batch
      // DELETE route does (hide the backing food, then drop the batch), so a
      // "fresh start" doesn't leave a stale batch with old remaining_g behind.
      db.prepare(`UPDATE foods SET hidden = 1 WHERE id IN
        (SELECT food_id FROM batches WHERE profile_id = $pid AND food_id IS NOT NULL)`).run({ pid });
      db.prepare('DELETE FROM batches WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM daily_overrides WHERE profile_id = $pid').run({ pid });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (Removed: GET /export-csv. The report's CSV format is a strict superset —
// same columns, plus day totals, brands, a summary and a date range — so the
// two buttons produced near-identical files.)

// Export all data as JSON
router.get('/export', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const payload = {
      exported_at: new Date().toISOString(),
      // Only foods this profile actually logged — not the whole shared
      // ~4,800-row seed table, which every profile can already re-derive
      // (it's re-seeded on a fresh DB) and would bloat every export.
      // The UNION covers foods that back a batch: a batch you've never taken a
      // portion from has no meal_entries row, so its backing food would be
      // missing and the restored batch would have nothing to log against.
      foods: db.prepare(`
        SELECT DISTINCT f.* FROM foods f
        JOIN meal_entries me ON me.food_id = f.id
        JOIN meal_sessions ms ON ms.id = me.meal_session_id
        WHERE ms.profile_id = $pid
        UNION
        SELECT f.* FROM foods f
        JOIN batches b ON b.food_id = f.id
        WHERE b.profile_id = $pid
      `).all({ pid }),
      // Batches were absent from every export until now, while "Clear all
      // logged data" deleted them — so export → clear → restore silently lost
      // every meal prep you'd saved.
      batches: db.prepare('SELECT * FROM batches WHERE profile_id = $pid').all({ pid }),
      meal_sessions: db.prepare('SELECT * FROM meal_sessions WHERE profile_id = $pid').all({ pid }),
      meal_entries:  db.prepare(`
        SELECT me.* FROM meal_entries me
        JOIN meal_sessions ms ON ms.id = me.meal_session_id
        WHERE ms.profile_id = $pid
      `).all({ pid }),
      weight_log:    db.prepare('SELECT * FROM weight_log WHERE profile_id = $pid').all({ pid }),
      settings:      allSettings(db, pid),
    };
    const filename = `plated-export-${new Date().toISOString().split('T')[0]}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore this profile's own meal/weight history + settings from a previous
// /export. Foods are a table SHARED across every profile (and re-seeded from
// scratch on a fresh DB, so ids drift between exports) — they are matched by
// name+brand and only inserted when genuinely new, never deleted. Everything
// scoped to this profile (meals, weight, settings) is fully replaced,
// matching what /export actually captures — batches/overrides
// aren't in the export, so import leaves them alone. Body can be large (a
// food-heavy history), so this route gets its own higher JSON size limit
// rather than raising it app-wide.
router.post('/import', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const body = req.body || {};
    const foods         = Array.isArray(body.foods) ? body.foods : [];
    const meal_sessions = Array.isArray(body.meal_sessions) ? body.meal_sessions : [];
    const meal_entries  = Array.isArray(body.meal_entries) ? body.meal_entries : [];
    const weight_log    = Array.isArray(body.weight_log) ? body.weight_log : [];
    // Absent from exports taken before batches were included — an older backup
    // restores exactly as it did before rather than wiping the batches you have.
    const batches       = Array.isArray(body.batches) ? body.batches : null;
    const settings      = (body.settings && typeof body.settings === 'object') ? body.settings : {};

    if (!body.exported_at || !Array.isArray(body.meal_sessions)) {
      return res.status(400).json({ error: 'Not a valid Plated export file' });
    }

    let foodsAdded = 0;
    let entriesImported = 0;
    let batchesImported = 0;
    db.exec('BEGIN');
    try {
      const findFood = db.prepare('SELECT id FROM foods WHERE name = $name AND brand IS $brand');
      const insertFood = db.prepare(`
        INSERT INTO foods (name, brand, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source, created_by_profile)
        VALUES ($name, $brand, $cal, $pro, $carb, $fat, $fiber, $serv, $source, $pid)
      `);
      const foodIdMap = new Map();
      for (const f of foods) {
        const brand = f.brand ?? null;
        const existing = findFood.get({ name: f.name, brand });
        if (existing) { foodIdMap.set(f.id, existing.id); continue; }
        const newId = insertFood.run({
          name: f.name, brand,
          cal: f.calories_per_100g ?? null, pro: f.protein_per_100g ?? null,
          carb: f.carbs_per_100g ?? null, fat: f.fat_per_100g ?? null,
          fiber: f.fiber_per_100g ?? null, serv: f.serving_size_g ?? 100,
          source: f.source || 'custom', pid,
        }).lastInsertRowid;
        foodIdMap.set(f.id, newId);
        foodsAdded++;
      }

      // Wipe this profile's own history — meal_entries cascades off
      // meal_sessions (foreign_keys=ON) so deleting sessions is enough.
      db.prepare('DELETE FROM meal_sessions WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM weight_log    WHERE profile_id = $pid').run({ pid });

      const insSession = db.prepare('INSERT INTO meal_sessions (date, name, meal_index, logged_at, profile_id) VALUES ($date, $name, $idx, $logged_at, $pid)');
      const sessionIdMap = new Map();
      for (const s of meal_sessions) {
        const newId = insSession.run({ date: s.date, name: s.name ?? null, idx: s.meal_index || 1, logged_at: s.logged_at || null, pid }).lastInsertRowid;
        sessionIdMap.set(s.id, newId);
      }

      const insEntry = db.prepare(`
        INSERT INTO meal_entries (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber, logged_at)
        VALUES ($sid, $fid, $qty, $cal, $pro, $carb, $fat, $fiber, $logged_at)
      `);
      for (const e of meal_entries) {
        const sid = sessionIdMap.get(e.meal_session_id);
        const fid = foodIdMap.get(e.food_id);
        if (sid == null || fid == null) continue; // orphaned reference — food/session missing from this export
        insEntry.run({ sid, fid, qty: e.quantity_g, cal: e.calories ?? null, pro: e.protein ?? null, carb: e.carbs ?? null, fat: e.fat ?? null, fiber: e.fiber ?? null, logged_at: e.logged_at || null });
        entriesImported++;
      }

      const insWeight = db.prepare('INSERT INTO weight_log (date, weight_kg, note, source, logged_at, profile_id) VALUES ($date, $kg, $note, $src, $logged_at, $pid)');
      for (const w of weight_log) insWeight.run({ date: w.date, kg: w.weight_kg, note: w.note ?? null, src: w.source || 'manual', logged_at: w.logged_at || null, pid });

      // Batches. Only touched when the file actually carries them, so restoring
      // a pre-batch backup leaves your current batches alone instead of wiping
      // them to match a file that never knew about them.
      if (batches) {
        db.prepare('DELETE FROM batches WHERE profile_id = $pid').run({ pid });
        const insBatch = db.prepare(`
          INSERT INTO batches (profile_id, name, food_id, calories, protein, carbs, fat, fiber, cooked_g, remaining_g, ingredients, created_at)
          VALUES ($pid, $name, $fid, $cal, $pro, $carb, $fat, $fiber, $cooked, $remaining, $ing, $created)
        `);
        for (const b of batches) {
          if (!b.name || !(b.cooked_g > 0)) continue;          // unusable without a divisor
          // Ingredients are stored as JSON carrying the ORIGINAL database's
          // food ids. Remap them the same way entries are, and drop an id that
          // didn't come across rather than leaving one pointing at a stranger's
          // food — the name and grams still render, and batches.js already
          // falls back to resolving an ingredient by name.
          let ing = b.ingredients ?? null;
          try {
            const parsed = JSON.parse(b.ingredients || '[]');
            if (Array.isArray(parsed)) {
              ing = JSON.stringify(parsed.map(i => ({
                ...i,
                food_id: i.food_id != null ? (foodIdMap.get(i.food_id) ?? null) : null,
              })));
            }
          } catch { /* not JSON — keep whatever was there */ }
          // A batch with no backing food still logs portions, but they land as
          // meal_entries with food_id NULL — and editing one of those 500s
          // (PATCH /entries/:id looks the food up and hands it to calcMacros).
          // So if the mapping came up empty, rebuild a backing food from the
          // batch's own per-100g figures, exactly as POST /api/batches does.
          let fid = b.food_id != null ? (foodIdMap.get(b.food_id) ?? null) : null;
          if (fid == null && b.calories > 0) {
            const per = k => Math.round(((b[k] || 0) / b.cooked_g * 100) * 10) / 10;
            fid = insertFood.run({
              name: b.name, brand: null,
              cal: per('calories'), pro: per('protein'), carb: per('carbs'),
              fat: per('fat'), fiber: per('fiber'), serv: 100, source: 'batch', pid,
            }).lastInsertRowid;
          }
          insBatch.run({
            pid, name: b.name, fid,
            cal: b.calories ?? null, pro: b.protein ?? null, carb: b.carbs ?? null,
            fat: b.fat ?? null, fiber: b.fiber ?? null,
            cooked: b.cooked_g,
            // Clamp so a hand-edited file can't leave a batch claiming more is
            // left than was ever cooked.
            remaining: Math.max(0, Math.min(b.cooked_g, b.remaining_g ?? b.cooked_g)),
            ing, created: b.created_at || null,
          });
          batchesImported++;
        }
      }

      const setSetting = db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)');
      for (const [key, value] of Object.entries(settings)) {
        if (ALLOWED.has(key) && value != null) setSetting.run({ pid, key, value: String(value) });
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    res.json({
      success: true,
      imported: { meals: meal_sessions.length, entries: entriesImported, weight: weight_log.length, foods_added: foodsAdded, batches: batchesImported },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escCsv  = v => {
  if (v == null) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const round1 = n => Math.round(n * 10) / 10;
// A food with no data for a macro is unknown, not zero — render it as a dash
// so a reader doesn't mistake "not recorded" for "contains none".
const num = v => (v == null ? '–' : v);
const zeroMacros = () => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
// Rounded on the way out: summing floats produces things like
// 2303.2000000000003, which then printed verbatim into every day total.
const sumMacros = entries => {
  const t = entries.reduce((a, e) => ({
    calories: a.calories + (e.calories || 0),
    protein:  a.protein  + (e.protein  || 0),
    carbs:    a.carbs    + (e.carbs    || 0),
    fat:      a.fat      + (e.fat      || 0),
    fiber:    a.fiber    + (e.fiber    || 0),
  }), zeroMacros());
  for (const k in t) t[k] = round1(t[k]);
  return t;
};
const fmtDay = date => new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// Display formatting (HTML/Markdown only — never CSV, where a thousands
// separator would break the column). Calories read as whole numbers; grams
// keep one decimal but drop a trailing .0.
const kcal = v => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
const g = v => {
  if (v == null) return '–';
  const r = round1(v);
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const macroLine = t => `${g(t.protein)}P · ${g(t.carbs)}C · ${g(t.fat)}F${t.fiber ? ` · ${g(t.fiber)} fib` : ''}`;
const foodName = e => (e.food_brand ? `${e.food_name} (${e.food_brand})` : e.food_name);

// Everything the report needs beyond the food rows: what you were aiming at,
// what the scale did, and the plan behind both.
//
// Goals are CURRENT goals. Plated stores one value per setting and no history,
// so there is genuinely no way to know what the goal was on a past day — the
// renderers say so rather than implying the figure applied across the range.
function reportContext(db, pid, from, to) {
  const s = allSettings(db, pid);
  const num = k => { const v = parseFloat(s[k]); return Number.isFinite(v) ? v : null; };
  // One weigh-in per day (the latest, same rule as everywhere else).
  const weights = db.prepare(`
    SELECT date, weight_kg FROM weight_log
    WHERE profile_id = $pid AND date >= $from AND date <= $to
      AND id IN (SELECT MAX(id) FROM weight_log WHERE profile_id = $pid GROUP BY date)
    ORDER BY date ASC
  `).all({ pid, from, to });
  return {
    goals: {
      calories: num('calorie_goal'), protein: num('protein_goal'),
      carbs: num('carb_goal'), fat: num('fat_goal'), fiber: num('fiber_goal'),
    },
    phase: s.phase || null,
    tdee:  num('tdee'),
    weights,
  };
}

// Least-squares slope, kg per day. Same fit Trends uses for its rate.
function slopePerDay(points) {
  const n = points.length;
  if (n < 2) return null;
  const x0 = Date.parse(points[0].date + 'T00:00:00Z') / 864e5;
  const xs = points.map(p => Date.parse(p.date + 'T00:00:00Z') / 864e5 - x0);
  const ys = points.map(p => p.weight_kg);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (!sxx) return null;
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
}

// Weight over time: the raw readings, the same smoothing Trends applies, the
// week-by-week picture, the pace, and where the data simply isn't.
//
// The trend column averages the last 7 WEIGH-INS, not the last 7 calendar
// days — matching movingAvg() in the app exactly, so the report and Trends
// can't quote different numbers for the same thing.
function analyseWeight(weights) {
  if (!weights.length) return null;
  const kgs = weights.map(w => w.weight_kg);
  const series = weights.map((w, i) => {
    const win = kgs.slice(Math.max(0, i - 6), i + 1);
    return { date: w.date, kg: w.weight_kg, trend: round1(win.reduce((a, b) => a + b, 0) / win.length) };
  });

  // Monday-start weeks, in UTC so the bucket never depends on where this runs.
  const weekStart = iso => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const buckets = new Map();
  for (const w of weights) {
    const k = weekStart(w.date);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(w.weight_kg);
  }
  const weekly = [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([week, vals]) => ({ week, n: vals.length, avg: round1(vals.reduce((a, b) => a + b, 0) / vals.length) }));
  // Change is against the previous week's AVERAGE, so one salty Saturday moves
  // it far less than a raw week-end-to-week-end diff would.
  weekly.forEach((w, i) => { w.change = i ? round1(w.avg - weekly[i - 1].avg) : null; });

  // Stretches with no reading at all. A trend line drawn across a five-day hole
  // looks exactly like one drawn across five daily weigh-ins, and isn't.
  const gaps = [];
  for (let i = 1; i < weights.length; i++) {
    const days = Math.round((Date.parse(weights[i].date) - Date.parse(weights[i - 1].date)) / 864e5);
    if (days >= 3) gaps.push({ after: weights[i - 1].date, before: weights[i].date, missing: days - 1 });
  }

  const slope = slopePerDay(weights);
  return {
    series, weekly, gaps,
    ratePerWeek: slope != null ? round1(slope * 7) : null,
    // How much of the range actually has readings behind it.
    spanDays: Math.round((Date.parse(weights[weights.length - 1].date) - Date.parse(weights[0].date)) / 864e5),
  };
}

// Groups flat meal-entry rows into day -> meal -> entries, with subtotals at
// every level and a period-average computed over days actually logged (not
// diluted by unlogged days — more meaningful for a doctor/coach to read).
function buildReport(rows, from, to, ctx = {}) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, new Map());
    const meals = byDate.get(r.date);
    if (!meals.has(r.meal_name)) meals.set(r.meal_name, []);
    meals.get(r.meal_name).push(r);
  }

  const days = [...byDate.entries()]
    .map(([date, meals]) => {
      const mealList = [...meals.entries()].map(([name, entries]) => ({ name, entries, total: sumMacros(entries) }));
      return { date, meals: mealList, total: sumMacros(mealList.flatMap(m => m.entries)) };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const daysInRange = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const daysLogged = days.length;
  const avg = daysLogged ? sumMacros(days.map(d => d.total)) : zeroMacros();
  for (const k in avg) avg[k] = round1(avg[k] / (daysLogged || 1));

  const goals = ctx.goals || {};
  const wRows = ctx.weights || [];

  // Hang each day's weigh-in off its day, so intake and the scale can be read
  // on one line instead of cross-referencing two tables.
  const byWeight = Object.fromEntries(wRows.map(w => [w.date, w.weight_kg]));
  for (const d of days) d.weight_kg = byWeight[d.date] ?? null;

  const weight = wRows.length ? {
    count: wRows.length,
    first: wRows[0],
    last:  wRows[wRows.length - 1],
    change: round1(wRows[wRows.length - 1].weight_kg - wRows[0].weight_kg),
    spanDays: Math.round((new Date(wRows[wRows.length - 1].date) - new Date(wRows[0].date)) / 86400000),
  } : null;

  // Average against target, per macro. Null where no goal is set.
  const vsGoal = {};
  for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber']) {
    vsGoal[k] = goals[k] != null && daysLogged ? round1(avg[k] - goals[k]) : null;
  }

  // Adherence says more than the average does: 1,800 every day and alternating
  // 1,200/2,400 both average 1,800, and they are not the same month.
  let adherence = null;
  if (goals.calories > 0 && daysLogged) {
    const band = goals.calories * 0.10;
    adherence = { onTarget: 0, over: 0, under: 0, bandPct: 10 };
    for (const d of days) {
      const diff = d.total.calories - goals.calories;
      if (Math.abs(diff) <= band) adherence.onTarget++;
      else if (diff > 0) adherence.over++;
      else adherence.under++;
    }
  }

  // Maintenance implied by THIS range: what you ate, corrected for what the
  // scale did (1 kg ~ 7,700 kcal). Deliberately computed from the reported
  // range rather than reusing Trends' fixed 28-day window, and it counts every
  // logged day where Trends drops the under-logged ones — so the two figures
  // can legitimately differ. Needs a real span to mean anything.
  const estMaintenance = (weight && weight.spanDays >= 14 && daysLogged >= 7)
    ? Math.round(avg.calories - (weight.change * 7700) / weight.spanDays)
    : null;

  return {
    from, to, days,
    summary: { daysInRange, daysLogged, avg },
    goals, vsGoal, adherence, weight, estMaintenance,
    weightDetail: analyseWeight(wRows),
    phase: ctx.phase || null,
    tdee:  ctx.tdee ?? null,
  };
}

// Weight chart as inline SVG: no library, no external request, and it survives
// printing, an email client, and being opened offline. Raw readings as points,
// the smoothed trend as the line through them — which is the whole argument for
// drawing it, since the two tell noticeably different stories.
function weightChartSvg(detail) {
  const pts = detail?.series || [];
  if (pts.length < 2) return '';
  const W = 700, H = 190, L = 42, R = 12, T = 14, B = 26;
  const day = iso => Date.parse(iso + 'T00:00:00Z') / 864e5;
  const x0 = day(pts[0].date), x1 = day(pts[pts.length - 1].date);
  const all = pts.flatMap(p => [p.kg, p.trend]);
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.15, 0.3);          // never a flat line on the axis
  lo -= pad; hi += pad;
  const px = iso => L + (x1 === x0 ? 0 : (day(iso) - x0) / (x1 - x0)) * (W - L - R);
  const py = kg => T + (1 - (kg - lo) / (hi - lo)) * (H - T - B);
  const path = key => pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.date).toFixed(1)},${py(p[key]).toFixed(1)}`).join('');
  // Three gridlines: bottom, middle, top of the padded range.
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Weight over time"
       style="display:block;max-width:${W}px;font-family:inherit">
    ${ticks.map(t => `
      <line x1="${L}" y1="${py(t).toFixed(1)}" x2="${W - R}" y2="${py(t).toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>
      <text x="${L - 6}" y="${(py(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${g(t)}</text>`).join('')}
    <path d="${path('kg')}" fill="none" stroke="#c7cbd1" stroke-width="1.2"/>
    <path d="${path('trend')}" fill="none" stroke="#4c1d95" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${pts.map(p => `<circle cx="${px(p.date).toFixed(1)}" cy="${py(p.kg).toFixed(1)}" r="2.2" fill="#6b7280"/>`).join('')}
    <text x="${L}" y="${H - 8}" font-size="10" fill="#9ca3af">${escHtml(pts[0].date)}</text>
    <text x="${W - R}" y="${H - 8}" font-size="10" fill="#9ca3af" text-anchor="end">${escHtml(pts[pts.length - 1].date)}</text>
  </svg>
  <p class="note"><span style="color:#6b7280">●</span> raw weigh-in &nbsp; <span style="color:#4c1d95">▬</span> trend (mean of the last 7 weigh-ins, the same smoothing Trends uses)</p>`;
}

function toCsv(report) {
  const { summary, goals, vsGoal, adherence, weight } = report;
  const COLS = 10;
  // A key/value row padded to the table's width, so a parser reading this as
  // one CSV doesn't hit ragged rows.
  const kv = (k, v) => [escCsv(k), escCsv(String(v ?? ''))].concat(Array(COLS - 2).fill('')).join(',');
  const macroRow = (label, m) => [escCsv(label), '', '', '',
    m.calories ?? '', m.protein ?? '', m.carbs ?? '', m.fat ?? '', m.fiber ?? '', ''].join(',');

  const lines = ['Date,Meal,Food,Quantity (g),Calories (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g),Weight (kg)'];
  for (const day of report.days) {
    for (const meal of day.meals) {
      for (const e of meal.entries) {
        lines.push([day.date, escCsv(meal.name), escCsv(foodName(e)),
          e.quantity_g ?? '', e.calories ?? '', e.protein ?? '', e.carbs ?? '', e.fat ?? '', e.fiber ?? '', ''].join(','));
      }
    }
    // The day's weigh-in rides on its total row — intake and scale on one line.
    lines.push([day.date, '', 'Day total', '', day.total.calories, day.total.protein,
      day.total.carbs, day.total.fat, day.total.fiber, day.weight_kg ?? ''].join(','));
  }

  lines.push('', 'Summary' + ','.repeat(COLS - 1));
  lines.push(kv('Date range', `${report.from} to ${report.to}`));
  lines.push(kv('Days logged', `${summary.daysLogged} of ${summary.daysInRange}`));
  lines.push(macroRow('Average per logged day', summary.avg));
  lines.push(macroRow('Goal (current, see note)', goals));
  lines.push(macroRow('Average minus goal', vsGoal));
  lines.push(kv('Note on goals', 'Goals are current values. Plated stores no goal history, so earlier days in this range may have had different targets.'));

  if (report.phase) lines.push(kv('Phase', report.phase));
  if (report.tdee != null) lines.push(kv('Set maintenance / TDEE (kcal)', report.tdee));
  if (report.estMaintenance != null) {
    lines.push(kv('Estimated maintenance from this range (kcal)', report.estMaintenance));
    lines.push(kv('How that was derived', 'Average intake minus weight change x 7700 / days. Counts every logged day; Trends excludes under-logged days and uses a fixed 28-day window, so the two can differ.'));
  }
  if (weight) {
    lines.push(kv('Weight start (kg)', `${weight.first.weight_kg} on ${weight.first.date}`));
    lines.push(kv('Weight end (kg)', `${weight.last.weight_kg} on ${weight.last.date}`));
    lines.push(kv('Weight change (kg)', weight.change));
    lines.push(kv('Weigh-ins', weight.count));
  }
  if (adherence) {
    lines.push(kv(`Days within ${adherence.bandPct}% of calorie goal`, adherence.onTarget));
    lines.push(kv('Days over goal', adherence.over));
    lines.push(kv('Days under goal', adherence.under));
  }

  const wd = report.weightDetail;
  if (wd) {
    if (wd.ratePerWeek != null) lines.push(kv('Rate of change (kg/week, least-squares)', wd.ratePerWeek));
    lines.push('', 'Weight by week' + ','.repeat(COLS - 1));
    // Header labels go through escCsv like any other cell: one of them below
    // contains a comma, and unescaped it split into an extra column and made
    // the whole file ragged.
    const head = (...cells) => cells.map(escCsv).concat(Array(COLS - cells.length).fill('')).join(',');
    lines.push(head('Week starting', 'Average (kg)', 'Change vs prev week (kg)', 'Weigh-ins'));
    for (const w of wd.weekly) lines.push([w.week, w.avg, w.change ?? '', w.n].concat(Array(COLS - 4).fill('')).join(','));

    lines.push('', 'All weigh-ins' + ','.repeat(COLS - 1));
    lines.push(head('Date', 'Weight (kg)', 'Trend (7 weigh-ins, kg)'));
    for (const p of wd.series) lines.push([p.date, p.kg, p.trend].concat(Array(COLS - 3).fill('')).join(','));

    if (wd.gaps.length) {
      lines.push('', 'Gaps with no weigh-in' + ','.repeat(COLS - 1));
      lines.push(head('After', 'Before', 'Days missing'));
      for (const gp of wd.gaps) lines.push([gp.after, gp.before, gp.missing].concat(Array(COLS - 3).fill('')).join(','));
    }
  }
  return lines.join('\n');
}

// One table per day rather than one per meal — a reader scans down a single
// aligned column of numbers instead of re-orienting at every meal heading.
function toMarkdown(report) {
  const { summary } = report;
  const a = summary.avg;
  const lines = [
    `# Nutrition report`,
    '',
    `**${report.from} to ${report.to}**`,
    '',
    `| | |`,
    `|---|---|`,
    `| Days logged | ${summary.daysLogged} of ${summary.daysInRange} |`,
    `| Avg calories | **${kcal(a.calories)} kcal/day** |`,
    `| Avg protein | ${g(a.protein)} g |`,
    `| Avg carbs | ${g(a.carbs)} g |`,
    `| Avg fat | ${g(a.fat)} g |`,
    `| Avg fiber | ${g(a.fiber)} g |`,
  ];

  const { goals, vsGoal, adherence, weight } = report;
  const delta = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${g(v)}`);
  if (goals.calories != null || goals.protein != null) {
    lines.push('', '## Goals', '',
      '| | Goal | Average | Difference |', '|---|--:|--:|--:|',
      `| Calories | ${kcal(goals.calories)} | ${kcal(a.calories)} | ${delta(vsGoal.calories)} |`,
      `| Protein | ${g(goals.protein)} g | ${g(a.protein)} g | ${delta(vsGoal.protein)} |`,
      `| Carbs | ${g(goals.carbs)} g | ${g(a.carbs)} g | ${delta(vsGoal.carbs)} |`,
      `| Fat | ${g(goals.fat)} g | ${g(a.fat)} g | ${delta(vsGoal.fat)} |`,
      `| Fiber | ${g(goals.fiber)} g | ${g(a.fiber)} g | ${delta(vsGoal.fiber)} |`,
      '', '_Goals shown are current values — Plated keeps no history of goal changes, so earlier days in this range may have had different targets._');
  }
  if (adherence) {
    lines.push('', `**Adherence:** ${adherence.onTarget} of ${report.summary.daysLogged} logged days within ${adherence.bandPct}% of the calorie goal · ${adherence.over} over · ${adherence.under} under`);
  }
  if (report.phase || report.tdee != null || report.estMaintenance != null) {
    lines.push('', '## Plan', '', '| | |', '|---|---|');
    if (report.phase) lines.push(`| Phase | ${report.phase} |`);
    if (report.tdee != null) lines.push(`| Set maintenance (TDEE) | ${kcal(report.tdee)} kcal |`);
    if (report.estMaintenance != null) {
      lines.push(`| Maintenance implied by this range | ${kcal(report.estMaintenance)} kcal |`);
      lines.push('', '_Implied maintenance = average intake corrected for weight change (1 kg ≈ 7,700 kcal). It counts every logged day, where the Trends figure drops under-logged days and uses a fixed 28-day window — so the two can differ._');
    }
  }
  if (weight) {
    const wd = report.weightDetail;
    lines.push('', '## Weight', '', '| | |', '|---|---|',
      `| Start | ${g(weight.first.weight_kg)} kg (${weight.first.date}) |`,
      `| End | ${g(weight.last.weight_kg)} kg (${weight.last.date}) |`,
      `| Change | ${delta(weight.change)} kg over ${weight.spanDays} days |`,
      `| Weigh-ins | ${weight.count} |`);
    if (wd?.ratePerWeek != null) lines.push(`| Rate | ${delta(wd.ratePerWeek)} kg/week |`);
    if (wd) {
      lines.push('', '### By week', '',
        '| Week starting | Average | Change | Weigh-ins |', '|---|--:|--:|--:|');
      for (const w of wd.weekly) lines.push(`| ${w.week} | ${g(w.avg)} kg | ${w.change == null ? '–' : delta(w.change)} | ${w.n} |`);

      lines.push('', '### Every weigh-in', '',
        '| Date | Weight | Trend |', '|---|--:|--:|');
      for (const p of wd.series) lines.push(`| ${p.date} | ${g(p.kg)} kg | ${g(p.trend)} kg |`);
      lines.push('', '_Trend is the mean of the last 7 weigh-ins — the same smoothing Trends uses, so the two agree._');

      if (wd.gaps.length) {
        lines.push('', '### Gaps with no weigh-in', '');
        for (const gp of wd.gaps) lines.push(`- ${gp.missing} day${gp.missing === 1 ? '' : 's'} between ${gp.after} and ${gp.before}`);
        lines.push('', '_The trend line is drawn straight across these — it has no data there._');
      }
    }
  }

  if (!report.days.length) {
    lines.push('', '_No meals logged in this date range._');
    return lines.join('\n');
  }

  for (const day of report.days) {
    const t = day.total;
    lines.push('', '---', '', `## ${fmtDay(day.date)}${day.weight_kg != null ? ` · ${g(day.weight_kg)} kg` : ''}`, '',
      `**${kcal(t.calories)} kcal** · ${macroLine(t)}`, '',
      '| Meal | Food | Qty | Cal | P | C | F | Fib |',
      '|---|---|--:|--:|--:|--:|--:|--:|');
    for (const meal of day.meals) {
      meal.entries.forEach((e, i) => {
        lines.push(`| ${i === 0 ? meal.name : ''} | ${foodName(e)} | ${g(e.quantity_g)} g | ${kcal(e.calories)} | ${g(e.protein)} | ${g(e.carbs)} | ${g(e.fat)} | ${g(e.fiber)} |`);
      });
    }
  }
  return lines.join('\n');
}

function toHtml(report) {
  const { summary } = report;
  const a = summary.avg;

  // One table per day, with the meal name as a spanning label row. Reads as a
  // single aligned column of numbers instead of restarting at every meal.
  const dayBlocks = report.days.map(day => {
    const t = day.total;
    const rows = day.meals.map(meal => `
      <tr class="meal-row"><td colspan="7">${escHtml(meal.name)}</td></tr>
      ${meal.entries.map(e => `
        <tr>
          <td class="food">${escHtml(foodName(e))}</td>
          <td>${g(e.quantity_g)} g</td>
          <td class="cal">${kcal(e.calories)}</td>
          <td>${g(e.protein)}</td><td>${g(e.carbs)}</td><td>${g(e.fat)}</td><td>${g(e.fiber)}</td>
        </tr>`).join('')}`).join('');
    return `
    <section class="day">
      <div class="day-head">
        <h2>${escHtml(fmtDay(day.date))}${day.weight_kg != null ? ` <span class="dayw">${g(day.weight_kg)} kg</span>` : ''}</h2>
        <div class="day-total"><strong>${kcal(t.calories)} kcal</strong><span>${escHtml(macroLine(t))}</span></div>
      </div>
      <table>
        <thead><tr>
          <th>Food</th><th>Qty</th><th>Cal</th><th>P</th><th>C</th><th>F</th><th>Fib</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join('') || '<p class="empty">No meals logged in this date range.</p>';

  const { goals, vsGoal, adherence, weight } = report;
  const delta = v => v == null ? '–'
    : `<span class="${v > 0 ? 'over' : v < 0 ? 'under' : ''}">${v > 0 ? '+' : ''}${g(v)}</span>`;
  const goalRow = (label, goal, avgV, d, unit) => goal == null ? '' :
    `<tr><td>${label}</td><td>${unit === 'kcal' ? kcal(goal) : g(goal)}</td><td>${unit === 'kcal' ? kcal(avgV) : g(avgV)}</td><td>${delta(d)}</td></tr>`;

  const goalBlock = (goals.calories == null && goals.protein == null) ? '' : `
  <section class="block">
    <h3>Goals vs actual</h3>
    <table class="kv">
      <thead><tr><th></th><th>Goal</th><th>Average</th><th>Diff</th></tr></thead>
      <tbody>
        ${goalRow('Calories', goals.calories, a.calories, vsGoal.calories, 'kcal')}
        ${goalRow('Protein (g)', goals.protein, a.protein, vsGoal.protein)}
        ${goalRow('Carbs (g)', goals.carbs, a.carbs, vsGoal.carbs)}
        ${goalRow('Fat (g)', goals.fat, a.fat, vsGoal.fat)}
        ${goalRow('Fiber (g)', goals.fiber, a.fiber, vsGoal.fiber)}
      </tbody>
    </table>
    ${adherence ? `<p class="note"><strong>${adherence.onTarget} of ${summary.daysLogged}</strong> logged days landed within ${adherence.bandPct}% of the calorie goal · ${adherence.over} over · ${adherence.under} under.</p>` : ''}
    <p class="note">Goals shown are current values. Plated keeps no history of goal changes, so earlier days in this range may have had different targets.</p>
  </section>`;

  const planBlock = (!report.phase && report.tdee == null && report.estMaintenance == null) ? '' : `
  <section class="block">
    <h3>Plan</h3>
    <table class="kv"><tbody>
      ${report.phase ? `<tr><td>Phase</td><td>${escHtml(report.phase)}</td></tr>` : ''}
      ${report.tdee != null ? `<tr><td>Set maintenance (TDEE)</td><td>${kcal(report.tdee)} kcal</td></tr>` : ''}
      ${report.estMaintenance != null ? `<tr><td>Maintenance implied by this range</td><td>${kcal(report.estMaintenance)} kcal</td></tr>` : ''}
    </tbody></table>
    ${report.estMaintenance != null ? `<p class="note">Implied maintenance is average intake corrected for weight change (1&nbsp;kg ≈ 7,700&nbsp;kcal). It counts every logged day, where the figure on Trends drops under-logged days and uses a fixed 28-day window — so the two can legitimately differ.</p>` : ''}
  </section>`;

  const wd = report.weightDetail;
  const weightBlock = !weight ? '' : `
  <section class="block">
    <h3>Weight</h3>
    ${weightChartSvg(wd)}
    <table class="kv"><tbody>
      <tr><td>Start</td><td>${g(weight.first.weight_kg)} kg <span style="color:#9ca3af">${escHtml(weight.first.date)}</span></td></tr>
      <tr><td>End</td><td>${g(weight.last.weight_kg)} kg <span style="color:#9ca3af">${escHtml(weight.last.date)}</span></td></tr>
      <tr><td>Change</td><td>${delta(weight.change)} kg over ${weight.spanDays} days</td></tr>
      ${wd?.ratePerWeek != null ? `<tr><td>Rate</td><td>${delta(wd.ratePerWeek)} kg/week</td></tr>` : ''}
      <tr><td>Weigh-ins</td><td>${weight.count}</td></tr>
    </tbody></table>
    ${!wd ? '' : `
    <h3 style="margin-top:22px">By week</h3>
    <table class="kv">
      <thead><tr><th>Week starting</th><th>Average</th><th>Change</th><th>Weigh-ins</th></tr></thead>
      <tbody>${wd.weekly.map(w => `<tr><td>${escHtml(w.week)}</td><td>${g(w.avg)} kg</td><td>${w.change == null ? '–' : delta(w.change)}</td><td>${w.n}</td></tr>`).join('')}</tbody>
    </table>
    <h3 style="margin-top:22px">Every weigh-in</h3>
    <table class="kv">
      <thead><tr><th>Date</th><th>Weight</th><th>Trend</th></tr></thead>
      <tbody>${wd.series.map(p => `<tr><td>${escHtml(p.date)}</td><td>${g(p.kg)} kg</td><td>${g(p.trend)} kg</td></tr>`).join('')}</tbody>
    </table>
    <p class="note">Trend is the mean of the last 7 weigh-ins — the same smoothing Trends uses, so the two agree.</p>
    ${!wd.gaps.length ? '' : `
    <h3 style="margin-top:22px">Gaps with no weigh-in</h3>
    <table class="kv"><tbody>${wd.gaps.map(gp => `<tr><td>${escHtml(gp.after)} → ${escHtml(gp.before)}</td><td>${gp.missing} day${gp.missing === 1 ? '' : 's'} missing</td></tr>`).join('')}</tbody></table>
    <p class="note">The trend line is drawn straight across these — it has no data there.</p>`}`}
  </section>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nutrition report ${escHtml(report.from)} to ${escHtml(report.to)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    max-width: 760px; margin: 40px auto; padding: 0 20px; color: #16181d; line-height: 1.5;
    -webkit-font-smoothing: antialiased; }
  h1 { font-size: 24px; margin: 0 0 2px; letter-spacing: -.01em; }
  .range { color: #6b7280; font-size: 13px; margin-bottom: 22px; }

  /* Summary: the part most people read and stop. */
  .summary { border: 1px solid #e5e7eb; border-radius: 12px; padding: 18px 20px; margin-bottom: 34px; }
  .summary .lead { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin-bottom: 12px; }
  .stats { display: flex; flex-wrap: wrap; gap: 26px; }
  .stat .v { font-size: 21px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .stat .k { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .05em; margin-top: 1px; }
  .stat.primary .v { color: #4c1d95; }

  .day { margin-bottom: 30px; break-inside: avoid; }
  .day-head { display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; border-bottom: 2px solid #16181d; padding-bottom: 5px; margin-bottom: 2px; }
  h2 { font-size: 15px; margin: 0; letter-spacing: -.01em; }
  .day-total { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
  .day-total strong { font-size: 14px; }
  .day-total span { color: #6b7280; margin-left: 8px; }

  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 5px 8px; }
  th { font-size: 10px; font-weight: 600; color: #6b7280; text-transform: uppercase;
    letter-spacing: .05em; border-bottom: 1px solid #e5e7eb; }
  td { border-bottom: 1px solid #f1f2f4; font-variant-numeric: tabular-nums; }
  th:first-child, td.food { text-align: left; }
  th:not(:first-child), td:not(.food) { text-align: right; white-space: nowrap; }
  td.food { width: 45%; }
  td.cal { font-weight: 600; }
  /* Meal label: a quiet divider, not a competing heading. */
  .meal-row td { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    color: #6b7280; background: #fafafb; padding-top: 8px; padding-bottom: 4px; border-bottom: none; }
  .empty { color: #6b7280; }
  .dayw { font-size: 11px; font-weight: 500; color: #6b7280; margin-left: 6px; }
  .block { margin-bottom: 28px; }
  .block h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: #6b7280; margin: 0 0 8px; font-weight: 600; }
  .kv { width: 100%; border-collapse: collapse; font-size: 13px; }
  .kv td { padding: 4px 8px; border-bottom: 1px solid #f1f2f4; font-variant-numeric: tabular-nums; }
  .kv td:first-child { text-align: left; color: #6b7280; }
  .kv td:not(:first-child) { text-align: right; white-space: nowrap; }
  .kv th { font-size: 10px; font-weight: 600; color: #6b7280; text-transform: uppercase;
    letter-spacing: .05em; border-bottom: 1px solid #e5e7eb; padding: 4px 8px; text-align: right; }
  .kv th:first-child { text-align: left; }
  .over { color: #b45309; } .under { color: #1d4ed8; }
  .note { font-size: 11px; color: #6b7280; margin-top: 8px; line-height: 1.45; }

  @media print {
    body { margin: 0; max-width: none; font-size: 12px; }
    .summary { break-inside: avoid; }
    thead { display: table-header-group; }
  }
</style></head>
<body>
  <h1>Nutrition report</h1>
  <div class="range">${escHtml(report.from)} to ${escHtml(report.to)}</div>
  <div class="summary">
    <div class="lead">Average per logged day</div>
    <div class="stats">
      <div class="stat primary"><div class="v">${kcal(a.calories)}</div><div class="k">kcal</div></div>
      <div class="stat"><div class="v">${g(a.protein)}</div><div class="k">protein g</div></div>
      <div class="stat"><div class="v">${g(a.carbs)}</div><div class="k">carbs g</div></div>
      <div class="stat"><div class="v">${g(a.fat)}</div><div class="k">fat g</div></div>
      <div class="stat"><div class="v">${g(a.fiber)}</div><div class="k">fiber g</div></div>
      <div class="stat"><div class="v">${summary.daysLogged}<span style="color:#9ca3af;font-weight:400">/${summary.daysInRange}</span></div><div class="k">days logged</div></div>
    </div>
  </div>
  ${goalBlock}
  ${planBlock}
  ${weightBlock}
  ${dayBlocks}
</body></html>`;
}

// GET /api/settings/export-report?from=YYYY-MM-DD&to=YYYY-MM-DD&format=html|md|csv
// A readable day-by-day nutrition breakdown (meals unpacked to individual
// foods, day totals, period average) — meant for sharing with a doctor or
// coach, unlike the raw JSON dump from /export.
router.get('/export-report', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const format = ['html', 'md', 'csv'].includes(req.query.format) ? req.query.format : 'html';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : todayLocal(tzFor(db, pid));
    let from = req.query.from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) {
      from = db.prepare('SELECT MIN(date) AS d FROM meal_sessions WHERE profile_id = $pid').get({ pid })?.d || to;
    }

    const rows = db.prepare(`
      SELECT ms.date, ms.name AS meal_name,
             f.name AS food_name, f.brand AS food_brand,
             me.quantity_g, me.calories, me.protein, me.carbs, me.fat, me.fiber
      FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      JOIN foods f ON f.id = me.food_id
      WHERE ms.profile_id = $pid AND ms.date BETWEEN $from AND $to
      ORDER BY ms.date ASC, ms.meal_index ASC, me.logged_at ASC
    `).all({ pid, from, to });

    const report = buildReport(rows, from, to, reportContext(db, pid, from, to));
    const base = `plated-report-${from}_to_${to}`;

    if (format === 'csv') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      res.setHeader('Content-Type', 'text/csv');
      return res.send(toCsv(report));
    }
    if (format === 'md') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.md"`);
      res.setHeader('Content-Type', 'text/markdown');
      return res.send(toMarkdown(report));
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(toHtml(report));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
