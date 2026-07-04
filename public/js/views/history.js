import { api }             from '../api.js';
import { showToast }        from '../app.js';
import { renderMacroBar }   from '../components/macroBar.js';
import { fmtE, unitLabel }  from '../utils/energy.js';
import { openFoodEntry, renderMealCard } from './log.js';
import { localDate }        from '../utils/date.js';

function isoDate(d) { return localDate(d); }          // local timezone, not UTC
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }

function fmtDateFull(iso) {
  const d = new Date(iso + 'T00:00:00');
  const today = isoDate(new Date());
  if (iso === today) return 'Today';
  if (iso === isoDate(addDays(new Date(), 1))) return 'Tomorrow';
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
    if (!strip) return;   // view torn down (tab switch) during async load
    strip.innerHTML = '';
    const summaryByDate = Object.fromEntries(summary.map(r => [r.date, r]));
    const todayIso = isoDate(new Date());

    // 30 days back through 7 days ahead — future days let you pre-log planned
    // meals (they render dimmer so "the future" reads at a glance).
    for (let i = 29; i >= -7; i--) {
      const d   = addDays(new Date(), -i);
      const iso = isoDate(d);
      const has = !!summaryByDate[iso];

      const el = document.createElement('button');
      el.className = `cal-day${has ? ' has-data' : ''}${iso === selectedDate ? ' selected' : ''}${iso > todayIso ? ' future' : ''}`;
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
    if (!dayEl) return;   // view torn down before/while loading
    dayEl.innerHTML = '<div class="skeleton skel-line" style="margin-bottom:10px"></div><div class="skeleton skel-line" style="width:70%"></div>';
    try {
      const [mealData, settings, dayWeight] = await Promise.all([
        api.get(`/api/meals/day/${date}`),
        api.get('/api/settings'),
        api.get(`/api/weight/day/${date}`).catch(() => null),
      ]);
      if (!document.getElementById('history-day')) return;   // navigated away during fetch
      renderDay(dayEl, mealData, settings, date, dayWeight);
    } catch (err) {
      dayEl.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  // Re-pull the 30-day summary (powers the calendar dots + 7-day avg) before
  // reloading the day — otherwise an edit shows in the totals above but the
  // 7-day-avg panel and strip dots stay stale until you leave and come back.
  async function refresh(date) {
    await loadSummary();
    loadDay(date);
  }

  function renderDay(el, mealData, settings, date, dayWeight) {
    const goals = {
      cal:    parseFloat(settings.calorie_goal) || 2000,
      protein:parseFloat(settings.protein_goal) || 150,
      carbs:  parseFloat(settings.carb_goal)     || 250,
      fat:    parseFloat(settings.fat_goal)       || 65,
      fiber:  parseFloat(settings.fiber_goal)     || 30,
    };
    const t  = mealData.totals;
    const ul = unitLabel();

    // 7-day rolling average ending at `date`
    const byDate = Object.fromEntries(summary.map(r => [r.date, r]));
    const weekRows = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(date + 'T00:00:00');
      d.setDate(d.getDate() - (6 - i));
      return byDate[isoDate(d)];
    }).filter(Boolean);
    const n = weekRows.length;
    const wAvg = k => n ? Math.round(weekRows.reduce((s, r) => s + (r[k] ?? 0), 0) / n) : 0;

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
        ${dayWeight ? `
        <div style="display:flex;align-items:center;gap:6px;border-top:1px solid var(--border);margin-top:12px;padding-top:10px;font-size:12px;color:var(--text-muted)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><rect x="3" y="9" width="18" height="12" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M8 9a4 4 0 0 1 8 0" stroke="currentColor" stroke-width="1.7"/><path d="M12 12v3.2M12 12l2.6 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
          Bodyweight <span class="num" style="color:var(--text);font-weight:700">${dayWeight.weight_kg} kg</span>
        </div>` : ''}
        ${date <= localDate() && n >= 2 ? `
        <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:10px">
          <div style="font-size:10px;font-weight:700;color:var(--text-faint);letter-spacing:.06em;margin-bottom:6px">
            7-DAY AVG · ${n} of 7 days logged
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="num" style="font-size:18px">${fmtE(wAvg('calories'))}
              <span style="font-size:11px;color:var(--text-muted)">${ul}/day</span>
            </div>
            <div style="font-size:12px;color:var(--text-muted)">
              <span style="color:var(--protein)">${wAvg('protein')}g P</span> ·
              <span style="color:var(--carbs)">${wAvg('carbs')}g C</span> ·
              <span style="color:var(--fat)">${wAvg('fat')}g F</span>
            </div>
          </div>
        </div>` : ''}
      </div>
    `;
    renderMacroBar(el.querySelector('#hist-macro-bar'), t, goals, false);

    if (mealData.sessions.length === 0) {
      const future = date > localDate();
      el.insertAdjacentHTML('beforeend', `<div class="empty-state" style="padding:20px 0"><div class="empty-icon">🍽</div><div class="empty-text">${future ? 'Nothing planned yet — add a meal below to plan ahead' : 'No meals logged'}</div></div>`);
    } else {
      const isPast = date < localDate();
      mealData.sessions.forEach(session => {
        const card = renderMealCard(session, date, { showMoveToday: isPast }, () => refresh(date));
        card.style.margin = '0 0 10px';   // history-day already has 16px side padding
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
        openFoodEntry(session.id, () => refresh(date));
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
    el.appendChild(addBtn);
  }

  loadSummary().then(() => loadDay(selectedDate));
}
