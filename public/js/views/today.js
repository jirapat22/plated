import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { openFoodEntry, openQuickLog, renderMealCard } from './log.js';
import { renderMacroBar }                  from '../components/macroBar.js';
import { fmtE, unitLabel } from '../utils/energy.js';
import { localDate }                       from '../utils/date.js';
import { classifyDay, isFlagged, LOG_STRONG } from '../utils/logCheck.js';
import { assert } from '../utils/bugReport.js';

const CIRC = 2 * Math.PI * 60;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── Line icons (match the bottom-nav's hand-drawn stroke style) ───────────
// valign: only needed where the icon sits inline next to text in a non-flex
// container (label spans, ring-center divs) — flex parents already center
// their children and ignore vertical-align, so omit it there.
function icon(path, size = 16, valign = null) {
  const style = valign != null ? `vertical-align:${valign}px;flex-shrink:0` : 'flex-shrink:0';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="${style}">${path}</svg>`;
}
const ICON_WATER      = '<path d="M12 3c-4.2 5-7 8.6-7 12a7 7 0 0 0 14 0c0-3.4-2.8-7-7-12Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>';
const ICON_SCALE       = '<rect x="3" y="9" width="18" height="12" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M8 9a4 4 0 0 1 8 0" stroke="currentColor" stroke-width="1.7"/><path d="M12 12v3.2M12 12l2.6 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
const ICON_BOLT        = '<path d="M13 2 5 14h6l-1 8 9-12h-6l1-8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>';
const ICON_CLIPBOARD   = '<rect x="5" y="4" width="14" height="17" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 10.5h7M8.5 14h7M8.5 17.5h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
const ICON_FLAME       = '<path d="M12 2.5c1.2 3.6-3.4 5-3.4 8.7a3.4 3.4 0 0 0 6.8 0c0-1-.5-1.8-.5-1.8s.3 1.6-.8 2c.9-2.6-1.7-3.4-2.1-8.9Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>';
const ICON_CHART       = '<path d="M4 19V9M9.5 19V5M15 19v-7M20 19V3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
const ICON_TREND_DOWN  = '<path d="M5 6l14 14M19 13v7h-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_TREND_UP    = '<path d="M5 18 19 4M12 4h7v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';

// Graduation ticks around the ring track — a bezel detail (à la a kitchen
// scale's dial), drawn just outside the stroke band so they read as markings
// rather than competing with the progress arc.
function ringTicks(count = 12) {
  let marks = '';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 2 * Math.PI;
    const x1 = 70 + 66 * Math.cos(a), y1 = 70 + 66 * Math.sin(a);
    const x2 = 70 + 70 * Math.cos(a), y2 = 70 + 70 * Math.sin(a);
    marks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--border)" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  return marks;
}

// Build one calorie ring SVG. variant: '' (goal, accent) | 'workout' | 'target'.
// overflowPct (0-100): the exceeded portion, drawn on top in the darker --over
// colour so only the slice past the goal is dark, not the whole ring.
// ticks: draw the dial-bezel graduations — reserved for the primary ring so
// the two side rings stay clean at their smaller physical size.
function calRingSvg(pct, variant = '', small = false, overflowPct = 0, ticks = false) {
  const base = (Math.min(pct, 100) / 100) * CIRC;
  const over = (Math.min(Math.max(overflowPct, 0), 100) / 100) * CIRC;
  return `
    <svg class="calorie-ring${small ? ' ring-sm' : ''}" viewBox="0 0 140 140">
      ${ticks ? ringTicks() : ''}
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

// ── Main render ──────────────────────────────────────────────
export function renderToday(container) {
  container.classList.add('today-view');
  let viewDate      = localDate();
  let userNavigated = false;   // true only when user manually tapped ← › or swiped
  let ironlogExpanded = false;
  let loadGen = 0;             // increments on each load; stale responses discarded
  const ironCache = new Map(); // past days are immutable — cache their IronLog data

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
      // Pull IronLog for the viewed day (endpoint matches workouts by local date).
      // Cache past days (immutable); always re-fetch today since workouts change.
      let ironlog;
      if (viewDate !== localDate() && ironCache.has(viewDate)) {
        ironlog = ironCache.get(viewDate);
      } else {
        ironlog = await fetchIronLog(viewDate);
        if (viewDate !== localDate()) ironCache.set(viewDate, ironlog);
      }
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

    // ── Concerns: one glanceable row of "what needs attention" ──
    const concerns = [];
    if (showNoCal)               concerns.push({ t: `${noCalNames.length} food${noCalNames.length === 1 ? '' : 's'} no calories`, kind: 'bad' });
    if (eaten > combined)        concerns.push({ t: `+${fmtE(eaten - combined)} ${ul} over`, kind: 'warn' });
    if (t.carbs > goals.carbs + 0.5) concerns.push({ t: `Carbs +${Math.round(t.carbs - goals.carbs)}g`, kind: 'warn' });
    if (t.fat   > goals.fat   + 0.5) concerns.push({ t: `Fat +${Math.round(t.fat - goals.fat)}g`,     kind: 'warn' });
    const showConcernRow = concerns.length > 0 || eaten > 0;

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
      <div style="padding:0 16px 6px">
        <div style="background:var(--accent-dim);border:1px solid rgba(200,184,255,.25);border-radius:var(--radius-sm);padding:9px 14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:var(--accent)">📅 Viewing a past day — not today</span>
          <button id="go-today-btn" style="font-size:12px;font-weight:700;color:var(--accent)">Today →</button>
        </div>
      </div>` : ''}

      <!-- Concerns: at-a-glance "what to be aware of" -->
      ${showConcernRow ? `
      <div style="padding:0 16px 6px">
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
          ${concerns.length
            ? concerns.map(c => `<span class="concern-chip ${c.kind}">${c.kind === 'bad' ? '⚠ ' : ''}${esc(c.t)}</span>`).join('')
            : `<span class="concern-chip good">✓ Nothing to flag</span>`}
        </div>
        ${showNoCal ? `<div style="font-size:11px;color:var(--text-faint);margin-top:6px">${noCalNames.slice(0, 3).map(esc).join(', ')}${noCalNames.length > 3 ? ` +${noCalNames.length - 3}` : ''} — add calories in Foods (~${fmtE(missingKcalEst)} ${ul} uncounted).</div>` : ''}
      </div>` : ''}

      <!-- "Did you forget to log?" check -->
      ${showLogCheck ? `
      <div style="padding:0 16px 10px">
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
      <div style="padding:0 16px 14px">
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
                ${calRingSvg(midPct, '', false, midOver, true)}
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
                  <div class="num ring-kcal-sm">${fmtE(burned)} ${icon(ICON_FLAME, 12, -2)}</div>
                  <div class="ring-goal-sm">${hasWorkout ? 'burned' : 'rest day'}</div>
                </div>
              </div>
            </div>
          </div>
          <div id="macro-bar-root" style="margin-top:12px"></div>
        </div>
      </div>

      <!-- Water -->
      <div style="padding:0 16px 14px">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span class="label">${icon(ICON_WATER, 13, -3)} Water</span>
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
      <div style="padding:0 16px 14px">
        <div class="card" style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="label">${icon(ICON_SCALE, 13, -3)} Bodyweight</div>
            ${todayWeight
              ? `<div class="num" style="font-size:20px;margin-top:2px">${todayWeight.weight_kg} <span style="font-size:12px;color:var(--text-muted)">kg</span></div>`
              : (isToday && ironlog?.bodyweight)
              ? `<div class="num" style="font-size:20px;margin-top:2px">${ironlog.bodyweight.weight_kg} <span style="font-size:12px;color:var(--text-muted)">kg</span></div>
                 <div style="font-size:11px;color:var(--accent);margin-top:2px">${icon(ICON_BOLT, 11, -2)} via IronLog${ironlog.bodyweight.is_today ? ' · today' : ' · ' + ironlog.bodyweight.date}</div>`
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
      <div style="padding:0 16px 14px">
        <button id="ironlog-toggle" class="card" style="width:100%;display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px">
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
            ${ironlog ? `<span style="color:var(--accent)">${icon(ICON_BOLT, 13)}</span>` : `<span style="color:var(--text-faint)">${icon(ICON_CHART, 13)}</span>`}
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
              <span class="label">${icon(ICON_BOLT, 13, -3)} IronLog</span>
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
          ${icon(ICON_BOLT, 14)} Quick Log
        </button>
        <button class="new-meal-btn" id="from-template-btn" style="margin:0;flex:1;color:var(--text-muted)">
          ${icon(ICON_CLIPBOARD, 14)} Template
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
      const isPastDay = viewDate < localDate();
      mealData.sessions.forEach(session => {
        mealsList.appendChild(renderMealCard(session, viewDate, {
          showTime: true,
          showMoveToday: isPastDay,
          showTemplate: true,
          showPullIn: true,
          showQuickLog: true,
        }, () => load()));
      });
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
  const map = {
    cut:      { glyph: ICON_TREND_DOWN, color: '#ff6b6b' },
    maintain: { glyph: ICON_SCALE,      color: '#5dca8a' },
    bulk:     { glyph: ICON_TREND_UP,   color: '#c8b8ff' },
  };
  const { glyph, color } = map[phase] || map.maintain;
  return `<span style="font-size:11px;font-weight:700;color:${color};background:${color}18;padding:3px 10px;border-radius:999px;border:1px solid ${color}44;display:inline-flex;align-items:center;gap:4px">${icon(glyph, 12)} ${(phase||'maintain').toUpperCase()}</span>`;
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
