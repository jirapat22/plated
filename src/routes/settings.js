const express = require('express');
const { getDb } = require('../db');
const { todayLocal, isValidTz, tzFor, isRealDate } = require('../utils/tz');
const { recalcMacroGoals, trendWeight } = require('../utils/macros');
const { snapshotGoals, goalsOn } = require('../utils/goals');
// The same guards the live write routes apply. An import is no more trusted
// than a form — the principle this file already states over the measurements
// band — but it was only ever applied to the tables added after it was written.
const { qtyError } = require('./meals');
const { badWeight } = require('./weight');

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
  // URL.hostname keeps the brackets on an IPv6 literal — 'http://[::1]:3000'
  // gives '[::1]', not '::1' — so the comparison below could never match and
  // every loopback form walked straight through. http://[::1]:PORT reached the
  // app's own port; so did [0:0:0:0:0:0:0:1] and [::ffff:127.0.0.1].
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0') return false;
  // Any IPv6 literal is judged by the one rule that is short and complete:
  // globally routable IPv6 is 2000::/3. Loopback (::1), unspecified (::),
  // unique-local (fc00::/7), link-local (fe80::/10) and IPv4-mapped
  // (::ffff:7f00:1) all fall outside it, so one test covers forms that would
  // each otherwise need their own case — and anything new does too.
  if (host.includes(':')) return /^[23]/.test(host);
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

// Sane ranges for the settings that are numbers.
//
// Weight and waist have had bounds (and a "check the decimal point" message)
// since someone could type 700 kg. These never did: PATCH /api/settings took
// calorie_goal -500 and calorie_goal 1000000000 without comment, wrote them,
// and — because snapshotGoals runs after every goal write — recorded them into
// goal_history, where they permanently describe what you were "aiming at" on
// that day. A negative goal makes every ring, every "left" figure and every
// history comparison nonsense, with no way to tell where it came from.
//
// Bounds are wide on purpose: they exist to catch a slipped decimal point or a
// probe, not to have an opinion about anyone's diet.
// [min, max, unit] — the unit is appended to the message rather than left in
// the key, so it reads "between 20 and 400 kg" and not "target weight kg".
const NUMERIC_RANGE = {
  calorie_goal:        [200, 20000, 'kcal'],
  protein_goal:        [0, 2000, 'g'],
  carb_goal:           [0, 2000, 'g'],
  fat_goal:            [0, 2000, 'g'],
  fiber_goal:          [0, 500, 'g'],
  protein_multiplier:  [0, 10],
  fat_multiplier:      [0, 10],
  tdee:                [500, 20000, 'kcal'],
  cut_deficit:         [0, 5000, 'kcal'],
  bulk_surplus:        [0, 5000, 'kcal'],
  target_weight_kg:    [20, 400, 'kg'],
  bodyweight_kg:       [20, 400, 'kg'],
  height_cm:           [50, 260, 'cm'],
  birth_year:          [1900, 2100],
  activity_level:      [1, 3],
  ui_scale:            [100, 150, '%'],
};

// Returns an error message, or null when everything numeric is in range. Blank
// is allowed throughout — several of these are legitimately "not set yet"
// (tdee, target_weight_kg), and clearing one is not the same as setting it to
// zero.
function rangeError(body) {
  for (const [key, [min, max, unit]] of Object.entries(NUMERIC_RANGE)) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === '' || raw === null || raw === undefined) continue;
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v < min || v > max) {
      // Reads like the weight and waist messages rather than naming the column:
      // "Protein multiplier must be between 0 and 10", not "protein_multiplier".
      const label = key.replace(/_(kg|cm)$/, '').replace(/_/g, ' ');
      // Separators above four digits only, so a year stays 1900 and not 1,900.
      const n = x => (x >= 10000 ? x.toLocaleString('en-NZ') : String(x));
      return `${label[0].toUpperCase()}${label.slice(1)} must be between ${n(min)} and ${n(max)}${unit ? ' ' + unit : ''}`;
    }
  }
  return null;
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
    const bad = rangeError(req.body);
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
        UNION
        -- A whole-meal leftover mints its own backing food and has no
        -- meal_entries until it is eaten, so neither branch above reaches it.
        -- Without this the restored leftover's food_id remaps to null, and
        -- because loadDay INNER JOINs foods the entry it creates is written and
        -- then never rendered: measured at 0 of 400 kcal landing on the day.
        SELECT f.* FROM foods f
        JOIN leftovers l ON l.food_id = f.id
        WHERE l.profile_id = $pid
      `).all({ pid }),
      // Batches were absent from every export until now, while "Clear all
      // logged data" deleted them — so export → clear → restore silently lost
      // every meal prep you'd saved.
      batches: db.prepare('SELECT * FROM batches WHERE profile_id = $pid').all({ pid }),
      // Same clear-deletes-it/export-misses-it trap batches and daily_overrides
      // each fell into once. Carried from the start this time.
      leftovers: db.prepare('SELECT * FROM leftovers WHERE profile_id = $pid').all({ pid }),
      meal_sessions: db.prepare('SELECT * FROM meal_sessions WHERE profile_id = $pid').all({ pid }),
      meal_entries:  db.prepare(`
        SELECT me.* FROM meal_entries me
        JOIN meal_sessions ms ON ms.id = me.meal_session_id
        WHERE ms.profile_id = $pid
      `).all({ pid }),
      weight_log:    db.prepare('SELECT * FROM weight_log WHERE profile_id = $pid').all({ pid }),
      // Without this, export → "clear all data" → import silently reinstates the
      // exact defect goal_history exists to prevent: settings come back, boot
      // re-anchors the current goal at TODAY, and every past day quietly reverts
      // to being judged against a target set afterwards. Unrecoverable, because
      // nothing else in the file records what you were aiming at and when.
      goal_history:  db.prepare('SELECT * FROM goal_history WHERE profile_id = $pid ORDER BY effective_from').all({ pid }),
      // Waist history. Never captured, so restoring onto a new device or a fresh
      // DB lost the whole series — and it is the one measurement that keeps
      // meaning something when the scale is arguing with you.
      measurements:  db.prepare('SELECT date, waist_cm, logged_at FROM measurements WHERE profile_id = $pid ORDER BY date').all({ pid }),
      // The "I ate light, this day is fine" confirmations. THE dangerous gap:
      // "Clear all logged data" deletes these and the export did not carry them,
      // so export -> clear -> import silently un-confirmed every day. Those days
      // go back to counting as under-logged, which drops them from the 28-day
      // intake average behind the maintenance estimate — so a restore quietly
      // changed a number the user makes decisions on.
      daily_overrides: db.prepare('SELECT date, key, value FROM daily_overrides WHERE profile_id = $pid').all({ pid }),
      // Use counts and last portion sizes. Not data you'd mourn, but it is what
      // makes logging fast — without it "recent foods" is empty and every
      // quantity sheet forgets the portion you always take.
      food_stats:    db.prepare('SELECT food_id, use_count, last_used, last_qty_g FROM profile_food_stats WHERE profile_id = $pid').all({ pid }),
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
    // Same null-not-empty rule as batches: a file taken before goal history
    // existed leaves the history you have alone rather than wiping it to match
    // a file that never knew about it.
    const goal_history  = Array.isArray(body.goal_history) ? body.goal_history : null;
    const measurements  = Array.isArray(body.measurements) ? body.measurements : null;
    const overrides     = Array.isArray(body.daily_overrides) ? body.daily_overrides : null;
    const foodStats     = Array.isArray(body.food_stats) ? body.food_stats : null;
    const leftovers     = Array.isArray(body.leftovers) ? body.leftovers : null;
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
        const existing = findFood.get({ name: f.name, brand });
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
            const per = k => Math.round(((b[k] || 0) / b.cooked_g * 100) * 10) / 10;
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
      db.prepare(`
        DELETE FROM foods WHERE source = 'leftover' AND created_by_profile = $pid
          AND NOT EXISTS (SELECT 1 FROM meal_entries me WHERE me.food_id = foods.id)
          AND NOT EXISTS (SELECT 1 FROM leftovers l    WHERE l.food_id  = foods.id)
          AND NOT EXISTS (SELECT 1 FROM batches b      WHERE b.food_id  = foods.id)
      `).run({ pid });

      const setSetting = db.prepare('INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)');
      for (const [key, value] of Object.entries(settings)) {
        if (ALLOWED.has(key) && value != null) setSetting.run({ pid, key, value: String(value) });
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
        measurements: measurementsImported, day_notes: overridesImported, leftovers: leftoversImported },
      skipped,
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
// Markdown tables are pipe-delimited, so a name containing a pipe splits the
// row into extra columns and the table stops being a table. HTML escapes these
// cells and CSV escapes them; Markdown was the one renderer that did not — and
// meal names are typed by the user, food names arrive from Open Food Facts,
// and a whole-meal leftover names its backing food after the meal. A newline
// ends the row outright, so those collapse to a space.
const escMd = v => String(v ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
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
// One formatter, built once. toLocaleDateString constructs a fresh
// Intl.DateTimeFormat on every call — measured at 45µs each against 0.9µs for a
// reused one — and the report calls this per day. On an "All" range covering
// five years that was 81ms of the ~200ms this route blocks the event loop for,
// spent entirely on rebuilding the same formatter 1,825 times.
const DAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay = date => DAY_FMT.format(new Date(`${date}T00:00:00`));

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

// Written once for the same reason goalNote is. Empty when the range doesn't
// reach today, which is most exports.
const progressNote = report => report.inProgressDay
  ? `${report.inProgressDay.date} is today and still being logged (${kcal(report.inProgressDay.total.calories)} kcal so far). It is listed in full below, but left out of the averages, the goal comparison and adherence — it is not yet an observation of a day's intake.`
  : '';

// The goal caveat, written once. Three hand-maintained copies is exactly how
// this went wrong: when goal history shipped, the HTML note was rewritten and
// the CSV and Markdown ones were not, so both files carried "Plated stores no
// goal history" directly above an adherence line computed from that history.
// Now the renderers can only differ in markup, never in what they claim.
function goalNote(report) {
  const head = 'The goal row above is your current goal.';
  const a = report.adherence;
  if (!a) return `${head} No logged days in this range to compare it against.`;
  const est = a.estimated || 0;
  if (!est) return `${head} Every logged day in this range is compared against the goal recorded for that day.`;
  const cur = report.goals.calories != null ? `${kcal(report.goals.calories)} kcal` : 'it';
  const d = `${est} logged day${est === 1 ? '' : 's'}`;
  return report.historyFrom
    ? `${head} Goal history begins ${report.historyFrom} — days from then on are compared against the goal recorded for that day, while the ${d} before it are compared against ${cur}, because nothing was recorded yet. Treat those as an estimate.`
    : `${head} No goal was recorded for any day in this range, so all ${d} are compared against ${cur}. If your target was different then, those comparisons are estimates rather than measurements.`;
}

// Everything the report needs beyond the food rows: what you were aiming at,
// what the scale did, and the plan behind both.
//
// `goals` is the CURRENT goal — the headline figure, labelled as such. Per-day
// comparisons do NOT use it: they go through goalFor(), which reads
// goal_history and answers for the day being asked about. Days that predate the
// history genuinely have no recorded answer and fall back to the current goal;
// the renderers count those separately and say so, rather than letting an
// estimate pass as a measurement.
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
  // Goals as they were on each day, from goal_history. Cached per date because
  // adherence asks for one per logged day and the weekly table asks again.
  const cache = new Map();
  const goalFor = date => {
    if (!cache.has(date)) cache.set(date, goalsOn(db, pid, date));
    return cache.get(date);
  };
  return {
    goals: {
      calories: num('calorie_goal'), protein: num('protein_goal'),
      carbs: num('carb_goal'), fat: num('fat_goal'), fiber: num('fiber_goal'),
    },
    phase: s.phase || null,
    tdee:  num('tdee'),
    weights,
    goalFor,
    // The report had no concept of "today", so a range ending today averaged in
    // a day the user was still eating. Trends learned this; the report is the
    // artifact someone hands to a doctor, so it matters more here.
    today: todayLocal(tzFor(db, pid)),
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
    // Unrounded, because estMaintenance multiplies it by 7,700: rounding to
    // 0.1 kg/week first would put ±55 kcal/day of pure rounding into the answer.
    slopePerDay: slope,
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
  // A range ending today includes a day still being eaten. It stays in the
  // day-by-day tables — hiding what you logged would be worse — but it is not
  // an observation of a day's intake, so it is kept out of every figure derived
  // from one: the averages, the goal comparison, adherence and the implied
  // maintenance. Over 90 days it was noise; over 7 it read 1,732 against a true
  // 1,788, always low, and worst in the morning.
  for (const d of days) d.inProgress = !!ctx.today && d.date === ctx.today;
  const finished = days.filter(d => !d.inProgress);
  const inProgressDay = days.find(d => d.inProgress) || null;

  const daysLogged = finished.length;
  const avg = daysLogged ? sumMacros(finished.map(d => d.total)) : zeroMacros();
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
  // Each day is judged against the goal that was live THAT day. Measuring an
  // old week against a goal set afterwards is how a month spent on plan turns
  // into a month of failures the moment you adjust your target.
  const goalFor = ctx.goalFor || (() => null);
  for (const d of days) {
    const gh = goalFor(d.date);
    d.goal = gh && gh.calorie_goal > 0 ? gh.calorie_goal : (goals.calories || null);
    d.goalRecorded = !!gh?.recorded;
  }
  let adherence = null;
  if (daysLogged && finished.some(d => d.goal > 0)) {
    adherence = { onTarget: 0, over: 0, under: 0, bandPct: 10, unknownGoal: 0, estimated: 0 };
    for (const d of finished) {
      if (!(d.goal > 0)) { adherence.unknownGoal++; continue; }
      // Scored against the CURRENT goal because nothing was recorded that far
      // back. Still the most useful comparison available, but it is an estimate
      // and has to travel labelled: goal history began on one date, and every
      // day before it was silently being judged against a target that may not
      // have existed yet — the exact defect goal_history was built to end.
      if (!d.goalRecorded) adherence.estimated++;
      const diff = d.total.calories - d.goal;
      if (Math.abs(diff) <= d.goal * 0.10) adherence.onTarget++;
      else if (diff > 0) adherence.over++;
      else adherence.under++;
    }
  }
  // Did the goal actually move inside this range? Only worth explaining if so.
  const goalChanges = [...new Map(days.filter(d => d.goalRecorded)
    .map(d => [goalFor(d.date).effective_from, goalFor(d.date)])).values()]
    .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  // The first day in this range with a real recorded goal. Everything before it
  // is measured against the current one, and every renderer needs to be able to
  // name that date rather than waving at "earlier days".
  const historyFrom = goalChanges.length ? goalChanges[0].effective_from : null;

  // Maintenance implied by THIS range: what you ate, corrected for what the
  // scale did (1 kg ~ 7,700 kcal). Deliberately computed from the reported
  // range rather than reusing Trends' fixed 28-day window, and it counts every
  // logged day where Trends drops the under-logged ones — so the two figures
  // can legitimately differ. Needs a real span to mean anything.
  //
  // From the least-squares fit over every reading, NOT last-minus-first. Two
  // raw endpoints let a single water-weight morning set the answer, and the end
  // point is usually today — the most likely day to be carrying water from
  // yesterday's eating. Measured on real data: the endpoint method read
  // -0.210 kg/week where the fit read -0.399, a 208 kcal/day difference in the
  // figure below. The fit was already being computed here and printed two
  // sections down as "Rate of change", so the report was showing both numbers
  // and quoting the fragile one.
  const weightDetail = analyseWeight(wRows);
  const estMaintenance = (weight && weight.spanDays >= 14 && daysLogged >= 7 && weightDetail?.slopePerDay != null)
    ? Math.round(avg.calories - weightDetail.slopePerDay * 7700)
    : null;

  return {
    from, to, days,
    summary: { daysInRange, daysLogged, avg },
    goals, vsGoal, adherence, weight, estMaintenance, goalChanges, historyFrom, inProgressDay,
    weightDetail,
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
  // Header labels escape like any other cell — one of them contains a comma,
  // and unescaped it split into an extra column and made the file ragged.
  // Declared here rather than inside a block: the goal-changes section uses it
  // too, and a const scoped to a later block threw a ReferenceError that came
  // back as a 500 with an empty report.
  const head = (...cells) => cells.map(escCsv).concat(Array(COLS - cells.length).fill('')).join(',');

  // Quantity doubles as the day's calorie goal on Day total rows — same column,
  // unambiguous by row type, and it keeps the table at ten columns.
  const lines = ['Date,Meal,Food,Quantity (g) / day goal,Calories (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g),Weight (kg)'];
  for (const day of report.days) {
    for (const meal of day.meals) {
      for (const e of meal.entries) {
        lines.push([day.date, escCsv(meal.name), escCsv(foodName(e)),
          e.quantity_g ?? '', e.calories ?? '', e.protein ?? '', e.carbs ?? '', e.fat ?? '', e.fiber ?? '', ''].join(','));
      }
    }
    // The day's weigh-in rides on its total row — intake and scale on one line.
    lines.push([day.date, '', escCsv(day.inProgress ? 'Day total (in progress)' : 'Day total'),
      day.goal ?? '', day.total.calories, day.total.protein,
      day.total.carbs, day.total.fat, day.total.fiber, day.weight_kg ?? ''].join(','));
  }

  lines.push('', 'Summary' + ','.repeat(COLS - 1));
  lines.push(kv('Date range', `${report.from} to ${report.to}`));
  lines.push(kv('Days logged', `${summary.daysLogged} of ${summary.daysInRange}`));
  if (progressNote(report)) lines.push(kv('Today', progressNote(report)));
  lines.push(macroRow('Average per logged day', summary.avg));
  lines.push(macroRow('Goal (current, see note)', goals));
  lines.push(macroRow('Average minus goal', vsGoal));
  lines.push(kv('Note on goals', goalNote(report)));

  if (report.phase) lines.push(kv('Phase', report.phase));
  if (report.tdee != null) lines.push(kv('Set maintenance / TDEE (kcal)', report.tdee));
  if (report.estMaintenance != null) {
    lines.push(kv('Estimated maintenance from this range (kcal)', report.estMaintenance));
    lines.push(kv('How that was derived', 'Average intake minus the least-squares weight trend x 7700. The trend is fitted across every weigh-in rather than taken from the first and last, so one water-weight morning cannot set the answer. Counts every logged day; Trends excludes under-logged days and uses a fixed 28-day window, so the two can differ.'));
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
    if (adherence.estimated) lines.push(kv('Days measured against the current goal (none recorded then)', adherence.estimated));
    if (adherence.unknownGoal) lines.push(kv('Days with no goal at all', adherence.unknownGoal));
  }

  if (report.goalChanges?.length > 1) {
    lines.push('', 'Goal changes in this range' + ','.repeat(COLS - 1));
    lines.push(head('Effective from', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Fiber (g)'));
    for (const gc of report.goalChanges) {
      lines.push([gc.effective_from, gc.calorie_goal ?? '', gc.protein_goal ?? '', gc.carb_goal ?? '',
        gc.fat_goal ?? '', gc.fiber_goal ?? ''].concat(Array(COLS - 6).fill('')).join(','));
    }
    lines.push(kv('Note', "Days from each date onward are compared against that row's goal."));
  }

  const wd = report.weightDetail;
  if (wd) {
    if (wd.ratePerWeek != null) lines.push(kv('Rate of change (kg/week, least-squares)', wd.ratePerWeek));
    lines.push('', 'Weight by week' + ','.repeat(COLS - 1));
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
  if (progressNote(report)) lines.push('', `_${progressNote(report)}_`);

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
      '', `_${goalNote(report)}_`);
  }
  if (adherence) {
    lines.push('', `**Adherence:** ${adherence.onTarget} of ${report.summary.daysLogged} logged days within ${adherence.bandPct}% of that day's calorie goal · ${adherence.over} over · ${adherence.under} under${adherence.unknownGoal ? ` · ${adherence.unknownGoal} with no goal at all` : ''}`);
    if (adherence.estimated) {
      lines.push('', `_${adherence.estimated} of those day${adherence.estimated === 1 ? ' predates' : 's predate'} recorded goal history and ${adherence.estimated === 1 ? 'was' : 'were'} measured against your current goal instead._`);
    }
  }
  if (report.goalChanges?.length > 1) {
    lines.push('', '### Goal changes in this range', '', '| From | Calories | P | C | F | Fib |', '|---|--:|--:|--:|--:|--:|');
    for (const gc of report.goalChanges) {
      lines.push(`| ${gc.effective_from} | ${kcal(gc.calorie_goal)} | ${g(gc.protein_goal)} | ${g(gc.carb_goal)} | ${g(gc.fat_goal)} | ${g(gc.fiber_goal)} |`);
    }
    lines.push('', "_Days from each date onward are compared against that row's goal._");
  }
  if (report.phase || report.tdee != null || report.estMaintenance != null) {
    lines.push('', '## Plan', '', '| | |', '|---|---|');
    if (report.phase) lines.push(`| Phase | ${report.phase} |`);
    if (report.tdee != null) lines.push(`| Set maintenance (TDEE) | ${kcal(report.tdee)} kcal |`);
    if (report.estMaintenance != null) {
      lines.push(`| Maintenance implied by this range | ${kcal(report.estMaintenance)} kcal |`);
      lines.push('', '_Implied maintenance = average intake corrected for the weight trend (1 kg ≈ 7,700 kcal). The trend is the least-squares fit across every weigh-in — not the first and last readings — so a day of water weight can\'t set the figure. It counts every logged day, where the Trends figure drops under-logged days and uses a fixed 28-day window, so the two can differ._');
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
    lines.push('', '---', '', `## ${fmtDay(day.date)}${day.weight_kg != null ? ` · ${g(day.weight_kg)} kg` : ''}${day.inProgress ? ' · still being logged' : ''}`, '',
      `**${kcal(t.calories)} kcal** · ${macroLine(t)}`, '',
      '| Meal | Food | Qty | Cal | P | C | F | Fib |',
      '|---|---|--:|--:|--:|--:|--:|--:|');
    for (const meal of day.meals) {
      meal.entries.forEach((e, i) => {
        lines.push(`| ${i === 0 ? escMd(meal.name) : ''} | ${escMd(foodName(e))} | ${g(e.quantity_g)} g | ${kcal(e.calories)} | ${g(e.protein)} | ${g(e.carbs)} | ${g(e.fat)} | ${g(e.fiber)} |`);
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
        <h2>${escHtml(fmtDay(day.date))}${day.weight_kg != null ? ` <span class="dayw">${g(day.weight_kg)} kg</span>` : ''}${day.inProgress ? ' <span class="dayw">still being logged</span>' : ''}</h2>
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
    ${adherence ? `<p class="note"><strong>${adherence.onTarget} of ${summary.daysLogged}</strong> logged days landed within ${adherence.bandPct}% of <em>that day's</em> calorie goal · ${adherence.over} over · ${adherence.under} under${adherence.unknownGoal ? ` · ${adherence.unknownGoal} with no goal at all` : ''}.</p>` : ''}
    ${report.goalChanges?.length > 1 ? `
      <h3 style="margin-top:22px">Goal changes in this range</h3>
      <table class="kv">
        <thead><tr><th>From</th><th>Calories</th><th>P</th><th>C</th><th>F</th><th>Fib</th></tr></thead>
        <tbody>${report.goalChanges.map(gc => `<tr><td>${escHtml(gc.effective_from)}</td><td>${kcal(gc.calorie_goal)}</td><td>${g(gc.protein_goal)}</td><td>${g(gc.carb_goal)}</td><td>${g(gc.fat_goal)}</td><td>${g(gc.fiber_goal)}</td></tr>`).join('')}</tbody>
      </table>` : ''}
    <p class="note">${escHtml(goalNote(report))}</p>
  </section>`;

  const planBlock = (!report.phase && report.tdee == null && report.estMaintenance == null) ? '' : `
  <section class="block">
    <h3>Plan</h3>
    <table class="kv"><tbody>
      ${report.phase ? `<tr><td>Phase</td><td>${escHtml(report.phase)}</td></tr>` : ''}
      ${report.tdee != null ? `<tr><td>Set maintenance (TDEE)</td><td>${kcal(report.tdee)} kcal</td></tr>` : ''}
      ${report.estMaintenance != null ? `<tr><td>Maintenance implied by this range</td><td>${kcal(report.estMaintenance)} kcal</td></tr>` : ''}
    </tbody></table>
    ${report.estMaintenance != null ? `<p class="note">Implied maintenance is average intake corrected for the weight <em>trend</em> (1&nbsp;kg ≈ 7,700&nbsp;kcal). The trend is the least-squares fit across every weigh-in rather than the first and last readings, so a single morning of water weight can't set the figure. It counts every logged day, where the figure on Trends drops under-logged days and uses a fixed 28-day window — so the two can legitimately differ.</p>` : ''}
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
    ${progressNote(report) ? `<p class="note">${escHtml(progressNote(report))}</p>` : ''}
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
