import { api }                      from '../api.js';
import { showToast, showSheet }      from '../app.js';
import { openFoodEntry }             from './log.js';
import { renderMacroBar }            from '../components/macroBar.js';

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

// ─── Swipe-to-delete on a meal entry element ────────────────
function enableSwipe(el, onDelete) {
  let startX = 0, dx = 0;
  const THRESHOLD = 64;

  el.addEventListener('touchstart', e => { startX = e.touches[0].clientX; dx = 0; }, { passive: true });
  el.addEventListener('touchmove', e => {
    dx = e.touches[0].clientX - startX;
    if (dx < 0) el.style.transform = `translateX(${Math.max(dx, -THRESHOLD)}px)`;
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (dx < -THRESHOLD * 0.7) {
      el.classList.add('swiped');
    } else {
      el.style.transform = '';
      el.classList.remove('swiped');
    }
    dx = 0;
  });
}

// ─── IronLog fetch (non-fatal) ─────────────────────────────
async function fetchIronLog(settings) {
  const url = settings.ironlog_api_url?.trim();
  if (!url) return null;
  const today = new Date().toISOString().split('T')[0];
  try {
    const [profile, cals] = await Promise.all([
      fetch(`${url}/api/plated/profile`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      fetch(`${url}/api/plated/workouts/calories?date=${today}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
    ]);
    return { profile, calories_burned: cals.calories_burned ?? cals.total ?? 0 };
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
        ${ironlog ? '<div class="ironlog-chip">⚡ IronLog</div>' : ''}
      </div>

      <!-- Calorie ring + macro bar -->
      <div style="padding:0 16px 4px">
        <div class="card">
          <div class="summary-row">
            <div class="ring-wrap-relative">
              <svg class="calorie-ring" viewBox="0 0 140 140">
                <circle class="ring-bg"   cx="70" cy="70" r="60"/>
                <circle class="ring-fill ${t.calories > goals.cal ? 'over' : ''}" cx="70" cy="70" r="60"
                  stroke-dasharray="${(calPct/100)*CIRC} ${CIRC}" id="cal-ring-fill"/>
              </svg>
              <div class="ring-center" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">
                <div class="num ring-kcal">${fmt(t.calories)}</div>
                <div class="ring-goal muted">/ ${fmt(goals.cal)} kcal</div>
              </div>
            </div>
          </div>

          <!-- Macro bar -->
          <div class="macros-section" style="margin-top:4px">
            <div id="macro-bar-root"></div>
            <div class="macro-totals-row">
              <div class="macro-total">
                <div class="macro-total-val num" style="color:var(--protein)">${fmt(t.protein,1)}g</div>
                <div class="macro-total-lbl label">Protein</div>
              </div>
              <div class="macro-total">
                <div class="macro-total-val num" style="color:var(--carbs)">${fmt(t.carbs,1)}g</div>
                <div class="macro-total-lbl label">Carbs</div>
              </div>
              <div class="macro-total">
                <div class="macro-total-val num" style="color:var(--fat)">${fmt(t.fat,1)}g</div>
                <div class="macro-total-lbl label">Fat</div>
              </div>
              <div class="macro-total">
                <div class="macro-total-val num" style="color:var(--fiber)">${fmt(t.fiber,1)}g</div>
                <div class="macro-total-lbl label">Fiber</div>
              </div>
            </div>
          </div>
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

      <!-- IronLog panel -->
      ${ironlog ? `
      <div style="padding:0 16px 4px">
        <div class="card ironlog-panel">
          <div class="label" style="margin-bottom:10px">⚡ IronLog — Today</div>
          <div class="ironlog-row">
            <span class="muted">Calories burned</span>
            <span class="num">${fmt(burned)} kcal</span>
          </div>
          <div class="ironlog-row">
            <span class="muted">Net calories</span>
            <span class="num" style="color:${net < 0 ? 'var(--success)' : 'var(--text)'}">${fmt(net)} kcal</span>
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
          <div class="meal-entry-sub">${fmt(entry.quantity_g)}g
            <span class="meal-entry-dots">
              <span class="macro-mini-dot" style="background:var(--protein)"></span>
              <span class="macro-mini-dot" style="background:var(--carbs)"></span>
              <span class="macro-mini-dot" style="background:var(--fat)"></span>
            </span>
          </div>
        </div>
        <div class="meal-entry-kcal">${fmt(entry.calories)}</div>
        <div class="meal-entry-delete-reveal" data-entry-id="${entry.id}">Delete</div>
      `;
      enableSwipe(entryEl, async () => {
        try {
          await api.delete(`/api/meals/entries/${entry.id}`);
          showToast('Entry removed', 'success');
          load();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      entryEl.querySelector('.meal-entry-delete-reveal').addEventListener('click', async () => {
        try {
          await api.delete(`/api/meals/entries/${entry.id}`);
          showToast('Entry removed', 'success');
          load();
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

  load();

  return () => { clearTimeout(refreshTimer); };
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
