import { api }                       from '../api.js';
import { fmtE, unitLabel, toDisplay } from '../utils/energy.js';
import { localDate }                  from '../utils/date.js';
import { showToast, navigateTo }      from '../app.js';
import { openFoodEntry, lazySession } from './log.js';
import { classifyDay, isFlagged, LOG_STRONG, LOG_COMPLETE, LOG_EMPTY } from '../utils/logCheck.js';
import { movingAvg, weeklyTrendChange, etaWeeks, maintenanceShortfall } from '../utils/stats.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Chart.js paints to a canvas, so it needs real colour strings — var(--border)
// means nothing to it. These read the live token values instead of hardcoding
// the dark palette, which is what makes the charts follow the theme. Read at
// call time, not module load: the theme can change between the two.
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// Series colours are chosen to glow on a near-black plot area, and pale lavender
// or cyan on white is barely a line at all. CSS solves this elsewhere with
// color-mix(), but a canvas needs a resolved string, so do the same darkening in
// JS. Legend swatches call this too, so the dot always matches its line.
const isLight = () => document.documentElement.getAttribute('data-theme') === 'light';
const ink = hex => {
  if (!isLight() || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const d = v => Math.round(v * 0.62).toString(16).padStart(2, '0');
  return '#' + d((n >> 16) & 255) + d((n >> 8) & 255) + d(n & 255);
};
const chartDefaults = () => {
  const grid = cssVar('--border'), tick = cssVar('--text-muted');
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        grid: { color: grid },
        ticks: { color: tick, font: { size: 10 }, maxTicksLimit: 7 },
      },
      y: {
        grid: { color: grid },
        ticks: { color: tick, font: { size: 10 } },
      },
    },
    elements: {
      point: { radius: 2, hoverRadius: 5 },
      line:  { tension: 0.3 },
    },
  };
};

// Chart.js comes from a CDN and the service worker deliberately doesn't cache
// cross-origin, so offline it's simply absent — and every one of these threw
// "Chart is not defined", which took the whole Trends render down with it. The
// verdict, weekly bars, streak and review list need no charts at all, so guard
// here and let the rest of the page stand.
// ponytail: guarding beats vendoring ~550kb of Chart.js + html5-qrcode into the
// repo; self-host if offline charts ever actually matter.
const haveChart = () => typeof Chart !== 'undefined';

// 205kb fetched when you open Trends, not on every cold start. It rides in the
// same Promise.all as this view's own data, so it costs no extra wall time, and
// haveChart() already copes with it never arriving — a failed load just leaves
// the "Chart needs a connection" placeholders.
let chartLibPromise = null;
function ensureChartLib() {
  if (haveChart()) return Promise.resolve();
  return chartLibPromise ??= new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
    // Subresource Integrity: the browser refuses the file unless it hashes to
    // exactly this. Without it, a compromised or hijacked CDN could serve
    // arbitrary JS into the app with full access to the session token, and
    // nothing here would notice. The URL is version-pinned, so the bytes are
    // immutable and this hash can't go stale on its own. A mismatch lands on
    // the existing onerror path — charts show "Chart needs a connection",
    // which is the same thing that happens offline, rather than a broken tab.
    s.integrity = 'sha384-e6nUZLBkQ86NJ6TVVKAeSaK8jWa3NhkYWZFomE39AvDbQWeie9PlQqM3pmYW5d1g';
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve();
    s.onerror = () => { chartLibPromise = null; resolve(); };
    document.head.appendChild(s);
  });
}
// Chart instances we created, by canvas id. Chart.getChart(id) used to be the
// whole of this, and it leaked: it resolves the id through
// document.getElementById, so once navigateTo has done innerHTML='' and the
// view re-rendered, that id points at a BRAND NEW canvas with no instance
// attached. It returned undefined and the previous Chart — plus its resize
// listener and its detached canvas — was never destroyed. One more every time
// you opened Trends. Holding our own references means destroy() always has
// something to destroy.
const charts = new Map();
function destroyChart(id) {
  charts.get(id)?.destroy();
  charts.delete(id);
}
function destroyAllCharts() {
  for (const c of charts.values()) c.destroy();
  charts.clear();
}

// "set target" in the verdict card was inert text with no way to act on it —
// jump to Settings and land right on the field instead of leaving the user
// to go hunt for it. Settings renders async, so poll briefly for the input.
function goToTargetWeight() {
  navigateTo('settings');
  let tries = 0;
  const tryFocus = () => {
    const input = document.querySelector('[data-key="target_weight_kg"]');
    if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
    else if (tries++ < 20) setTimeout(tryFocus, 100);
  };
  setTimeout(tryFocus, 100);
}

// The Monday (YYYY-MM-DD) of the week containing the given date.
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // getDay: Sun=0 → shift so Mon=0
  return localDate(d);
}

// Least-squares slope of y over x (used for the weight trend, kg/day).
function linFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  return denom === 0 ? null : (n * sxy - sx * sy) / denom;
}

function makeChart(id, labels, data, color, yLabel, opts = {}) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  if (!haveChart()) {
    ctx.replaceWith(Object.assign(document.createElement('div'), {
      className: 'chart-offline',
      textContent: 'Chart needs a connection',
    }));
    return;
  }

  const datasets = [{
    data,
    borderColor: color,
    backgroundColor: color + '22',
    fill: true,
    borderWidth: 2,
    pointBackgroundColor: opts.pointColors || color,
    pointBorderColor:     opts.pointColors || color,
    pointRadius:          opts.pointRadii  || 2,
    pointHoverRadius:     6,
  }];

  // Smoothed trend line
  if (opts.trendData) {
    datasets.push({
      label: 'trend',
      data: opts.trendData,
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [2, 3],
      pointRadius: 0,
      tension: 0.4,
      fill: false,
    });
  }

  if (opts.goalLine != null) {
    datasets.push({
      label: 'goal',
      data: labels.map(() => opts.goalLine),
      borderColor: ink('#5dca8a') + '99',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [6, 4],
      pointRadius: 0,
      tension: 0,
      fill: false,
    });
  }

  if (opts.avgLine != null) {
    datasets.push({
      label: '7d avg',
      data: labels.map(() => opts.avgLine),
      borderColor: ink('#c8b8ff') + '88',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      tension: 0,
      fill: false,
    });
  }

  // Expected curve (e.g. weight predicted from logged calories). Array aligned
  // to labels; nulls are skipped so it can cover just part of the x-axis.
  if (opts.expectedData) {
    datasets.push({
      label: 'expected',
      data: opts.expectedData,
      borderColor: ink('#c8b8ff'),
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [5, 4],
      pointRadius: 0,
      tension: 0.3,
      fill: false,
      spanGaps: false,
    });
  }

  const CD = chartDefaults();
  charts.set(id, new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...CD,
      plugins: {
        ...CD.plugins,
        tooltip: {
          callbacks: {
            label: c => {
              const lbl = c.dataset.label;
              if ((lbl === 'trend' || lbl === 'expected') && c.parsed.y == null) return null;
              const suffix = lbl === 'goal' ? ' (goal)' : lbl === '7d avg' ? ' (7d avg)'
                : lbl === 'trend' ? ' (trend)' : lbl === 'expected' ? ' (expected)' : '';
              return `${c.parsed.y.toFixed(1)} ${yLabel}${suffix}`;
            },
          },
        },
      },
      scales: {
        ...CD.scales,
        y: {
          ...CD.scales.y,
          title: { display: true, text: yLabel, color: cssVar('--text-muted'), font: { size: 10 } },
          ticks: { ...CD.scales.y.ticks, callback: v => `${Math.round(v)}` },
        },
      },
    },
  }));
}

// Consecutive fully-logged days (a consistency streak — not a hit-your-calorie-
// target streak). Allows 1 skipped (no-log) day per 7-day window. An
// under-logged day breaks it; today is in progress so it can only extend it.
function calcStreak(summary, goal, todayISO) {
  const byDate = Object.fromEntries(summary.map(r => [r.date, r]));
  const todayD = new Date();
  let streak       = 0;
  let graceUsed    = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(todayD);
    d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const status = classifyDay(byDate[iso] || { date: iso, calories: 0, meal_count: 0 }, goal, todayISO);
    const logged = status === LOG_COMPLETE;   // fully logged (or "ate light" confirmed)
    const empty  = status === LOG_EMPTY;      // nothing logged that day

    if (i > 0 && i % 7 === 0) graceUsed = 0;   // reset grace counter every 7 days back

    if (i === 0) {
      // Today is still in progress: it extends the streak as soon as it's
      // logged, but a not-yet-logged today never breaks it.
      if (logged) streak++;
      continue;
    }

    if (logged) {
      streak++;
    } else if (empty && graceUsed < 1) {
      graceUsed++;
      streak++;                                  // one skipped day per week is OK
    } else {
      break;                                     // under-logged, or a 2nd skip in the week
    }
  }
  return streak;
}

export function renderTrends(container) {
  container.classList.add('trends-view');
  let days = 30;                  // Infinity = all time
  let weighInsOpen = false;       // weigh-ins disclosure survives re-renders
  let waistOpen    = false;       // ditto for waist
  let weighInsExpanded = false;   // "show older" state, ditto
  const rangeLabel = () => (days === Infinity ? 'all time' : `${days} days`);

  container.innerHTML = `
    <div class="today-header" style="flex-wrap:wrap;gap:8px">
      <div class="today-date">Trends</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="range-btn" data-days="7">7d</button>
        <button class="range-btn active" data-days="30">30d</button>
        <button class="range-btn" data-days="90">90d</button>
        <button class="range-btn" data-days="365">1y</button>
        <button class="range-btn" data-days="all">All</button>
      </div>
    </div>
    <div id="trends-body" style="padding:0 16px">
      <div class="skeleton skel-line" style="height:180px;border-radius:14px"></div>
    </div>
  `;

  // Range buttons
  container.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      days = btn.dataset.days === 'all' ? Infinity : parseInt(btn.dataset.days);
      container.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
      load();
    });
  });

  // Inline range button styles
  const style = document.createElement('style');
  style.textContent = `.range-btn{height:28px;padding:0 12px;border-radius:999px;font-size:12px;font-weight:700;background:var(--surface-2);color:var(--text-muted);border:1px solid var(--border);transition:all .15s}.range-btn.active{background:var(--accent-dim);color:var(--accent);border-color:rgba(200,184,255,.3)}`;
  container.prepend(style);

  async function load() {
    // The view may be torn down (tab switch) while we await — bail if #trends-body
    // is gone instead of throwing on a null element.
    const bodyEl = document.getElementById('trends-body');
    if (!bodyEl) return;
    bodyEl.innerHTML =
      '<div class="skeleton skel-line" style="height:180px;border-radius:14px"></div>';
    try {
      // IronLog rides in the same batch instead of a second round trip after it.
      // Unlike Today, where IronLog is its own panel and can arrive late, these
      // weigh-ins merge into the very series the chart and the verdict are
      // computed from — rendering without them and refining after would visibly
      // rewrite the verdict a beat later.
      const [summary, weights, settings, ironlogWeights, waistRows] = await Promise.all([
        // Always fetch at least 90d regardless of chart range so the consistency
        // streak isn't capped short — the streak walks the full summary, while
        // the charts slice it down to `days`.
        api.get(`/api/meals/summary?days=${days === Infinity ? 'all' : Math.max(days, 90)}`),
        api.get(`/api/weight?limit=${days === Infinity ? 5000 : Math.max(days, 90)}`),
        api.get('/api/settings'),
        // ponytail: non-fatal — degrades to no IronLog weigh-ins rather than
        // failing the view. Still bounded by the route's 6s timeout; give it its
        // own shorter budget if that ever bites.
        api.get('/api/ironlog/bodyweight')
          .then(d => d.entries || (Array.isArray(d) ? d : []))
          .catch(() => []),
        api.get('/api/measurements?limit=400').catch(() => []),   // waist — never fails the view
        ensureChartLib(),   // last, result unused — just has to be here before render
      ]);

      if (!document.getElementById('trends-body')) return;  // left the view during fetch
      render(summary, weights, ironlogWeights, settings, waistRows);
    } catch (err) {
      const el = document.getElementById('trends-body');
      if (el) el.innerHTML =
        `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(summary, localWeights, ironlogWeights, settings, waistRows = []) {
    const goal        = parseFloat(settings.calorie_goal) || 2000;
    const proteinGoal = parseFloat(settings.protein_goal) || 150;
    const carbGoal    = parseFloat(settings.carb_goal) || 250;
    const fatGoal     = parseFloat(settings.fat_goal)  || 65;
    const ul          = unitLabel();
    const todayISO    = localDate();
    const streak      = calcStreak(summary, goal, todayISO);

    // Tag every day; charts + consistency use the selected range, the verdict
    // uses a fixed 28-day window (below) regardless of range. Future dates
    // (pre-logged planned meals) are excluded — Trends reads what happened,
    // not what's planned.
    const fullRows = summary.filter(r => r.date <= todayISO)
      .map(r => ({ ...r, status: classifyDay(r, goal, todayISO) }));
    const rows = fullRows.slice(-days);
    const loggedDays   = rows.filter(r => (r.meal_count || 0) > 0);
    const flaggedDays  = rows.filter(r => isFlagged(r.status));
    const completeDays = loggedDays.filter(r => r.status === 'complete');

    // Only nag about recently-flagged days — you can't realistically fix a
    // month-old day, so anything older than 2 weeks ages off this list by itself.
    const flagCutoff = (() => { const d = new Date(); d.setDate(d.getDate() - 14); return localDate(d); })();
    const recentFlagged = flaggedDays.filter(r => r.date >= flagCutoff);

    const labels   = rows.map(r => { const d = new Date(r.date + 'T00:00:00'); return `${d.getMonth()+1}/${d.getDate()}`; });
    const cals     = rows.map(r => toDisplay(r.calories ?? 0));
    const proteins = rows.map(r => r.protein ?? 0);
    const carbs    = rows.map(r => r.carbs ?? 0);
    const fats     = rows.map(r => r.fat ?? 0);

    // Flagged (likely-incomplete) days get an orange dot so the gap is visible.
    const FLAG = ink('#f97316');
    const pointColors = rows.map(r => isFlagged(r.status) ? FLAG : ink('#c8b8ff'));
    const pointRadii  = rows.map(r => isFlagged(r.status) ? 5 : 2);
    const calTrend    = movingAvg(cals, 7);

    // Weight series (IronLog + local merged by date). Normalize hard: IronLog
    // can send ISO timestamps and a 'weight' field — both produce NaN/NaN if
    // used raw. Keep only valid YYYY-MM-DD dates with finite kg.
    // split('T')[0] took the UTC day off IronLog's ISO stamps. Weighing at 7am
    // local timestamps at ~19:00 UTC the day BEFORE, so most weigh-ins landed a
    // day early — against calorie days that are local. A plain YYYY-MM-DD (our
    // own weight_log) is already local and passes through untouched.
    const weightMap = {};
    const addWeight = (rawDate, rawKg) => {
      const s = String(rawDate || '');
      const date = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (t => Number.isNaN(t) ? '' : localDate(new Date(t)))(Date.parse(s));
      const kg = Number(rawKg);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(kg)) weightMap[date] = kg;
    };
    ironlogWeights.forEach(w => addWeight(w.date, w.weight_kg ?? w.weight ?? w.bodyweight_kg));
    localWeights.forEach(w   => addWeight(w.date, w.weight_kg));
    // Waist series — oldest-first, sliced to the chart range like weight is.
    const waistAll     = (waistRows || [])
      .filter(w => /^\d{4}-\d{2}-\d{2}$/.test(w.date) && Number.isFinite(Number(w.waist_cm)))
      .map(w => [w.date, Number(w.waist_cm)])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const waistLatest  = waistAll.length ? waistAll[waistAll.length - 1] : null;
    const waistEntries = waistAll.slice(-days);
    const waistChange  = waistEntries.length >= 2
      ? waistEntries[waistEntries.length - 1][1] - waistEntries[0][1] : null;

    const weightSorted  = Object.entries(weightMap).sort((a, b) => a[0].localeCompare(b[0]));
    const weightEntries = weightSorted.slice(-days);   // charts reflect the range
    const wLabels = weightEntries.map(([d]) => { const dt = new Date(d + 'T00:00:00'); return `${dt.getMonth()+1}/${dt.getDate()}`; });
    const wVals   = weightEntries.map(([, v]) => v);
    const wTrend  = movingAvg(wVals, 7);

    // ── 7-day average — excludes flagged (likely-incomplete) days ──
    const recent7  = rows.slice(-7);
    const valid7   = recent7.filter(r => (r.meal_count || 0) > 0 && !isFlagged(r.status));
    const weeklyAvgKcal = valid7.length
      ? valid7.reduce((s, r) => s + (r.calories ?? 0), 0) / valid7.length
      : null;
    const weeklyAvgDisplay = weeklyAvgKcal != null ? toDisplay(weeklyAvgKcal) : null;
    const goalDisplay = toDisplay(goal);

    // ── Consistency over the range ──
    const loggedCount   = loggedDays.length;
    const completeCount = completeDays.length;
    const completePct   = loggedCount ? Math.round((completeCount / loggedCount) * 100) : 0;

    // ── This calendar week (Mon–Sun) ──
    const thisMon = mondayOf(todayISO);
    const wkRows  = fullRows.filter(r => r.date >= thisMon && (r.meal_count || 0) > 0);
    const wkTotal = wkRows.reduce((s, r) => s + (r.calories || 0), 0);
    const wkAvg   = wkRows.length ? wkTotal / wkRows.length : 0;
    const wkLabel = (() => {
      const m = new Date(thisMon + 'T00:00:00'), su = new Date(m); su.setDate(su.getDate() + 6);
      const f = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `${f(m)} – ${f(su)}`;
    })();

    // This-week macro averages (per logged day)
    const wkAvgOf = k => wkRows.length ? wkRows.reduce((s, r) => s + (r[k] || 0), 0) / wkRows.length : 0;
    const wkP = wkAvgOf('protein'), wkC = wkAvgOf('carbs'), wkF = wkAvgOf('fat');

    // ── Weekly averages over the selected range (Mon–Sun buckets), per macro ──
    // Excludes the in-progress week — the "This week" card above already covers
    // it, and a 2–3 day partial week isn't comparable to full weeks here.
    const weekMap = {};
    rows.forEach(r => { if ((r.meal_count || 0) > 0 && mondayOf(r.date) !== thisMon) (weekMap[mondayOf(r.date)] ||= []).push(r); });
    const avgOf = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0) / arr.length;
    // Weight moved per week, on the smoothed trend (see weeklyTrendChange).
    const weekKg = mon => weeklyTrendChange(weightSorted, mon);

    const weekData = Object.entries(weekMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mon, arr]) => ({ mon, kg: weekKg(mon), cal: avgOf(arr, 'calories'), protein: avgOf(arr, 'protein'), carbs: avgOf(arr, 'carbs'), fat: avgOf(arr, 'fat') }));

    const macroMeta = {
      cal:     { label: 'Calories', goal, color: 'var(--accent)',  disp: v => fmtE(v) },
      protein: { label: 'Protein',  goal: proteinGoal, color: 'var(--protein)', disp: v => Math.round(v) + 'g' },
      carbs:   { label: 'Carbs',    goal: carbGoal,    color: 'var(--carbs)',   disp: v => Math.round(v) + 'g' },
      fat:     { label: 'Fat',      goal: fatGoal,     color: 'var(--fat)',     disp: v => Math.round(v) + 'g' },
    };
    function drawWeekBars(metric) {
      const m = macroMeta[metric];
      const box = document.getElementById('wk-bars');
      if (!box) return;
      const max = Math.max(m.goal || 1, ...weekData.map(w => w[metric])) * 1.08;  // headroom
      const goalPct = m.goal ? (m.goal / max) * 100 : null;
      const f = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      // A week's weight move counts as progress when it goes the way the phase
      // wants. Colouring by raw direction would mark every good bulking week red.
      const phase = settings.phase || 'maintain';
      const kgGood = kg => phase === 'cut' ? kg < -0.05 : phase === 'bulk' ? kg > 0.05 : Math.abs(kg) <= 0.3;
      const anyKg = weekData.some(w => w.kg != null);

      box.innerHTML = weekData.slice().reverse().map(w => {   // most recent week on top
        const mon = new Date(w.mon + 'T00:00:00');
        const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
        const val = w[metric];
        const over = m.goal && val > m.goal;
        const kgTxt = w.kg == null ? '–'
          : `${w.kg > 0 ? '+' : w.kg < 0 ? '−' : ''}${Math.abs(w.kg).toFixed(1)}`;
        const kgColor = w.kg == null ? 'var(--text-faint)'
          : kgGood(w.kg) ? 'var(--success)' : 'var(--text-muted)';
        return `<div style="display:flex;align-items:center;gap:8px;margin:9px 0">
          <span style="width:74px;flex-shrink:0;font-size:11px;color:var(--text-muted)">${f(mon)}–${sun.getDate()}</span>
          <div style="flex:1;min-width:30px;height:20px;background:var(--surface-2);border-radius:5px;position:relative;overflow:hidden">
            <div style="height:100%;width:${Math.round(val / max * 100)}%;background:${m.color};border-radius:5px"></div>
            ${goalPct != null ? `<div title="goal" style="position:absolute;top:-1px;bottom:-1px;left:${goalPct}%;width:2px;background:var(--text);opacity:.5"></div>` : ''}
          </div>
          <span style="width:46px;text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;${over ? 'color:var(--warning)' : ''}">${m.disp(val)}</span>
          ${anyKg ? `<span title="trend weight change" style="width:52px;text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:${kgColor}">${kgTxt}${w.kg == null ? '' : ' kg'}</span>` : ''}
        </div>`;
      }).join('') + `<div style="display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--text-faint);margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
          <span>avg per logged day</span>
          <span>┃ goal ${m.disp(m.goal)}${anyKg ? ' · kg = 7-day trend move' : ''}</span>
        </div>${anyKg && weekData.some(w => w.kg == null) ? `<div style="font-size:10px;color:var(--text-faint);margin-top:4px">“–” = no weigh-in that week, so there's nothing to compare.</div>` : ''}`;
    }

    // ── "Is it working?" verdict — intake vs actual weight change ──
    // Fixed ~28-day window, independent of the chart range. Excludes today (its
    // calories are still being logged) so the average isn't dragged down.
    const win28 = (() => { const d = new Date(); d.setDate(d.getDate() - 28); return localDate(d); })();
    const validForAvg = fullRows.filter(r =>
      r.date >= win28 && r.date < todayISO && (r.meal_count || 0) > 0 && !isFlagged(r.status));
    const avgCal = validForAvg.length
      ? validForAvg.reduce((s, r) => s + (r.calories ?? 0), 0) / validForAvg.length
      : null;
    const targetWeight = parseFloat(settings.target_weight_kg) || null;
    const cfgTdee      = parseFloat(settings.tdee) || null;
    const phase        = settings.phase || 'maintain';
    // Trend weight, not the last raw reading: one weigh-in carries the whole
    // day-to-day water swing, and this feeds the ETA.
    const curWeight    = weightSorted.length
      ? movingAvg(weightSorted.map(([, v]) => v), 7).at(-1) : null;
    // The verdict spans 4 weeks but never said how much of that had weigh-ins.
    const lastWeighIn  = weightSorted.length ? weightSorted[weightSorted.length - 1][0] : null;
    const staleDays    = lastWeighIn
      ? Math.round((new Date(todayISO + 'T00:00:00') - new Date(lastWeighIn + 'T00:00:00')) / 86400000)
      : null;

    // Weight trend slope (kg/day) — least-squares over the last 28 days of weigh-ins.
    const wWin = weightSorted.filter(([d]) => d >= win28);
    const wWinVals = wWin.map(([, v]) => v);
    const wWinX = wWin.map(([d]) =>
      Math.round((new Date(d + 'T00:00:00') - new Date((wWin[0]?.[0] || d) + 'T00:00:00')) / 86400000));
    const slopePerDay = linFit(wWinX, wWinVals);
    const spanDays    = wWinX.length ? wWinX[wWinX.length - 1] : 0;
    const weeklyRate  = slopePerDay != null ? slopePerDay * 7 : null;
    // >1.5 kg/wk over a 28-day trend is almost always water/scale noise, not real
    // tissue change — the energy math (and projection) can't be trusted then.
    const rateReliable = weeklyRate != null && Math.abs(weeklyRate) <= 1.5;
    // Adaptive TDEE: real maintenance ≈ avg intake − weight-change energy.
    // Rounded to 10 (it's an estimate); only shown when the trend is reliable.
    const realTDEE = (avgCal != null && slopePerDay != null && rateReliable)
      ? Math.round((avgCal - slopePerDay * 7700) / 10) * 10 : null;

    // Does the measured figure square with your size and training? Only
    // answerable once the TDEE estimator has stored height/age/sex/activity.
    const shortfall = maintenanceShortfall(realTDEE, {
      weightKg: curWeight,
      heightCm: parseFloat(settings.height_cm) || null,
      age:      settings.birth_year ? new Date().getFullYear() - parseInt(settings.birth_year) : null,
      sex:      settings.sex,
      activity: parseFloat(settings.activity_level) || null,
    });

    const haveVerdict = wWinVals.length >= 4 && spanDays >= 10 && validForAvg.length >= 5 && weeklyRate != null;

    let verdictGood = null, verdictSub = '', weeksToTarget = null;
    if (haveVerdict) {
      if (phase === 'maintain') {
        verdictGood = Math.abs(weeklyRate) <= 0.15;
        verdictSub = verdictGood ? 'Weight is holding steady.'
          : `Drifting ${weeklyRate > 0 ? 'up' : 'down'} — nudge intake to hold.`;
      } else {
        verdictGood = phase === 'cut' ? weeklyRate <= -0.05 : weeklyRate >= 0.05;
        verdictSub = phase === 'cut'
          ? (verdictGood ? `Losing ${Math.abs(weeklyRate).toFixed(2)} kg/wk — your deficit is real.`
                         : 'Not losing yet — intake is at or above maintenance.')
          : (verdictGood ? `Gaining ${weeklyRate.toFixed(2)} kg/wk — your surplus is working.`
                         : 'Not gaining — intake is at or below maintenance.');
      }
      weeksToTarget = etaWeeks({
        curWeight, targetWeight, weeklyRate, working: verdictGood && rateReliable,
      });
    }
    const etaLabel = weeksToTarget ? (() => {
      const d = new Date(); d.setDate(d.getDate() + Math.round(weeksToTarget * 7));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    })() : null;

    // ── Expected weight from logged calories (fixed last 28 days) ──
    // Anchor to the first weigh-in in the window, then walk each day applying
    // (logged intake − set TDEE) / 7700 kcal-per-kg. Days with no log count as
    // maintenance (no change). Overlaid on the weight chart as a dashed line so
    // you can see the scale track — or drift from — what your calories predict.
    const TDEE_PER_KG = 7700;
    const byDateAll = Object.fromEntries(fullRows.map(r => [r.date, r]));
    let expectedAligned = null, expectedLossKg = null, actualChangeKg = null;
    const wWin28 = weightSorted.filter(([dt]) => dt >= win28);   // weigh-ins in the window
    if (cfgTdee && wWin28.length > 1) {
      const [anchorDate, anchorWeight] = wWin28[0];
      const expectedByDate = { [anchorDate]: anchorWeight };
      let cum = anchorWeight;
      const cur = new Date(anchorDate + 'T00:00:00'); cur.setDate(cur.getDate() + 1);
      const end = new Date(todayISO + 'T00:00:00');
      while (cur <= end) {
        const iso = localDate(cur);
        const row = byDateAll[iso];
        const intake = row && (row.meal_count || 0) > 0 ? (row.calories || 0) : cfgTdee;
        cum += (intake - cfgTdee) / TDEE_PER_KG;
        expectedByDate[iso] = cum;
        cur.setDate(cur.getDate() + 1);
      }
      expectedAligned = weightEntries.map(([dt]) => dt >= anchorDate ? (expectedByDate[dt] ?? null) : null);
      const [lastDate, lastActual] = weightEntries[weightEntries.length - 1];
      if (expectedByDate[lastDate] != null) {
        expectedLossKg = anchorWeight - expectedByDate[lastDate];   // +ve = predicted loss
        actualChangeKg = anchorWeight - lastActual;                 // +ve = actual loss
      }
    }
    // +ve arg = a downward change (loss); shown as −, gains as +. Phase-neutral
    // so the caption reads correctly whether you're cutting, bulking, or holding.
    const fmtChange = chg => (chg >= 0 ? '−' : '+') + Math.abs(chg).toFixed(1) + ' kg';
    const expectedCaption = expectedLossKg == null ? null : (() => {
      const gap = expectedLossKg - actualChangeKg;   // +ve = scale heavier than predicted
      const read = Math.abs(gap) < 0.3
        ? 'The scale is tracking your calories closely — logging and TDEE look about right.'
        : gap > 0
          ? `The scale is ${gap.toFixed(1)} kg above what your calories predict — usually some under-logging, or your TDEE is set too high.`
          : `The scale is ${Math.abs(gap).toFixed(1)} kg below what your calories predict — your TDEE may be higher than set, or you over-logged / dropped water.`;
      return `Predicted ${fmtChange(expectedLossKg)} from your logged calories vs set TDEE; scale shows ${fmtChange(actualChangeKg)}. ${read}`;
    })();

    // Plain-English "bottom line" — translates the verdict numbers into what's
    // happening and why. Only meaningful when real maintenance is estimable
    // (realTDEE != null already implies a reliable weight trend).
    const bottomLine = realTDEE == null ? null : (() => {
      const rate = Math.abs(weeklyRate);
      const motion = rate < 0.05 ? "your weight's basically flat"
        : `you're ${weeklyRate < 0 ? 'losing' : 'gaining'} ~${rate.toFixed(1)} kg/week`;
      const actualDef = Math.round(realTDEE - avgCal);
      const underOver = actualDef >= 0 ? `${fmtE(actualDef)} ${ul} under` : `${fmtE(-actualDef)} ${ul} over`;
      let s = `You're eating about ${underOver} your real maintenance (${fmtE(realTDEE)} ${ul}), so ${motion}.`;
      if (cfgTdee) {
        const plannedDef = Math.abs(Math.round(cfgTdee - avgCal));
        if (realTDEE < cfgTdee - 150) {
          s += ` Your set TDEE (${fmtE(cfgTdee)}) is higher than your real burn — your true gap is smaller than the ${fmtE(plannedDef)} you planned, which is why the scale's slow. (Or you're under-logging — see below.)`;
        } else if (realTDEE > cfgTdee + 150) {
          s += ` Your real maintenance is above your set TDEE (${fmtE(cfgTdee)}), so there's a bit more room than your plan assumes.`;
        } else {
          s += ` That's in line with your set TDEE (${fmtE(cfgTdee)}).`;
        }
      }
      return s;
    })();

    // ── Signature: the calorie number-line ────────────────────────────────
    // Plots intake, real maintenance, and set TDEE on one axis so the two
    // deficits read as distances. The solid accent segment (intake→real maint)
    // is your real deficit; the dashed extension (→ set TDEE) is the phantom
    // deficit your set TDEE assumed but the scale says isn't there. SVG uses
    // hex (CSS vars don't resolve in SVG presentation attributes). Falls back
    // to a labels-only readout if real maintenance isn't estimable.
    const numberLine = realTDEE == null ? null : (() => {
      const intake = avgCal, maint = realTDEE;
      const showTdee = cfgTdee && Math.abs(cfgTdee - maint) >= 100;   // hide a colliding tick
      const pts = showTdee ? [intake, maint, cfgTdee] : [intake, maint];
      const lo = Math.min(...pts), hi = Math.max(...pts);
      const pad = Math.max(hi - lo, 1) * 0.18;
      const aMin = lo - pad, aMax = hi + pad;
      const X = v => 16 + ((v - aMin) / (aMax - aMin)) * 288;   // x within [16,304]
      const xI = X(intake), xM = X(maint), xT = showTdee ? X(cfgTdee) : 0;
      const close = Math.abs(xM - xI) < 38;                     // value labels would collide
      const T = (x, y, s, extra = '') => `<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" ${extra}>${s}</text>`;
      const sign = d => (d >= 0 ? '−' : '+') + fmtE(Math.abs(d));
      const realDef = Math.round(maint - intake);
      const planDef = cfgTdee ? Math.round(cfgTdee - intake) : null;
      return `
        <svg viewBox="0 0 320 78" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;max-width:440px;margin:0 auto;overflow:visible;font-family:var(--font-mono)">
          <line x1="16" y1="43" x2="304" y2="43" style="stroke:var(--border)" stroke-width="2" stroke-linecap="round"/>
          ${showTdee ? `<line x1="${xM.toFixed(1)}" y1="43" x2="${xT.toFixed(1)}" y2="43" style="stroke:var(--text-faint)" stroke-width="2" stroke-dasharray="3 3"/>` : ''}
          <line x1="${xI.toFixed(1)}" y1="43" x2="${xM.toFixed(1)}" y2="43" style="stroke:var(--accent)" stroke-width="4" stroke-linecap="round"/>
          <circle cx="${xI.toFixed(1)}" cy="43" r="5.5" style="fill:var(--accent);stroke:var(--surface)" stroke-width="3"/>
          <line x1="${xM.toFixed(1)}" y1="34" x2="${xM.toFixed(1)}" y2="52" style="stroke:var(--text)" stroke-width="2.5" stroke-linecap="round"/>
          ${showTdee ? `<line x1="${xT.toFixed(1)}" y1="36" x2="${xT.toFixed(1)}" y2="50" style="stroke:var(--text-muted)" stroke-width="2" stroke-dasharray="2 2"/>` : ''}
          <g style="fill:var(--text)" font-size="15" font-weight="700">
            ${T(xI, 25, fmtE(intake))}
            ${T(xM, close ? 13 : 25, fmtE(maint))}
            ${showTdee ? T(xT, 25, fmtE(cfgTdee)) : ''}
          </g>
          <g style="fill:var(--text-muted)" font-size="10" letter-spacing="0.5">
            ${T(xI, close ? 73 : 66, 'YOU EAT')}
            ${T(xM, close ? 61 : 66, 'REAL MAINT.')}
            ${showTdee ? T(xT, 66, 'SET TDEE') : ''}
          </g>
        </svg>
        <div style="font-size:11px;color:var(--text-faint);margin-top:4px;text-align:center;max-width:440px;margin-left:auto;margin-right:auto">${realDef >= 0 ? 'Real deficit' : 'Real surplus'} <b style="color:var(--accent)">${sign(realDef)} ${ul}</b>${planDef != null ? ` · you planned <span style="color:var(--text-muted)">${sign(planDef)}</span>` : ''}</div>
        <div style="font-size:9px;color:var(--text-faint);text-align:center;margin-top:3px">“You eat” is your average intake over the last 4 weeks</div>`;
    })();

    // Compact "real vs planned deficit" shown on the collapsed breakdown summary,
    // so the signature says something before you expand it.
    const gapSummary = realTDEE == null ? '' : (() => {
      const s = d => (d >= 0 ? '−' : '+') + fmtE(Math.abs(d));
      return `${s(Math.round(realTDEE - avgCal))} vs real maint${cfgTdee ? ` · ${s(Math.round(cfgTdee - avgCal))} vs TDEE` : ''}`;
    })();

    // The method explainer — shown in both the reliable breakdown and the noisy
    // fallback, so it's never lost when weigh-ins are too noisy to estimate.
    const howWorkedOut = `
      <details style="margin-top:14px">
        <summary style="cursor:pointer;list-style:none;font-size:11px;color:var(--accent);font-weight:700">ⓘ TDEE vs real maintenance — how is this worked out?</summary>
        <div style="font-size:11px;color:var(--text-faint);line-height:1.7;margin-top:8px">
          <b style="color:var(--text-muted)">Set TDEE</b> is a starting estimate from your stats (in Settings). It never looks at your results — it's a formula's best guess.<br><br>
          <b style="color:var(--text-muted)">Real maintenance</b> is measured from what actually happened: your average logged calories minus your real weight change (1&nbsp;kg ≈ 7,700&nbsp;${ul}). ${realTDEE != null ? `If you're losing while eating ${fmtE(avgCal)}, your maintenance has to sit above that — the scale shows by how much. ` : ''}It folds your weigh-ins in, so it's usually the more accurate of the two — <i>as long as your logging is honest</i>.<br><br>
          If real maintenance reads below your set TDEE, it's one of two things — your TDEE was set too high, <i>or</i> you're under-logging — and from this data alone they look identical. To tell which: weigh your food carefully for ~2 weeks. If the number holds, your TDEE was genuinely high; if it climbs back toward your set TDEE, you were under-logging.
        </div>
      </details>`;

    const trendsBody = document.getElementById('trends-body');
    if (!trendsBody) return;   // view torn down before render
    trendsBody.innerHTML = `
      <!-- Verdict (hero) -->
      <div class="card" style="margin-bottom:12px;border:1px solid ${haveVerdict ? (verdictGood ? 'rgba(93,202,138,.45)' : 'rgba(249,115,22,.45)') : 'var(--border)'};background:${haveVerdict ? `linear-gradient(180deg, ${verdictGood ? 'rgba(93,202,138,.09)' : 'rgba(249,115,22,.10)'} 0%, transparent 58%), var(--surface)` : 'var(--surface)'}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px">
          <div class="label">${phase === 'cut' ? 'Is your cut working?' : phase === 'bulk' ? 'Is your bulk working?' : 'Holding maintenance?'}</div>
          <div style="font-size:10px;color:var(--text-faint);flex-shrink:0">last 4 weeks · fixed</div>
        </div>
        ${haveVerdict ? `
          <div style="font-family:var(--font-display);font-size:24px;font-weight:800;text-transform:uppercase;letter-spacing:.02em;color:${verdictGood ? 'var(--success)' : FLAG}">${verdictGood ? 'On track ✓' : 'Off track ⚠'}</div>
          <div style="font-size:13px;color:var(--text-muted);margin:2px 0 12px">${verdictSub}</div>
          <div class="stat-grid">
            <div class="stat-cell"><div class="stat-num">${weeklyRate > 0 ? '+' : ''}${weeklyRate.toFixed(2)}</div><div class="stat-lbl">kg / week</div><div class="stat-sub">your real pace</div></div>
            <div class="stat-cell"><div class="stat-num">${realTDEE != null ? fmtE(realTDEE) : '—'}</div><div class="stat-lbl">real maint. ${ul}</div><div class="stat-sub">what you burn</div></div>
            <div class="stat-cell${!targetWeight ? ' set-target-cell' : ''}"${!targetWeight ? ' style="cursor:pointer"' : ''}><div class="stat-num">${weeksToTarget ? '~' + Math.round(weeksToTarget) + 'w' : '–'}</div><div class="stat-lbl"${!targetWeight ? ' style="text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px"' : ''}>${targetWeight ? 'to ' + targetWeight + ' kg' : 'set target'}</div><div class="stat-sub">${weeksToTarget ? 'at this pace' : (targetWeight ? 'not at this pace' : '&nbsp;')}</div></div>
          </div>
          ${staleDays >= 4 ? `<div style="font-size:11px;color:var(--warning);margin-top:10px">Newest weigh-in is ${staleDays} days old — nothing since then counts toward this.</div>` : ''}
          ${shortfall ? `<div style="font-size:11px;color:var(--warning);margin-top:10px">Your size and training predict about ${fmtE(shortfall.predicted)} ${ul} — measured maintenance is ${fmtE(shortfall.gap)} lower. That's usually under-logging, sometimes an over-stated activity level. Weigh your food for two weeks before cutting any lower.</div>` : ''}
          ${!rateReliable ? `<div style="font-size:11px;color:var(--text-faint);margin-top:10px">Weigh-ins are too noisy to estimate maintenance (${weeklyRate > 0 ? '+' : ''}${weeklyRate.toFixed(1)} kg/wk looks like water/scale swing). Weigh in consistently for a steadier read.</div>${howWorkedOut}`
            : `<details class="nl-details" style="border-top:1px solid var(--border);margin-top:12px;padding-top:12px">
                <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px">
                  <span class="label">See the breakdown</span>
                  ${gapSummary ? `<span class="gap-summary">${gapSummary}</span>` : ''}
                  <span class="nl-chev" style="font-size:9px;color:var(--text-faint);${gapSummary ? '' : 'margin-left:auto'}">▾</span>
                </summary>
                <div style="margin-top:12px">
                  ${numberLine ? `<div class="label" style="margin-bottom:2px">Where you sit · ${ul}/day</div>${numberLine}` : ''}
                  <div class="label" style="margin-top:16px;margin-bottom:6px">Bottom line</div>
                  <div style="background:var(--surface-2);border-radius:var(--radius-sm);padding:11px 13px;font-size:12px;color:var(--text-muted);line-height:1.65">${bottomLine}</div>
                  ${etaLabel ? `<div style="font-size:11px;color:var(--text-faint);margin-top:6px">At this rate you reach ${targetWeight} kg around ${etaLabel}.</div>` : ''}
                  ${howWorkedOut}
                </div>
              </details>`}
        ` : `
          <div style="font-size:13px;color:var(--text-muted);line-height:1.55">Keep logging to unlock your verdict — it weighs your intake against your real weight change to say whether it's working, and estimates your true maintenance calories.<br><span style="color:var(--text-faint)">Needs ~2 weeks of weigh-ins (have ${wWinVals.length}) and ≥5 fully-logged days (have ${validForAvg.length}).</span></div>
        `}
      </div>

      <!-- Bodyweight + target + expected (the verdict's weight evidence) -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
          <div class="label">Bodyweight <span class="range-chip">· ${rangeLabel()}</span></div>
          <div style="display:flex;gap:10px;font-size:10px;color:var(--text-faint);flex-wrap:wrap">
            ${expectedAligned ? `<span style="display:flex;align-items:center;gap:4px"><span style="width:16px;height:0;border-top:2px dashed ${ink('#c8b8ff')};display:inline-block"></span>expected from calories</span>` : ''}
            ${targetWeight ? `<span style="display:flex;align-items:center;gap:4px"><span style="width:16px;height:2px;background:${ink('#5dca8a')};display:inline-block;border-radius:1px"></span>target ${targetWeight} kg</span>` : ''}
          </div>
        </div>
        <div style="height:170px;position:relative"><canvas id="chart-wt"></canvas></div>
        ${expectedCaption ? `<div style="font-size:11px;color:var(--text-faint);margin-top:10px;line-height:1.5">${expectedCaption}<br><span style="opacity:.7">Last 28 days · days you didn't log are counted as maintenance.</span></div>` : ''}
        <details id="wt-log-details" class="nl-details" ${weighInsOpen ? 'open' : ''} style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">
          <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px">
            <span class="label">Weigh-ins</span>
            <span class="range-chip">${localWeights.length} logged</span>
            <span class="nl-chev" style="font-size:9px;color:var(--text-faint);margin-left:auto">▾</span>
          </summary>
          <!-- Backfilling a missed weigh-in used to be impossible: Today's
               logger always writes today's date, History showed the day's
               weight read-only, and this list could edit and delete but never
               add. That gap now moves your macro goals too — protein and fat
               follow the 7-day trend weight. -->
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:10px 0 6px">
            <div style="position:relative;flex:1 1 120px;min-width:0">
              <input class="input" id="wt-add-kg" type="text" inputmode="decimal" placeholder="e.g. 76.4"
                style="width:100%;height:38px;padding-right:30px;font-weight:700;font-variant-numeric:tabular-nums"/>
              <span style="position:absolute;right:11px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--text-muted);pointer-events:none">kg</span>
            </div>
            <button class="btn btn-primary" id="wt-add-save" style="height:38px;padding:0 16px;font-size:13px;flex-shrink:0;order:3">Add</button>
            <input class="input" id="wt-add-date" type="date" max="${todayISO}"
              style="flex:0 1 138px;height:38px;min-width:0;font-size:12px;color:var(--text-muted)"/>
          </div>
          <div id="wt-log-list" style="margin-top:4px"></div>
        </details>

        <!-- Waist lives inside Bodyweight rather than in a card of its own: it
             measures the same thing by a steadier route, and anyone not using a
             tape shouldn't be scrolling past an empty card forever. Collapsed
             until opened; the summary carries the number so the disclosure only
             hides the chart and the logger, never the reading. -->
        <details id="waist-details" class="nl-details" ${waistOpen ? 'open' : ''} style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">
          <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px">
            <span class="label">Waist</span>
            ${waistLatest ? `<span class="range-chip">${waistLatest[1]} cm</span>` : '<span class="range-chip">not measured</span>'}
            ${waistChange != null ? `<span class="num" style="font-size:11px;font-weight:700;color:${waistChange < 0 ? 'var(--success)' : waistChange > 0 ? 'var(--warning)' : 'var(--text-muted)'}">${waistChange > 0 ? '+' : ''}${waistChange.toFixed(1)}</span>` : ''}
            <span class="nl-chev" style="font-size:9px;color:var(--text-faint);margin-left:auto">▾</span>
          </summary>
          ${waistEntries.length >= 2
            ? `<div style="height:150px;position:relative;margin-top:10px"><canvas id="chart-waist"></canvas></div>`
            : `<div style="font-size:12px;color:var(--text-muted);line-height:1.55;margin-top:10px">
                 ${waistEntries.length === 1
                   ? `First measurement logged: <b style="color:var(--text)">${waistEntries[0][1]} cm</b>. One more and this charts.`
                   : `Measure at the navel, standing relaxed, same time of day — first thing works best.
                      Waist ignores the water swings the scale doesn't, so it's the honest read on a cut.`}
               </div>`}
          <!-- The number leads. The date defaults to today and is changed
               rarely, so it takes what's left and wraps when short. -->
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px">
            <div style="position:relative;flex:1 1 130px;min-width:0">
              <input class="input" id="waist-cm" type="text" inputmode="decimal" placeholder="e.g. 86.5"
                style="width:100%;height:38px;padding-right:32px;font-weight:700;font-variant-numeric:tabular-nums"/>
              <span style="position:absolute;right:11px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--text-muted);pointer-events:none">cm</span>
            </div>
            <button class="btn btn-primary" id="waist-save" style="height:38px;padding:0 16px;font-size:13px;flex-shrink:0;order:3">Log</button>
            <input class="input" id="waist-date" type="date" max="${todayISO}" value="${todayISO}"
              style="flex:0 1 138px;height:38px;min-width:0;font-size:12px;color:var(--text-muted)"/>
          </div>
        </details>
      </div>

      <!-- Calories chart (the verdict's intake evidence) -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="label">Calories <span class="range-chip">· ${rangeLabel()}</span></div>
          <div style="display:flex;gap:10px;font-size:10px;color:var(--text-faint)">
            <span style="display:flex;align-items:center;gap:4px">
              <span style="width:16px;height:2px;background:${ink('#5dca8a')};display:inline-block;border-radius:1px"></span>goal
            </span>
            <span style="display:flex;align-items:center;gap:4px">
              <span style="width:7px;height:7px;background:${FLAG};display:inline-block;border-radius:50%"></span>under-logged
            </span>
          </div>
        </div>
        <div style="height:160px;position:relative"><canvas id="chart-cal"></canvas></div>
      </div>

      <!-- ── Shift from "is it working" to "your week & logging" ── -->
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-faint);font-family:var(--font-display);margin:18px 4px 10px">Your week &amp; logging</div>

      <!-- This week (Mon–Sun) -->
      ${wkRows.length ? `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <div class="label">This week</div>
          <span class="range-chip">${wkLabel}</span>
        </div>
        <div class="stat-grid">
          <div class="stat-cell"><div class="stat-num">${fmtE(wkTotal)}</div><div class="stat-lbl">total ${ul}</div></div>
          <div class="stat-cell"><div class="stat-num">${fmtE(wkAvg)}</div><div class="stat-lbl">avg / day</div></div>
          <div class="stat-cell"><div class="stat-num">${wkRows.length}<span style="font-size:13px;color:var(--text-muted)">/7</span></div><div class="stat-lbl">days logged</div></div>
        </div>
        <div style="font-size:12px;color:${wkAvg > goal ? 'var(--warning)' : 'var(--text-muted)'};margin-top:10px">${wkAvg > goal ? `+${fmtE(wkAvg - goal)} over` : `${fmtE(goal - wkAvg)} under`} your ${fmtE(goal)} ${ul} goal, on average</div>
        <div style="display:flex;gap:14px;font-size:12px;margin-top:8px;border-top:1px solid var(--border);padding-top:10px">
          <span><span style="color:var(--protein);font-weight:600">${Math.round(wkP)}</span><span style="color:var(--text-faint)">/${Math.round(proteinGoal)} P</span></span>
          <span><span style="color:var(--carbs);font-weight:600">${Math.round(wkC)}</span><span style="color:var(--text-faint)">/${Math.round(carbGoal)} C</span></span>
          <span><span style="color:var(--fat);font-weight:600">${Math.round(wkF)}</span><span style="color:var(--text-faint)">/${Math.round(fatGoal)} F</span></span>
          <span style="color:var(--text-faint);margin-left:auto">avg/day</span>
        </div>
      </div>` : ''}

      <!-- Weekly averages (Mon–Sun), per macro — "am I eating more than usual?" -->
      ${weekData.length >= 2 ? `
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Weekly average <span class="range-chip">· ${rangeLabel()} · Mon–Sun</span></div>
        <div class="search-tabs" id="wk-metric" style="padding:0;margin-bottom:10px">
          <button class="search-tab active" data-m="cal">Calories</button>
          <button class="search-tab" data-m="protein">Protein</button>
          <button class="search-tab" data-m="carbs">Carbs</button>
          <button class="search-tab" data-m="fat">Fat</button>
        </div>
        <div id="wk-bars"></div>
      </div>` : ''}

      <!-- Consistency -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <div class="label">Consistency</div>
          <span class="range-chip">${rangeLabel()}</span>
        </div>
        <!-- Current streak — an ongoing run, not tied to the range above -->
        <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--surface-2);border-radius:var(--radius-sm);margin-bottom:10px">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><path d="M12 2.5c1.2 3.6-3.4 5-3.4 8.7a3.4 3.4 0 0 0 6.8 0c0-1-.5-1.8-.5-1.8s.3 1.6-.8 2c.9-2.6-1.7-3.4-2.1-8.9Z" style="stroke:var(--carbs)" stroke-width="1.6" stroke-linejoin="round"/></svg>
          <span class="num" style="font-size:22px;line-height:1">${streak || '–'}</span>
          <span style="font-size:12px;color:var(--text-muted);line-height:1.3">day logging streak<br><span style="font-size:10px;color:var(--text-faint)">current run · all-time</span></span>
        </div>
        <div class="stat-grid">
          <div class="stat-cell"><div class="stat-num">${loggedCount}</div><div class="stat-lbl">days logged</div></div>
          <div class="stat-cell"><div class="stat-num">${completePct}%</div><div class="stat-lbl">fully logged</div></div>
          <div class="stat-cell"><div class="stat-num" style="color:${recentFlagged.length ? FLAG : 'var(--text)'}">${recentFlagged.length}</div><div class="stat-lbl">need a look</div></div>
        </div>
      </div>

      ${recentFlagged.length ? `
      <!-- Needs a look -->
      <div class="card" style="margin-bottom:12px;padding:0">
        <div style="padding:14px 16px 4px;font-size:13px;font-weight:700;color:var(--text-muted)">⚠️ NEEDS A LOOK · LAST 2 WEEKS</div>
        <div style="padding:0 16px 10px;font-size:12px;color:var(--text-muted);line-height:1.5">
          These days look <strong>under-logged</strong> — under 60% of your ${fmtE(goal)} ${ul} goal with only 1–2 meals, so you probably forgot to log something. Tap <strong>Forgot — add</strong> to log the missing food, or <strong>Ate light</strong> if the low day was real (it'll then count normally). Do nothing and a day drops off this list after 2 weeks.
        </div>
        <div style="padding:0 12px 8px">
          ${recentFlagged.slice().reverse().map(r => {
            const d = new Date(r.date + 'T00:00:00');
            const lbl = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const pct = goal ? Math.round((r.calories / goal) * 100) : 0;
            return `
            <div class="review-row">
              <div style="min-width:0">
                <div style="font-size:14px;font-weight:600">${lbl}
                  <span class="review-flag">under-logged</span>
                </div>
                <div style="font-size:12px;color:var(--text-muted)">${r.meal_count} meal${r.meal_count === 1 ? '' : 's'} · ${fmtE(r.calories)} ${ul} · only ${pct}% of goal</div>
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                <button class="review-add"   data-date="${r.date}">Forgot — add</button>
                <button class="review-light" data-date="${r.date}">Ate light</button>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <!-- Protein chart -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Protein <span class="range-chip">· ${rangeLabel()}</span></div>
        <div style="height:160px;position:relative"><canvas id="chart-pro"></canvas></div>
      </div>

      <!-- Carbs + fat (secondary — tucked away) -->
      <details id="more-macros" style="margin-bottom:12px">
        <summary style="cursor:pointer;list-style:none;font-size:13px;font-weight:700;color:var(--text-muted);padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md)">More macros · carbs & fat</summary>
        <div class="card" style="margin-top:10px">
          <div class="label" style="margin-bottom:10px">Carbs <span class="range-chip">· ${rangeLabel()}</span></div>
          <div style="height:150px;position:relative"><canvas id="chart-carb"></canvas></div>
        </div>
        <div class="card" style="margin-top:12px">
          <div class="label" style="margin-bottom:10px">Fat <span class="range-chip">· ${rangeLabel()}</span></div>
          <div style="height:150px;position:relative"><canvas id="chart-fat"></canvas></div>
        </div>
      </details>
    `;

    // Weigh-ins list (browse / edit / delete with undo) under the weight chart.
    // Manual entries only — IronLog weigh-ins are managed in IronLog. Any
    // mutation re-runs load() so the chart and verdict stay in sync.
    const wtDetails = document.getElementById('wt-log-details');
    wtDetails?.addEventListener('toggle', () => { weighInsOpen = wtDetails.open; });

    // Chart.js sizes off the canvas, and a canvas inside a closed <details> has
    // no size — so draw on first open, same as the carbs/fat section below.
    const waistDetails = document.getElementById('waist-details');
    let waistDrawn = false;
    const drawWaist = () => {
      if (!waistDetails?.open || waistDrawn || waistEntries.length < 2) return;
      waistDrawn = true;
      const wsLabels = waistEntries.map(([d]) => {
        const dt = new Date(d + 'T00:00:00');
        return `${dt.getMonth() + 1}/${dt.getDate()}`;
      });
      makeChart('chart-waist', wsLabels, waistEntries.map(([, v]) => v), ink('#ffd166'), 'cm',
        { trendData: movingAvg(waistEntries.map(([, v]) => v), 5) });
    };
    waistDetails?.addEventListener('toggle', () => { waistOpen = waistDetails.open; drawWaist(); });
    drawWaist();

    document.getElementById('waist-save')?.addEventListener('click', async () => {
      const el = document.getElementById('waist-cm');
      const cm = parseFloat(el.value);
      if (!(cm >= 40 && cm <= 200)) {
        // Catches inches typed into a cm box — a 32in waist reads as 32.
        showToast(cm > 0 && cm < 40 ? 'That looks like inches — this field is cm' : 'Enter a waist in cm', 'error');
        return;
      }
      try {
        await api.post('/api/measurements', { waist_cm: cm, date: document.getElementById('waist-date').value || undefined });
        showToast('Waist logged', 'success');
        load();
      } catch (err) { showToast(err.message, 'error'); }
    });

    document.getElementById('wt-add-save')?.addEventListener('click', async () => {
      const date = document.getElementById('wt-add-date').value;
      const kg   = parseFloat(document.getElementById('wt-add-kg').value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showToast('Pick a date', 'error');
      if (!(kg > 0)) return showToast('Enter a valid weight', 'error');
      // POST always inserts — there's no unique constraint on date — so patch
      // an existing entry instead of leaving two rows for one day, which would
      // show as a phantom duplicate and skew the trend average for that date.
      const existing = localWeights.find(w => w.date === date);
      const btn = document.getElementById('wt-add-save');
      btn.disabled = true; btn.textContent = '…';
      try {
        if (existing) await api.patch(`/api/weight/${existing.id}`, { weight_kg: kg });
        else          await api.post('/api/weight', { weight_kg: kg, date });
        showToast(existing ? `${date} updated to ${kg} kg` : `${kg} kg logged for ${date}`, 'success');
        weighInsOpen = true;
        load();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Add';
      }
    });

    (function renderWeighIns() {
      const box = document.getElementById('wt-log-list');
      if (!box) return;
      const RECENT = 8;
      const shown = weighInsExpanded ? localWeights : localWeights.slice(0, RECENT);
      const older = localWeights.length - RECENT;

      box.innerHTML = shown.map(w => `
        <div class="weight-entry" data-id="${w.id}" style="padding:9px 0">
          <div style="flex:1;min-width:0">
            <button class="wt-edit" data-id="${w.id}" data-kg="${w.weight_kg}" style="padding:0;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums" title="Tap to edit">${w.weight_kg} kg <span style="font-size:11px;color:var(--text-faint)">✎</span></button>
            <div class="weight-date">${w.date}</div>
          </div>
          <button class="weight-del wt-del" data-id="${w.id}" data-kg="${w.weight_kg}" data-date="${w.date}">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </div>`).join('')
        + (older > 0 ? `<button id="wt-show-older" class="btn btn-ghost btn-full" style="height:36px;font-size:12px;margin-top:4px">${weighInsExpanded ? 'Show recent only ▴' : `Show ${older} older ▾`}</button>` : '');

      document.getElementById('wt-show-older')?.addEventListener('click', () => {
        weighInsExpanded = !weighInsExpanded;
        renderWeighIns();
      });

      box.querySelectorAll('.wt-edit').forEach(btn => {
        btn.addEventListener('click', () => {
          const entryEl = btn.closest('.weight-entry');
          btn.outerHTML = `<span style="display:inline-flex;gap:6px;align-items:center">
            <input class="input wt-edit-input" type="text" inputmode="decimal" value="${btn.dataset.kg}" style="width:76px;height:34px;padding:0 8px;text-align:center;font-weight:700"/>
            <button class="btn btn-primary wt-edit-save" style="height:34px;padding:0 12px;font-size:12px">Save</button>
          </span>`;
          const input = entryEl.querySelector('.wt-edit-input');
          input.focus(); input.select();
          const save = async () => {
            const v = parseFloat(input.value);
            if (!v || v <= 0) { showToast('Enter a valid weight', 'error'); return; }
            try {
              await api.patch(`/api/weight/${btn.dataset.id}`, { weight_kg: v });
              showToast('Weight updated', 'success');
              load();
            } catch (err) { showToast(err.message, 'error'); }
          };
          entryEl.querySelector('.wt-edit-save').addEventListener('click', save);
          input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
        });
      });

      box.querySelectorAll('.wt-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          const { kg, date } = btn.dataset;
          try {
            await api.delete(`/api/weight/${btn.dataset.id}`);
            load();
            showToast(`${kg} kg on ${date} deleted`, 'info', {
              actionLabel: 'Undo',
              onAction: async () => {
                try {
                  await api.post('/api/weight', { weight_kg: parseFloat(kg), date });
                  load();
                } catch (err) { showToast(err.message, 'error'); }
              },
            });
          } catch (err) { showToast(err.message, 'error'); }
        });
      });
    })();

    document.querySelector('.set-target-cell')?.addEventListener('click', goToTargetWeight);

    // Review-list actions
    document.querySelectorAll('.review-add').forEach(btn => {
      btn.addEventListener('click', () =>
        openFoodEntry(lazySession(btn.dataset.date), () => load()));
    });
    document.querySelectorAll('.review-light').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.post('/api/meals/log-status', { date: btn.dataset.date, status: 'confirmed' });
          showToast('Counted as a light day', 'success');
          load();
        } catch (err) { showToast(err.message, 'error'); }
      });
    });

    // Weekly-average macro toggle
    const wkMetric = document.getElementById('wk-metric');
    if (wkMetric) {
      drawWeekBars('cal');
      wkMetric.addEventListener('click', e => {
        const b = e.target.closest('[data-m]');
        if (!b) return;
        wkMetric.querySelectorAll('.search-tab').forEach(x => x.classList.toggle('active', x === b));
        drawWeekBars(b.dataset.m);
      });
    }

    requestAnimationFrame(() => {
      makeChart('chart-cal', labels, cals, ink('#c8b8ff'), ul, {
        goalLine: goalDisplay, avgLine: weeklyAvgDisplay,
        pointColors, pointRadii, trendData: calTrend,
      });
      makeChart('chart-pro',  labels, proteins, ink('#1E88E5'), 'g', { goalLine: proteinGoal });
      if (wVals.length > 1) makeChart('chart-wt', wLabels, wVals, ink('#62d8ff'), 'kg', { trendData: wTrend, goalLine: targetWeight ?? undefined, expectedData: expectedAligned ?? undefined });
      else {
        const c = document.getElementById('chart-wt');
        if (c) c.closest('.card').querySelector('div[style*="height"]').innerHTML =
          '<div class="empty-state" style="height:170px;display:flex;align-items:center;justify-content:center"><div class="empty-text">Log your weight to see a chart</div></div>';
      }
      // Carbs/fat render only once their section is open (canvas needs to be visible).
      const more = document.getElementById('more-macros');
      let drawn = false;
      const drawMacros = () => {
        if (!more || drawn || !more.open) return;
        drawn = true;
        makeChart('chart-carb', labels, carbs, ink('#f97316'), 'g', { goalLine: carbGoal });
        makeChart('chart-fat',  labels, fats,  ink('#eab308'), 'g', { goalLine: fatGoal  });
      };
      more?.addEventListener('toggle', drawMacros);
      drawMacros();
    });
  }

  load();
  // navigateTo calls this before swapping views. Without it the canvases go out
  // with innerHTML='' but their Chart instances stay alive, holding a resize
  // listener each — one more per visit, for as long as the app stays open.
  return () => destroyAllCharts();
}
