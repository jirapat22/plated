import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }               from '../components/foodSearch.js';
import { fmtE, unitLabel, wireEnergyUnitToggle } from '../utils/energy.js';
import { localDate }                      from '../utils/date.js';
import { getFoodIcon }                    from '../utils/foodIcon.js';
import { openPortion }                    from './batches.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Clicking anywhere closes any open meal menu. Registered ONCE for the module,
// not per card: the per-card version added a document listener for every meal
// on every render, and nothing ever removed them — scroll through a month of
// History and you leave hundreds behind. Same leak class as the chart instances
// that used to survive a view swap.
const closeAllMenus = () => document.querySelectorAll('.session-menu').forEach(m => { m.style.display = 'none'; });
document.addEventListener('click', closeAllMenus);

// Move: an arrow travelling into a wall. Stroked at 1.7 to match the nav and
// ring icons rather than adding another emoji to a row that has two already —
// and shaped to say "send this away", where the ⧉ beside it says "duplicate".
const ICON_MOVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><path d="M4 12h11M11 7.5l4.5 4.5L11 16.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.5 5v14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
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

// ── Deferred meal creation ───────────────────────────────────
// Every "log something" button used to POST a meal session first and open the
// sheet second, so backing out of the sheet left an empty "Meal 3" on the day
// forever — nothing ever cleans those up. Pass one of these instead of an id
// and the meal is only created once a food is actually going into it.
// The promise is memoised so two adds from one sheet share a meal, and cleared
// on failure so a retry isn't stuck with the rejection.
export function lazySession(date, name) {
  let pending = null;
  return () => (pending ??= api.post('/api/meals/sessions', { date, name })
    .then(s => s.id)
    .catch(err => { pending = null; throw err; }));
}

// Accepts either a plain session id or a lazySession thunk.
export const sessionIdOf = ref => (typeof ref === 'function' ? ref() : Promise.resolve(ref));

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
// opts: { targetLabel, newLabel, days, defaultDate } — Move reuses this whole
// sheet and only needs different words and a past-leaning day strip, which is
// cheaper than a second near-identical sheet that then drifts from this one.
function destinationSheet(title, subtitle, viewDate, excludeSessionId, initialOthers, onPick, opts = {}) {
  showSheet(content => {
    const today = localDate();
    const quickDays = opts.days || [today, ...Array.from({ length: 7 }, (_, i) => addDaysIso(today, i + 1))];
    // Compare dates, don't count positions. The index-based version read
    // "Today/Tomorrow" off the first two slots, which is only true for the copy
    // strip — hand it any other order and it labels yesterday "Tomorrow". Same
    // bug the batch portion picker already shipped once.
    const dayLabel = iso => iso === today ? 'Today'
      : iso === addDaysIso(today, 1)  ? 'Tomorrow'
      : iso === addDaysIso(today, -1) ? 'Yesterday'
      : new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    let selectedDate = opts.defaultDate || quickDays[1];   // copy defaults to tomorrow — the common case

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">${title}</span>
        <button class="sheet-close" id="cp-close">✕</button>
      </div>
      <div style="padding:0 16px">
        ${subtitle}
        <label class="form-label">Date</label>
        <div id="cp-days" style="display:flex;gap:6px;overflow-x:auto;padding:6px 0 10px;-webkit-overflow-scrolling:touch">
          ${quickDays.map(d => `<button type="button" class="fs-chip cp-day${d === selectedDate ? ' active' : ''}" data-date="${d}" style="flex-shrink:0">${dayLabel(d)}</button>`).join('')}
        </div>
        <button type="button" id="cp-custom-toggle" style="font-size:12px;color:var(--accent);font-weight:600;padding:2px 0;margin-bottom:4px">Pick another date…</button>
        <input class="input" id="cp-date-custom" type="date" max="${addDaysIso(today, 7)}" style="display:none;margin-bottom:14px"/>
        <label class="form-label">${opts.targetLabel || 'Copy into'}</label>
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
      ).join('') + `<button class="cp-target btn btn-secondary" data-sid="new" style="justify-content:flex-start;color:var(--accent)">${opts.newLabel || '+ New meal'}</button>`;
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

// ── Move a meal: to its own slot on another day, or into a meal already there ─
// Two different server calls behind one picker, because they are two different
// operations wearing the same intent:
//   "Its own meal"  -> PATCH date. The session survives; meal_index is
//                      recalculated so it can't collide on the target day.
//   an existing meal -> POST /merge. The entries are re-parented and this
//                      session stops existing.
// Neither duplicates anything, which is the whole difference from Copy — and
// the reason merge does no batch-stock or use-count bookkeeping.
//
// Past-leaning day strip: the reason to move a meal is nearly always that it
// landed on the wrong day, and the wrong day is usually the one just gone.
export async function openMoveMeal(session, viewDate, onDone) {
  const today = localDate();
  const others = (await dayMeals(viewDate)).filter(s => s.id !== session.id);
  const n = (session.entries || []).length;
  const sub = `<div style="font-size:15px;font-weight:600">${esc(session.name || 'Meal')}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${n} food${n === 1 ? '' : 's'} · moves off ${esc(viewDate)}, nothing is left behind</div>`;
  const days = [addDaysIso(today, -1), today, addDaysIso(today, 1), addDaysIso(today, -2), addDaysIso(today, -3)];
  destinationSheet('Move meal', sub, viewDate, session.id, others, async (date, sid) => {
    // Moving it to the day it is already on, as its own meal, is a no-op —
    // don't spend a request or claim in a toast that something happened.
    if (sid === 'new' && date === viewDate) { hideSheet(); return; }
    try {
      if (sid === 'new') {
        await api.patch(`/api/meals/sessions/${session.id}`, { date });
        showToast(`Moved to ${date === today ? 'today' : date}`, 'success');
      } else {
        const r = await api.post(`/api/meals/sessions/${session.id}/merge`, { target_session_id: sid });
        showToast(`Merged into ${r.name || 'that meal'}`, 'success');
      }
      hideSheet();
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); }
  }, {
    targetLabel: 'Move into',
    newLabel: 'Its own meal',
    days,
    defaultDate: days.find(d => d !== viewDate),
  });
}

// ── Didn't finish it: split an entry into what you ate and what's left ──
// You type what's LEFT, because that is the number you get from putting the
// container back on the scale — which is the moment this happens. The log
// corrects itself to the difference.
export function openLeftover(entry, onDone) {
  const isQuick = entry.food_source === 'quick';
  const whole   = isQuick ? Math.round(entry.calories || 0) : Math.round(entry.quantity_g || 0);
  const unit    = isQuick ? unitLabel() : 'g';
  // Only worth asking about the pot when there IS a pot. A batch's backing food
  // is the only thing this can go back into.
  const fromBatch = entry.food_source === 'batch';

  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">🥡 Didn't finish it</span>
        <button class="sheet-close" id="lo-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:15px;font-weight:600">${esc(entry.food_name)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${whole} ${unit} logged${
          isQuick ? ' · typed as calories, so leave calories' : ''}</div>
        <div class="form-group">
          <label class="form-label">How much is left over?</label>
          <div style="position:relative">
            <input class="input" id="lo-amount" type="text" inputmode="decimal" placeholder="e.g. ${Math.round(whole / 3)}"
              style="height:48px;font-size:18px;font-weight:700;padding-right:44px"/>
            <span style="position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--text-muted)">${unit}</span>
          </div>
        </div>
        <div id="lo-preview" style="font-size:12px;color:var(--text-faint);min-height:18px;margin-bottom:14px"></div>
        ${fromBatch ? `
        <label class="form-label">Where does the rest go?</label>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
          <button class="lo-dest btn btn-secondary active" data-batch="1" style="justify-content:flex-start">Back into the batch</button>
          <button class="lo-dest btn btn-secondary" data-batch="0" style="justify-content:flex-start">Keep as a leftover portion</button>
        </div>` : ''}
        <button class="btn btn-primary btn-full" id="lo-save">Save the rest</button>
      </div>`;

    let toBatch = fromBatch;
    const input = document.getElementById('lo-amount');
    const prev  = document.getElementById('lo-preview');
    const upd = () => {
      const v = parseFloat(input.value);
      prev.textContent = !(v > 0) ? ''
        : v >= whole ? "That's all of it — delete the entry instead."
        : `You ate ${Math.round(whole - v)} ${unit}, saving ${Math.round(v)} ${unit}.`;
    };
    input.addEventListener('input', upd);
    content.querySelectorAll('.lo-dest').forEach(b => b.addEventListener('click', () => {
      toBatch = b.dataset.batch === '1';
      content.querySelectorAll('.lo-dest').forEach(x => x.classList.toggle('active', x === b));
    }));
    document.getElementById('lo-close').addEventListener('click', hideSheet);
    document.getElementById('lo-save').addEventListener('click', async e => {
      const v = parseFloat(input.value);
      if (!(v > 0))     return showToast(`Enter how much is left, in ${unit}`, 'error');
      if (v >= whole)   return showToast("That's the whole thing — delete the entry instead", 'error');
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const body = isQuick ? { left_kcal: v } : { left_g: v, to_batch: toBatch };
        const r = await api.post(`/api/meals/entries/${entry.id}/leftover`, body);
        hideSheet();
        showToast(r.to_batch ? `${Math.round(v)} ${unit} back into the batch` : `Saved ${Math.round(v)} ${unit} as a leftover`, 'success');
        onDone?.();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Save the rest';
      }
    });
    setTimeout(() => input.focus(), 60);
  });
}

// ── Didn't finish the whole plate ────────────────────────────
// A fraction rather than a weight: a mixed plate can't be weighed back per
// food. Every food scales by the same share, which is an approximation and
// says so — the per-entry 🥡 stays the exact tool for an uneven plate.
export function openMealLeftover(session, onDone) {
  const kcal = (session.entries || []).reduce((s, e) => s + (e.calories || 0), 0);
  const n = (session.entries || []).length;
  const ul = unitLabel();

  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">🥡 Didn't finish it</span>
        <button class="sheet-close" id="ml-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:15px;font-weight:600">${esc(session.name || 'Meal')}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${n} food${n === 1 ? '' : 's'} · ${fmtE(kcal)} ${ul} logged</div>
        <label class="form-label">How much did you eat?</label>
        <div style="display:flex;gap:6px;margin:6px 0 10px">
          ${[['¼', .25], ['⅓', .34], ['½', .5], ['⅔', .67], ['¾', .75]].map(([l, v]) =>
            `<button type="button" class="fs-chip ml-frac" data-ate="${v}" style="flex:1">${l}</button>`).join('')}
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input class="input" id="ml-pct" type="text" inputmode="decimal" placeholder="or type a %" style="flex:1"/>
          <span style="color:var(--text-muted)">%</span>
        </div>
        <div id="ml-prev" style="font-size:12px;color:var(--text-faint);min-height:34px;line-height:1.5;margin-bottom:12px"></div>
        ${n > 1 ? `<div style="font-size:11px;color:var(--text-faint);line-height:1.5;margin-bottom:14px">Scales all ${n} foods equally. If you finished one and left another, use 🥡 on that food instead.</div>` : ''}
        <button class="btn btn-primary btn-full" id="ml-save">Save the rest</button>
      </div>`;

    let ate = null;
    const prev = document.getElementById('ml-prev');
    const pct  = document.getElementById('ml-pct');
    const show = () => {
      prev.textContent = !(ate > 0 && ate < 1) ? ''
        : `You ate ${fmtE(kcal * ate)} ${ul}, saving ${fmtE(kcal * (1 - ate))} ${ul} as one leftover.`;
    };
    const pick = v => {
      ate = v;
      content.querySelectorAll('.ml-frac').forEach(b => b.classList.toggle('active', Math.abs(+b.dataset.ate - v) < 1e-9));
      show();
    };
    content.querySelectorAll('.ml-frac').forEach(b => b.addEventListener('click', () => { pct.value = ''; pick(+b.dataset.ate); }));
    pct.addEventListener('input', () => {
      const v = parseFloat(pct.value) / 100;
      content.querySelectorAll('.ml-frac').forEach(b => b.classList.remove('active'));
      ate = v; show();
    });

    document.getElementById('ml-close').addEventListener('click', hideSheet);
    document.getElementById('ml-save').addEventListener('click', async e => {
      if (!(ate > 0 && ate < 1)) return showToast('Pick how much of it you ate', 'error');
      // Disabled while in flight, like every other save in this app. Without it
      // a double-tap splits the meal twice — the second request halves what the
      // first one left, and both succeed.
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api.post(`/api/meals/sessions/${session.id}/leftover`, { ate });
        hideSheet();
        showToast(`Saved ${fmtE(r.saved.calories)} ${ul} as a leftover`, 'success');
        onDone?.();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false; btn.textContent = 'Save the rest';
      }
    });
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
        const sid = await sessionIdOf(sessionId);
        await api.post(`/api/meals/sessions/${sid}/entries`, { food_id: food.id, quantity_g: 100 });
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
        // Meal-prep batches are reachable here too, so eating from one doesn't
        // mean leaving for the Batches tab. Logs into this meal and draws the
        // batch down, rather than going through the plain quantity sheet.
        onSelectBatch: batch => openPortion(batch, onSuccess, {
          sessionId, sessionName: opts.sessionName,
        }),
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
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
          ${['pro','carb','fat'].map((id, i) => {
            const [label, color] = [['Protein','var(--protein)'],['Carbs','var(--carbs)'],['Fat','var(--fat)']][i];
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
      document.getElementById('edit-cal').value  = entry.calories_per_100g != null ? fmtE(entry.calories_per_100g) : '';
      document.getElementById('edit-pro').value  = entry.protein_per_100g  ?? '';
      document.getElementById('edit-carb').value = entry.carbs_per_100g    ?? '';
      document.getElementById('edit-fat').value  = entry.fat_per_100g      ?? '';
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
            protein_per_100g: parseFloat(document.getElementById('edit-pro').value)  || null,
            carbs_per_100g:   parseFloat(document.getElementById('edit-carb').value) || null,
            fat_per_100g:     parseFloat(document.getElementById('edit-fat').value)  || null,
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
    // What you had last time beats what the packet says. serving_size_g
    // describes the product, not your portion of it — rice ships a 15g serving
    // against your 158g average across 35 logs, egg white 30g against 229g.
    const startQty = food.last_qty_g > 0 ? +(+food.last_qty_g).toFixed(1) : srv;

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
          <input type="text" inputmode="decimal" id="qty-g" class="qty-input" value="${startQty}" min="1" step="1" />
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
      <div style="margin:0 16px 8px;padding:9px 12px;background:rgba(249,115,22,.10);border:1px solid rgba(249,115,22,.3);border-radius:8px;font-size:12px;color:var(--alert);line-height:1.4">
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
        const sid = await sessionIdOf(sessionId);
        await api.post(`/api/meals/sessions/${sid}/entries`, { food_id: food.id, quantity_g: qty });
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
//   opts: { showTime, showMoveToday, showQuickLog }
// showMoveToday is the one-tap "→ Today" shortcut History puts on past meals.
// It is deliberately kept alongside the general Move button: "I logged this on
// the wrong day" is the reason people move a meal, and today is nearly always
// where it belongs, so the common case stays one tap.
export function renderMealCard(session, viewDate, opts = {}, onDone) {
  const { showTime = false, showMoveToday = false, showQuickLog = false } = opts;
  // Same window the server enforces, and only when there is something to split.
  const canLeftoverMeal = (session.entries?.length > 0)
    && (viewDate === localDate() || viewDate === addDaysIso(localDate(), -1));
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
      <span class="meal-session-kcal meal-session-macros num">${fmtE(sessionKcal)} ${ul}${sessionProtein > 0 ? ` · <span style="color:var(--protein);font-weight:600">${sessionProtein}g P</span>` : ''}${sessionCarb > 0 ? ` · <span style="color:var(--carbs);font-weight:600">${sessionCarb}g C</span>` : ''}${sessionFat > 0 ? ` · <span style="color:var(--fat);font-weight:600">${sessionFat}g F</span>` : ''}</span>
      <div class="meal-session-actions">
        ${showMoveToday ? `<button class="session-move-btn" title="Move to today"
          style="font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 9px;border-radius:999px;border:1px solid rgba(200,184,255,.2);white-space:nowrap">
          → Today
        </button>` : ''}
        <button class="session-more-btn" title="More" style="color:var(--text-faint);padding:4px 6px;font-size:16px;line-height:1">⋮</button>
        <button class="session-del-btn" title="Delete" style="color:var(--text-faint);padding:4px">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
    <!-- An expanding row, not a floating dropdown. .meal-session is
         overflow:hidden to clip its rounded corners, so an absolutely
         positioned menu was being cut off — worst on a one-item meal, where the
         card is shorter than the menu. Escaping the clip would have meant
         position:fixed and hand-computed coordinates, which then has to fight
         the zoom: var(--ui-scale) the text-scaling feature puts on the scroll
         container. A row in normal flow just makes the card taller. -->
    <div class="session-menu" style="display:none;border-bottom:1px solid var(--border);background:var(--surface-2)">
      ${canLeftoverMeal ? `<button class="sm-left" style="display:block;width:100%;text-align:left;padding:12px 16px;font-size:13px;color:var(--text)">🥡 Didn't finish it</button>` : ''}
      <button class="sm-move" style="display:block;width:100%;text-align:left;padding:12px 16px;font-size:13px;color:var(--text)">Move to another day</button>
      <button class="sm-copy" style="display:block;width:100%;text-align:left;padding:12px 16px;font-size:13px;color:var(--text)">Copy to…</button>
    </div>
  `;

  session.entries.forEach(entry => {
    // Quick Log has no weight — it stores the calories you typed as a 100g
    // "food" and logs exactly 100g of it, so the per-100g maths the rest of the
    // app runs on comes out right. That 100g is bookkeeping, not something you
    // put on a scale, so showing it invited the obvious question.
    const isQuick = entry.food_source === 'quick';
    // Only offered on days the food could still plausibly be in the fridge.
    // The server enforces the same window; this just avoids showing a button
    // that would come back with an error.
    const canLeftover = viewDate === localDate() || viewDate === addDaysIso(localDate(), -1);
    const entryEl = document.createElement('div');
    entryEl.className = 'meal-entry';
    entryEl.innerHTML = `
      <div style="font-size:20px;flex-shrink:0;width:30px;text-align:center">${getFoodIcon(entry.food_name)}</div>
      <div class="meal-entry-info">
        <div class="meal-entry-name">${esc(entry.food_name)}</div>
        <div class="meal-entry-sub">${isQuick
          ? '<span style="color:var(--text-faint)">⚡ quick</span>'
          : `<span style="color:var(--text)">${fmt(entry.quantity_g)}g</span>`} <span style="color:var(--text-faint)">·</span>
          <span style="color:var(--protein)">${fmt(entry.protein)}P</span>
          <span style="color:var(--carbs)">${fmt(entry.carbs)}C</span>
          <span style="color:var(--fat)">${fmt(entry.fat)}F</span>
        </div>
      </div>
      <div class="meal-entry-kcal">${fmtE(entry.calories)}</div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        ${canLeftover ? `<button class="entry-left-btn" title="Didn't finish it — save the rest" style="width:30px;height:30px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:13px">🥡</button>` : ''}
        <button class="entry-copy-btn" title="Copy to…" style="width:30px;height:30px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:13px">⧉</button>
        <button class="entry-edit-btn" title="Edit" style="width:30px;height:30px;border-radius:50%;background:var(--surface-2);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:12px">✏️</button>
        <button class="entry-del-btn" title="Delete" style="width:30px;height:30px;border-radius:50%;background:rgba(255,107,107,.1);color:var(--error);display:flex;align-items:center;justify-content:center;font-size:15px">×</button>
      </div>
    `;

    entryEl.querySelector('.entry-left-btn')?.addEventListener('click', () => openLeftover(entry, onDone));
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
  addBtn.addEventListener('click', () => openFoodEntry(session.id, onDone, { sessionName: session.name }));
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
  // Overflow menu. The header row was at four buttons on a past day and the
  // title already loses to them below 430px; the seldom-used actions move
  // behind ⋮ rather than the row growing a fifth.
  const menu = sessionEl.querySelector('.session-menu');
  const closeMenu = () => { menu.style.display = 'none'; };
  sessionEl.querySelector('.session-more-btn').addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.style.display === 'block';
    // Only ever one open: a second card's menu left the first one hanging.
    closeAllMenus();
    menu.style.display = open ? 'none' : 'block';
  });
  menu.querySelector('.sm-move').addEventListener('click', () => { closeMenu(); openMoveMeal(session, viewDate, onDone); });
  menu.querySelector('.sm-copy').addEventListener('click', () => { closeMenu(); openCopyMeal(session, viewDate, onDone); });
  menu.querySelector('.sm-left')?.addEventListener('click', () => { closeMenu(); openMealLeftover(session, onDone); });
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
