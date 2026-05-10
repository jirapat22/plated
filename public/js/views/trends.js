import { api } from '../api.js';

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

function destroyChart(id) {
  const existing = Chart.getChart(id);
  existing?.destroy();
}

function makeChart(id, labels, data, color, label) {
  destroyChart(id);
  const ctx = document.getElementById(id);
  if (!ctx) return;
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label,
        data,
        borderColor: color,
        backgroundColor: color + '22',
        fill: true,
        borderWidth: 2,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y.toFixed(1)} ${label}`,
          },
        },
      },
    },
  });
}

function calcStreak(summary, goal) {
  const sorted = [...summary].sort((a, b) => b.date.localeCompare(a.date));
  let streak = 0;
  const today = new Date().toISOString().split('T')[0];
  for (const row of sorted) {
    if (row.date > today) continue;
    const cal = row.calories ?? 0;
    if (cal > 0 && Math.abs(cal - goal) / goal <= 0.10) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export function renderTrends(container) {
  container.innerHTML = `
    <div class="today-header"><div class="today-date">Trends</div></div>
    <div id="trends-body" style="padding:0 16px">
      <div class="skeleton skel-line" style="height:180px;border-radius:14px"></div>
    </div>
  `;

  async function load() {
    try {
      const [summary, weights, settings] = await Promise.all([
        api.get('/api/meals/summary?days=30'),
        api.get('/api/weight?limit=30'),
        api.get('/api/settings'),
      ]);

      // Fetch IronLog weight data via backend proxy (avoids CORS)
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
    const goal = parseFloat(settings.calorie_goal) || 2000;
    const streak = calcStreak(summary, goal);

    const labels = summary.map(r => {
      const d = new Date(r.date + 'T00:00:00');
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
    const cals    = summary.map(r => r.calories    ?? 0);
    const proteins= summary.map(r => r.protein     ?? 0);

    // Merge weight: local takes priority for same date
    const weightMap = {};
    ironlogWeights.forEach(w => { weightMap[w.date] = w.weight_kg; });
    localWeights.forEach(w  => { weightMap[w.date]  = w.weight_kg; });
    const weightEntries = Object.entries(weightMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-30);
    const wLabels = weightEntries.map(([d]) => {
      const dt = new Date(d + 'T00:00:00');
      return `${dt.getMonth()+1}/${dt.getDate()}`;
    });
    const wVals = weightEntries.map(([, v]) => v);

    const weeklyAvg = summary.length >= 7
      ? (summary.slice(-7).reduce((s, r) => s + (r.calories ?? 0), 0) / 7).toFixed(0)
      : '–';

    document.getElementById('trends-body').innerHTML = `
      <!-- Streak -->
      <div class="card streak-card" style="margin-bottom:12px">
        <div class="streak-num">${streak}</div>
        <div>
          <div style="font-size:15px;font-weight:700">Day streak</div>
          <div class="streak-label">Hitting calorie goal (±10%)</div>
        </div>
      </div>

      <!-- Weekly avg -->
      <div class="card" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
        <div class="label">7-day avg calories</div>
        <div class="num" style="font-size:18px">${weeklyAvg} <span style="font-size:12px;color:var(--text-muted)">/ ${goal}</span></div>
      </div>

      <!-- Calories chart -->
      <div class="card chart-card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Calories — 30 days</div>
        <div style="height:160px;position:relative">
          <canvas id="chart-cal"></canvas>
        </div>
      </div>

      <!-- Protein chart -->
      <div class="card chart-card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Protein — 30 days</div>
        <div style="height:160px;position:relative">
          <canvas id="chart-pro"></canvas>
        </div>
      </div>

      <!-- Weight chart -->
      <div class="card chart-card" style="margin-bottom:12px">
        <div class="label" style="margin-bottom:10px">Bodyweight — 30 days</div>
        <div style="height:160px;position:relative">
          <canvas id="chart-wt"></canvas>
        </div>
      </div>
    `;

    // Small delay so DOM is painted
    requestAnimationFrame(() => {
      makeChart('chart-cal', labels, cals, '#c8b8ff', 'kcal');
      makeChart('chart-pro', labels, proteins, '#ff8ad1', 'g protein');
      if (wVals.length > 0) makeChart('chart-wt', wLabels, wVals, '#62d8ff', 'kg');
    });
  }

  load();
}
