import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }               from '../components/foodSearch.js';
import { fmtE, unitLabel }                from '../utils/energy.js';
import { localDate }                      from '../utils/date.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── Copy a single logged food, or a whole meal, to another meal/day ──
async function dayMeals(viewDate) {
  try { return (await api.get(`/api/meals/day/${viewDate}`)).sessions || []; } catch { return []; }
}

// Shared sheet body for picking a destination (other meals today / new meal / a date).
// onPick(target) → target = { sid } for an existing/new meal today, or { date } for a day.
function destinationSheet(title, subtitle, viewDate, others, handlers) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">${title}</span>
        <button class="sheet-close" id="cp-close">✕</button>
      </div>
      <div style="padding:0 16px">
        ${subtitle}
        <label class="form-label">Copy into a meal</label>
        <div style="display:flex;flex-direction:column;gap:6px;margin:6px 0 16px">
          ${others.map(s => `<button class="cp-meal btn btn-secondary" data-sid="${s.id}" style="justify-content:flex-start">${esc(s.name || 'Meal')}</button>`).join('')}
          <button class="cp-meal btn btn-secondary" data-sid="new" style="justify-content:flex-start;color:var(--accent)">+ New meal</button>
        </div>
        <label class="form-label">…or another day</label>
        <div style="display:flex;gap:8px;margin-top:6px">
          <input class="input" id="cp-date" type="date" max="${localDate()}" value="${viewDate}" style="flex:1"/>
          <button class="btn btn-primary" id="cp-date-go">Copy</button>
        </div>
      </div>`;
    document.getElementById('cp-close').addEventListener('click', hideSheet);
    content.querySelectorAll('.cp-meal').forEach(btn => btn.addEventListener('click', () => handlers.toMeal(btn.dataset.sid)));
    document.getElementById('cp-date-go').addEventListener('click', () => {
      const date = document.getElementById('cp-date').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showToast('Pick a date', 'error');
      handlers.toDate(date);
    });
  });
}

// Copy a single logged food (same quantity) into another meal today or onto any day.
export async function openCopyEntry(entry, viewDate, onDone) {
  const others = (await dayMeals(viewDate)).filter(s => s.id !== entry.meal_session_id);
  const copyTo = sid => api.post(`/api/meals/sessions/${sid}/entries`, { food_id: entry.food_id, quantity_g: entry.quantity_g });
  const newSession = async date => (await api.post('/api/meals/sessions', { date })).id;
  const sub = `<div style="font-size:15px;font-weight:600">${esc(entry.food_name)}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${Math.round(entry.quantity_g)}g · ${fmtE(entry.calories)} ${unitLabel()}</div>`;
  destinationSheet('Copy food', sub, viewDate, others, {
    toMeal: async sid => {
      try { await copyTo(sid === 'new' ? await newSession(viewDate) : sid); hideSheet(); showToast('Copied', 'success'); onDone?.(); }
      catch (err) { showToast(err.message, 'error'); }
    },
    toDate: async date => {
      try { await copyTo(await newSession(date)); hideSheet(); showToast(date === localDate() ? 'Copied to today' : `Copied to ${date}`, 'success'); onDone?.(); }
      catch (err) { showToast(err.message, 'error'); }
    },
  });
}

// Copy a whole meal (all foods) to a new meal on a day, or merge into an existing meal.
export async function openCopyMeal(session, viewDate, onDone) {
  const others = (await dayMeals(viewDate)).filter(s => s.id !== session.id);
  const copy = body => api.post(`/api/meals/sessions/${session.id}/copy`, body);
  const n = (session.entries || []).length;
  const sub = `<div style="font-size:15px;font-weight:600">${esc(session.name || 'Meal')}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">${n} food${n === 1 ? '' : 's'} · copied with the same amounts</div>`;
  destinationSheet('Copy meal', sub, viewDate, others, {
    toMeal: async sid => {
      try { await copy(sid === 'new' ? { date: viewDate } : { target_session_id: sid }); hideSheet(); showToast(sid === 'new' ? 'Meal copied' : 'Merged into meal', 'success'); onDone?.(); }
      catch (err) { showToast(err.message, 'error'); }
    },
    toDate: async date => {
      try { await copy({ date }); hideSheet(); showToast(date === localDate() ? 'Copied to today' : `Copied to ${date}`, 'success'); onDone?.(); }
      catch (err) { showToast(err.message, 'error'); }
    },
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

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Edit Quantity</span>
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

      <div class="qty-macros" id="edit-macros"></div>
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

    document.getElementById('edit-confirm').addEventListener('click', async () => {
      const qty = getTotalG();
      if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
      const btn = document.getElementById('edit-confirm');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
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
