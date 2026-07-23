const express = require('express');
const { getDb } = require('../db');
const { todayLocal } = require('../utils/tz');

const router = express.Router();

const ALLOWED = new Set([
  'calorie_goal', 'protein_goal', 'carb_goal', 'fat_goal',
  'fiber_goal', 'ironlog_api_url', 'ironlog_api_key', 'protein_multiplier',
  'phase', 'tdee', 'cut_deficit', 'bulk_surplus', 'energy_unit', 'ironlog_last_synced',
  'target_weight_kg',
  'weight_display',   // Today's bodyweight card: 'raw' (default) or 'trend'
]);

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
    res.json(allSettings(getDb(), req.profileId));
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
    const db = getDb();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES ($pid, $key, $value)'
    );
    for (const [key, value] of Object.entries(req.body)) {
      if (ALLOWED.has(key)) stmt.run({ pid: req.profileId, key, value: String(value) });
    }
    res.json(allSettings(db, req.profileId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete this profile's logged data (meals, weight, templates) — keeps foods + settings
router.delete('/data', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM meal_sessions  WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM weight_log     WHERE profile_id = $pid').run({ pid });
      db.prepare('DELETE FROM meal_templates WHERE profile_id = $pid').run({ pid });
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

// Export meals as CSV
router.get('/export-csv', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT ms.date, ms.name AS meal_name,
             f.name AS food_name, me.quantity_g,
             me.calories, me.protein, me.carbs, me.fat, me.fiber
      FROM meal_entries me
      JOIN meal_sessions ms ON ms.id = me.meal_session_id
      JOIN foods f ON f.id = me.food_id
      WHERE ms.profile_id = $pid
      ORDER BY ms.date ASC, ms.meal_index ASC, me.logged_at ASC
    `).all({ pid: req.profileId });

    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [
      'Date,Meal,Food,Quantity (g),Calories (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g)',
      ...rows.map(r => [
        r.date, esc(r.meal_name), esc(r.food_name),
        r.quantity_g ?? '', r.calories ?? '', r.protein ?? '',
        r.carbs ?? '', r.fat ?? '', r.fiber ?? '',
      ].join(',')),
    ];

    const filename = `plated-meals-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      foods: db.prepare(`
        SELECT DISTINCT f.* FROM foods f
        JOIN meal_entries me ON me.food_id = f.id
        JOIN meal_sessions ms ON ms.id = me.meal_session_id
        WHERE ms.profile_id = $pid
      `).all({ pid }),
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
// matching what /export actually captures — batches/templates/overrides
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
    const settings      = (body.settings && typeof body.settings === 'object') ? body.settings : {};

    if (!body.exported_at || !Array.isArray(body.meal_sessions)) {
      return res.status(400).json({ error: 'Not a valid Plated export file' });
    }

    let foodsAdded = 0;
    let entriesImported = 0;
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
      imported: { meals: meal_sessions.length, entries: entriesImported, weight: weight_log.length, foods_added: foodsAdded },
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
const zeroMacros = () => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
const sumMacros = entries => entries.reduce((a, e) => ({
  calories: a.calories + (e.calories || 0),
  protein:  a.protein  + (e.protein  || 0),
  carbs:    a.carbs    + (e.carbs    || 0),
  fat:      a.fat      + (e.fat      || 0),
  fiber:    a.fiber    + (e.fiber    || 0),
}), zeroMacros());
const fmtDay = date => new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// Groups flat meal-entry rows into day -> meal -> entries, with subtotals at
// every level and a period-average computed over days actually logged (not
// diluted by unlogged days — more meaningful for a doctor/coach to read).
function buildReport(rows, from, to) {
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

  return { from, to, days, summary: { daysInRange, daysLogged, avg } };
}

function toCsv(report) {
  const lines = ['Date,Meal,Food,Quantity (g),Calories (kcal),Protein (g),Carbs (g),Fat (g),Fiber (g)'];
  for (const day of report.days) {
    for (const meal of day.meals) {
      for (const e of meal.entries) {
        lines.push([day.date, escCsv(meal.name), escCsv(e.food_brand ? `${e.food_name} (${e.food_brand})` : e.food_name),
          e.quantity_g ?? '', e.calories ?? '', e.protein ?? '', e.carbs ?? '', e.fat ?? '', e.fiber ?? ''].join(','));
      }
    }
    lines.push([day.date, '', 'Day total', '', day.total.calories, day.total.protein, day.total.carbs, day.total.fat, day.total.fiber].join(','));
  }
  const { summary } = report;
  lines.push('', 'Summary,,,,,,,,');
  lines.push(`Date range,${report.from} to ${report.to},,,,,,,`);
  lines.push(`Days logged,${summary.daysLogged} of ${summary.daysInRange},,,,,,,`);
  lines.push(`Average per logged day,,,,${summary.avg.calories},${summary.avg.protein},${summary.avg.carbs},${summary.avg.fat},${summary.avg.fiber}`);
  return lines.join('\n');
}

function toMarkdown(report) {
  const { summary } = report;
  const lines = [
    `# Nutrition report — ${report.from} to ${report.to}`,
    '',
    `**Days logged:** ${summary.daysLogged} of ${summary.daysInRange}`,
    `**Average per logged day:** ${summary.avg.calories} kcal · ${summary.avg.protein}g protein · ${summary.avg.carbs}g carbs · ${summary.avg.fat}g fat · ${summary.avg.fiber}g fiber`,
    '',
    '---',
  ];
  for (const day of report.days) {
    lines.push('', `## ${fmtDay(day.date)}`);
    for (const meal of day.meals) {
      lines.push('', `**${meal.name}**`);
      for (const e of meal.entries) {
        const name = e.food_brand ? `${e.food_name} (${e.food_brand})` : e.food_name;
        lines.push(`- ${name} — ${e.quantity_g}g — ${e.calories} kcal (${e.protein}P / ${e.carbs}C / ${e.fat}F${e.fiber ? ` / ${e.fiber} fiber` : ''})`);
      }
    }
    lines.push('', `**Day total: ${day.total.calories} kcal · ${day.total.protein}g protein · ${day.total.carbs}g carbs · ${day.total.fat}g fat · ${day.total.fiber}g fiber**`);
  }
  return lines.join('\n');
}

function toHtml(report) {
  const { summary } = report;
  const dayBlocks = report.days.map(day => `
    <section class="day">
      <h2>${escHtml(fmtDay(day.date))}</h2>
      ${day.meals.map(meal => `
        <h3>${escHtml(meal.name)}</h3>
        <table>
          <thead><tr><th>Food</th><th>Qty</th><th>Cal</th><th>P</th><th>C</th><th>F</th><th>Fiber</th></tr></thead>
          <tbody>
            ${meal.entries.map(e => `
              <tr>
                <td>${escHtml(e.food_brand ? `${e.food_name} (${e.food_brand})` : e.food_name)}</td>
                <td>${e.quantity_g}g</td><td>${e.calories}</td><td>${e.protein}</td><td>${e.carbs}</td><td>${e.fat}</td><td>${e.fiber || 0}</td>
              </tr>`).join('')}
          </tbody>
        </table>`).join('')}
      <div class="day-total">Day total: ${day.total.calories} kcal · ${day.total.protein}g protein · ${day.total.carbs}g carbs · ${day.total.fat}g fat · ${day.total.fiber}g fiber</div>
    </section>`).join('') || '<p>No meals logged in this date range.</p>';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Nutrition report ${escHtml(report.from)} to ${escHtml(report.to)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 28px; border-bottom: 2px solid #e5e5e5; padding-bottom: 4px; }
  h3 { font-size: 13px; color: #666; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .03em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 4px; }
  th, td { text-align: left; padding: 3px 6px; }
  th { color: #888; font-weight: 600; font-size: 11px; }
  td:not(:first-child), th:not(:first-child) { text-align: right; }
  tbody tr:nth-child(odd) { background: #f7f7f8; }
  .day-total { font-weight: 600; font-size: 13px; text-align: right; margin: 6px 0 4px; }
  .summary { background: #f7f7f8; border-radius: 10px; padding: 14px 16px; margin: 12px 0 20px; font-size: 14px; }
  .summary b { display: block; margin-bottom: 4px; }
  @media print { body { margin: 0; } .summary { border: 1px solid #ddd; } }
</style></head>
<body>
  <h1>Nutrition report</h1>
  <div style="color:#666;font-size:13px;margin-bottom:12px">${escHtml(report.from)} to ${escHtml(report.to)}</div>
  <div class="summary">
    <b>Days logged: ${summary.daysLogged} of ${summary.daysInRange}</b>
    Average per logged day: ${summary.avg.calories} kcal · ${summary.avg.protein}g protein · ${summary.avg.carbs}g carbs · ${summary.avg.fat}g fat · ${summary.avg.fiber}g fiber
  </div>
  ${dayBlocks}
</body></html>`;
}

// GET /api/settings/export-report?from=YYYY-MM-DD&to=YYYY-MM-DD&format=html|md|csv
// A readable day-by-day nutrition breakdown (meals unpacked to individual
// foods, day totals, period average) — meant for sharing with a doctor or
// coach, unlike the raw dumps from /export and /export-csv.
router.get('/export-report', (req, res) => {
  try {
    const db = getDb();
    const pid = req.profileId;
    const format = ['html', 'md', 'csv'].includes(req.query.format) ? req.query.format : 'html';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : todayLocal();
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

    const report = buildReport(rows, from, to);
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
