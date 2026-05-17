import { api }                       from '../api.js';
import { fmtE, unitLabel, toDisplay } from '../utils/energy.js';

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
  }];

  if (opts.goalLine != null) {
    datasets.push({
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
              const suffix = c.datasetIndex === 1 ? ' (goal)' : c.datasetIndex === 2 ? ' (7d avg)' : '';
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
        <button class="range-btn active" data-days="7">7d</button>
        <button class="range-btn" data-days="30">30d</button>
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
      if (settings.ironlog_api_url?.trim()) {
        try {
          const d = await api.get('/api/ironlog/bodyweight');
          ironlogWeights = d.entries || (Array.isArray(d) ? d : []);
        } catch { /* non-fatal */ }
      }

      render(summary, weights, ironlogWeights, settings);
    } catch (err) {
      document.getElementById('trends-body').innerHTML =
        `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(summary, localWeights, ironlogWeights, settings) {
    const goal   = parseFloat(settings.calorie_goal) || 2000;
    const streak = calcStreak(summary, goal);
    const ul     = unitLabel();

    const labels   = summary.map(r => { const d = new Date(r.date + 'T00:00:00'); return `${d.getMonth()+1}/${d.getDate()}`; });
    const cals     = summary.map(r => toDisplay(r.calories ?? 0));
    const proteins = summary.map(r => r.protein ?? 0);

    const weightMap = {};
    ironlogWeights.forEach(w => { weightMap[w.date] = w.weight_kg; });
    localWeights.forEach(w   => { weightMap[w.date] = w.weight_kg; });
    const weightEntries = Object.entries(weightMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-days);
    const wLabels = weightEntries.map(([d]) => { const dt = new Date(d + 'T00:00:00'); return `${dt.getMonth()+1}/${dt.getDate()}`; });
    const wVals   = weightEntries.map(([, v]) => v);

    const weeklyAvgKcal = summary.length >= 7
      ? summary.slice(-7).reduce((s, r) => s + (r.calories ?? 0), 0) / 7
      : null;
    const weeklyAvg = weeklyAvgKcal != null ? fmtE(weeklyAvgKcal) : null;
    const weeklyAvgDisplay = weeklyAvgKcal != null ? toDisplay(weeklyAvgKcal) : null;
    const goalDisplay = toDisplay(goal);

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

      <!-- Weekly avg -->
      ${weeklyAvg ? `
      <div class="card" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
        <div class="label">7-day avg</div>
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
            ${weeklyAvg ? `<span style="display:flex;align-items:center;gap:4px">
              <span style="width:16px;height:2px;background:#c8b8ff;display:inline-block;border-radius:1px"></span>7d avg
            </span>` : ''}
          </div>
        </div>
        <div style="height:160px;position:relative"><canvas id="chart-cal"></canvas></div>
      </div>

      <!-- Protein chart -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Protein — ${days}d</div>
        <div style="height:160px;position:relative"><canvas id="chart-pro"></canvas></div>
      </div>

      <!-- Weight chart -->
      <div class="card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Bodyweight — ${days}d</div>
        <div style="height:160px;position:relative"><canvas id="chart-wt"></canvas></div>
      </div>
    `;

    requestAnimationFrame(() => {
      makeChart('chart-cal', labels, cals, '#c8b8ff', ul, { goalLine: goalDisplay, avgLine: weeklyAvgDisplay });
      makeChart('chart-pro', labels, proteins, '#1E88E5', 'g');
      if (wVals.length > 1) makeChart('chart-wt', wLabels, wVals, '#62d8ff', 'kg');
      else {
        const c = document.getElementById('chart-wt');
        if (c) c.closest('.card').querySelector('.label').nextElementSibling.innerHTML =
          '<div class="empty-state" style="height:160px;display:flex;align-items:center;justify-content:center"><div class="empty-text">Log your weight to see a chart</div></div>';
      }
    });
  }

  load();
}
