import { api }                      from '../api.js';
import { showToast, showSheet }      from '../app.js';
import { openFoodEntry }             from './log.js';
import { renderMacroBar }            from '../components/macroBar.js';
import { fmtE, unitLabel, toDisplay } from '../utils/energy.js';

const CIRC = 2 * Math.PI * 60; // r=60

function fmt(n, dec = 0) {
  if (n == null) return '–';
  return Number(n).toFixed(dec);
}

function fmtDate(d) {
  const now = new Date();
  const dt  = new Date(d);
  if (dt.toDateString() === now.toDateString()) return 'Today';
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// (swipe-to-delete removed — replaced with visible × button)

// ─── IronLog fetch via Plated backend proxy (avoids CORS) ──
async function fetchIronLog(settings) {
  if (!settings.ironlog_api_url?.trim()) return null;
  try {
    const data = await api.get('/api/ironlog/today');
    return data.connected ? data : null;
  } catch {
    return null;
  }
}

// ─── Render ─────────────────────────────────────────────────
export function renderToday(container) {
  const today = new Date().toISOString().split('T')[0];
  container.innerHTML = buildSkeleton();

  let refreshTimer = null;

  async function load() {
    try {
      const [mealData, waterData, settings] = await Promise.all([
        api.get('/api/meals/today'),
        api.get('/api/water/today'),
        api.get('/api/settings'),
      ]);

      const ironlog = await fetchIronLog(settings);
      render(mealData, waterData, settings, ironlog);
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(mealData, waterData, settings, ironlog) {
    const goals = {
      cal:    parseFloat(settings.calorie_goal)   || 2000,
      protein:parseFloat(settings.protein_goal)   || 150,
      carbs:  parseFloat(settings.carb_goal)       || 250,
      fat:    parseFloat(settings.fat_goal)         || 65,
      fiber:  parseFloat(settings.fiber_goal)       || 30,
      water:  parseFloat(settings.water_goal_ml)   || 2500,
    };
    const t = mealData.totals;
    const waterPct = Math.min((waterData.total_ml / goals.water) * 100, 100);
    const calPct   = Math.min((t.calories / goals.cal) * 100, 100);
    const multiplier = parseFloat(settings.protein_multiplier) || 2.2;
    const bodyweight = ironlog?.profile?.bodyweight_kg ?? null;
    const burned     = ironlog?.calories_burned ?? 0;
    const net        = t.calories - burned;
    const recProtein = bodyweight ? Math.round(bodyweight * multiplier) : null;

    container.innerHTML = `
      <div class="today-header">
        <div>
          <div class="today-date">${fmtDate(today)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${phaseBadge(settings.phase)}
          ${ironlog ? '<div class="ironlog-chip">⚡ IronLog</div>' : ''}
        </div>
      </div>

      <!-- Calorie ring + macro bar -->
      <div style="padding:0 16px 4px">
        <div class="card">
          <div class="summary-row">
            <div class="ring-wrap-relative">
              <svg class="calorie-ring" viewBox="0 0 140 140">
                <circle class="ring-bg"   cx="70" cy="70" r="60"/>
                <circle class="ring-fill ${t.calories > goals.cal ? 'over' : ''}" cx="70" cy="70" r="60"
                  style="stroke-dasharray:${(calPct/100)*CIRC} ${CIRC}" id="cal-ring-fill"/>
              </svg>
              <div class="ring-center" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">
                <div class="num ring-kcal">${fmtE(t.calories)}</div>
                <div class="ring-goal muted">/ ${fmtE(goals.cal)} ${unitLabel()}</div>
              </div>
            </div>
          </div>

          <!-- Macro bars (individual per-goal) -->
          <div id="macro-bar-root" style="margin-top:12px"></div>
        </div>
      </div>

      <!-- Water tracker -->
      <div style="padding:0 16px 4px">
        <div class="card">
          <div class="label" style="margin-bottom:10px">💧 Water</div>
          <div class="water-track">
            <div class="water-bar-outer" style="flex:1">
              <div class="water-bar-fill" style="width:${waterPct}%"></div>
            </div>
            <div class="water-amount num">${waterData.total_ml} <span style="font-size:11px;color:var(--text-muted)">/ ${goals.water} ml</span></div>
          </div>
          <div class="water-btns" id="water-btns">
            <button class="water-btn" data-ml="150">+150 ml</button>
            <button class="water-btn" data-ml="250">+250 ml</button>
            <button class="water-btn" data-ml="330">+330 ml</button>
            <button class="water-btn" data-ml="500">+500 ml</button>
            <button class="water-btn" data-ml="custom">Custom</button>
          </div>
        </div>
      </div>

      <!-- Phase progress vs TDEE -->
      ${phaseProgressCard(settings, t, burned)}

      <!-- IronLog panel -->
      ${ironlog ? `
      <div style="padding:0 16px 4px">
        <div class="card ironlog-panel">
          <div class="label" style="margin-bottom:10px">⚡ IronLog — Today</div>
          <div class="ironlog-row">
            <span class="muted">Calories burned</span>
            <span class="num">${fmtE(burned)} ${unitLabel()}</span>
          </div>
          <div class="ironlog-row">
            <span class="muted">Net calories</span>
            <span class="num" style="color:${net < 0 ? 'var(--success)' : 'var(--text)'}">${fmtE(net)} ${unitLabel()}</span>
          </div>
          ${recProtein ? `<div class="ironlog-row">
            <span class="muted">Rec. protein (${bodyweight}kg × ${multiplier})</span>
            <span class="num">${recProtein}g</span>
          </div>` : ''}
        </div>
      </div>` : ''}

      <!-- Meal sessions -->
      <div class="section-header">
        <h2>Meals</h2>
      </div>
      <div id="meals-list"></div>
      <button class="new-meal-btn" id="new-meal-btn">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        New Meal
      </button>
    `;

    // Render macro bar
    renderMacroBar(document.getElementById('macro-bar-root'), t, goals);

    // Render meal sessions
    const mealsList = document.getElementById('meals-list');
    if (mealData.sessions.length === 0) {
      mealsList.innerHTML = '<div class="empty-state"><div class="empty-icon">🍽</div><div class="empty-text">No meals yet — tap New Meal to start</div></div>';
    } else {
      mealData.sessions.forEach(session => renderSession(mealsList, session));
    }

    // Water buttons
    document.getElementById('water-btns').addEventListener('click', async e => {
      const btn = e.target.closest('[data-ml]');
      if (!btn) return;
      const ml = btn.dataset.ml;
      if (ml === 'custom') {
        const amount = prompt('Enter amount in ml:');
        if (!amount || isNaN(amount) || amount <= 0) return;
        await logWater(parseInt(amount));
      } else {
        await logWater(parseInt(ml));
      }
      load();
    });

    // New meal
    document.getElementById('new-meal-btn').addEventListener('click', async () => {
      try {
        await api.post('/api/meals/sessions', { date: today });
        load();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  function renderSession(container, session) {
    const sessionEl = document.createElement('div');
    sessionEl.className = 'meal-session';

    const sessionKcal = session.entries.reduce((s, e) => s + (e.calories || 0), 0);
    const timeStr = formatTime(session.logged_at);

    sessionEl.innerHTML = `
      <div class="meal-session-header">
        <div>
          <div class="meal-session-title">${session.name}</div>
          ${timeStr ? `<div class="meal-session-kcal">${timeStr}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="meal-session-kcal num">${fmt(sessionKcal)} kcal</span>
          <button class="session-del-btn" data-id="${session.id}" style="color:var(--text-faint);padding:4px">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    session.entries.forEach(entry => {
      const entryEl = document.createElement('div');
      entryEl.className = 'meal-entry';
      entryEl.innerHTML = `
        <div class="meal-entry-info">
          <div class="meal-entry-name">${entry.food_name}${entry.food_brand ? ` <span style="color:var(--text-muted);font-size:12px">${entry.food_brand}</span>` : ''}</div>
          <div class="meal-entry-sub">${fmt(entry.quantity_g)}g &nbsp;
            <span style="color:var(--protein);font-variant-numeric:tabular-nums">${fmt(entry.protein,1)}P</span> ·
            <span style="color:var(--carbs);font-variant-numeric:tabular-nums">${fmt(entry.carbs,1)}C</span> ·
            <span style="color:var(--fat);font-variant-numeric:tabular-nums">${fmt(entry.fat,1)}F</span>
          </div>
        </div>
        <div class="meal-entry-kcal">${fmt(entry.calories)}</div>
        <button class="entry-del-btn" data-id="${entry.id}" style="
          width:32px;height:32px;border-radius:50%;
          background:rgba(255,107,107,.1);color:var(--error);
          display:flex;align-items:center;justify-content:center;
          flex-shrink:0;font-size:16px;transition:background .15s">×</button>
      `;
      entryEl.querySelector('.entry-del-btn').addEventListener('click', async () => {
        try {
          await api.delete(`/api/meals/entries/${entry.id}`);
          entryEl.style.opacity = '0';
          entryEl.style.transition = 'opacity .2s';
          setTimeout(() => load(), 200);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      sessionEl.appendChild(entryEl);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'meal-session-add';
    addBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      Add to ${session.name}
    `;
    addBtn.addEventListener('click', () => {
      openFoodEntry(session.id, () => load());
    });
    sessionEl.appendChild(addBtn);
    container.appendChild(sessionEl);

    // Delete session
    sessionEl.querySelector('.session-del-btn').addEventListener('click', async () => {
      if (!confirm(`Delete ${session.name} and all its entries?`)) return;
      try {
        await api.delete(`/api/meals/sessions/${session.id}`);
        showToast('Meal deleted', 'success');
        load();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  async function logWater(ml) {
    try {
      await api.post('/api/water', { amount_ml: ml });
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  const onSettingsChanged = () => load();
  window.addEventListener('plated:settings-changed', onSettingsChanged);

  load();

  return () => {
    clearTimeout(refreshTimer);
    window.removeEventListener('plated:settings-changed', onSettingsChanged);
  };
}

function phaseBadge(phase) {
  const map = { cut: ['🔻', '#ff6b6b'], maintain: ['⚖️', '#5dca8a'], bulk: ['📈', '#c8b8ff'] };
  const [icon, color] = map[phase] || map.maintain;
  return `<span style="font-size:11px;font-weight:700;color:${color};background:${color}18;padding:3px 10px;border-radius:999px;border:1px solid ${color}44">${icon} ${(phase||'maintain').toUpperCase()}</span>`;
}

function phaseProgressCard(settings, totals, burned) {
  const tdee = parseFloat(settings.tdee);
  if (!tdee) return '';

  const phase    = settings.phase || 'maintain';
  const deficit  = parseInt(settings.cut_deficit)  || 500;
  const surplus  = parseInt(settings.bulk_surplus) || 300;
  const consumed = totals.calories || 0;
  const net      = consumed - burned;

  const target = phase === 'cut'  ? tdee - deficit
               : phase === 'bulk' ? tdee + surplus
               : tdee;

  const diff    = net - target;
  const onTrack = Math.abs(diff) <= 150;
  const over    = diff > 150;
  const diffLabel = over
    ? `+${fmt(Math.abs(diff))} over target`
    : diff < -150
    ? `${fmt(Math.abs(diff))} under target`
    : 'On track ✓';
  const diffColor = onTrack ? 'var(--success)' : over ? 'var(--warning)' : 'var(--fat)';

  const pct = Math.min((net / target) * 100, 110);

  return `
    <div style="padding:0 16px 4px">
      <div class="card" style="border-color:${onTrack ? 'var(--success)' : 'var(--border)'}44">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span class="label">${phase.toUpperCase()} TARGET</span>
          <span class="num" style="font-size:13px;color:${diffColor}">${diffLabel}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:6px">
          <span>Net <strong class="num" style="color:var(--text)">${fmtE(net)} ${unitLabel()}</strong></span>
          <span>Target <strong class="num" style="color:var(--text)">${fmtE(target)} ${unitLabel()}</strong></span>
        </div>
        <div style="height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${diffColor};border-radius:999px;transition:width .6s ease-out;max-width:100%"></div>
        </div>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px">TDEE ${fmtE(tdee)} · Burned ${fmtE(burned)} · Consumed ${fmtE(consumed)} ${unitLabel()}</div>
      </div>
    </div>
  `;
}

function buildSkeleton() {
  return `
    <div style="padding:20px 16px 8px">
      <div class="skeleton skel-line" style="width:160px;height:24px"></div>
    </div>
    <div style="padding:0 16px 8px">
      <div class="card">
        <div class="skeleton" style="width:140px;height:140px;border-radius:50%;margin:0 auto 16px"></div>
        <div class="skeleton skel-line"></div>
        <div class="skeleton skel-line" style="width:70%;margin-top:6px"></div>
      </div>
    </div>
    <div style="padding:0 16px 8px">
      <div class="card">
        <div class="skeleton skel-line" style="width:80px;margin-bottom:10px"></div>
        <div class="skeleton skel-line"></div>
      </div>
    </div>
  `;
}
