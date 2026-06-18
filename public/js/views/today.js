import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { openFoodEntry, openEditEntry }    from './log.js';
import { renderMacroBar }                  from '../components/macroBar.js';
import { fmtE, unitLabel, wireEnergyUnitToggle } from '../utils/energy.js';
import { getFoodIcon }                     from '../utils/foodIcon.js';
import { localDate }                       from '../utils/date.js';
import { classifyDay, isFlagged, LOG_STRONG } from '../utils/logCheck.js';
import { assert } from '../utils/bugReport.js';

const CIRC = 2 * Math.PI * 60;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function fmt(n, dec = 0) { return n == null ? '–' : Number(n).toFixed(dec); }

// Build one calorie ring SVG. variant: '' (goal, accent) | 'workout' | 'target'.
// overflowPct (0-100): the exceeded portion, drawn on top in the darker --over
// colour so only the slice past the goal is dark, not the whole ring.
function calRingSvg(pct, variant = '', small = false, overflowPct = 0) {
  const base = (Math.min(pct, 100) / 100) * CIRC;
  const over = (Math.min(Math.max(overflowPct, 0), 100) / 100) * CIRC;
  return `
    <svg class="calorie-ring${small ? ' ring-sm' : ''}" viewBox="0 0 140 140">
      <circle class="ring-bg" cx="70" cy="70" r="60"/>
      <circle class="ring-fill ${variant}" cx="70" cy="70" r="60"
        style="stroke-dasharray:${base} ${CIRC}"/>
      ${over > 0 ? `<circle class="ring-fill ${variant} ring-over" cx="70" cy="70" r="60"
        style="stroke-dasharray:${over} ${CIRC}"/>` : ''}
    </svg>`;
}

function fmtDateNav(iso) {
  const today = localDate();
  if (iso === today) return 'Today';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function timeAgo(iso) {
  if (!iso) return null;
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}

async function fetchIronLog(dateStr) {
  try {
    const data = await api.get(`/api/ironlog/today?date=${dateStr}&tz=${new Date().getTimezoneOffset()}`);
    if (data.connected) return data;
    return data.last_synced ? { ...data, _stale: true } : null;
  } catch { return null; }
}

// ── Meal name presets ────────────────────────────────────────
const MEAL_PRESETS = [
  { emoji: '🌅', name: 'Breakfast'    },
  { emoji: '☕', name: 'Brunch'       },
  { emoji: '🌞', name: 'Lunch'        },
  { emoji: '🌙', name: 'Dinner'       },
  { emoji: '🍎', name: 'Snack'        },
  { emoji: '💪', name: 'Pre-Workout'  },
  { emoji: '🥤', name: 'Post-Workout' },
  { emoji: '🍽', name: 'Meal Out'     },
];

function openRenameSession(sessionId, currentName, onSuccess) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Name this meal</span>
        <button class="sheet-close" id="rn-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
          ${MEAL_PRESETS.map(p => `
            <button class="btn btn-secondary rn-preset" data-name="${p.name}"
              style="height:46px;font-size:14px;justify-content:flex-start;gap:10px;${currentName===p.name?'border-color:var(--accent);color:var(--accent)':''}">
              ${p.emoji} ${p.name}
            </button>
          `).join('')}
        </div>
        <div class="form-group">
          <label class="form-label">Custom name</label>
          <input class="input" id="rn-input" placeholder="e.g. Late Night Snack" />
        </div>
        <button class="btn btn-primary btn-full" id="rn-save">Save</button>
      </div>
    `;
    document.getElementById('rn-input').value = currentName;
    document.getElementById('rn-close').addEventListener('click', hideSheet);

    async function doRename(name) {
      try {
        await api.patch(`/api/meals/sessions/${sessionId}`, { name });
        hideSheet();
        onSuccess?.();
      } catch (err) { showToast(err.message, 'error'); }
    }

    content.querySelectorAll('.rn-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('rn-input').value = btn.dataset.name;
        doRename(btn.dataset.name);
      });
    });
    document.getElementById('rn-save').addEventListener('click', () => {
      const name = document.getElementById('rn-input').value.trim();
      if (name) doRename(name);
    });
  });
}

// ── Log weight ───────────────────────────────────────────────
function openLogWeight(date, existing, onSuccess) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">⚖️ Log Bodyweight</span>
        <button class="sheet-close" id="wt-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div class="form-group">
          <label class="form-label">Weight (kg)</label>
          <input class="input" id="wt-input" type="text" step="0.1" placeholder="e.g. 75.5"
            value="${existing?.weight_kg || ''}" inputmode="decimal"
            style="height:52px;font-size:22px;text-align:center;font-weight:700" />
        </div>
        <button class="btn btn-primary btn-full" id="wt-save" style="height:48px">Save</button>
      </div>
    `;
    document.getElementById('wt-close').addEventListener('click', hideSheet);
    setTimeout(() => document.getElementById('wt-input')?.focus(), 200);

    document.getElementById('wt-save').addEventListener('click', async () => {
      const weight_kg = parseFloat(document.getElementById('wt-input').value);
      if (!weight_kg || weight_kg <= 0) { showToast('Enter a valid weight', 'error'); return; }
      const btn = document.getElementById('wt-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await api.post('/api/weight', { weight_kg, date });
        hideSheet();
        showToast('Weight logged', 'success');
        onSuccess?.();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
  });
}

// ── Meal templates ───────────────────────────────────────────
async function openFromTemplate(date, onSuccess) {
  showSheet(async content => {
    content.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted)">Loading templates…</div>`;

    let templates;
    try {
      templates = await api.get('/api/templates');
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
      return;
    }

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">📋 Meal Templates</span>
        <button class="sheet-close" id="tmpl-close">✕</button>
      </div>
      ${templates.length === 0
        ? `<div class="empty-state">
            <div class="empty-icon" style="font-size:32px">📋</div>
            <div class="empty-text">No templates yet<br/>
              <span style="font-size:12px;color:var(--text-faint)">Save a meal as a template to reuse it</span>
            </div>
           </div>`
        : templates.map(t => `
          <div class="food-list-item" data-tmpl-id="${t.id}">
            <div style="font-size:22px;width:36px;text-align:center;flex-shrink:0">📋</div>
            <div class="food-list-info" style="flex:1">
              <div class="food-list-name">${esc(t.name)}</div>
              <div style="font-size:12px;color:var(--text-muted)">${t.item_count} item${t.item_count !== 1 ? 's' : ''}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button class="tmpl-apply btn btn-secondary" data-tmpl-id="${t.id}" data-tmpl-name="${esc(t.name)}"
                style="height:34px;padding:0 14px;font-size:12px;font-weight:700">Use</button>
              <button class="tmpl-del" data-tmpl-id="${t.id}"
                style="width:34px;height:34px;border-radius:50%;background:rgba(255,107,107,.1);color:var(--error);font-size:18px">×</button>
            </div>
          </div>`).join('')
      }
    `;

    document.getElementById('tmpl-close').addEventListener('click', hideSheet);

    content.querySelectorAll('.tmpl-apply').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Loading…';
        try {
          const items = await api.get(`/api/templates/${btn.dataset.tmplId}/items`);
          const session = await api.post('/api/meals/sessions', { date, name: btn.dataset.tmplName });
          await Promise.all(items.map(item =>
            api.post(`/api/meals/sessions/${session.id}/entries`, {
              food_id: item.food_id, quantity_g: item.quantity_g,
            })
          ));
          hideSheet();
          showToast(`"${btn.dataset.tmplName}" applied`, 'success');
          onSuccess?.();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false; btn.textContent = 'Use';
        }
      });
    });

    content.querySelectorAll('.tmpl-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this template?')) return;
        try {
          await api.delete(`/api/templates/${btn.dataset.tmplId}`);
          btn.closest('.food-list-item').remove();
          showToast('Template deleted', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  });
}

function openSaveAsTemplate(session) {
  if (session.entries.length === 0) {
    showToast('Add foods to this meal before saving as a template', 'error');
    return;
  }
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">🔖 Save as Template</span>
        <button class="sheet-close" id="st-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;line-height:1.5">
          Save <strong>${esc(session.name)}</strong> (${session.entries.length} foods) as a reusable template.
        </div>
        <div class="form-group">
          <label class="form-label">Template name</label>
          <input class="input" id="st-name" placeholder="e.g. My Breakfast" />
        </div>
        <button class="btn btn-primary btn-full" id="st-save">Save Template</button>
      </div>
    `;
    document.getElementById('st-name').value = session.name;
    document.getElementById('st-close').addEventListener('click', hideSheet);
    setTimeout(() => document.getElementById('st-name')?.focus(), 200);

    document.getElementById('st-save').addEventListener('click', async () => {
      const name = document.getElementById('st-name').value.trim();
      if (!name) { showToast('Enter a template name', 'error'); return; }
      const btn = document.getElementById('st-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await api.post('/api/templates', {
          name,
          items: session.entries.map(e => ({ food_id: e.food_id, food_name: e.food_name, quantity_g: e.quantity_g })),
        });
        hideSheet();
        showToast(`Template "${name}" saved`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Save Template';
      }
    });
  });
}

// ── Copy past meal ───────────────────────────────────────────
async function openCopyPastMeal(targetSessionId, onSuccess) {
  showSheet(async content => {
    content.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted)">Loading past meals…</div>`;

    const days = Array.from({ length: 7 }, (_, i) => addDays(localDate(), -(i + 1)));
    const dayResults = await Promise.all(days.map(d => api.get(`/api/meals/day/${d}`).catch(() => null)));

    const sessions = [];
    dayResults.forEach((data, i) => {
      (data?.sessions || []).forEach(s => {
        if (s.entries.length > 0) sessions.push({ ...s, date: days[i] });
      });
    });

    const ul = unitLabel();
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">♻️ Copy past meal</span>
        <button class="sheet-close" id="cp-close">✕</button>
      </div>
      ${sessions.length === 0
        ? '<div class="empty-state"><div class="empty-text">No past meals to copy from</div></div>'
        : sessions.map((s, idx) => {
            const kcal = s.entries.reduce((sum, e) => sum + (e.calories || 0), 0);
            return `
              <button class="food-list-item cp-session" data-idx="${idx}"
                style="width:100%;text-align:left">
                <div style="font-size:20px;width:36px;text-align:center">🍽</div>
                <div class="food-list-info">
                  <div class="food-list-name">${esc(s.name)}</div>
                  <div style="font-size:12px;color:var(--text-muted)">${s.date} · ${s.entries.length} items · ${fmtE(kcal)} ${ul}</div>
                </div>
              </button>`;
          }).join('')
      }
    `;

    document.getElementById('cp-close').addEventListener('click', hideSheet);

    content.querySelectorAll('.cp-session').forEach(btn => {
      btn.addEventListener('click', async () => {
        const s = sessions[parseInt(btn.dataset.idx)];
        btn.style.opacity = '0.5';
        try {
          await Promise.all(s.entries.map(e =>
            api.post(`/api/meals/sessions/${targetSessionId}/entries`, {
              food_id: e.food_id, quantity_g: e.quantity_g,
            })
          ));
          hideSheet();
          showToast(`Copied ${s.entries.length} foods from ${s.name}`, 'success');
          onSuccess?.();
        } catch (err) {
          showToast(err.message, 'error');
          btn.style.opacity = '1';
        }
      });
    });
  });
}

// ── Quick Log ────────────────────────────────────────────────
function openQuickLog(sessionId, onSuccess) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">⚡ Quick Log</span>
        <button class="sheet-close" id="ql-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;line-height:1.5">
          For meals out — enter rough calories from Google. Won't be saved to your food database.
        </div>
        <div class="form-group">
          <label class="form-label">Meal description *</label>
          <input class="input" id="ql-name" placeholder="e.g. Burger from Burgerfuel" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">Calories *</label>
          <div style="display:flex;gap:6px">
            <input class="input" id="ql-cal" type="text" placeholder="e.g. 650" inputmode="decimal" style="flex:1;min-width:0" />
            <div style="display:flex;gap:4px;flex-shrink:0" id="ql-cal-unit">
              <button type="button" class="eunit-btn active" data-unit="kcal">kcal</button>
              <button type="button" class="eunit-btn" data-unit="kj">kJ</button>
            </div>
          </div>
        </div>
        <div class="label" style="margin-bottom:10px">Macros — optional</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px">
          ${['pro','carb','fat'].map((id, i) => {
            const [label, color] = [['Protein','var(--protein)'],['Carbs','var(--carbs)'],['Fat','var(--fat)']][i];
            return `<div style="position:relative">
              <input class="input" id="ql-${id}" type="text" placeholder="${label}" inputmode="decimal"
                style="height:42px;padding-right:20px;border-color:${color}44"/>
              <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;font-weight:700;color:${color}">${label[0]}</span>
            </div>`;
          }).join('')}
        </div>
        <button class="btn btn-primary btn-full" id="ql-submit">Log Meal</button>
      </div>
    `;
    document.getElementById('ql-close').addEventListener('click', hideSheet);
    setTimeout(() => document.getElementById('ql-name')?.focus(), 200);

    const getCalKcal = wireEnergyUnitToggle(
      document.getElementById('ql-cal-unit'),
      document.getElementById('ql-cal')
    );

    document.getElementById('ql-submit').addEventListener('click', async () => {
      const name    = document.getElementById('ql-name').value.trim();
      const calKcal = getCalKcal();
      if (!name)   { showToast('Enter a meal description', 'error'); return; }
      if (!calKcal) { showToast('Enter the calories', 'error'); return; }
      const pro  = parseFloat(document.getElementById('ql-pro').value)  || null;
      const carb = parseFloat(document.getElementById('ql-carb').value) || null;
      const fat  = parseFloat(document.getElementById('ql-fat').value)  || null;
      const btn = document.getElementById('ql-submit');
      btn.disabled = true; btn.textContent = 'Logging…';
      try {
        const food = await api.post('/api/foods', {
          name, calories_per_100g: calKcal,
          protein_per_100g: pro, carbs_per_100g: carb, fat_per_100g: fat,
          serving_size_g: 100, source: 'quick',
        });
        await api.post(`/api/meals/sessions/${sessionId}/entries`, { food_id: food.id, quantity_g: 100 });
        hideSheet();
        showToast('Meal logged', 'success');
        onSuccess?.();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Log Meal';
      }
    });
  });
}

// ── Main render ──────────────────────────────────────────────
export function renderToday(container) {
  let viewDate      = localDate();
  let userNavigated = false;   // true only when user manually tapped ← › or swiped
  let ironlogExpanded = false;
  let loadGen = 0;             // increments on each load; stale responses discarded

  // Swipe navigation
  let swipeStartX = 0, swipeStartY = 0;
  container.addEventListener('touchstart', e => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }, { passive: true });
  container.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - swipeStartY);
    // High threshold (90px) + strict horizontal (dy<20) to avoid accidental
    // nav while scrolling the long Today list
    if (Math.abs(dx) > 90 && dy < 20) {
      const next = addDays(viewDate, dx < 0 ? -1 : 1);
      if (next <= localDate()) { userNavigated = true; viewDate = next; load(); }
    }
  }, { passive: true });

  async function load() {
    if (!userNavigated) viewDate = localDate();
    const myGen = ++loadGen;
    try {
      const [mealData, waterData, settings, todayWeight] = await Promise.all([
        api.get(`/api/meals/day/${viewDate}`),
        api.get(`/api/water/day/${viewDate}`),
        api.get('/api/settings'),
        api.get(`/api/weight/day/${viewDate}`).catch(() => null),
      ]);
      if (myGen !== loadGen) return;            // a newer load() superseded us
      // Only pull IronLog for the actual current day, using the local date.
      const ironlog = (viewDate === localDate()) ? await fetchIronLog(viewDate) : null;
      if (myGen !== loadGen) return;            // and again after the IronLog fetch
      render(mealData, waterData, settings, ironlog, todayWeight);
    } catch (err) {
      if (myGen !== loadGen) return;
      container.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function render(mealData, waterData, settings, ironlog, todayWeight) {
    const today  = localDate();
    const isToday = viewDate === today;
    const ul     = unitLabel();
    const goals  = {
      cal:    parseFloat(settings.calorie_goal)  || 2000,
      protein:parseFloat(settings.protein_goal)  || 150,
      carbs:  parseFloat(settings.carb_goal)      || 250,
      fat:    parseFloat(settings.fat_goal)        || 65,
      fiber:  parseFloat(settings.fiber_goal)      || 30,
      water:  parseFloat(settings.water_goal_ml)  || 2500,
    };
    const t         = mealData.totals;
    const waterGoal = waterData.goal_ml || goals.water;
    const waterPct  = Math.min((waterData.total_ml / waterGoal) * 100, 100);

    // ── "Did you fully log this day?" check (past days only) ──
    const mealCount = (mealData.sessions || []).filter(s => (s.entries?.length || 0) > 0).length;
    const dayStatus = classifyDay(
      { date: viewDate, calories: t.calories, meal_count: mealCount, log_status: mealData.log_status },
      goals.cal, today
    );
    const showLogCheck = isFlagged(dayStatus);   // never true for today/future

    // Foods logged without calorie data add 0 kcal — they make the total look
    // low even though you logged them. Estimate the missing kcal from macros.
    const noCalNames = [];
    let missingKcalEst = 0;
    for (const sess of (mealData.sessions || [])) {
      for (const e of (sess.entries || [])) {
        const macros = (e.protein || 0) + (e.carbs || 0) + (e.fat || 0);
        if ((e.calories || 0) === 0 && macros > 0) {
          noCalNames.push(e.food_name);
          missingKcalEst += Math.round(4 * (e.protein || 0) + 4 * (e.carbs || 0) + 9 * (e.fat || 0));
        }
      }
    }
    const showNoCal = noCalNames.length > 0;

    // ── Calorie rings ────────────────────────────────────────
    // Middle = base goal; right = workout earned; left = goal + workout.
    // Eaten fills the base goal first, then spills into the workout ring.
    const burned      = ironlog?.calories_burned ?? 0;
    const baseGoal    = goals.cal;                  // phase calorie goal (e.g. 2207)
    const combined    = baseGoal + burned;          // eat target incl. workout
    const hasWorkout  = burned > 0;
    const eaten       = t.calories;
    const net         = eaten - burned;

    // Sanity invariants — surface "impossible state" data bugs (NaN totals,
    // bad IronLog values) that wouldn't otherwise throw.
    assert(Number.isFinite(eaten) && eaten >= 0, "today's calorie total isn't a valid number", { eaten });
    assert(Number.isFinite(burned) && burned >= 0, 'IronLog burned is not a valid number', { burned });

    const midPct   = Math.min(eaten / baseGoal, 1) * 100;            // middle: eaten vs goal
    const rightFill= Math.max(0, Math.min(eaten - baseGoal, burned)); // overflow into workout
    const rightPct = burned > 0 ? (rightFill / burned) * 100 : 0;     // right: overflow vs burned
    const leftPct  = Math.min(eaten / combined, 1) * 100;            // left: eaten vs combined
    // Exceeded slices — only this portion of the ring is drawn dark.
    const midOver  = baseGoal > 0 ? Math.max(0, (eaten - baseGoal) / baseGoal) * 100 : 0;
    const leftOver = combined > 0 ? Math.max(0, (eaten - combined) / combined) * 100 : 0;

    // Hint speaks to the real budget (combined when a workout exists)
    const budget    = hasWorkout ? combined : baseGoal;
    const remaining = budget - eaten;
    const hintText  = eaten === 0 ? 'nothing yet'
      : remaining > 50  ? `${fmtE(remaining)} left`
      : remaining < -50 ? `+${fmtE(-remaining)} over`
      : '✓ goal hit';
    const hintColor = remaining < -50 ? 'var(--over)' : remaining < 50 ? 'var(--success)' : 'var(--text-faint)';

    // Water chips (collapse > 3)
    const entries = waterData.entries;
    const showChips = entries.length > 0;
    const visibleChips = entries.slice(-3);
    const hiddenCount = Math.max(0, entries.length - 3);

    // IronLog/phase summary for collapsed row
    const tdee  = parseFloat(settings.tdee);
    const phase = settings.phase || 'maintain';
    const deficit = parseInt(settings.cut_deficit) || 500;
    const surplus = parseInt(settings.bulk_surplus) || 300;
    const target  = phase === 'cut' ? tdee - deficit : phase === 'bulk' ? tdee + surplus : tdee;
    const diff    = net - target;
    const onTrack = tdee && Math.abs(diff) <= 150;
    const phaseLabel = tdee
      ? (onTrack ? 'On track ✓' : diff > 150 ? `+${fmtE(diff)} ${ul} over` : `${fmtE(-diff)} ${ul} under`)
      : phase;

    const showMorningPrompt = false; // removed per user preference

    container.innerHTML = `
      <!-- Date navigation -->
      <div class="today-header" style="padding-bottom:4px">
        <div style="display:flex;align-items:center;gap:12px">
          <button id="nav-prev" style="width:32px;height:32px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:18px">‹</button>
          <div style="text-align:center">
            <div class="today-date" style="font-size:18px">${fmtDateNav(viewDate)}</div>
          </div>
          <button id="nav-next" style="width:32px;height:32px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:${isToday ? 'var(--text-faint)' : 'var(--text-muted)'};font-size:18px" ${isToday ? 'disabled' : ''}>›</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${phaseBadge(settings.phase)}
        </div>
      </div>

      <!-- Past-day warning banner -->
      ${!isToday ? `
      <div style="padding:0 16px 4px">
        <div style="background:var(--accent-dim);border:1px solid rgba(200,184,255,.25);border-radius:var(--radius-sm);padding:9px 14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:var(--accent)">📅 Viewing a past day — not today</span>
          <button id="go-today-btn" style="font-size:12px;font-weight:700;color:var(--accent)">Today →</button>
        </div>
      </div>` : ''}

      <!-- "Did you forget to log?" check -->
      ${showLogCheck ? `
      <div style="padding:0 16px 4px">
        <div class="logcheck-banner">
          <div class="logcheck-text">
            <div class="logcheck-title">${dayStatus === LOG_STRONG ? '⚠️ This day looks under-logged' : '🤔 Did you log everything?'}</div>
            <div class="logcheck-sub">Only ${mealCount} meal${mealCount === 1 ? '' : 's'} · ${fmtE(t.calories)} ${ul} — that's low for your goal. Forgot something, or just a light day?</div>
          </div>
          <div class="logcheck-actions">
            <button class="btn btn-secondary logcheck-add">Add a meal</button>
            <button class="btn btn-ghost logcheck-light">I ate light</button>
          </div>
        </div>
      </div>` : ''}

      <!-- Calorie ring(s) -->
      <div style="padding:0 16px 4px">
        <div class="card">
          <div class="tri-rings">
            <div class="ring-col">
              <div class="ring-title">Eat Target</div>
              <div class="ring-wrap-relative">
                ${calRingSvg(leftPct, 'target', true, leftOver)}
                <div class="ring-center">
                  <div class="num ring-kcal-sm">${fmtE(eaten)}</div>
                  <div class="ring-goal-sm">/ ${fmtE(combined)}</div>
                </div>
              </div>
            </div>
            <div class="ring-col">
              <div class="ring-title">Daily Goal</div>
              <div class="ring-wrap-relative">
                ${calRingSvg(midPct, '', false, midOver)}
                <div class="ring-center">
                  <div class="num ring-kcal">${fmtE(eaten)}</div>
                  <div class="ring-goal muted">/ ${fmtE(baseGoal)} ${ul}</div>
                  <div style="font-size:11px;margin-top:2px;color:${hintColor};font-weight:600">${hintText}</div>
                </div>
              </div>
            </div>
            <div class="ring-col">
              <div class="ring-title">Workout</div>
              <div class="ring-wrap-relative">
                ${calRingSvg(rightPct, 'workout', true, 0)}
                <div class="ring-center">
                  <div class="num ring-kcal-sm">${fmtE(burned)}🔥</div>
                  <div class="ring-goal-sm">${hasWorkout ? 'burned' : 'rest day'}</div>
                </div>
              </div>
            </div>
          </div>
          <div id="macro-bar-root" style="margin-top:12px"></div>
        </div>
      </div>

      <!-- Foods logged without calorie data -->
      ${showNoCal ? `
      <div style="padding:0 16px 4px">
        <div class="logcheck-banner">
          <div class="logcheck-text">
            <div class="logcheck-title">⚠️ ${noCalNames.length} food${noCalNames.length === 1 ? '' : 's'} logged without calories</div>
            <div class="logcheck-sub">${noCalNames.slice(0, 3).map(esc).join(', ')}${noCalNames.length > 3 ? ` +${noCalNames.length - 3} more` : ''} — about ${fmtE(missingKcalEst)} ${ul} aren't counted in your total. Add calories to ${noCalNames.length === 1 ? 'it' : 'them'} in the Foods tab (search → Edit).</div>
          </div>
        </div>
      </div>` : ''}

      <!-- Water -->
      <div style="padding:0 16px 4px">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span class="label">💧 Water</span>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="num" style="font-size:13px">${waterData.total_ml}
                <span style="font-size:11px;color:var(--text-muted)">/ ${waterGoal} ml</span>
              </span>
              <button id="water-goal-edit" style="font-size:11px;color:var(--text-faint);padding:2px 8px;background:var(--surface-2);border:1px solid var(--border);border-radius:999px">⚙️</button>
            </div>
          </div>
          <div class="water-bar-outer" style="margin-bottom:10px">
            <div class="water-bar-fill" style="width:${waterPct}%"></div>
          </div>
          <div class="water-btns" id="water-btns">
            <button class="water-btn" data-ml="150">+150</button>
            <button class="water-btn" data-ml="250">+250</button>
            <button class="water-btn" data-ml="330">+330</button>
            <button class="water-btn" data-ml="500">+500</button>
            <button class="water-btn" data-ml="custom">Custom</button>
          </div>
          ${showChips ? `
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px" id="water-chips">
            ${visibleChips.map(e => waterChip(e)).join('')}
            ${hiddenCount > 0 ? `<button id="water-show-all" style="background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--text-muted)">+${hiddenCount} more</button>` : ''}
          </div>` : ''}
        </div>
      </div>

      <!-- Bodyweight -->
      <div style="padding:0 16px 4px">
        <div class="card" style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="label">⚖️ Bodyweight</div>
            ${todayWeight
              ? `<div class="num" style="font-size:20px;margin-top:2px">${todayWeight.weight_kg} <span style="font-size:12px;color:var(--text-muted)">kg</span></div>`
              : ironlog?.bodyweight
              ? `<div class="num" style="font-size:20px;margin-top:2px">${ironlog.bodyweight.weight_kg} <span style="font-size:12px;color:var(--text-muted)">kg</span></div>
                 <div style="font-size:11px;color:var(--accent);margin-top:2px">⚡ via IronLog${ironlog.bodyweight.is_today ? ' · today' : ' · ' + ironlog.bodyweight.date}</div>`
              : `<div style="font-size:12px;color:var(--text-faint);margin-top:3px">Not logged today</div>`
            }
          </div>
          <button id="log-weight-btn" class="btn btn-secondary" style="height:36px;padding:0 16px;font-size:13px">
            ${todayWeight ? 'Update' : 'Log weight'}
          </button>
        </div>
      </div>

      <!-- IronLog + Phase (collapsible) -->
      ${(ironlog || tdee) ? `
      <div style="padding:0 16px 4px">
        <button id="ironlog-toggle" class="card" style="width:100%;display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px">
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
            ${ironlog ? '<span style="font-size:12px;color:var(--accent)">⚡</span>' : '<span style="font-size:12px">📊</span>'}
            <span style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${burned > 0 ? `Burned ${fmtE(burned)} ${ul} · ` : ''}${phaseLabel}
            </span>
          </div>
          <span class="il-chevron" style="color:var(--text-faint);font-size:13px;flex-shrink:0">${ironlogExpanded ? '▲' : '▼'}</span>
        </button>
        <div id="ironlog-details" style="display:${ironlogExpanded ? 'block' : 'none'}">
          ${phaseProgressCard(settings, t, burned)}
          ${ironlog ? `
          <div class="card ironlog-panel" style="margin-top:4px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <span class="label">⚡ IronLog</span>
              ${ironlog.last_synced ? `<span style="font-size:11px;color:var(--text-faint)">${ironlog._stale ? '⚠ cached · ' : ''}${timeAgo(ironlog.last_synced)}</span>` : ''}
            </div>
            <div class="ironlog-row">
              <span class="muted">Burned</span>
              <span class="num">${fmtE(burned)} ${ul}</span>
            </div>
            <div class="ironlog-row">
              <span class="muted">Net</span>
              <span class="num">${fmtE(net)} ${ul}</span>
            </div>
            ${(burned === 0 && ironlog.debug) ? `
            <div style="margin-top:8px;font-size:10px;color:var(--text-faint);line-height:1.5">
              No workout found for ${ironlog.debug.date}.
              <br>recent: ${ironlog.debug.recent_ok ? `${ironlog.debug.recent_count} returned, ${ironlog.debug.matchedCount} matched` : 'unavailable'} ·
              calories endpoint: ${ironlog.debug.cals_ok ? `${ironlog.debug.endpointBurned} ${ul}` : 'unavailable'}
              <details style="margin-top:6px">
                <summary style="cursor:pointer">raw IronLog data</summary>
                <button class="il-debug-copy btn btn-secondary" style="height:30px;padding:0 12px;font-size:12px;margin:6px 0">📋 Copy raw data</button>
                <pre style="white-space:pre-wrap;word-break:break-all;font-size:9px;background:var(--surface-2);padding:8px;border-radius:6px;margin-top:4px">${esc(JSON.stringify({ recent_sample: ironlog.debug.recent_sample, cals_raw: ironlog.debug.cals_raw, recent_err: ironlog.debug.recent_err, cals_err: ironlog.debug.cals_err }, null, 2))}</pre>
              </details>
            </div>` : ''}
          </div>` : ''}
        </div>
      </div>` : ''}

      <!-- Meals -->
      <div class="section-header">
        <h2>${isToday ? 'Meals' : 'Meals on ' + fmtDateNav(viewDate)}</h2>
      </div>
      ${showMorningPrompt ? `
      <div style="padding:0 16px 12px">
        <div class="card" style="text-align:center;border-color:var(--accent-dim)">
          <div style="font-size:28px;margin-bottom:8px">🌅</div>
          <div style="font-size:15px;font-weight:700;margin-bottom:4px">Good morning!</div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">Ready to log breakfast?</div>
          <button class="btn btn-primary" id="morning-breakfast-btn" style="width:100%">Log Breakfast</button>
        </div>
      </div>` : ''}
      <div id="meals-list"></div>
      <div style="display:flex;gap:8px;margin:8px 16px 16px">
        <button class="new-meal-btn" id="new-meal-btn" style="margin:0;flex:1">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          New Meal
        </button>
        <button class="new-meal-btn" id="quick-log-standalone" style="margin:0;flex:1;color:var(--carbs);border-color:var(--carbs)44">
          ⚡ Quick Log
        </button>
        <button class="new-meal-btn" id="from-template-btn" style="margin:0;flex:1;color:var(--text-muted)">
          📋 Template
        </button>
      </div>
    `;

    // Render macro bar
    renderMacroBar(document.getElementById('macro-bar-root'), t, goals);

    // Render sessions
    const mealsList = document.getElementById('meals-list');
    if (mealData.sessions.length === 0 && !showMorningPrompt) {
      mealsList.innerHTML = '<div class="empty-state"><div class="empty-icon">🍽</div><div class="empty-text">No meals yet</div></div>';
    } else {
      mealData.sessions.forEach(session => renderSession(mealsList, session));
    }

    // Date nav — mark as intentional so load() doesn't auto-snap to today
    document.getElementById('nav-prev').addEventListener('click', () => {
      userNavigated = true; viewDate = addDays(viewDate, -1); load();
    });
    document.getElementById('nav-next')?.addEventListener('click', () => {
      const next = addDays(viewDate, 1);
      if (next <= localDate()) { userNavigated = true; viewDate = next; load(); }
    });
    document.getElementById('go-today-btn')?.addEventListener('click', () => {
      userNavigated = false; viewDate = localDate(); load();
    });

    // Copy raw IronLog debug data to clipboard for diagnosis
    document.querySelector('.il-debug-copy')?.addEventListener('click', async () => {
      const txt = JSON.stringify(ironlog?.debug ?? {}, null, 2);
      try { await navigator.clipboard.writeText(txt); showToast('Copied — paste it to Claude', 'success'); }
      catch { showToast('Copy failed — long-press the text instead', 'error'); }
    });

    // Log-check banner: add a meal, or confirm "I ate light"
    document.querySelector('.logcheck-add')?.addEventListener('click', async () => {
      try {
        const session = await api.post('/api/meals/sessions', { date: viewDate });
        openFoodEntry(session.id, () => load());
      } catch (err) { showToast(err.message, 'error'); }
    });
    document.querySelector('.logcheck-light')?.addEventListener('click', async () => {
      try {
        await api.post('/api/meals/log-status', { date: viewDate, status: 'confirmed' });
        showToast('Got it — counted as a light day', 'success');
        load();
      } catch (err) { showToast(err.message, 'error'); }
    });

    // IronLog toggle
    document.getElementById('ironlog-toggle')?.addEventListener('click', () => {
      ironlogExpanded = !ironlogExpanded;
      const det = document.getElementById('ironlog-details');
      const chev = document.getElementById('ironlog-toggle').querySelector('.il-chevron');
      if (det) det.style.display = ironlogExpanded ? 'block' : 'none';
      if (chev) chev.textContent = ironlogExpanded ? '▲' : '▼';
    });

    // Water
    document.getElementById('water-btns').addEventListener('click', async e => {
      const btn = e.target.closest('[data-ml]');
      if (!btn) return;
      const ml = btn.dataset.ml;
      if (ml === 'custom') {
        const a = prompt('Enter amount in ml:');
        if (!a || isNaN(a) || a <= 0) return;
        await logWater(parseInt(a));
      } else {
        await logWater(parseInt(ml));
      }
      load();
    });

    // Water chip removes
    document.querySelectorAll('[data-water-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await api.delete(`/api/water/${btn.dataset.waterId}`); load(); }
        catch (err) { showToast(err.message, 'error'); }
      });
    });

    // Water "show all"
    document.getElementById('water-show-all')?.addEventListener('click', () => {
      const chips = document.getElementById('water-chips');
      chips.innerHTML = entries.map(e => waterChip(e)).join('');
      chips.querySelectorAll('[data-water-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api.delete(`/api/water/${btn.dataset.waterId}`); load(); }
          catch (err) { showToast(err.message, 'error'); }
        });
      });
    });

    // Morning prompt
    document.getElementById('morning-breakfast-btn')?.addEventListener('click', async () => {
      try {
        const session = await api.post('/api/meals/sessions', { date: viewDate, name: 'Breakfast' });
        openFoodEntry(session.id, () => load());
      } catch (err) { showToast(err.message, 'error'); }
    });

    // Water goal override
    document.getElementById('water-goal-edit').addEventListener('click', async () => {
      const input = prompt(`Water goal for ${viewDate === localDate() ? 'today' : viewDate} (ml):\nCurrent: ${waterGoal} ml`);
      if (!input) return;
      const newGoal = parseInt(input);
      if (isNaN(newGoal) || newGoal < 100) { showToast('Enter a valid goal (e.g. 3000)', 'error'); return; }
      try {
        await api.patch(`/api/water/goal/${viewDate}`, { goal_ml: newGoal });
        showToast(`Water goal → ${newGoal} ml`, 'success');
        load();
      } catch (err) { showToast(err.message, 'error'); }
    });

    // Weight
    document.getElementById('log-weight-btn').addEventListener('click', () => {
      openLogWeight(viewDate, todayWeight, () => load());
    });

    // New meal / quick log / template
    document.getElementById('new-meal-btn').addEventListener('click', async () => {
      try { await api.post('/api/meals/sessions', { date: viewDate }); load(); }
      catch (err) { showToast(err.message, 'error'); }
    });
    document.getElementById('quick-log-standalone').addEventListener('click', async () => {
      try {
        const session = await api.post('/api/meals/sessions', { date: viewDate });
        openQuickLog(session.id, () => load());
      } catch (err) { showToast(err.message, 'error'); }
    });
    document.getElementById('from-template-btn').addEventListener('click', () => {
      openFromTemplate(viewDate, () => load());
    });
  }

  function waterChip(e) {
    return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:12px;font-variant-numeric:tabular-nums">
      ${e.amount_ml}ml
      <button data-water-id="${e.id}" style="color:var(--text-faint);font-size:14px;line-height:1;margin-left:2px">×</button>
    </span>`;
  }

  function renderSession(container, session) {
    const sessionEl  = document.createElement('div');
    sessionEl.className = 'meal-session';
    const sessionKcal    = session.entries.reduce((s, e) => s + (e.calories || 0), 0);
    const sessionProtein = Math.round(session.entries.reduce((s, e) => s + (e.protein || 0), 0));
    const sessionCarb    = Math.round(session.entries.reduce((s, e) => s + (e.carbs || 0), 0));
    const sessionFat     = Math.round(session.entries.reduce((s, e) => s + (e.fat   || 0), 0));
    const timeStr        = formatTime(session.logged_at);
    const ul          = unitLabel();
    const isPastDay   = viewDate < localDate();

    sessionEl.innerHTML = `
      <div class="meal-session-header">
        <button class="session-rename-btn" style="text-align:left;flex:1;min-width:0">
          <div class="meal-session-title" style="display:flex;align-items:center;gap:6px">
            ${esc(session.name)}
            <span style="font-size:11px;color:var(--text-faint)">✎</span>
          </div>
          ${timeStr ? `<div class="meal-session-kcal">${timeStr}</div>` : ''}
        </button>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <span class="meal-session-kcal num">${fmtE(sessionKcal)} ${ul}${sessionProtein > 0 ? ` · <span style="color:var(--protein);font-weight:600">${sessionProtein}g P</span>` : ''}${sessionCarb > 0 ? ` · <span style="color:var(--carbs);font-weight:600">${sessionCarb}g C</span>` : ''}${sessionFat > 0 ? ` · <span style="color:var(--fat);font-weight:600">${sessionFat}g F</span>` : ''}</span>
          ${isPastDay ? `<button class="session-move-btn" title="Move to today"
            style="font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 9px;border-radius:999px;border:1px solid rgba(200,184,255,.2);white-space:nowrap">
            → Today
          </button>` : ''}
          <button class="session-save-tmpl-btn" title="Save as template" style="color:var(--text-faint);padding:4px;font-size:15px">🔖</button>
          <button class="session-copy-btn" title="Copy past meal" style="color:var(--text-faint);padding:4px;font-size:15px">♻️</button>
          <button class="session-del-btn" title="Delete" style="color:var(--text-faint);padding:4px">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // Entry rows
    session.entries.forEach(entry => {
      const entryEl = document.createElement('div');
      entryEl.className = 'meal-entry';
      entryEl.innerHTML = `
        <div style="font-size:20px;flex-shrink:0;width:30px;text-align:center">${getFoodIcon(entry.food_name)}</div>
        <div class="meal-entry-info">
          <div class="meal-entry-name">${esc(entry.food_name)}</div>
          <div class="meal-entry-sub">${fmt(entry.quantity_g)}g &nbsp;
            <span style="color:var(--protein)">${fmt(entry.protein,1)}P</span> ·
            <span style="color:var(--carbs)">${fmt(entry.carbs,1)}C</span> ·
            <span style="color:var(--fat)">${fmt(entry.fat,1)}F</span>
          </div>
        </div>
        <div class="meal-entry-kcal">${fmtE(entry.calories)}</div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="entry-edit-btn" title="Edit" style="width:30px;height:30px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:12px">✏️</button>
          <button class="entry-del-btn" title="Delete" style="width:30px;height:30px;border-radius:50%;background:rgba(255,107,107,.1);color:var(--error);display:flex;align-items:center;justify-content:center;font-size:15px">×</button>
        </div>
      `;

      // Long-press to duplicate
      let lpTimer = null;
      entryEl.addEventListener('touchstart', () => {
        lpTimer = setTimeout(async () => {
          try {
            await api.post(`/api/meals/sessions/${session.id}/entries`, {
              food_id: entry.food_id, quantity_g: entry.quantity_g,
            });
            showToast(`${entry.food_name} duplicated`, 'success');
            load();
          } catch (err) { showToast(err.message, 'error'); }
        }, 600);
      }, { passive: true });
      ['touchend','touchmove','touchcancel'].forEach(ev =>
        entryEl.addEventListener(ev, () => clearTimeout(lpTimer), { passive: true })
      );

      entryEl.querySelector('.entry-edit-btn').addEventListener('click', () => openEditEntry(entry, () => load()));
      entryEl.querySelector('.entry-del-btn').addEventListener('click', async () => {
        try {
          await api.delete(`/api/meals/entries/${entry.id}`);
          entryEl.style.opacity = '0'; entryEl.style.transition = 'opacity .2s';
          setTimeout(() => load(), 200);
        } catch (err) { showToast(err.message, 'error'); }
      });
      sessionEl.appendChild(entryEl);
    });

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;border-top:1px solid var(--border)';
    const addBtn = document.createElement('button');
    addBtn.className = 'meal-session-add'; addBtn.style.flex = '1';
    addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Add Food`;
    addBtn.addEventListener('click', () => openFoodEntry(session.id, () => load()));
    const qlBtn = document.createElement('button');
    qlBtn.className = 'meal-session-add';
    qlBtn.style.cssText = 'flex:0 0 auto;border-left:1px solid var(--border);color:var(--carbs)';
    qlBtn.textContent = '⚡ Quick Log';
    qlBtn.addEventListener('click', () => openQuickLog(session.id, () => load()));
    footer.appendChild(addBtn); footer.appendChild(qlBtn);
    sessionEl.appendChild(footer);
    container.appendChild(sessionEl);

    // Session events
    sessionEl.querySelector('.session-rename-btn').addEventListener('click', () =>
      openRenameSession(session.id, session.name, () => load())
    );
    sessionEl.querySelector('.session-save-tmpl-btn').addEventListener('click', () =>
      openSaveAsTemplate(session)
    );
    sessionEl.querySelector('.session-copy-btn').addEventListener('click', () =>
      openCopyPastMeal(session.id, () => load())
    );
    sessionEl.querySelector('.session-del-btn').addEventListener('click', async () => {
      if (!confirm(`Delete "${session.name}" and all its entries?`)) return;
      try { await api.delete(`/api/meals/sessions/${session.id}`); showToast('Meal deleted', 'success'); load(); }
      catch (err) { showToast(err.message, 'error'); }
    });

    sessionEl.querySelector('.session-move-btn')?.addEventListener('click', async () => {
      try {
        await api.patch(`/api/meals/sessions/${session.id}`, { date: localDate() });
        showToast(`"${session.name}" moved to today`, 'success');
        load();
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  async function logWater(ml) {
    try { await api.post('/api/water', { amount_ml: ml, date: viewDate }); }
    catch (err) { showToast(err.message, 'error'); }
  }

  const onSettingsChanged = () => load();
  window.addEventListener('plated:settings-changed', onSettingsChanged);
  container.innerHTML = buildSkeleton();
  load();

  return () => window.removeEventListener('plated:settings-changed', onSettingsChanged);
}

function phaseBadge(phase) {
  const map = { cut: ['🔻','#ff6b6b'], maintain: ['⚖️','#5dca8a'], bulk: ['📈','#c8b8ff'] };
  const [icon, color] = map[phase] || map.maintain;
  return `<span style="font-size:11px;font-weight:700;color:${color};background:${color}18;padding:3px 10px;border-radius:999px;border:1px solid ${color}44">${icon} ${(phase||'maintain').toUpperCase()}</span>`;
}

function phaseProgressCard(settings, totals, burned) {
  const tdee = parseFloat(settings.tdee);
  if (!tdee) return '';
  const ul      = unitLabel();
  const phase   = settings.phase || 'maintain';
  const deficit = parseInt(settings.cut_deficit)  || 500;
  const surplus = parseInt(settings.bulk_surplus) || 300;
  const net     = (totals.calories || 0) - burned;
  const target  = phase === 'cut' ? tdee - deficit : phase === 'bulk' ? tdee + surplus : tdee;
  const diff    = net - target;
  const onTrack = Math.abs(diff) <= 150;
  const over    = diff > 150;
  const diffLabel = onTrack ? 'On track ✓' : over ? `+${Math.round(diff)} over` : `${Math.round(-diff)} under`;
  const diffColor = onTrack ? 'var(--success)' : over ? 'var(--warning)' : 'var(--fat)';
  const pct = Math.min((net / target) * 100, 110);
  return `
    <div class="card" style="margin-top:4px;border-color:${onTrack?'var(--success)':'var(--border)'}44">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span class="label">${phase.toUpperCase()} TARGET</span>
        <span class="num" style="font-size:12px;color:${diffColor}">${diffLabel}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:6px">
        <span>Net <strong style="color:var(--text)">${fmtE(net)} ${ul}</strong></span>
        <span>Target <strong style="color:var(--text)">${fmtE(target)} ${ul}</strong></span>
      </div>
      <div style="height:5px;background:var(--surface-2);border-radius:999px;overflow:hidden">
        <div style="height:100%;width:${Math.min(pct,100)}%;background:${diffColor};border-radius:999px;transition:width .5s ease-out"></div>
      </div>
    </div>`;
}

function buildSkeleton() {
  return `
    <div style="padding:20px 16px 8px"><div class="skeleton skel-line" style="width:160px;height:24px"></div></div>
    <div style="padding:0 16px 8px"><div class="card">
      <div class="skeleton" style="width:140px;height:140px;border-radius:50%;margin:0 auto 16px"></div>
      <div class="skeleton skel-line"></div><div class="skeleton skel-line" style="width:70%;margin-top:6px"></div>
    </div></div>`;
}
