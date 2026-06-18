import { api }                       from '../api.js';
import { fmtE, unitLabel, toDisplay } from '../utils/energy.js';
import { localDate }                  from '../utils/date.js';
import { showToast }                  from '../app.js';
import { openFoodEntry }              from './log.js';
import { classifyDay, isFlagged, LOG_STRONG } from '../utils/logCheck.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: {
      grid: { color: '#2c2c35' },
      ticks: { color: '#8b8a96', font: { size: 10 }, maxTicksLimit: 7 },
    },
    y: {
      grid: { color: '#2c2c35' },
      ticks: { color: '#8b8a96', font: { size: 10 } },
    },
  },
  elements: {
    point: { radius: 2, hoverRadius: 5 },
    line:  { tension: 0.3 },
  },
};

function destroyChart(id) { Chart.getChart(id)?.destroy(); }

// Trailing moving average — a smooth trend line over `win` days.
function movingAvg(arr, win = 7) {
  return arr.map((_, i) => {
    const start = Math.max(0, i - win + 1);
    const slice = arr.slice(start, i + 1).filter(v => v != null);
    if (!slice.length) return null;
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

function makeChart(id, labels, data, color, yLabel, opts = {}) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;

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
      borderColor: '#5dca8a99',
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
      borderColor: '#c8b8ff88',
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      tension: 0,
      fill: false,
    });
  }

  new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          callbacks: {
            label: c => {
              const lbl = c.dataset.label;
              const suffix = lbl === 'goal' ? ' (goal)' : lbl === '7d avg' ? ' (7d avg)'
                : lbl === 'trend' ? ' (trend)' : '';
              if (lbl === 'trend' && c.parsed.y == null) return null;
              return `${c.parsed.y.toFixed(1)} ${yLabel}${suffix}`;
            },
          },
        },
      },
      scales: {
        ...CHART_DEFAULTS.scales,
        y: {
          ...CHART_DEFAULTS.scales.y,
          title: { display: true, text: yLabel, color: '#8b8a96', font: { size: 10 } },
          ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => `${Math.round(v)}` },
        },
      },
    },
  });
}

function calcStreak(summary, goal) {
  // Allow 1 missed (zero-cal / no-log) day per 7-day window.
  // A day with logged calories outside ±10% of goal still breaks the streak.
  const byDate = Object.fromEntries(summary.map(r => [r.date, r]));
  const todayD = new Date();
  let streak       = 0;
  let graceUsed    = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(todayD);
    d.setDate(d.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const cal = byDate[iso]?.calories ?? 0;
    const hit = cal > 0 && Math.abs(cal - goal) / goal <= 0.10;
    const noLog = cal === 0;

    if (i > 0 && i % 7 === 0) graceUsed = 0;   // reset grace counter every 7 days back

    if (hit) {
      streak++;
    } else if (noLog && graceUsed < 1) {
      graceUsed++;
      streak++;                                  // no-log day counts (grace)
    } else {
      break;                                     // logged but missed goal = break
    }
  }
  return streak;
}

export function renderTrends(container) {
  let days = 30;

  container.innerHTML = `
    <div class="today-header">
      <div class="today-date">Trends</div>
      <div style="display:flex;gap:6px">
        <button class="range-btn" data-days="7">7d</button>
        <button class="range-btn active" data-days="30">30d</button>
        <button class="range-btn" data-days="90">90d</button>
      </div>
    </div>
    <div id="trends-body" style="padding:0 16px">
      <div class="skeleton skel-line" style="height:180px;border-radius:14px"></div>
    </div>
  `;

  // Range buttons
  container.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      days = parseInt(btn.dataset.days);
      container.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === btn));
      load();
    });
  });

  // Inline range button styles
  const style = document.createElement('style');
  style.textContent = `.range-btn{height:28px;padding:0 12px;border-radius:999px;font-size:12px;font-weight:700;background:var(--surface-2);color:var(--text-muted);border:1px solid var(--border);transition:all .15s}.range-btn.active{background:var(--accent-dim);color:var(--accent);border-color:rgba(200,184,255,.3)}`;
  container.prepend(style);

  async function load() {
    document.getElementById('trends-body').innerHTML =
      '<div class="skeleton skel-line" style="height:180px;border-radius:14px"></div>';
    try {
      const [summary, weights, settings] = await Promise.all([
        api.get(`/api/meals/summary?days=${days}`),
        api.get('/api/weight?limit=90'),
        api.get('/api/settings'),
      ]);

      let ironlogWeights = [];
      try {
        const d = await api.get('/api/ironlog/bodyweight');
        ironlogWeights = d.entries || (Array.isArray(d) ? d : []);
      } catch { /* non-fatal */ }

      render(summary, weights, ironlogWeights, settings);
    } catch (err) {
      document.getElementById('trends-body').innerHTML =
        `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(summary, localWeights, ironlogWeights, settings) {
    const goal        = parseFloat(settings.calorie_goal) || 2000;
    const proteinGoal = parseFloat(settings.protein_goal) || 150;
    const carbGoal    = parseFloat(settings.carb_goal) || 250;
    const fatGoal     = parseFloat(settings.fat_goal)  || 65;
    const ul          = unitLabel();
    const todayISO    = localDate();
    const streak      = calcStreak(summary, goal);

    // Tag every day with its logging-completeness status.
    const rows = summary.map(r => ({ ...r, status: classifyDay(r, goal, todayISO) }));
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
    const FLAG = '#f97316';
    const pointColors = rows.map(r => isFlagged(r.status) ? FLAG : '#c8b8ff');
    const pointRadii  = rows.map(r => isFlagged(r.status) ? 5 : 2);
    const calTrend    = movingAvg(rows.map(r => toDisplay(r.calories ?? 0)), 7);

    // Weight series (IronLog + local merged by date)
    const weightMap = {};
    ironlogWeights.forEach(w => { weightMap[w.date] = w.weight_kg; });
    localWeights.forEach(w   => { weightMap[w.date] = w.weight_kg; });
    const weightEntries = Object.entries(weightMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-days);
    const wLabels = weightEntries.map(([d]) => { const dt = new Date(d + 'T00:00:00'); return `${dt.getMonth()+1}/${dt.getDate()}`; });
    const wVals   = weightEntries.map(([, v]) => v);
    const wTrend  = movingAvg(wVals, 7);

    // ── 7-day average — excludes flagged (likely-incomplete) days ──
    const recent7  = rows.slice(-7);
    const valid7   = recent7.filter(r => (r.meal_count || 0) > 0 && !isFlagged(r.status));
    const skipped7 = recent7.filter(r => isFlagged(r.status)).length;
    const weeklyAvgKcal = valid7.length
      ? valid7.reduce((s, r) => s + (r.calories ?? 0), 0) / valid7.length
      : null;
    const weeklyAvg        = weeklyAvgKcal != null ? fmtE(weeklyAvgKcal) : null;
    const weeklyAvgDisplay = weeklyAvgKcal != null ? toDisplay(weeklyAvgKcal) : null;
    const goalDisplay = toDisplay(goal);

    // ── Consistency over the range ──
    const loggedCount   = loggedDays.length;
    const completeCount = completeDays.length;
    const completePct   = loggedCount ? Math.round((completeCount / loggedCount) * 100) : 0;

    // ── Goal progress ──
    const validForAvg = loggedDays.filter(r => !isFlagged(r.status));
    const avgCal = validForAvg.length
      ? validForAvg.reduce((s, r) => s + (r.calories ?? 0), 0) / validForAvg.length
      : null;
    const balance = avgCal != null ? avgCal - goal : null;   // + over / - under goal

    const targetWeight = parseFloat(settings.target_weight_kg) || null;
    const curWeight    = wVals.length ? wVals[wVals.length - 1] : null;
    const startWeight  = wVals.length ? wVals[0] : null;
    const wChange      = (curWeight != null && startWeight != null) ? curWeight - startWeight : null;
    const toTarget     = (curWeight != null && targetWeight != null) ? curWeight - targetWeight : null;

    // Streak messaging
    const streakEl = streak === 0
      ? `<div style="font-size:13px;color:var(--text-muted);margin-top:4px">Log meals and hit your calorie goal to start a streak 🎯</div>`
      : streak === 1
      ? `<div style="font-size:13px;color:var(--text-muted);margin-top:4px">1 day — keep it going! 💪</div>`
      : `<div style="font-size:13px;color:var(--text-muted);margin-top:4px">${streak} consecutive days within 10% of goal</div>`;

    document.getElementById('trends-body').innerHTML = `
      <!-- Streak -->
      <div class="card streak-card" style="margin-bottom:12px">
        <div class="streak-num">${streak === 0 ? '–' : streak}</div>
        <div>
          <div style="font-size:15px;font-weight:700">Day streak 🔥</div>
          ${streakEl}
        </div>
      </div>

      <!-- Consistency -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Consistency — ${days}d</div>
        <div class="stat-grid">
          <div class="stat-cell">
            <div class="stat-num">${loggedCount}</div>
            <div class="stat-lbl">days logged</div>
          </div>
          <div class="stat-cell">
            <div class="stat-num">${completePct}%</div>
            <div class="stat-lbl">fully logged</div>
          </div>
          <div class="stat-cell">
            <div class="stat-num" style="color:${recentFlagged.length ? FLAG : 'var(--text)'}">${recentFlagged.length}</div>
            <div class="stat-lbl">need a look</div>
          </div>
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

      <!-- Goal progress -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Goal progress — ${days}d</div>
        <div class="gp-row">
          <span class="gp-lbl">Avg intake ${avgCal != null ? '(complete days)' : ''}</span>
          <span class="gp-val">${avgCal != null ? `${fmtE(avgCal)} ${ul}` : '–'}
            ${balance != null ? `<span style="font-size:12px;color:${balance > 0 ? 'var(--warning)' : 'var(--success)'}"> · ${balance > 0 ? '+' : ''}${fmtE(balance)} vs goal</span>` : ''}
          </span>
        </div>
        <div class="gp-row">
          <span class="gp-lbl">Weight (${days}d change)</span>
          <span class="gp-val">${curWeight != null ? `${curWeight.toFixed(1)} kg` : '–'}
            ${wChange != null ? `<span style="font-size:12px;color:var(--text-muted)"> · ${wChange > 0 ? '+' : ''}${wChange.toFixed(1)} kg</span>` : ''}
          </span>
        </div>
        ${targetWeight != null ? `
        <div class="gp-row">
          <span class="gp-lbl">To target (${targetWeight} kg)</span>
          <span class="gp-val">${toTarget != null ? `${toTarget > 0 ? '' : '+'}${(-toTarget).toFixed(1)} kg to go` : '–'}</span>
        </div>` : `
        <div class="gp-row">
          <span class="gp-lbl" style="font-size:12px;color:var(--text-faint)">Set a target weight in Settings to track progress</span>
        </div>`}
      </div>

      <!-- Weekly avg -->
      ${weeklyAvg ? `
      <div class="card" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="label">7-day avg</div>
          ${skipped7 ? `<div style="font-size:11px;color:var(--text-faint);margin-top:2px">${skipped7} under-logged day${skipped7 === 1 ? '' : 's'} excluded</div>` : ''}
        </div>
        <div class="num" style="font-size:18px">${weeklyAvg}
          <span style="font-size:12px;color:var(--text-muted)"> / ${fmtE(goal)} ${ul}</span>
        </div>
      </div>` : ''}

      <!-- Calories chart -->
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="label">Calories — ${days}d</div>
          <div style="display:flex;gap:10px;font-size:10px;color:var(--text-faint)">
            <span style="display:flex;align-items:center;gap:4px">
              <span style="width:16px;height:2px;background:#5dca8a;display:inline-block;border-radius:1px"></span>goal
            </span>
            <span style="display:flex;align-items:center;gap:4px">
              <span style="width:7px;height:7px;background:${FLAG};display:inline-block;border-radius:50%"></span>under-logged
            </span>
          </div>
        </div>
        <div style="height:160px;position:relative"><canvas id="chart-cal"></canvas></div>
      </div>

      <!-- Protein chart -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Protein — ${days}d</div>
        <div style="height:160px;position:relative"><canvas id="chart-pro"></canvas></div>
      </div>

      <!-- Carbs chart -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Carbs — ${days}d</div>
        <div style="height:160px;position:relative"><canvas id="chart-carb"></canvas></div>
      </div>

      <!-- Fat chart -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Fat — ${days}d</div>
        <div style="height:160px;position:relative"><canvas id="chart-fat"></canvas></div>
      </div>

      <!-- Weight chart -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Bodyweight — ${days}d</div>
        <div style="height:160px;position:relative"><canvas id="chart-wt"></canvas></div>
      </div>
    `;

    // Review-list actions
    document.querySelectorAll('.review-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const session = await api.post('/api/meals/sessions', { date: btn.dataset.date });
          openFoodEntry(session.id, () => load());
        } catch (err) { showToast(err.message, 'error'); }
      });
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

    requestAnimationFrame(() => {
      makeChart('chart-cal', labels, cals, '#c8b8ff', ul, {
        goalLine: goalDisplay, avgLine: weeklyAvgDisplay,
        pointColors, pointRadii, trendData: calTrend,
      });
      makeChart('chart-pro',  labels, proteins, '#1E88E5', 'g', { goalLine: proteinGoal });
      makeChart('chart-carb', labels, carbs,    '#f97316', 'g', { goalLine: carbGoal });
      makeChart('chart-fat',  labels, fats,     '#eab308', 'g', { goalLine: fatGoal  });
      if (wVals.length > 1) makeChart('chart-wt', wLabels, wVals, '#62d8ff', 'kg', { trendData: wTrend });
      else {
        const c = document.getElementById('chart-wt');
        if (c) c.closest('.card').querySelector('.label').nextElementSibling.innerHTML =
          '<div class="empty-state" style="height:160px;display:flex;align-items:center;justify-content:center"><div class="empty-text">Log your weight to see a chart</div></div>';
      }
    });
  }

  load();
}
