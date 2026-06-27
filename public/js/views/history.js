import { api }             from '../api.js';
import { showToast }        from '../app.js';
import { renderMacroBar }   from '../components/macroBar.js';
import { fmtE, unitLabel }  from '../utils/energy.js';
import { openFoodEntry, openEditEntry, openCopyEntry, openCopyMeal } from './log.js';
import { localDate }        from '../utils/date.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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
    if (!strip) return;   // view torn down (tab switch) during async load
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
    if (!dayEl) return;   // view torn down before/while loading
    dayEl.innerHTML = '<div class="skeleton skel-line" style="margin-bottom:10px"></div><div class="skeleton skel-line" style="width:70%"></div>';
    try {
      const [mealData, settings] = await Promise.all([
        api.get(`/api/meals/day/${date}`),
        api.get('/api/settings'),
      ]);
      if (!document.getElementById('history-day')) return;   // navigated away during fetch
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
        ${n >= 2 ? `
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
      el.insertAdjacentHTML('beforeend', '<div class="empty-state" style="padding:20px 0"><div class="empty-icon">🍽</div><div class="empty-text">No meals logged</div></div>');
    } else {
      const today = localDate();
      mealData.sessions.forEach(session => {
        const sessionKcal    = session.entries.reduce((s, e) => s + (e.calories || 0), 0);
        const sessionProtein = session.entries.reduce((s, e) => s + (e.protein  || 0), 0);
        const sessionCarbs   = session.entries.reduce((s, e) => s + (e.carbs    || 0), 0);
        const sessionFat     = session.entries.reduce((s, e) => s + (e.fat      || 0), 0);
        const hasMacros      = session.entries.some(e => e.protein != null);
        const isPast = date < today;
        const card = document.createElement('div');
        card.className = 'card';
        card.style.marginBottom = '10px';
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
            <button class="h-rename" style="font-weight:600;text-align:left;flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow:hidden">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(session.name)}</span><span style="font-size:11px;color:var(--text-faint);flex-shrink:0">✎</span>
            </button>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
              <div style="text-align:right">
                <div class="num muted" style="font-size:13px">${fmtE(sessionKcal)} ${ul}</div>
                ${hasMacros ? `<div style="font-size:11px;color:var(--text-faint)"><span style="color:var(--protein)">${sessionProtein.toFixed(0)}P</span> · <span style="color:var(--carbs)">${sessionCarbs.toFixed(0)}C</span> · <span style="color:var(--fat)">${sessionFat.toFixed(0)}F</span></div>` : ''}
              </div>
              ${isPast ? `<button class="move-today-btn" title="Move to today" style="font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 9px;border-radius:999px;border:1px solid rgba(200,184,255,.2);white-space:nowrap">→ Today</button>` : ''}
              <button class="h-copy-meal" title="Copy meal to…" style="color:var(--text-faint);padding:4px;font-size:14px">⧉</button>
              <button class="h-del-meal" title="Delete meal" style="color:var(--text-faint);padding:4px;font-size:15px">×</button>
            </div>
          </div>
          ${session.entries.map(e => {
            const macros = [
              e.protein != null ? `<span style="color:var(--protein)">${e.protein.toFixed(0)}P</span>` : null,
              e.carbs   != null ? `<span style="color:var(--carbs)">${e.carbs.toFixed(0)}C</span>`   : null,
              e.fat     != null ? `<span style="color:var(--fat)">${e.fat.toFixed(0)}F</span>`       : null,
            ].filter(Boolean).join(' ');
            return `
            <div data-eid="${e.id}" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border)">
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.food_name)}</div>
                <div style="font-size:12px;color:var(--text-muted)">${e.quantity_g}g${macros ? ` · ${macros}` : ''}</div>
              </div>
              <div class="num" style="font-size:13px;font-weight:600;flex-shrink:0">${fmtE(e.calories ?? 0)}</div>
              <div style="display:flex;gap:3px;flex-shrink:0">
                <button class="h-ecopy" title="Copy" style="width:28px;height:28px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);font-size:12px">⧉</button>
                <button class="h-eedit" title="Edit" style="width:28px;height:28px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);font-size:11px">✏️</button>
                <button class="h-edel" title="Delete" style="width:28px;height:28px;border-radius:50%;background:rgba(255,107,107,.1);color:var(--error);font-size:14px">×</button>
              </div>
            </div>`;
          }).join('')}
          <button class="h-add-food new-meal-btn" style="margin-top:8px;width:100%;font-size:13px">+ Add food</button>
        `;

        card.querySelector('.h-rename').addEventListener('click', async () => {
          const name = prompt('Rename meal', session.name);
          if (name == null || !name.trim()) return;
          try { await api.patch(`/api/meals/sessions/${session.id}`, { name: name.trim() }); loadDay(date); }
          catch (err) { showToast(err.message, 'error'); }
        });
        card.querySelector('.h-del-meal').addEventListener('click', async () => {
          if (!confirm(`Delete "${session.name}" and its foods?`)) return;
          try { await api.delete(`/api/meals/sessions/${session.id}`); showToast('Meal deleted', 'success'); loadDay(date); }
          catch (err) { showToast(err.message, 'error'); }
        });
        card.querySelector('.h-copy-meal').addEventListener('click', () => openCopyMeal(session, date, () => loadDay(date)));
        card.querySelector('.h-add-food').addEventListener('click', () => openFoodEntry(session.id, () => loadDay(date)));
        card.querySelector('.move-today-btn')?.addEventListener('click', async () => {
          try {
            await api.patch(`/api/meals/sessions/${session.id}`, { date: today });
            showToast(`"${session.name}" moved to today`, 'success');
            loadDay(date);
          } catch (err) { showToast(err.message, 'error'); }
        });
        session.entries.forEach(e => {
          const row = card.querySelector(`[data-eid="${e.id}"]`);
          if (!row) return;
          row.querySelector('.h-eedit').addEventListener('click', () => openEditEntry(e, () => loadDay(date)));
          row.querySelector('.h-ecopy').addEventListener('click', () => openCopyEntry(e, date, () => loadDay(date)));
          row.querySelector('.h-edel').addEventListener('click', async () => {
            try { await api.delete(`/api/meals/entries/${e.id}`); loadDay(date); }
            catch (err) { showToast(err.message, 'error'); }
          });
        });

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
