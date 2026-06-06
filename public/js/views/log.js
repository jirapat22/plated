import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }               from '../components/foodSearch.js';
import { fmtE, unitLabel }                from '../utils/energy.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export function openFoodEntry(sessionId, onSuccess) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Add Food</span>
        <button class="sheet-close" id="close-search">✕</button>
      </div>
    `;
    document.getElementById('close-search').addEventListener('click', hideSheet);
    renderFoodSearch(content, food => showQuantitySheet(food, sessionId, onSuccess));
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
      <div style="height:8px"></div>
      <div class="qty-input-wrap">
        <input type="number" id="edit-qty" class="qty-input" value="${entry.quantity_g}" min="1" step="1" />
        <span class="qty-unit">g</span>
      </div>
      <div style="display:flex;gap:6px;padding:8px 16px;flex-wrap:wrap">
        ${[50,75,100,150,200,250,300].map(g =>
          `<button class="water-btn quick-edit-g" data-g="${g}">${g}g</button>`
        ).join('')}
      </div>
      <div class="qty-macros" id="edit-macros"></div>
      <div class="qty-confirm">
        <button class="btn btn-primary btn-full" id="edit-confirm">Update</button>
      </div>
    `;

    const qtyInput = document.getElementById('edit-qty');

    function calcMacros() {
      const qty = parseFloat(qtyInput.value) || 0;
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
    qtyInput.addEventListener('input', calcMacros);

    content.querySelectorAll('.quick-edit-g').forEach(btn => {
      btn.addEventListener('click', () => { qtyInput.value = btn.dataset.g; calcMacros(); });
    });

    document.getElementById('edit-close').addEventListener('click', hideSheet);

    document.getElementById('edit-confirm').addEventListener('click', async () => {
      const qty = parseFloat(qtyInput.value);
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
          <input type="number" id="qty-g" class="qty-input" value="${srv}" min="1" step="1" />
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
          <input type="number" id="qty-srv" class="qty-input" value="1" min="0.5" step="0.5" />
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
              <input type="number" id="qty-g-per-pc" class="input" value="${(srv/3).toFixed(1)}" min="0.1" step="0.1" style="height:42px" />
            </div>
            <div>
              <label class="form-label">Number of pieces</label>
              <input type="number" id="qty-pcs" class="input" value="3" min="1" step="1" style="height:42px" />
            </div>
          </div>
          <div id="pcs-total-g" style="font-size:12px;color:var(--text-muted)"></div>
        </div>
      </div>

      <div class="qty-macros" id="qty-macros"></div>
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
