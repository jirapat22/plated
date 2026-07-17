import { api }             from '../api.js';
import { showToast }        from '../app.js';
import { renderMacroBar }   from '../components/macroBar.js';
import { fmtE, unitLabel }  from '../utils/energy.js';
import { openFoodEntry, renderMealCard } from './log.js';
import { localDate }        from '../utils/date.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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

// Accent colors come from another profile's record and end up interpolated
// straight into style attributes — validate the shape (server now rejects
// non-hex on write, but this is the last line of defense at render time)
// rather than trusting it's still a plain hex string.
const safeColor = c => /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#c8b8ff';

function hexToRgba(hex, alpha) {
  const h = safeColor(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function renderHistory(container) {
  let selectedDate = localDate();
  let summary = [];
  let connections = [];
  let viewed = null;   // { id, name, accent_color } — null means viewing yourself

  container.innerHTML = `
    <div class="today-header"><div class="today-date">History</div></div>
    <div id="conn-switcher"></div>
    <div id="viewing-banner"></div>
    <div id="cal-strip-root" class="cal-strip"></div>
    <div id="history-day" style="padding:0 16px"></div>
  `;

  // Query suffix threaded onto every read while viewing someone else's data —
  // never used for writes, and never sent to /api/weight, so those stay
  // private by construction rather than by hiding a button in the UI.
  const qs = () => viewed ? `?profile=${viewed.id}` : '';

  async function loadConnections() {
    try { connections = await api.get('/api/connections'); } catch { connections = []; }
    renderSwitcher();
  }

  function renderSwitcher() {
    const root = document.getElementById('conn-switcher');
    if (!root) return;
    if (!connections.length) { root.innerHTML = ''; return; }
    root.innerHTML = `
      <div style="display:flex;gap:8px;overflow-x:auto;padding:0 16px 10px;-webkit-overflow-scrolling:touch">
        <button class="cal-day-name conn-pill${!viewed ? ' active' : ''}" data-id="" style="flex-shrink:0;padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:${!viewed ? 'var(--accent-dim)' : 'transparent'};color:${!viewed ? 'var(--accent)' : 'var(--text-muted)'};font-size:12px;font-weight:700;white-space:nowrap">Me</button>
        ${connections.map(p => `
          <button class="conn-pill" data-id="${p.id}" data-name="${esc(p.name)}" data-color="${safeColor(p.accent_color)}"
            style="flex-shrink:0;padding:6px 14px;border-radius:999px;border:1px solid ${viewed?.id === p.id ? safeColor(p.accent_color) : 'var(--border)'};background:${viewed?.id === p.id ? hexToRgba(p.accent_color, .18) : 'transparent'};color:${viewed?.id === p.id ? safeColor(p.accent_color) : 'var(--text-muted)'};font-size:12px;font-weight:700;white-space:nowrap">${esc(p.name)}</button>
        `).join('')}
      </div>
    `;
    root.querySelectorAll('.conn-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        viewed = id ? { id: parseInt(id), name: btn.dataset.name, accent_color: btn.dataset.color } : null;
        applyViewingTreatment();
        renderSwitcher();
        refresh(selectedDate);
      });
    });
  }

  function applyViewingTreatment() {
    const banner = document.getElementById('viewing-banner');
    if (!banner) return;
    if (viewed) {
      container.style.background = hexToRgba(viewed.accent_color, .05);
      container.style.borderRadius = '14px';
      banner.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin:0 16px 10px;padding:8px 12px;border-radius:10px;background:${hexToRgba(viewed.accent_color, .15)};border:1px solid ${hexToRgba(viewed.accent_color, .4)}">
          <span style="font-size:12px;font-weight:700;color:${safeColor(viewed.accent_color)}">Viewing ${esc(viewed.name)}'s day</span>
          <button id="viewing-back" class="btn btn-secondary" style="height:26px;padding:0 10px;font-size:11px">Back to me</button>
        </div>
      `;
      document.getElementById('viewing-back').addEventListener('click', () => {
        viewed = null;
        applyViewingTreatment();
        renderSwitcher();
        refresh(selectedDate);
      });
    } else {
      container.style.background = '';
      container.style.borderRadius = '';
      banner.innerHTML = '';
    }
  }

  async function loadSummary() {
    summary = await api.get(`/api/meals/summary?days=30${viewed ? `&profile=${viewed.id}` : ''}`);
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
      // Weight is never shared — skip that fetch entirely when viewing someone
      // else's day rather than showing your own weight under their meals.
      const [mealData, settings, dayWeight] = await Promise.all([
        api.get(`/api/meals/day/${date}${qs()}`),
        api.get('/api/settings'),
        viewed ? Promise.resolve(null) : api.get(`/api/weight/day/${date}`).catch(() => null),
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
            <div class="label">${viewed ? ul : `of ${fmtE(goals.cal)} ${ul}`}</div>
          </div>
          <div style="text-align:right">
            <div class="num" style="font-size:13px;color:var(--protein)">${t.protein.toFixed(1)}g protein</div>
            <div class="num" style="font-size:13px;color:var(--carbs)">${t.carbs.toFixed(1)}g carbs</div>
            <div class="num" style="font-size:13px;color:var(--fat)">${t.fat.toFixed(1)}g fat</div>
          </div>
        </div>
        <div id="hist-macro-bar"></div>
        ${viewed ? `<div style="font-size:11px;color:var(--text-faint);margin-top:2px">Totals shown, not compared to a goal — goals stay private</div>` : ''}
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
    // Only render the goal-relative macro bar for your own day — for a
    // connected profile's day we only have your goals, not theirs, and
    // showing their intake "against" your numbers is misleading rather
    // than just incomplete.
    if (!viewed) renderMacroBar(el.querySelector('#hist-macro-bar'), t, goals, false);

    if (mealData.sessions.length === 0) {
      const future = date > localDate();
      const emptyText = viewed ? `Nothing logged` : (future ? 'Nothing planned yet — add a meal below to plan ahead' : 'No meals logged');
      el.insertAdjacentHTML('beforeend', `<div class="empty-state" style="padding:20px 0"><div class="empty-icon">🍽</div><div class="empty-text">${emptyText}</div></div>`);
    } else if (viewed) {
      // Read-only: someone else's meals render as plain summary cards — no
      // edit/delete/move/copy affordances. Kept deliberately separate from
      // renderMealCard rather than threading a readOnly flag through every
      // one of its buttons, so there's no risk of a missed one leaving an
      // editable hole into another profile's data.
      mealData.sessions.forEach(session => {
        const card = document.createElement('div');
        card.className = 'meal-session';
        card.style.margin = '0 0 10px';
        const kcal = session.entries.reduce((s, e) => s + (e.calories || 0), 0);
        card.innerHTML = `
          <div class="meal-session-header">
            <div class="meal-session-title">${esc(session.name)}</div>
            <span class="meal-session-kcal num">${fmtE(kcal)} ${ul}</span>
          </div>
          ${session.entries.map(e => `
            <div class="meal-entry">
              <div class="meal-entry-info">
                <div class="meal-entry-name">${esc(e.food_name)}</div>
                <div class="meal-entry-sub"><span style="color:var(--text)">${e.quantity_g}g</span> <span style="color:var(--text-faint)">·</span>
                  <span style="color:var(--protein)">${e.protein}P</span>
                  <span style="color:var(--carbs)">${e.carbs}C</span>
                  <span style="color:var(--fat)">${e.fat}F</span>
                </div>
              </div>
              <div class="meal-entry-kcal">${fmtE(e.calories)}</div>
            </div>
          `).join('')}
        `;
        el.appendChild(card);
      });
    } else {
      const isPast = date < localDate();
      mealData.sessions.forEach(session => {
        const card = renderMealCard(session, date, { showMoveToday: isPast, showQuickLog: true }, () => refresh(date));
        card.style.margin = '0 0 10px';   // history-day already has 16px side padding
        el.appendChild(card);
      });
    }

    // ── Add meal to past date — not available while viewing someone else ──
    if (!viewed) {
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
  }

  loadConnections();
  loadSummary().then(() => loadDay(selectedDate));
}
