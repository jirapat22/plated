const express = require('express');
const { getDb } = require('../db');
const { todayLocal, isValidTz, tzFor, isRealDate } = require('../utils/tz');
const { recalcMacroGoals, trendWeight } = require('../utils/macros');
const { snapshotGoals } = require('../utils/goals');
// The same guards the live write routes apply. An import is no more trusted
// than a form — the principle this file already states over the measurements
// band — but it was only ever applied to the tables added after it was written.
const { qtyError, badWeight, badSetting, settingsError } = require('../utils/validate');
const { UNREFERENCED_SQL } = require('../utils/foodAccess');
const { allSettings } = require('../utils/profileSettings');
const { buildRangeReport, toCsv, toMarkdown, toHtml } = require('../utils/report');
const { buildExportPayload } = require('../utils/exportPayload');

const router = express.Router();

const ALLOWED = new Set([
  'calorie_goal', 'protein_goal', 'carb_goal', 'fat_goal',
  'fiber_goal', 'ironlog_api_url', 'ironlog_api_key',
  'phase', 'tdee', 'cut_deficit', 'bulk_surplus', 'energy_unit', 'ironlog_last_synced',
  'target_weight_kg',
  // Today's bodyweight card: 'trend' (the DEFAULT, including when the key is
  // absent — it is not in PROFILE_DEFAULTS) or 'raw' to opt out. Both of these
  // comments said raw was the default long after today.js stopped doing that,
  // and the reason trend won is the whole point: one weigh-in swings ~2 kg on
  // water, so the headline number has to be the smoothed one.
  'weight_display',
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
    // URL safety, timezone and every numeric range, from the one module that
    // decides those — so the form, a restored backup and an IronLog sync
    // cannot disagree about what a setting may hold. '' is allowed throughout:
    // it means "not set", which is not the same as zero.
    const bad = settingsError(req.body, isValidTz);
    if (bad) return res.status(400).json({ error: bad });
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
    // After every path that can move a goal, not before: this records what the
    // goals ARE now, and no-ops when nothing actually changed.
    snapshotGoals(db, req.profileId, todayLocal(tzFor(db, req.profileId)));
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
      // Leftovers go with the batches. Same class of thing — food you still
      // have — and leaving them behind points them at foods just hidden above.
      // They are in the export, so this is a wipe, not a loss.
      db.prepare('DELETE FROM leftovers WHERE profile_id = $pid').run({ pid });
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
    const payload = buildExportPayload(db, pid);
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
    // Same null-not-empty rule as batches: a file taken before goal history
    // existed leaves the history you have alone rather than wiping it to match
    // a file that never knew about it.
    const goal_history  = Array.isArray(body.goal_history) ? body.goal_history : null;
    const measurements  = Array.isArray(body.measurements) ? body.measurements : null;
    const overrides     = Array.isArray(body.daily_overrides) ? body.daily_overrides : null;
    const foodStats     = Array.isArray(body.food_stats) ? body.food_stats : null;
    const leftovers     = Array.isArray(body.leftovers) ? body.leftovers : null;
    // null-not-empty again: a backup taken before presets existed leaves the
    // presets you have alone instead of wiping them to match a file that never
    // knew about them.
    const presets       = Array.isArray(body.presets) ? body.presets : null;
    const presetItems   = Array.isArray(body.preset_items) ? body.preset_items : [];
    const settings      = (body.settings && typeof body.settings === 'object') ? body.settings : {};

    if (!body.exported_at || !Array.isArray(body.meal_sessions)) {
      return res.status(400).json({ error: 'Not a valid Plated export file' });
    }

    let foodsAdded = 0;
    let entriesImported = 0;
    let batchesImported = 0;
    let goalRowsImported = 0;
    let measurementsImported = 0;
    let overridesImported = 0;
    let leftoversImported = 0;
    let presetsImported = 0;
    let sessionsImported = 0;
    let weightImported = 0;
    // Rows the file carried that no live route would have accepted. Reported
    // rather than dropped in silence: a restore that quietly loses days is its
    // own kind of data loss, and the only place it can be noticed is here.
    let skipped = 0;
    db.exec('BEGIN');
    try {
      const findFood = db.prepare('SELECT id FROM foods WHERE name = $name AND brand IS $brand');
      // hidden rides along: a deleted batch's backing food is hidden, not
      // removed, so history keeps rendering. Dropping the flag on import
      // resurrected those into food search as strays.
      const insertFood = db.prepare(`
        INSERT INTO foods (name, brand, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, serving_size_g, source, created_by_profile, hidden)
        VALUES ($name, $brand, $cal, $pro, $carb, $fat, $fiber, $serv, $source, $pid, $hidden)
      `);
      const foodIdMap = new Map();
      for (const f of foods) {
        const brand = f.brand ?? null;
        // A batch's or a leftover's backing food belongs to that ONE batch or
        // leftover — it is minted by it, hidden from search, and carries that
        // batch's per-100g macros. Matching it by name the way a shared
        // catalogue food is matched merges two of them, and two live batches
        // with the same name is an ordinary thing to have ("Chilli", cooked
        // again on Wednesday before Sunday's ran out).
        //
        // Measured: two 'Chilli' batches, 1000g and 500g, exported and
        // restored. Portioning still worked, because that route addresses the
        // batch by id — but adjustBatchStock finds a batch by FOOD, so
        // deleting the portion handed the 100g to the first Chilli, which was
        // already full, where the min(cooked_g, ...) ceiling swallowed it.
        // 100g of food left the system: the entry was gone and no batch got it
        // back. That is the exact failure adjustBatchStock exists to prevent.
        // 'quick' belongs on that list too, and its absence was the most
        // expensive bug in the app.
        //
        // A Quick Log mints a throwaway food out of the words you typed, and
        // POST /api/foods/log deliberately never dedupes them: "two dinners
        // described the same way on different nights are two meals, not one
        // library entry being reused". This matched them by name anyway — across
        // profiles, because foods are a shared table.
        //
        // Measured on two profiles that had each quick-logged "Toast with jam",
        // at 210 and 410 kcal. Restoring the second profile's OWN backup
        // repointed its entry at the FIRST profile's private food. The entry
        // still read 410 while the food behind it said 210 per 100 g, so:
        // opening the edit sheet and pressing Update without changing anything
        // rewrote it to 210, and deleting it made Undo fail with 404 "Food not
        // found" — correctly, since the food now belongs to someone else and the
        // privacy gate refuses it. The meal was unrecoverable.
        const privateToOneOwner = f.source === 'batch' || f.source === 'leftover' || f.source === 'quick';
        const existing = privateToOneOwner ? null : findFood.get({ name: f.name, brand });
        if (existing) { foodIdMap.set(f.id, existing.id); continue; }
        const newId = insertFood.run({
          name: f.name, brand,
          cal: f.calories_per_100g ?? null, pro: f.protein_per_100g ?? null,
          carb: f.carbs_per_100g ?? null, fat: f.fat_per_100g ?? null,
          fiber: f.fiber_per_100g ?? null, serv: f.serving_size_g ?? 100,
          source: f.source || 'custom', pid, hidden: f.hidden ? 1 : 0,
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
        // A session's date is the only handle the app has on it. Anything that
        // isn't a real day makes a session the day route refuses to open (400)
        // and nothing in the UI can reach — while its calories keep counting in
        // every summary, average and export. Dropped, not repaired: there is no
        // way to know which day 2026-02-30 was meant to be.
        if (!isRealDate(s.date)) { skipped++; continue; }
        const newId = insSession.run({ date: s.date, name: s.name ?? null, idx: s.meal_index || 1, logged_at: s.logged_at || null, pid }).lastInsertRowid;
        sessionIdMap.set(s.id, newId);
        sessionsImported++;
      }

      const insEntry = db.prepare(`
        INSERT INTO meal_entries (meal_session_id, food_id, quantity_g, calories, protein, carbs, fat, fiber, logged_at)
        VALUES ($sid, $fid, $qty, $cal, $pro, $carb, $fat, $fiber, $logged_at)
      `);
      for (const e of meal_entries) {
        const sid = sessionIdMap.get(e.meal_session_id);
        const fid = foodIdMap.get(e.food_id);
        if (sid == null || fid == null) { skipped++; continue; } // orphaned reference — food/session missing from this export (or its session was dropped above)
        // The same ceiling POST /api/meals/entries enforces. Without it a file
        // carrying quantity_g 1000000000 restored a 5,189,000,000 kcal entry —
        // the exact figure that guard was written for — into the day totals,
        // the 28-day intake average and the real-maintenance estimate behind
        // Trends' verdict.
        if (qtyError(e.quantity_g)) { skipped++; continue; }
        insEntry.run({ sid, fid, qty: e.quantity_g, cal: e.calories ?? null, pro: e.protein ?? null, carb: e.carbs ?? null, fat: e.fat ?? null, fiber: e.fiber ?? null, logged_at: e.logged_at || null });
        entriesImported++;
      }

      const insWeight = db.prepare('INSERT INTO weight_log (date, weight_kg, note, source, logged_at, profile_id) VALUES ($date, $kg, $note, $src, $logged_at, $pid)');
      for (const w of weight_log) {
        // Everything POST /api/weight learned the hard way, applied to the file
        // as well: a real date, the 20-400 kg band, and — the one that bites
        // silently — storing parseFloat rather than the raw value. SQLite's
        // loose typing accepted "70abc" straight into the REAL column, where it
        // poisons every average, trend and macro recalculation that reads it
        // back. Same three bugs as the route, arriving through the other door.
        if (!isRealDate(w.date) || badWeight(w.weight_kg)) { skipped++; continue; }
        insWeight.run({ date: w.date, kg: parseFloat(w.weight_kg), note: w.note ?? null, src: w.source || 'manual', logged_at: w.logged_at || null, pid });
        weightImported++;
      }

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
          if (!b.name || !(b.cooked_g > 0)) { skipped++; continue; }   // unusable without a divisor
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
            // null in, null out — the same rule the live routes follow. `|| 0`
            // rebuilt a restored batch's backing food asserting 0 g of macros
            // nobody ever recorded, which then counted as measured on every day
            // a portion of it landed on. The restore door had not learned what
            // POST and PATCH both know.
            const per = k => (b[k] == null ? null : Math.round((b[k] / b.cooked_g * 100) * 10) / 10);
            fid = insertFood.run({
              name: b.name, brand: null,
              cal: per('calories'), pro: per('protein'), carb: per('carbs'),
              fat: per('fat'), fiber: per('fiber'), serv: 100, source: 'batch', pid, hidden: 0,
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

      if (goal_history) {
        db.prepare('DELETE FROM goal_history WHERE profile_id = $pid').run({ pid });
        const insGoal = db.prepare(`
          INSERT INTO goal_history (profile_id, effective_from, calorie_goal, protein_goal, carb_goal, fat_goal, fiber_goal, created_at)
          VALUES ($pid, $d, $cal, $pro, $carb, $fat, $fib, COALESCE($created, datetime('now')))
        `);
        for (const gh of goal_history) {
          // The date is the primary key and the whole point of the row — a junk
          // one would sort wrong and answer for days it never applied to.
          if (!isRealDate(gh.effective_from)) { skipped++; continue; }
          insGoal.run({
            pid, d: gh.effective_from,
            cal: gh.calorie_goal ?? null, pro: gh.protein_goal ?? null, carb: gh.carb_goal ?? null,
            fat: gh.fat_goal ?? null, fib: gh.fiber_goal ?? null, created: gh.created_at ?? null,
          });
          goalRowsImported++;
        }
      }


      if (measurements) {
        db.prepare('DELETE FROM measurements WHERE profile_id = $pid').run({ pid });
        const insM = db.prepare(`INSERT OR REPLACE INTO measurements (profile_id, date, waist_cm, logged_at)
          VALUES ($pid, $d, $w, COALESCE($at, datetime('now')))`);
        for (const m of measurements) {
          const w = parseFloat(m.waist_cm);
          // Same 40-200 cm band the POST route enforces — an import is no more
          // trusted than a form, and a 32 typed for inches would render a chart
          // nobody can read.
          if (!isRealDate(m.date) || !(w >= 40 && w <= 200)) { skipped++; continue; }
          insM.run({ pid, d: m.date, w: Math.round(w * 10) / 10, at: m.logged_at ?? null });
          measurementsImported++;
        }
      }

      if (overrides) {
        db.prepare('DELETE FROM daily_overrides WHERE profile_id = $pid').run({ pid });
        const insO = db.prepare('INSERT OR REPLACE INTO daily_overrides (profile_id, date, key, value) VALUES ($pid, $d, $k, $v)');
        for (const o of overrides) {
          if (!isRealDate(o.date) || !o.key) { skipped++; continue; }
          insO.run({ pid, d: o.date, k: String(o.key), v: o.value == null ? null : String(o.value) });
          overridesImported++;
        }
      }

      if (foodStats) {
        db.prepare('DELETE FROM profile_food_stats WHERE profile_id = $pid').run({ pid });
        const insS = db.prepare(`INSERT OR REPLACE INTO profile_food_stats (profile_id, food_id, use_count, last_used, last_qty_g)
          VALUES ($pid, $fid, $n, $at, $q)`);
        for (const s of foodStats) {
          // Food ids are per-database, so these remap the same way meal_entries
          // do. A stat whose food didn't come across is dropped rather than
          // pointed at whatever now holds that id.
          const fid = s.food_id != null ? foodIdMap.get(s.food_id) : null;
          if (fid == null) continue;
          insS.run({ pid, fid, n: s.use_count ?? 1, at: s.last_used ?? null, q: s.last_qty_g ?? null });
        }
      }

      if (leftovers) {
        db.prepare('DELETE FROM leftovers WHERE profile_id = $pid').run({ pid });
        const insL = db.prepare(`INSERT INTO leftovers (profile_id, name, food_id, quantity_g, calories, protein, carbs, fat, fiber, created_at)
          VALUES ($pid, $n, $f, $q, $cal, $p, $c, $ft, $fb, COALESCE($at, datetime('now')))`);
        for (const l of leftovers) {
          if (!l.name) { skipped++; continue; }
          // Food ids are per-database, so remap like meal_entries do. A leftover
          // whose food didn't come across keeps its stored macros and loses only
          // the link — it is still a real portion in a real fridge.
          const fid = l.food_id != null ? (foodIdMap.get(l.food_id) ?? null) : null;
          insL.run({ pid, n: String(l.name).slice(0, 80), f: fid, q: l.quantity_g ?? null,
            cal: l.calories ?? 0, p: l.protein ?? null, c: l.carbs ?? null,
            ft: l.fat ?? null, fb: l.fiber ?? null, at: l.created_at ?? null });
          leftoversImported++;
        }
      }

      if (presets) {
        // Replace wholesale, like every other owned table here: cascade takes
        // the items, then rebuild from the file. A preset item whose food did
        // not come across is DROPPED rather than written with a null food —
        // preset_items.food_id is NOT NULL, and a recipe line with no food is
        // not a recipe line. It is counted as skipped so the restore says so.
        db.prepare('DELETE FROM presets WHERE profile_id = $pid').run({ pid });
        const insP = db.prepare(
          "INSERT INTO presets (profile_id, name, kind, created_at) VALUES ($pid, $n, $k, COALESCE($at, datetime('now')))");
        const insPI = db.prepare(
          'INSERT INTO preset_items (preset_id, food_id, quantity_g, sort) VALUES ($p, $f, $q, $s)');
        const byPreset = new Map();
        for (const it of presetItems) {
          if (!byPreset.has(it.preset_id)) byPreset.set(it.preset_id, []);
          byPreset.get(it.preset_id).push(it);
        }
        for (const pr of presets) {
          if (!pr.name || (pr.kind !== 'batch' && pr.kind !== 'meal')) { skipped++; continue; }
          const rows = (byPreset.get(pr.id) || [])
            .map(it => ({ ...it, fid: foodIdMap.get(it.food_id) ?? null }))
            .filter(it => it.fid != null && it.quantity_g > 0);
          const lost = (byPreset.get(pr.id) || []).length - rows.length;
          if (lost) skipped += lost;
          // A preset with nothing left in it would be a name that does nothing.
          if (rows.length === 0) { skipped++; continue; }
          const newId = insP.run({ pid, n: String(pr.name).slice(0, 40), k: pr.kind, at: pr.created_at ?? null })
            .lastInsertRowid;
          rows.forEach((it, i) => insPI.run({ p: newId, f: it.fid, q: it.quantity_g, s: it.sort ?? i }));
          presetsImported++;
        }
      }

      // Sweep minted leftover foods nothing points at any more.
      //
      // Import matches foods by name+brand, and a whole-meal leftover names its
      // backing food after the meal — so two meals both called "Dinner" mint two
      // foods called "Dinner", and the restore collapses both leftovers onto the
      // first. The leftovers are unharmed (their macros live on their own row,
      // and each still logs its own calories), but the second food is left with
      // nothing referencing it: one invisible row per collision, forever.
      //
      // Swept rather than prevented, because the alternatives are worse. A
      // unique name would show up in the report, which renders a logged
      // leftover by its food name, and a unique brand would render there too.
      // Scoped to this profile's own minted rows, and only ones nothing at all
      // references.
      //
      // All THREE private sources, not just 'leftover'. Every restore re-inserts
      // the quick and batch foods rather than matching them by name — that is
      // deliberate (privateToOneOwner, above: two pots called "Chilli" must not
      // merge) — and the rows the previous restore made are then orphaned. The
      // sweep only named 'leftover', so they were never collected: measured at
      // exactly 2 permanent orphans per restore, unbounded, on a shared foods
      // table. The same list is already used by the profile-delete sweep; this
      // one was the half that didn't learn.
      db.prepare(`
        DELETE FROM foods
        WHERE source IN ('quick', 'batch', 'leftover') AND created_by_profile = $pid
          AND ${UNREFERENCED_SQL}
      `).run({ pid });

      const setSetting = db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)');
      for (const [key, value] of Object.entries(settings)) {
        // The tables above learned this; the settings block had not. A file
        // could set ironlog_api_url to 127.0.0.1 — which PATCH refuses, and
        // which turns GET /api/ironlog/raw into an SSRF read oracle — or a
        // calorie_goal of -500, which snapshotGoals then wrote into
        // goal_history as a permanent record of an impossible target.
        if (!ALLOWED.has(key) || value == null) continue;
        if (badSetting(key, value, isValidTz)) { skipped++; continue; }
        setSetting.run({ pid, key, value: String(value) });
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // A file older than goal history restores the settings without the record of
    // when they applied, so stamp the restored goals as of today. No-ops when
    // the file carried its own history and the newest row already matches.
    snapshotGoals(db, pid, todayLocal(tzFor(db, pid)));

    res.json({
      success: true,
      // Counts of what was actually written. These reported the file's own row
      // counts, which stopped being true the moment anything could be rejected.
      imported: { meals: sessionsImported, entries: entriesImported, weight: weightImported,
        foods_added: foodsAdded, batches: batchesImported, goal_rows: goalRowsImported,
        measurements: measurementsImported, day_notes: overridesImported, leftovers: leftoversImported,
        presets: presetsImported },
      skipped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    const report = buildRangeReport(db, pid, from, to);
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
