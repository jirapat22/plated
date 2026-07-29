import { api }                        from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }           from '../components/foodSearch.js';
import { fmtE, unitLabel }            from '../utils/energy.js';
import { localDate }                  from '../utils/date.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const g0  = n => Math.round(n || 0);                                    // whole grams
const g1  = n => {                                                      // 1dp, trimmed
  const v = Math.round((n || 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

// Renders the Batches view (active meal-prep batches + a "new batch" builder)
// into the given container.
export function renderBatches(container) {
  container.innerHTML = '<div class="skeleton skel-line" style="margin:8px 16px"></div>';
  load();

  async function load() {
    let batches;
    try { batches = await api.get('/api/batches'); }
    catch (err) { container.innerHTML = `<div class="empty-state"><div class="empty-text">${esc(err.message)}</div></div>`; return; }
    render(batches);
  }

  function render(batches) {
    const ul = unitLabel();
    container.innerHTML = `
      <div style="padding:0 16px 12px">
        <button class="btn btn-primary btn-full" id="new-batch">+ New meal-prep batch</button>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;line-height:1.5">Log everything you cooked, weigh the finished batch, then portion it out by weight — calories scale to what's left.</div>
      </div>
      ${batches.length ? batches.map(b => batchCard(b, ul)).join('')
        : `<div class="empty-state"><div class="empty-icon">🍱</div><div class="empty-text">No batches yet. Cook a big batch, save it once, then log portions by weight.</div></div>`}
    `;
    const find = id => batches.find(x => x.id == id);
    document.getElementById('new-batch').addEventListener('click', () => openBuilder(load));
    container.querySelectorAll('[data-portion]').forEach(btn =>
      btn.addEventListener('click', () => openPortion(find(btn.dataset.portion), load)));
    container.querySelectorAll('[data-edit]').forEach(btn =>
      btn.addEventListener('click', () => openBuilder(load, find(btn.dataset.edit))));
    container.querySelectorAll('[data-adjust]').forEach(btn =>
      btn.addEventListener('click', () => {
        const b = find(btn.dataset.adjust);
        if (b) openAdjust(b, load);
      }));
    container.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this batch? Portions you already logged stay in your history.')) return;
        try { await api.delete(`/api/batches/${btn.dataset.del}`); load(); }
        catch (err) { showToast(err.message, 'error'); }
      }));
  }

  function batchCard(b, ul) {
    const ingTxt = (b.ingredients || []).map(i => `${esc(i.name)} ${Math.round(i.grams)}g`).join(' · ');
    const pct = Math.max(2, Math.round(b.remaining_g / b.cooked_g * 100));
    const L = b.left || {};        // macros in what's still left
    const P = b.per_100g || {};    // density — what a portion size buys you
    return `
      <div style="padding:0 16px 12px">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:2px">
            <div style="font-weight:700;font-size:15px">${esc(b.name)}</div>
            <div style="display:flex;gap:8px;flex-shrink:0">
              <button data-edit="${b.id}" title="Edit this batch" style="color:var(--text-faint);font-size:13px">✏️</button>
              <button data-del="${b.id}" title="Delete" style="color:var(--error);font-size:15px">✕</button>
            </div>
          </div>
          ${ingTxt ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${ingTxt}</div>` : ''}
          <div class="water-bar-outer"><div class="water-bar-fill" style="width:${pct}%"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-top:6px">
            <span><strong style="color:var(--text)">${g0(b.remaining_g)} g</strong> of ${g0(b.cooked_g)} g left</span>
            <span>≈ ${fmtE(b.kcal_left)} ${ul} left</span>
          </div>
          <div style="display:flex;gap:10px;font-size:12px;font-variant-numeric:tabular-nums;margin-top:5px">
            <span style="color:var(--protein)">${g0(L.protein)}g P</span>
            <span style="color:var(--carbs)">${g0(L.carbs)}g C</span>
            <span style="color:var(--fat)">${g0(L.fat)}g F</span>
            ${L.fiber ? `<span style="color:var(--fiber)">${g0(L.fiber)}g fib</span>` : ''}
            <span style="color:var(--text-faint);margin-left:auto">still left</span>
          </div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:7px;padding-top:7px;border-top:1px solid var(--border)">
            Per 100 g: ${b.kcal_per_100g} ${ul} · ${g1(P.protein)}P · ${g1(P.carbs)}C · ${g1(P.fat)}F${P.fiber ? ` · ${g1(P.fiber)} fib` : ''}
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button data-portion="${b.id}" class="btn btn-secondary" style="flex:1">Log a portion</button>
            <button data-adjust="${b.id}" class="btn btn-secondary" style="flex-shrink:0;padding:0 14px" title="Correct how much is actually left">⚖️ Fix</button>
          </div>
        </div>
      </div>`;
  }
}

// ── Correct what's left ──────────────────────────────────────
// Was a prompt() — a system dialog in an otherwise fully themed app, with the
// max weight buried in a paragraph of text and no way to tap a common answer.
function openAdjust(batch, onDone) {
  showSheet(content => {
    const max = g0(batch.cooked_g);
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">⚖️ How much is left?</span>
        <button class="sheet-close" id="a-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.5">
          <strong style="color:var(--text)">${esc(batch.name)}</strong> — use this if a portion went in at the wrong weight, or some got eaten without logging.
        </div>
        <label class="form-label">Grams left · up to ${max}</label>
        <div style="display:flex;gap:8px;align-items:center;margin:6px 0 10px">
          <input class="input" id="a-g" type="text" inputmode="decimal" value="${g0(batch.remaining_g)}" style="flex:1"/>
          <span style="color:var(--text-muted)">g</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px">
          <button type="button" class="fs-chip a-quick" data-g="0">Finished it</button>
          <button type="button" class="fs-chip a-quick" data-g="${g0(batch.cooked_g / 2)}">Half left</button>
          <button type="button" class="fs-chip a-quick" data-g="${max}">Untouched</button>
        </div>
        <button class="btn btn-primary btn-full" id="a-save">Save</button>
      </div>`;
    const gi = document.getElementById('a-g');
    document.getElementById('a-close').addEventListener('click', hideSheet);
    content.querySelectorAll('.a-quick').forEach(b =>
      b.addEventListener('click', () => { gi.value = b.dataset.g; }));
    document.getElementById('a-save').addEventListener('click', async () => {
      const grams = parseFloat(gi.value);
      if (!Number.isFinite(grams) || grams < 0) return showToast('Enter grams (0 or more)', 'error');
      const btn = document.getElementById('a-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api.patch(`/api/batches/${batch.id}`, { remaining_g: grams });
        hideSheet();
        showToast(`${g0(r.remaining_g)} g left`, 'success');
        onDone?.();
      } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Save'; }
    });
  });
}

// ── New / edit batch builder ─────────────────────────────────
// Pass an existing batch to edit it in place; omit for a new one.
function openBuilder(onDone, batch = null) {
  const isEdit = !!batch;
  showSheet(content => {
    // { food_id, name, grams, cal }. On edit, seed from the saved ingredients —
    // cal is refetched below so the running total is right without trusting a
    // stale snapshot.
    const ingredients = isEdit
      ? (batch.ingredients || []).map(i => ({ food_id: i.food_id ?? null, name: i.name, grams: i.grams, cal: 0 }))
      : [];

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">${isEdit ? 'Edit batch' : 'New batch'}</span>
        <button class="sheet-close" id="b-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <label class="form-label">Batch name</label>
        <input class="input" id="b-name" placeholder="e.g. Beef &amp; veg prep" style="margin-bottom:14px"/>
        <label class="form-label">Ingredients</label>
        <div id="b-list" style="margin:6px 0"></div>
        <div id="b-totals" style="font-size:12px;color:var(--accent);font-weight:600;margin:6px 0 10px"></div>
        <div id="b-search" style="margin-bottom:8px"></div>
        <label class="form-label" style="margin-top:6px">Cooked weight — weigh the finished batch</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
          <input class="input" id="b-cooked" type="text" inputmode="decimal" placeholder="e.g. 1300" style="flex:1"/>
          <span style="color:var(--text-muted)">g</span>
        </div>
        <div id="b-leftover"></div>
        ${isEdit ? `<div style="font-size:11px;color:var(--text-faint);margin-bottom:12px;line-height:1.5">
          Portions you already logged keep the macros they were logged with — only future portions use the updated numbers.
        </div>` : ''}
        <button class="btn btn-primary btn-full" id="b-save">${isEdit ? 'Save changes' : 'Save batch'}</button>
      </div>`;

    // Values set via JS so a name with quotes/angle brackets can't break out.
    const nameInput   = document.getElementById('b-name');
    const cookedInput = document.getElementById('b-cooked');
    if (isEdit) {
      nameInput.value   = batch.name;
      cookedInput.value = g0(batch.cooked_g);
    }

    renderFoodSearch(document.getElementById('b-search'), food => {
      // Adding is instant at 100g. On a phone the list sits above the search
      // box and can be off-screen, so make the landing obvious: toast, flash
      // the new row, scroll it into view, and focus its grams field so the
      // next thing you type is the weight.
      ingredients.push({ food_id: food.id, name: food.name, grams: 100, cal: food.calories_per_100g || 0 });
      renderList(ingredients.length - 1);
      showToast(`${food.name} added — set the weight`, 'success');
    }, {});

    const totalsEl = () => document.getElementById('b-totals');
    function updTotals() {
      const tot = ingredients.reduce((s, it) => s + it.cal * it.grams / 100, 0);
      totalsEl().textContent = ingredients.length
        ? `≈ ${Math.round(tot)} ${unitLabel()} from ${ingredients.length} ingredient${ingredients.length === 1 ? '' : 's'}`
        : '';
    }

    function renderList(flashIndex = -1) {
      const list = document.getElementById('b-list');
      list.innerHTML = ingredients.length
        ? ingredients.map((it, i) => `
          <div class="b-row${i === flashIndex ? ' flash-in' : ''}" style="display:flex;align-items:center;gap:8px;padding:4px 0">
            <span style="flex:1;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}</span>
            <input class="input b-g" data-i="${i}" type="text" inputmode="decimal" value="${it.grams}" style="width:72px;height:36px;text-align:right"/>
            <span style="color:var(--text-muted);font-size:12px">g</span>
            <button class="b-rm" data-i="${i}" style="color:var(--error);font-size:14px">✕</button>
          </div>`).join('')
        : '<div style="font-size:12px;color:var(--text-faint)">Search below to add what went in.</div>';
      list.querySelectorAll('.b-g').forEach(inp => inp.addEventListener('input', () => {
        ingredients[inp.dataset.i].grams = parseFloat(inp.value) || 0; updTotals();
      }));
      list.querySelectorAll('.b-rm').forEach(btn => btn.addEventListener('click', () => {
        ingredients.splice(btn.dataset.i, 1); renderList();
      }));
      updTotals();

      if (flashIndex >= 0) {
        const row = list.querySelectorAll('.b-row')[flashIndex];
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const gramsInput = row?.querySelector('.b-g');
        if (gramsInput) { gramsInput.focus(); gramsInput.select(); }
      }
    }
    renderList();

    // Editing needs each ingredient's per-100g calories to show a running
    // total; the saved batch only stores name + grams.
    if (isEdit && ingredients.length) {
      Promise.all(ingredients.map(it =>
        it.food_id != null ? api.get(`/api/foods/${it.food_id}`).catch(() => null) : null
      )).then(foods => {
        foods.forEach((f, i) => { if (f) ingredients[i].cal = f.calories_per_100g || 0; });
        updTotals();
      });
    }

    // A changed cooked weight makes "how much is left" ambiguous once some has
    // been eaten: was the original weighing wrong (so the error applies to
    // what's left too), or only the total? This used to be a confirm() where
    // OK and Cancel were two different answers — so Cancel didn't abort, and
    // there was no way to back out once it appeared. It's now an inline choice
    // you can see, change, and simply not save.
    let leftoverMode = 'scale';
    function renderLeftover() {
      const box = document.getElementById('b-leftover');
      if (!box) return;
      const cooked = parseFloat(cookedInput.value);
      const eaten  = isEdit ? batch.cooked_g - batch.remaining_g : 0;
      if (!isEdit || !(cooked > 0) || cooked === batch.cooked_g || eaten <= 0.5) { box.innerHTML = ''; return; }
      const scaled = g0(batch.remaining_g * cooked / batch.cooked_g);
      const kept   = Math.min(g0(batch.remaining_g), g0(cooked));
      box.innerHTML = `
        <label class="form-label">${g0(batch.cooked_g)} g → ${g0(cooked)} g. You have ${g0(batch.remaining_g)} g left — what's actually left now?</label>
        <div style="display:flex;gap:6px;margin:8px 0 14px">
          <button type="button" class="fs-chip b-left-opt${leftoverMode === 'scale' ? ' active' : ''}" data-mode="scale" style="flex:1">${scaled} g<br><span style="font-size:10px;opacity:.75">same fraction left</span></button>
          <button type="button" class="fs-chip b-left-opt${leftoverMode === 'keep' ? ' active' : ''}" data-mode="keep" style="flex:1">${kept} g<br><span style="font-size:10px;opacity:.75">leave it as-is</span></button>
        </div>`;
      box.querySelectorAll('.b-left-opt').forEach(b =>
        b.addEventListener('click', () => { leftoverMode = b.dataset.mode; renderLeftover(); }));
    }
    cookedInput.addEventListener('input', renderLeftover);
    renderLeftover();

    document.getElementById('b-close').addEventListener('click', hideSheet);
    document.getElementById('b-save').addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const cooked_g = parseFloat(cookedInput.value);
      if (!name) return showToast('Name your batch', 'error');
      if (!ingredients.length) return showToast('Add at least one ingredient', 'error');
      if (!(cooked_g > 0)) return showToast('Enter the cooked weight', 'error');
      if (isEdit && ingredients.some(it => it.food_id == null)) {
        return showToast("One ingredient can't be matched to a food — remove and re-add it", 'error');
      }

      const body = { name, cooked_g, items: ingredients.map(it => ({ food_id: it.food_id, quantity_g: it.grams })) };

      // Nothing eaten yet → what's left is simply the new total. Otherwise take
      // whichever answer the inline choice above is showing.
      if (isEdit && cooked_g !== batch.cooked_g) {
        const eaten = batch.cooked_g - batch.remaining_g;
        body.remaining_g = eaten <= 0.5 ? cooked_g
          : leftoverMode === 'scale' ? g0(batch.remaining_g * cooked_g / batch.cooked_g)
          : Math.min(g0(batch.remaining_g), g0(cooked_g));
      }

      const btn = document.getElementById('b-save');
      const label = isEdit ? 'Save changes' : 'Save batch';
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (isEdit) await api.patch(`/api/batches/${batch.id}`, body);
        else        await api.post('/api/batches', body);
        hideSheet();
        showToast(isEdit ? 'Batch updated' : 'Batch saved', 'success');
        onDone?.();
      } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = label; }
    });
  });
}

// ── Log a portion ────────────────────────────────────────────
// opts.sessionId locks the portion to an existing meal (used when this is
// opened from a meal's Add Food flow) — the day and meal pickers are then
// redundant, so they're hidden.
export function openPortion(batch, onDone, opts = {}) {
  if (!batch) return;
  const lockedSession = opts.sessionId != null;
  showSheet(content => {
    const today = localDate();
    const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
    // Backfilling an already-eaten portion is the common reason to pick a
    // day at all, so the quick chips look backward (today, then the last
    // few days) rather than forward like the meal-copy day picker does.
    const quickDays = [today, addDays(today, -1), addDays(today, -2), addDays(today, -3)];
    const dayLabel = (iso, i) => i === 0 ? 'Today' : i === 1 ? 'Yesterday'
      : new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    let selectedDate = today;

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Portion · ${esc(batch.name)}</span>
        <button class="sheet-close" id="p-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${g0(batch.remaining_g)} g left · ${batch.kcal_per_100g} ${unitLabel()}/100g</div>
        ${lockedSession ? `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
          Adding to <strong style="color:var(--text)">${esc(opts.sessionName || 'this meal')}</strong>
        </div>` : `
        <label class="form-label">Day</label>
        <div id="p-days" style="display:flex;gap:6px;overflow-x:auto;padding:6px 0 4px;-webkit-overflow-scrolling:touch">
          ${quickDays.map((d, i) => `<button type="button" class="fs-chip p-day${i === 0 ? ' active' : ''}" data-date="${d}" style="flex-shrink:0">${dayLabel(d, i)}</button>`).join('')}
        </div>
        <button type="button" id="p-custom-toggle" style="font-size:12px;color:var(--accent);font-weight:600;padding:2px 0;margin-bottom:12px">Pick another date…</button>
        <input class="input" id="p-date-custom" type="date" max="${today}" style="display:none;margin-bottom:14px"/>
        <label class="form-label">Add to</label>
        <select class="input" id="p-meal" style="margin-bottom:14px"></select>`}
        <label class="form-label">How much are you eating?</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input class="input" id="p-g" type="text" inputmode="decimal" value="220" style="flex:1"/>
          <span style="color:var(--text-muted)">g</span>
        </div>
        <div id="p-cals" style="font-size:13px;color:var(--accent);font-weight:600;margin-bottom:16px"></div>
        <button class="btn btn-primary btn-full" id="p-save">Log portion</button>
      </div>`;

    const gi = document.getElementById('p-g');
    const upd = () => {
      const g = parseFloat(gi.value) || 0;
      const box = document.getElementById('p-cals');
      if (!g) { box.innerHTML = ''; return; }
      const r  = g / batch.cooked_g;
      const sc = k => (batch[k] || 0) * r;
      const over = g > batch.remaining_g;
      box.innerHTML = `
        ≈ ${fmtE(Math.round(batch.calories * r))} ${unitLabel()}
        · <span style="color:var(--protein)">${g1(sc('protein'))}P</span>
        · <span style="color:var(--carbs)">${g1(sc('carbs'))}C</span>
        · <span style="color:var(--fat)">${g1(sc('fat'))}F</span>
        <div style="font-size:11px;font-weight:400;margin-top:3px;color:${over ? 'var(--warning)' : 'var(--text-faint)'}">
          ${over
            ? `Only ${g0(batch.remaining_g)} g left — it'll log that instead`
            : `${g0(batch.remaining_g - g)} g will be left`}
        </div>`;
    };
    gi.addEventListener('input', upd); upd();

    // Meals already on the chosen day, so a portion can join an existing meal
    // instead of always landing in its own. Reloads when the day changes.
    const mealSel = document.getElementById('p-meal');
    async function loadMeals() {
      if (!mealSel) return;
      mealSel.innerHTML = `<option value="">New meal — ${esc(batch.name)}</option>`;
      try {
        const day = await api.get(`/api/meals/day/${selectedDate}`);
        for (const s of (day.sessions || [])) {
          const o = document.createElement('option');
          o.value = s.id;
          o.textContent = s.name || `Meal ${s.meal_index}`;
          mealSel.appendChild(o);
        }
      } catch { /* keep the "new meal" default */ }
    }
    loadMeals();

    const daysBox = document.getElementById('p-days');
    if (daysBox) {
      const customToggle = document.getElementById('p-custom-toggle');
      const customInput  = document.getElementById('p-date-custom');
      daysBox.querySelectorAll('.p-day').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedDate = btn.dataset.date;
          daysBox.querySelectorAll('.p-day').forEach(b => b.classList.toggle('active', b === btn));
          customInput.style.display = 'none';
          loadMeals();
        });
      });
      customToggle.addEventListener('click', () => {
        const opening = customInput.style.display === 'none';
        customInput.style.display = opening ? 'block' : 'none';
        if (opening) customInput.focus();
      });
      customInput.addEventListener('change', () => {
        if (!customInput.value) return;
        selectedDate = customInput.value;
        daysBox.querySelectorAll('.p-day').forEach(b => b.classList.remove('active'));
        loadMeals();
      });
    }

    document.getElementById('p-close').addEventListener('click', hideSheet);
    document.getElementById('p-save').addEventListener('click', async () => {
      const grams = parseFloat(gi.value);
      if (!(grams > 0)) return showToast('Enter how many grams', 'error');
      const btn = document.getElementById('p-save');
      btn.disabled = true; btn.textContent = 'Logging…';
      try {
        // opts.sessionId may be a lazySession thunk — the meal it targets isn't
        // created until here, so a dismissed sheet leaves nothing behind.
        const sid = typeof opts.sessionId === 'function' ? await opts.sessionId() : opts.sessionId;
        const r = await api.post(`/api/batches/${batch.id}/portion`, {
          grams,
          date: lockedSession ? undefined : selectedDate,
          meal_session_id: lockedSession ? sid : (mealSel?.value || undefined),
        });
        hideSheet();
        showToast(`Logged ${g0(r.logged_g)} g · ${g0(r.remaining_g)} g left`, 'success');
        onDone?.();
      } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Log portion'; }
    });
  });
}
