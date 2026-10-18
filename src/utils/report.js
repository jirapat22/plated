// The nutrition report: one profile, a range of LOCAL dates, rendered as
// HTML / Markdown / CSV. Moved out of routes/settings.js so two routes can
// share it without a route-to-route require: the export-report download
// (session) and GET /api/orbit/weekly-export (Orbit key, weekly vault copy).

'use strict';

const { goalsOn } = require('./goals');
const { todayLocal, tzFor } = require('./tz');
const { allSettings } = require('./profileSettings');

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
// One profile's report for local dates [from, to] (inclusive). Used by the
// export-report download and the weekly vault export.
function buildRangeReport(db, pid, from, to) {
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

  return buildReport(rows, from, to, reportContext(db, pid, from, to));
}

module.exports = { buildReport, buildRangeReport, reportContext, toCsv, toMarkdown, toHtml };
