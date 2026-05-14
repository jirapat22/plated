import { api }             from '../api.js';
import { showToast }        from '../app.js';
import { renderMacroBar }   from '../components/macroBar.js';
import { fmtE, unitLabel }  from '../utils/energy.js';
import { openFoodEntry }    from './log.js';
import { localDate }        from '../utils/date.js';

function isoDate(d) { return localDate(d); }          // local timezone, not UTC
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }

function fmtDateFull(iso) {
  const d = new Date(iso + 'T00:00:00');
  const today = isoDate(new Date());
  if (iso === today) return 'Today';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtWeekday(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 3);
}

export function renderHistory(container) {
  let selectedDate = localDate();
  let summary = [];

  container.innerHTML = `
    <div class="today-header"><div class="today-date">History</div></div>
    <div id="cal-strip-root" class="cal-strip"></div>
    <div id="history-day" style="padding:0 16px"></div>
  `;

  async function loadSummary() {
    summary = await api.get('/api/meals/summary?days=30');
    renderStrip();
  }

  function renderStrip() {
    const strip = document.getElementById('cal-strip-root');
    strip.innerHTML = '';
    const summaryByDate = Object.fromEntries(summary.map(r => [r.date, r]));

    for (let i = 29; i >= 0; i--) {
      const d   = addDays(new Date(), -i);
      const iso = isoDate(d);
      const has = !!summaryByDate[iso];

      const el = document.createElement('button');
      el.className = `cal-day${has ? ' has-data' : ''}${iso === selectedDate ? ' selected' : ''}`;
      el.dataset.date = iso;
      el.innerHTML = `
        <div class="cal-day-name">${fmtWeekday(d)}</div>
        <div class="cal-day-num">${d.getDate()}</div>
        <div class="cal-day-dot"></div>
      `;
      el.addEventListener('click', () => selectDate(iso));
      strip.appendChild(el);
    }

    const sel = strip.querySelector('.selected');
    sel?.scrollIntoView({ inline: 'center', behavior: 'smooth' });
  }

  function selectDate(date) {
    selectedDate = date;
    renderStrip();
    loadDay(date);
  }

  async function loadDay(date) {
    const dayEl = document.getElementById('history-day');
    dayEl.innerHTML = '<div class="skeleton skel-line" style="margin-bottom:10px"></div><div class="skeleton skel-line" style="width:70%"></div>';
    try {
      const [mealData, settings] = await Promise.all([
        api.get(`/api/meals/day/${date}`),
        api.get('/api/settings'),
      ]);
      renderDay(dayEl, mealData, settings, date);
    } catch (err) {
      dayEl.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function renderDay(el, mealData, settings, date) {
    const goals = {
      cal:    parseFloat(settings.calorie_goal) || 2000,
      protein:parseFloat(settings.protein_goal) || 150,
      carbs:  parseFloat(settings.carb_goal)     || 250,
      fat:    parseFloat(settings.fat_goal)       || 65,
      fiber:  parseFloat(settings.fiber_goal)     || 30,
    };
    const t  = mealData.totals;
    const ul = unitLabel();

    el.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px">${fmtDateFull(date)}</div>
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:12px">
          <div>
            <div class="num" style="font-size:28px;font-weight:800">${fmtE(t.calories)}</div>
            <div class="label">of ${fmtE(goals.cal)} ${ul}</div>
          </div>
          <div style="text-align:right">
            <div class="num" style="font-size:13px;color:var(--protein)">${t.protein.toFixed(1)}g protein</div>
            <div class="num" style="font-size:13px;color:var(--carbs)">${t.carbs.toFixed(1)}g carbs</div>
            <div class="num" style="font-size:13px;color:var(--fat)">${t.fat.toFixed(1)}g fat</div>
          </div>
        </div>
        <div id="hist-macro-bar"></div>
      </div>
    `;
    renderMacroBar(el.querySelector('#hist-macro-bar'), t, goals);

    if (mealData.sessions.length === 0) {
      el.insertAdjacentHTML('beforeend', '<div class="empty-state" style="padding:20px 0"><div class="empty-icon">🍽</div><div class="empty-text">No meals logged</div></div>');
    } else {
      mealData.sessions.forEach(session => {
        const sessionKcal = session.entries.reduce((s, e) => s + (e.calories || 0), 0);
        const card = document.createElement('div');
        card.className = 'card';
        card.style.marginBottom = '10px';
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <span style="font-weight:600">${session.name}</span>
            <span class="num muted">${fmtE(sessionKcal)} ${ul}</span>
          </div>
          ${session.entries.map(e => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--border)">
              <div>
                <div style="font-size:13px;font-weight:500">${e.food_name}</div>
                <div style="font-size:12px;color:var(--text-muted)">${e.quantity_g}g</div>
              </div>
              <div class="num" style="font-size:13px">${fmtE(e.calories ?? 0)} ${ul}</div>
            </div>
          `).join('')}
        `;
        el.appendChild(card);
      });
    }

    // ── Add meal to past date ─────────────────────────────────
    const addBtn = document.createElement('button');
    addBtn.className = 'new-meal-btn';
    addBtn.style.margin = '8px 0 16px';
    addBtn.style.width = '100%';
    addBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      Add Meal to ${fmtDateFull(date)}
    `;
    addBtn.addEventListener('click', async () => {
      try {
        const session = await api.post('/api/meals/sessions', { date });
        openFoodEntry(session.id, () => loadDay(date));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    el.appendChild(addBtn);
  }

  loadSummary().then(() => loadDay(selectedDate));
}
