import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet, getProfile, showConfirm } from '../app.js';
import { queueWrite }                     from '../utils/writeQueue.js';
import { savePresetFrom, openPresetLog }  from './presets.js';
import { newClientId }                    from '../utils/offlineStore.js';
import { renderFoodSearch }               from '../components/foodSearch.js';
import { fmtE, unitLabel, toKcal, wireEnergyUnitToggle } from '../utils/energy.js';
import { localDate, addDaysIso }          from '../utils/date.js';
import { getFoodIcon }                    from '../utils/foodIcon.js';
import { openPortion, openLeftoverLog }   from './batches.js';

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

// ── Deferred meal creation ───────────────────────────────────
// Every "log something" button used to POST a meal session first and open the
// sheet second, so backing out of the sheet left an empty "Meal 3" on the day
// forever — nothing ever cleans those up. Pass one of these instead of an id
// and the meal is only created once a food is actually going into it.
// The promise is memoised so two adds from one sheet share a meal, and cleared
// on failure so a retry isn't stuck with the rejection.
export function lazySession(date, name) {
  let pending = null;
  const thunk = () => (pending ??= api.post('/api/meals/sessions', { date, name })
    .then(s => s.id)
    .catch(err => { pending = null; throw err; }));
  // The date and name hang off the thunk so a caller can read the INTENT
  // without forcing the session into existence. /api/meals/log needs exactly
  // that: it wants "a meal on this date", not an id, and calling the thunk to
  // find out would defeat the deferral this whole helper exists for — and is
  // impossible offline anyway.
  thunk.date = date;
  thunk.mealName = name;
  return thunk;
}

// Accepts either a plain session id or a lazySession thunk.
export const sessionIdOf = ref => (typeof ref === 'function' ? ref() : Promise.resolve(ref));
// The date a ref refers to, without creating anything. A plain id carries no
// date of its own, so callers that hold one pass it alongside.
const refDate = (ref, fallback) => (typeof ref === 'function' ? ref.date : fallback) || localDate();
const refSessionId = ref => (typeof ref === 'function' ? null : ref ?? null);

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
    // Two days back as well as forward. The strip was today plus the next
    // seven, which serves meal-prep and not the commoner reason for copying a
    // food: you ate the same thing recently and forgot to log it. Yesterday was
    // reachable only through "Pick another date…", and dayLabel already knew
    // the word.
    const quickDays = opts.days || [
      addDaysIso(today, -2), addDaysIso(today, -1), today,
      ...Array.from({ length: 5 }, (_, i) => addDaysIso(today, i + 1)),
    ];
    // Compare dates, don't count positions. The index-based version read
    // "Today/Tomorrow" off the first two slots, which is only true for the copy
    // strip — hand it any other order and it labels yesterday "Tomorrow". Same
    // bug the batch portion picker already shipped once.
    const dayLabel = iso => iso === today ? 'Today'
      : iso === addDaysIso(today, 1)  ? 'Tomorrow'
      : iso === addDaysIso(today, -1) ? 'Yesterday'
      : new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    // By date, not by index. quickDays[1] happened to be tomorrow only while the
    // strip started at today; the comment above this block is the same warning.
    let selectedDate = opts.defaultDate || addDaysIso(today, 1);   // copy still defaults to tomorrow
    // Optional Copy/Move switch. An entry row is already four icons wide and a
    // fifth would be the first thing to fall off at 150% text, so the second
    // verb lives inside the sheet the first one opens rather than beside it.
    // The picker itself is identical either way — same days, same meals.
    let mode = opts.modes?.[0]?.id ?? null;

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">${title}</span>
        <button class="sheet-close" id="cp-close">✕</button>
      </div>
      <div style="padding:0 16px">
        ${subtitle}
        ${opts.modes ? `<div id="cp-modes" style="display:flex;gap:6px;margin-bottom:14px">
          ${opts.modes.map((m, i) => `<button type="button" class="fs-chip cp-mode${i === 0 ? ' active' : ''}" data-mode="${m.id}" style="flex:1">${m.label}</button>`).join('')}
        </div>` : ''}
        <label class="form-label">Date</label>
        <div id="cp-days" style="display:flex;gap:6px;overflow-x:auto;padding:6px 0 10px;-webkit-overflow-scrolling:touch">
          ${quickDays.map(d => `<button type="button" class="fs-chip cp-day${d === selectedDate ? ' active' : ''}" data-date="${d}" style="flex-shrink:0">${dayLabel(d)}</button>`).join('')}
        </div>
        <button type="button" id="cp-custom-toggle" style="font-size:12px;color:var(--accent);font-weight:600;padding:2px 0;margin-bottom:4px">Pick another date…</button>
        <input class="input" id="cp-date-custom" type="date" max="${addDaysIso(today, 7)}" style="display:none;margin-bottom:14px"/>
        <label class="form-label" id="cp-target-label">${opts.modes?.[0]?.targetLabel || opts.targetLabel || 'Copy into'}</label>
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
      // Disabled the moment one is tapped. These three sheets (copy entry,
      // copy meal, move meal) were the only saves in the app with no in-flight
      // guard, and the sheet stays up for the whole round trip — so a double
      // tap ran the whole thing twice. On a meal holding a batch portion that
      // is two extra meals AND twice the grams out of the pot, and only the
      // meals are visible enough to notice. onPick re-enables them if it fails.
      targetsBox.querySelectorAll('.cp-target').forEach(btn =>
        btn.addEventListener('click', () => {
          const all = [...targetsBox.querySelectorAll('.cp-target')];
          all.forEach(b => { b.disabled = true; });
          const revive = () => all.forEach(b => { b.disabled = false; });
          onPick(date, btn.dataset.sid, mode, revive);
        }));
    }

    function selectDate(date) {
      selectedDate = date;
      daysBox.querySelectorAll('.cp-day').forEach(b => b.classList.toggle('active', b.dataset.date === date));
      renderTargets();
    }

    daysBox.querySelectorAll('.cp-day').forEach(btn =>
      btn.addEventListener('click', () => selectDate(btn.dataset.date)));

    content.querySelectorAll('.cp-mode').forEach(btn => btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      content.querySelectorAll('.cp-mode').forEach(b => b.classList.toggle('active', b === btn));
      // The verb is the whole difference, so say it in the title and above the
      // list of meals too — a chip alone is easy to miss having pressed.
      const m = opts.modes.find(x => x.id === mode);
      const t = content.querySelector('.sheet-title');
      if (t && m?.title) t.textContent = m.title;
      const lbl = content.querySelector('#cp-target-label');
      if (lbl && m?.targetLabel) lbl.textContent = m.targetLabel;
    }));

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
  // One id for this copy, reused if the first attempt fails and is retried —
  // the same rule as the quantity sheet. This route has always supported the
  // replay guard and this caller never sent it anything.
  const copyId = newClientId();
  const copyTo = sid => api.post(`/api/meals/sessions/${sid}/entries`,
    { food_id: entry.food_id, quantity_g: entry.quantity_g, client_id: copyId });
  // lazySession, not an eager POST. Creating the meal and then writing into it
  // is two round trips, and ANY failure between them — a deleted entry, a food
  // gone, the connection dropping — left an empty "Meal 6" on the day that
  // nothing cleans up. That is the exact litter lazySession was built for, and
  // every logging sheet was converted to it except this one.
  const newSession = date => lazySession(date)();
  // Moving is a re-parent, not a copy-then-delete: the same row changes which
  // meal it belongs to, so nothing is duplicated and nothing has to be deleted
  // afterwards. The server leaves batch stock and use counts alone for exactly
  // that reason — nothing new was eaten.
  const moveTo = sid => api.patch(`/api/meals/entries/${entry.id}`, { meal_session_id: sid });
  const sub = `<div style="font-size:15px;font-weight:600">${esc(entry.food_name)}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${Math.round(entry.quantity_g)}g · ${fmtE(entry.calories)} ${unitLabel()}</div>`;
  destinationSheet('Copy food', sub, viewDate, entry.meal_session_id, others, async (date, sid, mode, revive) => {
    const moving = mode === 'move';
    try {
      const target = sid === 'new' ? await newSession(date) : sid;
      await (moving ? moveTo(target) : copyTo(target));
      hideSheet();
      const where = date === localDate() ? 'today' : date;
      showToast(
        moving ? (sid === 'new' ? `Moved to ${where}` : 'Moved')
               : (sid === 'new' ? (date === localDate() ? 'Copied to today' : `Copied to ${date}`) : 'Copied'),
        'success');
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); revive?.(); }
  }, {
    modes: [
      { id: 'copy', label: '⧉ Copy', title: 'Copy food', targetLabel: 'Copy into' },
      { id: 'move', label: '→ Move', title: 'Move food', targetLabel: 'Move into' },
    ],
  });
}

// Copy a whole meal (all foods) to a new meal on a day, or merge into an existing meal.
export async function openCopyMeal(session, viewDate, onDone) {
  const others = (await dayMeals(viewDate)).filter(s => s.id !== session.id);
  // Same one-id rule. /copy draws batch stock for every food it copies, so a
  // retry without an id is the most expensive duplicate in the app.
  const copyMealId = newClientId();
  const copy = body => api.post(`/api/meals/sessions/${session.id}/copy`,
    { ...body, client_id: copyMealId });
  const n = (session.entries || []).length;
  const sub = `<div style="font-size:15px;font-weight:600">${esc(session.name || 'Meal')}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${n} food${n === 1 ? '' : 's'} · copied with the same amounts</div>`;
  destinationSheet('Copy meal', sub, viewDate, session.id, others, async (date, sid, _mode, revive) => {
    try {
      await copy(sid === 'new' ? { date } : { target_session_id: sid });
      hideSheet();
      showToast(sid === 'new' ? (date === localDate() ? 'Copied to today' : `Copied to ${date}`) : 'Merged into meal', 'success');
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); revive?.(); }
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
  destinationSheet('Move meal', sub, viewDate, session.id, others, async (date, sid, _mode, revive) => {
    // Moving it to the day it is already on, as its own meal, changes nothing —
    // don't spend a request. But say so: closing the sheet in silence reads as
    // a tap that didn't register.
    if (sid === 'new' && date === viewDate) {
      hideSheet();
      showToast('It is already on that day', 'info');
      return;
    }
    try {
      if (sid === 'new') {
        const from = session.date || viewDate;
        await api.patch(`/api/meals/sessions/${session.id}`, { date });
        // Deleting has had an Undo for ages; moving is just as easy to do by
        // accident and was the one that left you hunting for the meal on
        // another day to put it back.
        showToast(`Moved to ${date === today ? 'today' : date}`, 'success', {
          actionLabel: 'Undo',
          onAction: () => undoMove(session.id, from, onDone),
        });
      } else {
        const r = await api.post(`/api/meals/sessions/${session.id}/merge`, { target_session_id: sid });
        // Merge is the destructive one: the meal it emptied stops existing and
        // its entries become indistinguishable from the ones already there. The
        // server hands back which entries moved and what the meal was called,
        // which is exactly enough to build it again.
        showToast(`Merged into ${r.name || 'that meal'}`, 'success', {
          actionLabel: 'Undo',
          onAction: () => undoMerge(r.undo, onDone),
        });
      }
      hideSheet();
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); revive?.(); }
  }, {
    targetLabel: 'Move into',
    newLabel: 'Its own meal',
    days,
    defaultDate: days.find(d => d !== viewDate),
  });
}

// Putting a move back is the same call in reverse.
async function undoMove(sessionId, backTo, onDone) {
  try {
    await api.patch(`/api/meals/sessions/${sessionId}`, { date: backTo });
    showToast('Move undone', 'info');
    onDone?.();
  } catch (err) { showToast(err.message, 'error'); }
}

// Putting a merge back means re-making the meal and sending its entries home.
// Both are ordinary routes; the only thing that could not be reconstructed
// afterwards is WHICH entries were the source meal's, and merge now says.
async function undoMerge(undo, onDone) {
  // Not `entry_ids.length` — merging an EMPTY meal moves nothing and still
  // destroys the meal and its name, which is the thing undo is putting back.
  // Found by merging one in a browser: the toast offered Undo and then refused.
  if (!undo) return showToast("That merge can't be undone", 'error');
  try {
    const back = await api.post('/api/meals/sessions', { date: undo.date, name: undo.name });
    // allSettled, not a loop that aborts on the first throw.
    //
    // It used to stop at the first failure — and an entry that has since been
    // deleted or moved answers 404 — so tapping Undo added an EMPTY ghost meal
    // to the day, left the merge standing, and said only "Entry not found".
    // Reproduced. A mid-way 502 on a multi-entry meal did the same with some
    // entries home and some not, and no way to tell which.
    const results = await Promise.allSettled(undo.entry_ids.map(
      id => api.patch(`/api/meals/entries/${id}`, { meal_session_id: back.id })));
    const landed = results.filter(r => r.status === 'fulfilled').length;
    if (landed === 0 && undo.entry_ids.length) {
      // Nothing came home, so the meal we just made is litter. Take it back out.
      try { await api.delete(`/api/meals/sessions/${back.id}`); } catch { /* best effort */ }
      throw new Error('None of those foods could be moved back');
    }
    showToast(landed < undo.entry_ids.length
      ? `"${undo.name || 'Meal'}" partly put back — ${undo.entry_ids.length - landed} food(s) had already moved on`
      : `"${undo.name || 'Meal'}" put back`, 'info');
    onDone?.();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── "Ate light", taken back ──────────────────────────────────
// Marking a day as a genuinely light one is the only action in the app that
// makes the numbers worse: an under-logged day is normally held OUT of your
// averages and your real-maintenance estimate, and confirming it is what pulls
// it back in. The route has accepted a null status — "forget I said that" —
// since it was written, and nothing ever sent one, so the tap was permanent.
// Worse than permanent: a confirmed day stops being flagged, so it also
// vanishes from the one list where you might have gone looking for it.
//
// Lives here rather than in logCheck.js because that module is deliberately
// pure — no DOM, no api — so it can be unit tested. Both Today and Trends
// import from this file already.
export async function undoAteLight(date, onDone) {
  try {
    await api.post('/api/meals/log-status', { date, status: null });
    showToast('Back to under-logged — it stays out of your averages', 'info');
    onDone?.();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Didn't finish it: split an entry into what you ate and what's left ──
// You type what's LEFT, because that is the number you get from putting the
// container back on the scale — which is the moment this happens. The log
// corrects itself to the difference.
export function openLeftover(entry, onDone) {
  const isQuick = entry.food_source === 'quick';
  // `whole` stays CANONICAL — kcal for a Quick Log, grams for anything weighed
  // — and only crosses into display units at the edges. A Quick Log's size is
  // energy, and this app can be set to kJ: showing a raw kcal number under a
  // "kJ" label understates it by 4.184x, and taking a typed kJ figure straight
  // into left_kcal saves a leftover four times the size the user meant.
  // disp()/canon() are the boundary; grams pass through both untouched.
  const whole   = isQuick ? Math.round(entry.calories || 0) : Math.round(entry.quantity_g || 0);
  const unit    = isQuick ? unitLabel() : 'g';
  const disp    = v => (isQuick ? fmtE(v) : String(Math.round(v)));
  const canon   = v => (isQuick ? toKcal(v) : v);
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
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${disp(whole)} ${unit} logged${
          isQuick ? ` · typed as energy, so leave ${unit}` : ''}</div>
        <div class="form-group">
          <label class="form-label">How much is left over?</label>
          <div style="position:relative">
            <input class="input" id="lo-amount" type="text" inputmode="decimal" placeholder="e.g. ${disp(whole / 3)}"
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
      // Typed value -> canonical before ANY comparison or arithmetic. Comparing
      // a kJ figure against a kcal `whole` is how "that's all of it" fires on a
      // quarter of the meal.
      const c = canon(parseFloat(input.value));
      prev.textContent = !(c > 0) ? ''
        : c >= whole ? "That's all of it — delete the entry instead."
        : `You ate ${disp(whole - c)} ${unit}, saving ${disp(c)} ${unit}.`;
    };
    input.addEventListener('input', upd);
    content.querySelectorAll('.lo-dest').forEach(b => b.addEventListener('click', () => {
      toBatch = b.dataset.batch === '1';
      content.querySelectorAll('.lo-dest').forEach(x => x.classList.toggle('active', x === b));
    }));
    document.getElementById('lo-close').addEventListener('click', hideSheet);
    document.getElementById('lo-save').addEventListener('click', async e => {
      const c = canon(parseFloat(input.value));
      if (!(c > 0))     return showToast(`Enter how much is left, in ${unit}`, 'error');
      if (c >= whole)   return showToast("That's the whole thing — delete the entry instead", 'error');
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        // left_kcal is kcal by name and by contract — the server stores kcal.
        const body = isQuick ? { left_kcal: c } : { left_g: c, to_batch: toBatch };
        const r = await api.post(`/api/meals/entries/${entry.id}/leftover`, body);
        hideSheet();
        showToast(r.to_batch ? `${disp(c)} ${unit} back into the batch` : `Saved ${disp(c)} ${unit} as a leftover`, 'success');
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
// viewDate is only needed when sessionId is a plain id — a lazySession already
// carries its own date.
export function openQuickLog(sessionId, onSuccess, viewDate) {
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
      // One request, not three. /api/meals/log mints the food, resolves or
      // creates the session and writes the entry in a single transaction —
      // which is what makes a Quick Log queueable at all: the old chain needed
      // ids from earlier links, and a phone with no signal has none of them.
      const payload = {
        quick: {
          name, calories_per_100g: calKcal,
          protein_per_100g: pro, carbs_per_100g: carb, fat_per_100g: fat,
        },
        quantity_g: 100,
        date: refDate(sessionId, viewDate),
        session_id: refSessionId(sessionId),
        meal_name: typeof sessionId === 'function' ? sessionId.mealName : undefined,
      };
      // ONE id for this meal, minted before the attempt and reused by the
      // queued retry below. It used to be minted inline here and then minted
      // AGAIN inside queueWrite, so the two carried different keys — and the
      // server's replay guard is keyed on the id. The case that breaks is the
      // one the whole queue exists for: the request reached the server and
      // committed, the response was lost coming back (a 502 after the
      // transaction, a handover mid-response), and the flush then looked like a
      // brand-new intake. Two meals, two duplicate hidden food rows, two
      // sessions. Reproduced.
      const clientId = newClientId();
      try {
        await api.post('/api/meals/log', { ...payload, client_id: clientId });
        hideSheet();
        showToast('Meal logged', 'success');
        onSuccess?.();
      } catch (err) {
        // Quick Log is the restaurant-with-one-bar case by definition — it
        // exists for food you can't weigh, eaten out. Failing it for want of a
        // connection is failing it exactly when it is needed.
        // .unreachable too, not just .offline. A 502 while Railway redeploys is
        // the same thing from the user's side — the write can't land right now —
        // and it is the more expensive one to refuse: they have already typed
        // the meal. The queue is idempotent and classifyFailure treats
        // unreachable as 'stop', so a queued write waits for the container
        // rather than burning retries against it.
        if (err.offline || err.unreachable) {
          const pid = getProfile()?.id;
          if (pid != null) {
            // Its own try/catch. enqueue is the one offlineStore export with no
            // internal guard, and this await sits INSIDE a catch block — so on
            // a device with site data blocked (a private window, storage
            // switched off) the rejection escaped the handler entirely: no
            // hideSheet, no toast, no re-enable. The sheet sat on a disabled
            // "Logging…" with the typed meal gone and nothing said at all.
            // Falling through to the error path below at least tells them.
            try {
              await queueWrite(pid, '/api/meals/log', payload, clientId);
              hideSheet();
              showToast('Saved — it\'ll sync when you\'re back on', 'success');
              onSuccess?.();
              return;
            } catch { /* can't store it either — report it below */ }
          }
        }
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
      food => showQuantitySheet(food, sessionId, onSuccess, opts),
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
        // The fridge, from where you are actually deciding what to eat. Saving
        // a leftover is offered on the meal (🥡 on the row, 🥡 in the ⋮ menu)
        // because that is where you are when it happens; eating one is offered
        // here for the same reason. It was reachable only via Foods → Batches
        // → scroll past the batches, which also meant it landed in a meal of
        // its own rather than the one being filled.
        onSelectLeftover: leftover => openLeftoverLog(leftover, onSuccess, {
          sessionId, sessionName: opts.sessionName,
          date: refDate(sessionId, opts.date),
        }),
        // A meal preset lands its own meal, named after itself — so it is
        // offered only when the meal being logged into does not exist yet.
        // lazySession is exactly that case, and it carries the date, which is
        // the one thing a preset needs. Adding INTO an open meal is a different
        // act: a preset there would quietly start a SECOND meal beside the one
        // you were filling, which is not what "+ Add" means.
        ...(typeof sessionId === 'function' && sessionId.date ? {
          onSelectPreset: preset => openPresetLog(preset, onSuccess, { date: sessionId.date }),
        } : {}),
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
      ${isQuick ? `
      <div style="padding:0 16px 12px;font-size:12px;color:var(--text-muted);line-height:1.5">
        A Quick Log has no weight — its size is the calories you typed.
      </div>` : `
      <div style="display:flex;gap:6px;padding:4px 16px 12px;flex-wrap:wrap">
        <button class="qty-mode-btn active" data-mode="g">by weight</button>
        <button class="qty-mode-btn" data-mode="srv">by serving (${srv}g)</button>
      </div>`}

      <div id="edit-mode-g" ${isQuick ? 'style="display:none"' : ''}>
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
        <!-- The calories of THIS entry, not the per-100g behind it.
             They were the same number right up until the 🥡 split landed:
             splitting a Quick Log scales its bookkeeping weight (100g → 66.7g)
             while the food keeps its density, so the sheet offered "1,800" over
             a meal card reading "1,200" and typing a correction applied it to
             the wrong one of the two. What you see on the card is what you edit;
             the density is recomputed underneath. -->
        <div class="label" style="margin-bottom:10px">Calories for this meal *</div>
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
    // How many "100 g" this entry is. 1 for an untouched Quick Log (they are
    // logged at exactly 100 g), less once a 🥡 split has scaled it down. Every
    // figure in this sheet is shown multiplied by it and divided back out on
    // save, so the numbers on screen are the ones on the meal card.
    const qUnit = isQuick ? (entry.quantity_g || 100) / 100 : 1;
    const per100 = v => (v == null ? null : v / qUnit);      // entry → food
    const ofEntry = v => (v == null ? null : v * qUnit);     // food → entry

    let getCalKcal = null;
    if (isQuick) {
      getCalKcal = wireEnergyUnitToggle(
        document.getElementById('edit-cal-unit'),
        document.getElementById('edit-cal')
      );
      // The entry's OWN stored figures, not the density multiplied back up.
      // Both describe the same meal, but the round trip through per-100g picks
      // up a rounding unit — a 1,200 kcal card offered "1201" to correct — and
      // the number on the card is the one being corrected. ofEntry only covers
      // the case where the entry never recorded that macro but its food did.
      const g1 = v => (v == null ? '' : Math.round(v * 10) / 10);
      const shown = (onEntry, onFood) => (onEntry != null ? onEntry : ofEntry(onFood));
      document.getElementById('edit-cal').value  = entry.calories != null || entry.calories_per_100g != null
        ? fmtE(shown(entry.calories, entry.calories_per_100g)) : '';
      document.getElementById('edit-pro').value  = g1(shown(entry.protein, entry.protein_per_100g));
      document.getElementById('edit-carb').value = g1(shown(entry.carbs,   entry.carbs_per_100g));
      document.getElementById('edit-fat').value  = g1(shown(entry.fat,     entry.fat_per_100g));
    }

    document.getElementById('edit-confirm').addEventListener('click', async () => {
      // A Quick Log's weight is bookkeeping, not something anyone put on a
      // scale, so this sheet no longer offers to change it — it keeps whatever
      // it has (100 g, or less after a split) and only the calories move.
      const qty = isQuick ? entry.quantity_g : getTotalG();
      if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
      const btn = document.getElementById('edit-confirm');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (isQuick) {
          const calKcal = getCalKcal();
          if (!calKcal) { showToast('Enter the calories', 'error'); btn.disabled = false; btn.textContent = 'Update'; return; }
          const num = id => parseFloat(document.getElementById(id).value) || null;
          await api.patch(`/api/foods/${entry.food_id}`, {
            calories_per_100g: per100(calKcal),
            protein_per_100g: per100(num('edit-pro')),
            carbs_per_100g:   per100(num('edit-carb')),
            fat_per_100g:     per100(num('edit-fat')),
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
// opts rides along so ← Back can rebuild the search it came from. Without it
// the rebuilt sheet had opts = {}, so the 🥡 chip lost the meal's date (and
// fell back to today, which for a History day is the wrong one) and both the
// portion and leftover sheets said "Adding to this meal" instead of naming it.
function showQuantitySheet(food, sessionId, onSuccess, opts = {}) {
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

    // One id for one intent, minted when the sheet opens and re-minted whenever
    // the amount changes.
    //
    // The server has replayed duplicate writes on this route for months and the
    // client never sent an id, so the guard did nothing. It matters here more
    // than anywhere: this route inserts the entry, draws the grams out of a
    // batch AND bumps the use count, and only the first of those is visible
    // enough to notice and undo — so a lost response plus the obvious retap
    // quietly ate twice the batch.
    //
    // Minting per TAP would not have helped: the second tap would carry a new
    // id and write again. It has to survive the retry, which means it lives as
    // long as the amount does — change the amount and it is a different intent,
    // so it gets a new id rather than replaying the old answer.
    let clientId = newClientId();
    const amountChanged = () => { clientId = newClientId(); updateMacros(); };
    ['qty-g','qty-srv','qty-g-per-pc','qty-pcs'].forEach(id =>
      document.getElementById(id)?.addEventListener('input', amountChanged)
    );
    content.querySelectorAll('.quick-g').forEach(btn => {
      btn.addEventListener('click', () => { document.getElementById('qty-g').value = btn.dataset.g; amountChanged(); });
    });
    content.querySelectorAll('.quick-srv').forEach(btn => {
      btn.addEventListener('click', () => { document.getElementById('qty-srv').value = btn.dataset.s; amountChanged(); });
    });
    // Switching between grams / servings / pieces changes the amount too.
    content.querySelectorAll('.qty-mode-btn').forEach(b => b.addEventListener('click', amountChanged));

    updateMacros();

    document.getElementById('qty-back').addEventListener('click', () => openFoodEntry(sessionId, onSuccess, opts));
    document.getElementById('qty-close').addEventListener('click', hideSheet);

    document.getElementById('qty-confirm-btn').addEventListener('click', async () => {
      const qty = getTotalG();
      if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
      const btn = document.getElementById('qty-confirm-btn');
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const sid = await sessionIdOf(sessionId);
        await api.post(`/api/meals/sessions/${sid}/entries`, { food_id: food.id, quantity_g: qty, client_id: clientId });
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
      ${showMoveToday ? `<button class="sm-copy-today" style="display:block;width:100%;text-align:left;padding:12px 16px;font-size:13px;color:var(--text)">↻ Eat this again today</button>` : ''}
      <button class="sm-move" style="display:block;width:100%;text-align:left;padding:12px 16px;font-size:13px;color:var(--text)">Move to another day</button>
      <button class="sm-copy" style="display:block;width:100%;text-align:left;padding:12px 16px;font-size:13px;color:var(--text)">Copy to…</button>
      <button class="sm-preset" style="display:block;width:100%;text-align:left;padding:12px 16px;font-size:13px;color:var(--text)">⭐ Save as a preset</button>
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
      <div class="meal-entry-actions">
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
  footer.className = 'meal-session-footer';
  const addBtn = document.createElement('button');
  addBtn.className = 'meal-session-add';
  addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Add Food`;
  // viewDate rides along so anything opened from here that needs a DAY — the
  // leftover sheet's toast, a preset — knows which one, rather than assuming
  // today. A plain session id carries no date of its own.
  addBtn.addEventListener('click', () => openFoodEntry(session.id, onDone, { sessionName: session.name, date: viewDate }));
  footer.appendChild(addBtn);
  if (showQuickLog) {
    const qlBtn = document.createElement('button');
    qlBtn.className = 'meal-session-add';
    qlBtn.style.cssText = 'border-left:1px solid var(--border);color:var(--carbs)';
    qlBtn.textContent = '⚡ Quick Log';
    qlBtn.addEventListener('click', () => openQuickLog(session.id, onDone, viewDate));
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
  // Repeating a meal you've eaten before is the common reason to look at a past
  // day at all, and it was the long way round: ⋮ → Copy to… → pick today →
  // confirm. Copy already accepts a date, so the whole thing collapses to one
  // tap. Deliberately NOT the same as the "→ Today" button beside it — that one
  // MOVES, for when a meal landed on the wrong day, and taking yesterday's
  // dinner off yesterday is the opposite of what you want here.
  menu.querySelector('.sm-copy-today')?.addEventListener('click', async () => {
    closeMenu();
    try {
      await api.post(`/api/meals/sessions/${session.id}/copy`, { date: localDate() });
      showToast(`${session.name || 'Meal'} added to today`, 'success');
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); }
  });
  menu.querySelector('.sm-move').addEventListener('click', () => { closeMenu(); openMoveMeal(session, viewDate, onDone); });
  menu.querySelector('.sm-copy').addEventListener('click', () => { closeMenu(); openCopyMeal(session, viewDate, onDone); });
  menu.querySelector('.sm-preset').addEventListener('click', () => {
    closeMenu();
    // Quick Log entries are a calories-only stand-in food logged at exactly
    // 100g; saving one into a preset would reuse that one-off row every time,
    // so they are left out and said so.
    // …and they weren't. The filter above checked for a food_id, which a Quick
    // Log has — it just points at a one-off row minted from the words you
    // typed. So "Fish and chips at the shop" went into the preset carrying its
    // bookkeeping 100 g, which the preset sheet then offers as an editable
    // weight: change it to 200 and you have logged 1,800 kcal. The comment
    // described the right behaviour for four months; this is the line that
    // does it.
    // 'batch' and 'leftover' are one-off rows in exactly the same way a
     // 'quick' one is: a batch's backing food belongs to that pot, and a
     // leftover's to that container. A preset holding either re-logs a plate
     // that no longer exists, forever — the same bug as the Quick Log case, one
     // source value over.
    const ONE_OFF = new Set(['quick', 'batch', 'leftover']);
    const usable = (session.entries || []).filter(e => e.food_id && e.quantity_g > 0 && !ONE_OFF.has(e.food_source));
    const items = usable.map(e => ({ food_id: e.food_id, quantity_g: e.quantity_g }));
    if (!items.length) return showToast('Nothing in this meal can be saved as a preset', 'error');
    // Say what was left out rather than silently saving a smaller meal than the
    // one on screen.
    const dropped = (session.entries || []).length - usable.length;
    if (dropped) {
      showToast(`${dropped} item${dropped === 1 ? '' : 's'} left out — Quick Logs, batch portions and leftovers are one-offs, not foods`, 'info', { duration: 5000 });
    }
    savePresetFrom('meal', session.name || 'Saved meal', items);
  });
  menu.querySelector('.sm-left')?.addEventListener('click', () => { closeMenu(); openMealLeftover(session, onDone); });
  sessionEl.querySelector('.session-del-btn').addEventListener('click', async () => {
    // showConfirm, not window.confirm — a suppressed system dialog returns
    // false, and this is the ONLY way to delete a meal, so the feature would
    // simply stop existing with no feedback at all.
    if (!await showConfirm({ title: `Delete "${session.name}"?`,
      body: 'Everything in it goes too.', cta: 'Delete', danger: true })) return;
    try { await api.delete(`/api/meals/sessions/${session.id}`); showToast('Meal deleted', 'success'); onDone?.(); }
    catch (err) { showToast(err.message, 'error'); }
  });
  sessionEl.querySelector('.session-move-btn')?.addEventListener('click', async () => {
    try {
      const from = session.date || viewDate;
      await api.patch(`/api/meals/sessions/${session.id}`, { date: localDate() });
      showToast(`"${session.name}" moved to today`, 'success', {
        actionLabel: 'Undo',
        onAction: () => undoMove(session.id, from, onDone),
      });
      onDone?.();
    } catch (err) { showToast(err.message, 'error'); }
  });

  return sessionEl;
}
