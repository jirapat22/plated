import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }               from '../components/foodSearch.js';
import { fmtE, unitLabel, wireEnergyUnitToggle } from '../utils/energy.js';
import { localDate }                      from '../utils/date.js';
import { getFoodIcon }                    from '../utils/foodIcon.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = (n, dec = 0) => n == null ? '–' : Number(n).toFixed(dec);

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}

// ── Copy a single logged food, or a whole meal, to another meal/day ──
async function dayMeals(viewDate) {
  try { return (await api.get(`/api/meals/day/${viewDate}`)).sessions || []; } catch { return []; }
}

// Shared sheet body for picking a destination: a day (quick-pick chips,
// defaulting to Tomorrow — copying to the source day itself is almost never
// the intent) plus the meals that already exist on whichever day is picked,
// so copying "to another day" can merge into a meal that's already there
// instead of always creating a duplicate. The target list re-fetches on
// date change. excludeSessionId is left out of the list (can't copy a meal
// into itself). onPick(date, sid) — sid is an existing session id, or 'new'.
//
// Chips instead of a native <input type="date"> — that was the only native
// OS UI anywhere in this otherwise fully custom-themed app (it pops up the
// platform's own light-themed date wheel), AND it defaulted to the meal's
// own day, so every "move this to a different day" attempt required
// operating that picker. History already has a themed, tap-based day
// picker one screen over; this reuses that same interaction language. A
// "Pick another date" fallback keeps the original's open-ended past-date
// support (e.g. backfilling a corrected day) for anything outside the
// 7-day quick-pick window.
function destinationSheet(title, subtitle, viewDate, excludeSessionId, initialOthers, onPick) {
  showSheet(content => {
    const today = localDate();
    const quickDays = [today, ...Array.from({ length: 7 }, (_, i) => addDaysIso(today, i + 1))];
    const dayLabel = (iso, i) => i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    let selectedDate = quickDays[1];   // default: tomorrow — the common case

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">${title}</span>
        <button class="sheet-close" id="cp-close">✕</button>
      </div>
      <div style="padding:0 16px">
        ${subtitle}
        <label class="form-label">Date</label>
        <div id="cp-days" style="display:flex;gap:6px;overflow-x:auto;padding:6px 0 10px;-webkit-overflow-scrolling:touch">
          ${quickDays.map((d, i) => `<button type="button" class="fs-chip cp-day${d === selectedDate ? ' active' : ''}" data-date="${d}" style="flex-shrink:0">${dayLabel(d, i)}</button>`).join('')}
        </div>
        <button type="button" id="cp-custom-toggle" style="font-size:12px;color:var(--accent);font-weight:600;padding:2px 0;margin-bottom:4px">Pick another date…</button>
        <input class="input" id="cp-date-custom" type="date" max="${addDaysIso(today, 7)}" style="display:none;margin-bottom:14px"/>
        <label class="form-label">Copy into</label>
        <div id="cp-targets" style="display:flex;flex-direction:column;gap:6px;margin:6px 0 16px"></div>
      </div>`;
    document.getElementById('cp-close').addEventListener('click', hideSheet);

    const daysBox      = document.getElementById('cp-days');
    const customToggle = document.getElementById('cp-custom-toggle');
    const customInput  = document.getElementById('cp-date-custom');
    const targetsBox   = document.getElementById('cp-targets');

    async function renderTargets() {
      const date = selectedDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { targetsBox.innerHTML = ''; return; }
      targetsBox.innerHTML = '<div class="skeleton skel-line" style="height:38px"></div>';
      const sessions = date === viewDate
        ? initialOthers
        : (await dayMeals(date)).filter(s => s.id !== excludeSessionId);
      if (selectedDate !== date) return;   // date changed again while this was in flight
      targetsBox.innerHTML = sessions.map(s =>
        `<button class="cp-target btn btn-secondary" data-sid="${s.id}" style="justify-content:flex-start">${esc(s.name || 'Meal')}</button>`
      ).join('') + `<button class="cp-target btn btn-secondary" data-sid="new" style="justify-content:flex-start;color:var(--accent)">+ New meal</button>`;
      targetsBox.querySelectorAll('.cp-target').forEach(btn =>
        btn.addEventListener('click', () => onPick(date, btn.dataset.sid)));
    }

    function selectDate(date) {
      selectedDate = date;
      daysBox.querySelectorAll('.cp-day').forEach(b => b.classList.toggle('active', b.dataset.date === date));
      renderTargets();
    }

    daysBox.querySelectorAll('.cp-day').forEach(btn =>
      btn.addEventListener('click', () => selectDate(btn.dataset.date)));

    customToggle.addEventListener('click', () => {
      const opening = customInput.style.display === 'none';
      customInput.style.display = opening ? 'block' : 'none';
      if (opening) customInput.focus();
    });
    customInput.addEventListener('change', () => {
      if (!customInput.value) return;
      daysBox.querySelectorAll('.cp-day').forEach(b => b.classList.remove('active'));
      selectDate(customInput.value);
    });

    renderTargets();
  });
}

// Copy a single logged food (same quantity) into another meal, on any day.
export async function openCopyEntry(entry, viewDate, onDone) {
  const others = (await dayMeals(viewDate)).filter(s => s.id !== entry.meal_session_id);
  const copyTo = sid => api.post(`/api/meals/sessions/${sid}/entries`, { food_id: entry.food_id, quantity_g: entry.quantity_g });
  const newSession = async date => (await api.post('/api/meals/sessions', { date })).id;
  const sub = `<div style="font-size:15px;font-weight:600">${esc(entry.food_name)}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${Math.round(entry.quantity_g)}g · ${fmtE(entry.calories)} ${unitLabel()}</div>`;
  destinationSheet('Copy food', sub, viewDate, entry.meal_session_id, others, async (date, sid) => {
    try {
      await copyTo(sid === 'new' ? await newSession(date) : sid);
      hideSheet();
      showToast(sid === 'new' ? (date === localDate() ? 'Copied to today' : `Copied to ${date}`) : 'Copied', 'success');
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); }
  });
}

// Copy a whole meal (all foods) to a new meal on a day, or merge into an existing meal.
export async function openCopyMeal(session, viewDate, onDone) {
  const others = (await dayMeals(viewDate)).filter(s => s.id !== session.id);
  const copy = body => api.post(`/api/meals/sessions/${session.id}/copy`, body);
  const n = (session.entries || []).length;
  const sub = `<div style="font-size:15px;font-weight:600">${esc(session.name || 'Meal')}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${n} food${n === 1 ? '' : 's'} · copied with the same amounts</div>`;
  destinationSheet('Copy meal', sub, viewDate, session.id, others, async (date, sid) => {
    try {
      await copy(sid === 'new' ? { date } : { target_session_id: sid });
      hideSheet();
      showToast(sid === 'new' ? (date === localDate() ? 'Copied to today' : `Copied to ${date}`) : 'Merged into meal', 'success');
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); }
  });
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

export function openRenameSession(sessionId, currentName, onSuccess) {
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

// ── Save / apply meal templates ───────────────────────────────
export function openSaveAsTemplate(session) {
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

// ── Copy past meal (pull foods from a meal in the last 7 days) ─
export function openCopyPastMeal(targetSessionId, onSuccess) {
  showSheet(async content => {
    content.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted)">Loading past meals…</div>`;

    const days = Array.from({ length: 7 }, (_, i) => addDaysIso(localDate(), -(i + 1)));
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
        // allSettled, not all — these fire concurrently, so if one entry 404s
        // (e.g. its food was deleted since this list loaded) the others have
        // already gone through server-side. Promise.all would reject and show
        // a plain "failed" toast implying nothing happened, and a user who
        // retried on that assumption would duplicate the ones that succeeded.
        const results = await Promise.allSettled(s.entries.map(e =>
          api.post(`/api/meals/sessions/${targetSessionId}/entries`, {
            food_id: e.food_id, quantity_g: e.quantity_g,
          })
        ));
        const okCount = results.filter(r => r.status === 'fulfilled').length;
        const failCount = results.length - okCount;
        if (failCount === 0) {
          hideSheet();
          showToast(`Copied ${okCount} foods from ${s.name}`, 'success');
          onSuccess?.();
        } else if (okCount > 0) {
          hideSheet();
          showToast(`Copied ${okCount} of ${results.length} — ${failCount} couldn't be copied (may have been removed)`, 'error');
          onSuccess?.();   // some entries did land — refresh so the view isn't stale
        } else {
          showToast('Could not copy any foods from that meal', 'error');
          btn.style.opacity = '1';
        }
      });
    });
  });
}

// ── Quick Log (rough calories for a meal out, not saved to the food db) ─
export function openQuickLog(sessionId, onSuccess) {
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
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:16px">
          ${['pro','carb','fat','fiber'].map((id, i) => {
            const [label, color] = [['Protein','var(--protein)'],['Carbs','var(--carbs)'],['Fat','var(--fat)'],['Fiber','var(--fiber)']][i];
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
      const pro   = parseFloat(document.getElementById('ql-pro').value)   || null;
      const carb  = parseFloat(document.getElementById('ql-carb').value)  || null;
      const fat   = parseFloat(document.getElementById('ql-fat').value)   || null;
      const fiber = parseFloat(document.getElementById('ql-fiber').value) || null;
      const btn = document.getElementById('ql-submit');
      btn.disabled = true; btn.textContent = 'Logging…';
      try {
        const food = await api.post('/api/foods', {
          name, calories_per_100g: calKcal,
          protein_per_100g: pro, carbs_per_100g: carb, fat_per_100g: fat, fiber_per_100g: fiber,
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

export function openFoodEntry(sessionId, onSuccess, opts = {}) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Add Food</span>
        <button class="sheet-close" id="close-search">✕</button>
      </div>
    `;
    document.getElementById('close-search').addEventListener('click', hideSheet);
    renderFoodSearch(
      content,
      food => showQuantitySheet(food, sessionId, onSuccess),
      {
        pendingBarcode: opts.pendingBarcode,
        // Re-open this sheet fresh (used after a barcode scan replaces it)
        reopen: (o = {}) => openFoodEntry(sessionId, onSuccess, o),
      }
    );
  });
}

// ── Edit existing entry ──────────────────────────────────────
export function openEditEntry(entry, onSuccess) {
  showSheet(content => {
    const ul  = unitLabel();
    const srv = entry.serving_size_g || 100;
    const isQuick = entry.food_source === 'quick';

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Edit ${isQuick ? 'Quick Log' : 'Quantity'}</span>
        <button class="sheet-close" id="edit-close">✕</button>
      </div>
      <div class="qty-food-name">${esc(entry.food_name)}</div>
      <div style="display:flex;gap:6px;padding:4px 16px 12px;flex-wrap:wrap">
        <button class="qty-mode-btn active" data-mode="g">by weight</button>
        <button class="qty-mode-btn" data-mode="srv">by serving (${srv}g)</button>
      </div>

      <div id="edit-mode-g">
        <div class="qty-input-wrap">
          <input type="text" inputmode="decimal" id="edit-qty" class="qty-input" value="${entry.quantity_g}" min="1" step="1" />
          <span class="qty-unit">g</span>
        </div>
        <div style="display:flex;gap:6px;padding:8px 16px;flex-wrap:wrap">
          ${[50,75,100,150,200,250,300].map(g =>
            `<button class="water-btn quick-edit-g" data-g="${g}">${g}g</button>`
          ).join('')}
        </div>
      </div>

      <div id="edit-mode-srv" style="display:none">
        <div class="qty-input-wrap">
          <input type="text" inputmode="decimal" id="edit-qty-srv" class="qty-input" value="${(entry.quantity_g / srv).toFixed(1)}" min="0.5" step="0.5" />
          <span class="qty-unit" style="font-size:13px">srv × ${srv}g</span>
        </div>
        <div style="display:flex;gap:6px;padding:8px 16px;flex-wrap:wrap">
          ${[0.5,1,1.5,2,2.5,3].map(n =>
            `<button class="water-btn quick-edit-srv" data-s="${n}">${n}</button>`
          ).join('')}
        </div>
      </div>

      ${isQuick ? `
      <div style="padding:14px 16px 0">
        <div class="label" style="margin-bottom:10px">Calories (for ${srv}g) *</div>
        <div style="display:flex;gap:6px;margin-bottom:14px">
          <input class="input" id="edit-cal" type="text" inputmode="decimal" style="flex:1;min-width:0" />
          <div style="display:flex;gap:4px;flex-shrink:0" id="edit-cal-unit">
            <button type="button" class="eunit-btn active" data-unit="kcal">kcal</button>
            <button type="button" class="eunit-btn" data-unit="kj">kJ</button>
          </div>
        </div>
        <div class="label" style="margin-bottom:10px">Macros — optional</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">
          ${['pro','carb','fat','fiber'].map((id, i) => {
            const [label, color] = [['Protein','var(--protein)'],['Carbs','var(--carbs)'],['Fat','var(--fat)'],['Fiber','var(--fiber)']][i];
            return `<div style="position:relative">
              <input class="input" id="edit-${id}" type="text" placeholder="${label}" inputmode="decimal"
                style="height:42px;padding-right:20px;border-color:${color}44"/>
              <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;font-weight:700;color:${color}">${label[0]}</span>
            </div>`;
          }).join('')}
        </div>
      </div>` : `<div class="qty-macros" id="edit-macros"></div>`}
      <div class="qty-confirm">
        <button class="btn btn-primary btn-full" id="edit-confirm">Update</button>
      </div>
    `;

    let currentMode = 'g';
    content.querySelectorAll('.qty-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentMode = btn.dataset.mode;
        content.querySelectorAll('.qty-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('edit-mode-g').style.display   = currentMode === 'g'   ? '' : 'none';
        document.getElementById('edit-mode-srv').style.display = currentMode === 'srv' ? '' : 'none';
        calcMacros();
      });
    });

    function getTotalG() {
      if (currentMode === 'srv') return (parseFloat(document.getElementById('edit-qty-srv')?.value) || 0) * srv;
      return parseFloat(document.getElementById('edit-qty')?.value) || 0;
    }

    function calcMacros() {
      if (isQuick) return;   // macro edit inputs replace this preview
      const qty = getTotalG();
      const r   = qty / 100;
      const cal = entry.calories_per_100g != null ? fmtE(entry.calories_per_100g * r) : '–';
      const pro = entry.protein_per_100g  != null ? (entry.protein_per_100g  * r).toFixed(1) : '–';
      const crb = entry.carbs_per_100g    != null ? (entry.carbs_per_100g    * r).toFixed(1) : '–';
      const fat = entry.fat_per_100g      != null ? (entry.fat_per_100g      * r).toFixed(1) : '–';
      document.getElementById('edit-macros').innerHTML = `
        <div class="qty-macro"><div class="qty-macro-val num">${cal}</div><div class="qty-macro-lbl">${ul}</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--protein)">${pro}g</div><div class="qty-macro-lbl">protein</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--carbs)">${crb}g</div><div class="qty-macro-lbl">carbs</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--fat)">${fat}g</div><div class="qty-macro-lbl">fat</div></div>
      `;
    }

    calcMacros();
    document.getElementById('edit-qty').addEventListener('input', calcMacros);
    document.getElementById('edit-qty-srv').addEventListener('input', calcMacros);

    content.querySelectorAll('.quick-edit-g').forEach(btn => {
      btn.addEventListener('click', () => { document.getElementById('edit-qty').value = btn.dataset.g; calcMacros(); });
    });
    content.querySelectorAll('.quick-edit-srv').forEach(btn => {
      btn.addEventListener('click', () => { document.getElementById('edit-qty-srv').value = btn.dataset.s; calcMacros(); });
    });

    document.getElementById('edit-close').addEventListener('click', hideSheet);

    // Quick-log entries also expose the underlying food's own calories/macros
    // for editing (rough numbers typed in on the go are often wrong) — real
    // foods stay quantity-only since editing their macros would ripple into
    // every other entry logged against that shared food.
    let getCalKcal = null;
    if (isQuick) {
      getCalKcal = wireEnergyUnitToggle(
        document.getElementById('edit-cal-unit'),
        document.getElementById('edit-cal')
      );
      document.getElementById('edit-cal').value   = entry.calories_per_100g != null ? fmtE(entry.calories_per_100g) : '';
      document.getElementById('edit-pro').value   = entry.protein_per_100g  ?? '';
      document.getElementById('edit-carb').value  = entry.carbs_per_100g    ?? '';
      document.getElementById('edit-fat').value   = entry.fat_per_100g      ?? '';
      document.getElementById('edit-fiber').value = entry.fiber_per_100g    ?? '';
    }

    document.getElementById('edit-confirm').addEventListener('click', async () => {
      const qty = getTotalG();
      if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
      const btn = document.getElementById('edit-confirm');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (isQuick) {
          const calKcal = getCalKcal();
          if (!calKcal) { showToast('Enter the calories', 'error'); btn.disabled = false; btn.textContent = 'Update'; return; }
          await api.patch(`/api/foods/${entry.food_id}`, {
            calories_per_100g: calKcal,
            protein_per_100g: parseFloat(document.getElementById('edit-pro').value)   || null,
            carbs_per_100g:   parseFloat(document.getElementById('edit-carb').value)  || null,
            fat_per_100g:     parseFloat(document.getElementById('edit-fat').value)   || null,
            fiber_per_100g:   parseFloat(document.getElementById('edit-fiber').value) || null,
          });
        }
        await api.patch(`/api/meals/entries/${entry.id}`, { quantity_g: qty });
        hideSheet();
        showToast('Updated', 'success');
        onSuccess?.();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Update';
      }
    });
  });
}

// ── Add to meal (new) ────────────────────────────────────────
function showQuantitySheet(food, sessionId, onSuccess) {
  showSheet(content => {
    const srv = food.serving_size_g || 100;
    const ul  = unitLabel();

    content.innerHTML = `
      <div class="sheet-header">
        <button id="qty-back" style="color:var(--accent);font-weight:600;font-size:14px">← Back</button>
        <button class="sheet-close" id="qty-close">✕</button>
      </div>
      <div class="qty-food-name">${esc(food.name)}</div>
      ${food.brand ? `<div class="qty-food-brand">${esc(food.brand)}</div>` : '<div style="height:8px"></div>'}

      <!-- Mode toggle -->
      <div style="display:flex;gap:6px;padding:0 16px 12px;flex-wrap:wrap">
        <button class="qty-mode-btn active" data-mode="g">by weight</button>
        <button class="qty-mode-btn" data-mode="srv">by serving (${srv}g)</button>
        <button class="qty-mode-btn" data-mode="pcs">by pieces</button>
      </div>

      <!-- Weight mode -->
      <div id="mode-g">
        <div class="qty-input-wrap">
          <input type="text" inputmode="decimal" id="qty-g" class="qty-input" value="${srv}" min="1" step="1" />
          <span class="qty-unit">g</span>
        </div>
        <div style="display:flex;gap:6px;padding:8px 16px;flex-wrap:wrap">
          ${[50,75,100,150,200,250,300].map(g =>
            `<button class="water-btn quick-g" data-g="${g}">${g}g</button>`
          ).join('')}
          <button class="water-btn quick-g" data-g="${srv}" style="color:var(--accent)">1 srv</button>
        </div>
      </div>

      <!-- Serving mode -->
      <div id="mode-srv" style="display:none">
        <div class="qty-input-wrap">
          <input type="text" inputmode="decimal" id="qty-srv" class="qty-input" value="1" min="0.5" step="0.5" />
          <span class="qty-unit" style="font-size:13px">srv × ${srv}g</span>
        </div>
        <div style="display:flex;gap:6px;padding:8px 16px;flex-wrap:wrap">
          ${[0.5,1,1.5,2,2.5,3].map(n =>
            `<button class="water-btn quick-srv" data-s="${n}">${n}</button>`
          ).join('')}
        </div>
      </div>

      <!-- Pieces mode -->
      <div id="mode-pcs" style="display:none">
        <div style="padding:0 16px 8px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div>
              <label class="form-label">Grams per piece</label>
              <input type="text" inputmode="decimal" id="qty-g-per-pc" class="input" value="${(srv/3).toFixed(1)}" min="0.1" step="0.1" style="height:42px" />
            </div>
            <div>
              <label class="form-label">Number of pieces</label>
              <input type="text" inputmode="decimal" id="qty-pcs" class="input" value="3" min="1" step="1" style="height:42px" />
            </div>
          </div>
          <div id="pcs-total-g" style="font-size:12px;color:var(--text-muted)"></div>
        </div>
      </div>

      <div class="qty-macros" id="qty-macros"></div>
      ${food.calories_per_100g == null ? `
      <div style="margin:0 16px 8px;padding:9px 12px;background:rgba(249,115,22,.10);border:1px solid rgba(249,115,22,.3);border-radius:8px;font-size:12px;color:#f9a35c;line-height:1.4">
        ⚠ This food has no calorie data — it'll log as <strong>0 ${ul}</strong> and won't count toward your goal. Add calories in the Foods tab (search it → Edit) first.
      </div>` : ''}
      <div class="qty-confirm">
        <button class="btn btn-primary btn-full" id="qty-confirm-btn">Add to Meal</button>
      </div>
    `;

    let currentMode = 'g';
    content.querySelectorAll('.qty-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentMode = btn.dataset.mode;
        content.querySelectorAll('.qty-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
        content.querySelectorAll('[id^="mode-"]').forEach(el => { el.style.display = 'none'; });
        document.getElementById(`mode-${currentMode}`).style.display = '';
        updateMacros();
      });
    });

    function getTotalG() {
      if (currentMode === 'g')   return parseFloat(document.getElementById('qty-g')?.value) || 0;
      if (currentMode === 'srv') return (parseFloat(document.getElementById('qty-srv')?.value) || 0) * srv;
      if (currentMode === 'pcs') {
        return (parseFloat(document.getElementById('qty-g-per-pc')?.value) || 0)
             * (parseFloat(document.getElementById('qty-pcs')?.value) || 0);
      }
      return 0;
    }

    function updateMacros() {
      const qty = getTotalG();
      const r   = qty / 100;
      const pcLabel = document.getElementById('pcs-total-g');
      if (pcLabel) pcLabel.textContent = `= ${qty.toFixed(1)}g total`;

      const cal = food.calories_per_100g != null ? fmtE(food.calories_per_100g * r) : '–';
      const pro = food.protein_per_100g  != null ? (food.protein_per_100g  * r).toFixed(1) : '–';
      const crb = food.carbs_per_100g    != null ? (food.carbs_per_100g    * r).toFixed(1) : '–';
      const fat = food.fat_per_100g      != null ? (food.fat_per_100g      * r).toFixed(1) : '–';

      document.getElementById('qty-macros').innerHTML = `
        <div class="qty-macro"><div class="qty-macro-val num">${cal}</div><div class="qty-macro-lbl">${ul}</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--protein)">${pro}g</div><div class="qty-macro-lbl">protein</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--carbs)">${crb}g</div><div class="qty-macro-lbl">carbs</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--fat)">${fat}g</div><div class="qty-macro-lbl">fat</div></div>
      `;
    }

    ['qty-g','qty-srv','qty-g-per-pc','qty-pcs'].forEach(id =>
      document.getElementById(id)?.addEventListener('input', updateMacros)
    );
    content.querySelectorAll('.quick-g').forEach(btn => {
      btn.addEventListener('click', () => { document.getElementById('qty-g').value = btn.dataset.g; updateMacros(); });
    });
    content.querySelectorAll('.quick-srv').forEach(btn => {
      btn.addEventListener('click', () => { document.getElementById('qty-srv').value = btn.dataset.s; updateMacros(); });
    });

    updateMacros();

    document.getElementById('qty-back').addEventListener('click', () => openFoodEntry(sessionId, onSuccess));
    document.getElementById('qty-close').addEventListener('click', hideSheet);

    document.getElementById('qty-confirm-btn').addEventListener('click', async () => {
      const qty = getTotalG();
      if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
      const btn = document.getElementById('qty-confirm-btn');
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        await api.post(`/api/meals/sessions/${sessionId}/entries`, { food_id: food.id, quantity_g: qty });
        hideSheet();
        showToast('Added to meal', 'success');
        onSuccess?.();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Add to Meal';
      }
    });
  });
}

// ── Shared meal card: header (rename/copy/move/delete) + entry rows
// (copy/edit/delete) + add-food footer. Used by both Today and History so
// the two views can't drift into different UX for the same actions.
//   opts: { showTime, showMoveToday, showTemplate, showPullIn, showQuickLog }
export function renderMealCard(session, viewDate, opts = {}, onDone) {
  const { showTime = false, showMoveToday = false, showTemplate = false, showPullIn = false, showQuickLog = false } = opts;
  const ul = unitLabel();
  const sessionKcal    = session.entries.reduce((s, e) => s + (e.calories || 0), 0);
  const sessionProtein = Math.round(session.entries.reduce((s, e) => s + (e.protein || 0), 0));
  const sessionCarb    = Math.round(session.entries.reduce((s, e) => s + (e.carbs   || 0), 0));
  const sessionFat     = Math.round(session.entries.reduce((s, e) => s + (e.fat     || 0), 0));
  const timeStr        = showTime ? formatTime(session.logged_at) : '';

  const sessionEl = document.createElement('div');
  sessionEl.className = 'meal-session';
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
        ${showMoveToday ? `<button class="session-move-btn" title="Move to today"
          style="font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 9px;border-radius:999px;border:1px solid rgba(200,184,255,.2);white-space:nowrap">
          → Today
        </button>` : ''}
        ${showTemplate ? `<button class="session-save-tmpl-btn" title="Save as template" style="color:var(--text-faint);padding:4px;font-size:15px">🔖</button>` : ''}
        ${showPullIn ? `<button class="session-copy-btn" title="Pull a past meal in" style="color:var(--text-faint);padding:4px;font-size:15px">♻️</button>` : ''}
        <button class="session-copyout-btn" title="Copy this meal to…" style="color:var(--text-faint);padding:4px;font-size:14px">⧉</button>
        <button class="session-del-btn" title="Delete" style="color:var(--text-faint);padding:4px">
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
      <div style="font-size:20px;flex-shrink:0;width:30px;text-align:center">${getFoodIcon(entry.food_name)}</div>
      <div class="meal-entry-info">
        <div class="meal-entry-name">${esc(entry.food_name)}</div>
        <div class="meal-entry-sub"><span style="color:var(--text)">${fmt(entry.quantity_g)}g</span> <span style="color:var(--text-faint)">·</span>
          <span style="color:var(--protein)">${fmt(entry.protein)}P</span>
          <span style="color:var(--carbs)">${fmt(entry.carbs)}C</span>
          <span style="color:var(--fat)">${fmt(entry.fat)}F</span>
        </div>
      </div>
      <div class="meal-entry-kcal">${fmtE(entry.calories)}</div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="entry-copy-btn" title="Copy to…" style="width:30px;height:30px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:13px">⧉</button>
        <button class="entry-edit-btn" title="Edit" style="width:30px;height:30px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:12px">✏️</button>
        <button class="entry-del-btn" title="Delete" style="width:30px;height:30px;border-radius:50%;background:rgba(255,107,107,.1);color:var(--error);display:flex;align-items:center;justify-content:center;font-size:15px">×</button>
      </div>
    `;

    entryEl.querySelector('.entry-copy-btn').addEventListener('click', () => openCopyEntry(entry, viewDate, onDone));
    entryEl.querySelector('.entry-edit-btn').addEventListener('click', () => openEditEntry(entry, onDone));
    entryEl.querySelector('.entry-del-btn').addEventListener('click', async () => {
      try {
        await api.delete(`/api/meals/entries/${entry.id}`);
        entryEl.style.opacity = '0'; entryEl.style.transition = 'opacity .2s';
        setTimeout(() => onDone?.(), 200);
        // Undo re-adds the same food+quantity to the same meal (macros recalc
        // from the food record — same math that created the original entry).
        showToast(`${entry.food_name} deleted`, 'info', {
          actionLabel: 'Undo',
          onAction: async () => {
            try {
              await api.post(`/api/meals/sessions/${entry.meal_session_id}/entries`,
                { food_id: entry.food_id, quantity_g: entry.quantity_g });
              onDone?.();
            } catch (err) { showToast(err.message, 'error'); }
          },
        });
      } catch (err) { showToast(err.message, 'error'); }
    });
    sessionEl.appendChild(entryEl);
  });

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;border-top:1px solid var(--border)';
  const addBtn = document.createElement('button');
  addBtn.className = 'meal-session-add'; addBtn.style.flex = '1';
  addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Add Food`;
  addBtn.addEventListener('click', () => openFoodEntry(session.id, onDone));
  footer.appendChild(addBtn);
  if (showQuickLog) {
    const qlBtn = document.createElement('button');
    qlBtn.className = 'meal-session-add';
    qlBtn.style.cssText = 'flex:0 0 auto;border-left:1px solid var(--border);color:var(--carbs)';
    qlBtn.textContent = '⚡ Quick Log';
    qlBtn.addEventListener('click', () => openQuickLog(session.id, onDone));
    footer.appendChild(qlBtn);
  }
  sessionEl.appendChild(footer);

  sessionEl.querySelector('.session-rename-btn').addEventListener('click', () =>
    openRenameSession(session.id, session.name, onDone)
  );
  if (showTemplate) {
    sessionEl.querySelector('.session-save-tmpl-btn').addEventListener('click', () => openSaveAsTemplate(session));
  }
  if (showPullIn) {
    sessionEl.querySelector('.session-copy-btn').addEventListener('click', () => openCopyPastMeal(session.id, onDone));
  }
  sessionEl.querySelector('.session-copyout-btn').addEventListener('click', () => openCopyMeal(session, viewDate, onDone));
  sessionEl.querySelector('.session-del-btn').addEventListener('click', async () => {
    if (!confirm(`Delete "${session.name}" and all its entries?`)) return;
    try { await api.delete(`/api/meals/sessions/${session.id}`); showToast('Meal deleted', 'success'); onDone?.(); }
    catch (err) { showToast(err.message, 'error'); }
  });
  sessionEl.querySelector('.session-move-btn')?.addEventListener('click', async () => {
    try {
      await api.patch(`/api/meals/sessions/${session.id}`, { date: localDate() });
      showToast(`"${session.name}" moved to today`, 'success');
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); }
  });

  return sessionEl;
}
