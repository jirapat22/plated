import { api }                            from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }               from '../components/foodSearch.js';
import { fmtE, unitLabel }                from '../utils/energy.js';

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

function showQuantitySheet(food, sessionId, onSuccess) {
  showSheet(content => {
    const srv       = food.serving_size_g || 100;
    const hasSrv    = !!food.serving_size_g && food.serving_size_g !== 100;
    const ul        = unitLabel();

    content.innerHTML = `
      <div class="sheet-header">
        <button id="qty-back" style="color:var(--accent);font-weight:600;font-size:14px">← Back</button>
        <button class="sheet-close" id="qty-close">✕</button>
      </div>
      <div class="qty-food-name">${food.name}</div>
      ${food.brand ? `<div class="qty-food-brand">${food.brand}</div>` : '<div style="height:8px"></div>'}

      <!-- Mode toggle: grams / servings / pieces -->
      <div style="display:flex;gap:6px;padding:0 16px 12px">
        <button class="qty-mode-btn active" data-mode="g">by weight (g)</button>
        ${hasSrv ? `<button class="qty-mode-btn" data-mode="srv">by serving (${srv}g)</button>` : ''}
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
          ${hasSrv ? `<button class="water-btn quick-g" data-g="${srv}" style="color:var(--accent)">1 srv (${srv}g)</button>` : ''}
        </div>
      </div>

      <!-- Serving mode -->
      ${hasSrv ? `<div id="mode-srv" style="display:none">
        <div class="qty-input-wrap">
          <input type="number" id="qty-srv" class="qty-input" value="1" min="0.5" step="0.5" />
          <span class="qty-unit">srv × ${srv}g</span>
        </div>
      </div>` : ''}

      <!-- Pieces mode -->
      <div id="mode-pcs" style="display:none">
        <div style="padding:0 16px 8px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div>
              <label class="form-label">Grams per piece</label>
              <input type="number" id="qty-g-per-pc" class="input" value="${(srv / 3).toFixed(1)}" min="0.1" step="0.1" style="height:42px" />
            </div>
            <div>
              <label class="form-label">Number of pieces</label>
              <input type="number" id="qty-pcs" class="input" value="3" min="1" step="1" style="height:42px" />
            </div>
          </div>
          <div style="font-size:12px;color:var(--text-muted)" id="pcs-total-g"></div>
        </div>
      </div>

      <div class="qty-macros" id="qty-macros"></div>

      <div class="qty-confirm">
        <button class="btn btn-primary btn-full" id="qty-confirm-btn">Add to Meal</button>
      </div>
    `;

    // ── Mode switching ───────────────────────────────────────
    let currentMode = 'g';
    content.querySelectorAll('.qty-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentMode = btn.dataset.mode;
        content.querySelectorAll('.qty-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
        content.querySelectorAll('[id^="mode-"]').forEach(el => { el.style.display = 'none'; });
        const modeEl = document.getElementById(`mode-${currentMode}`);
        if (modeEl) modeEl.style.display = '';
        updateMacros();
      });
    });

    // ── Calculate total grams from current mode ──────────────
    function getTotalG() {
      if (currentMode === 'g') {
        return parseFloat(document.getElementById('qty-g')?.value) || 0;
      }
      if (currentMode === 'srv') {
        return (parseFloat(document.getElementById('qty-srv')?.value) || 0) * srv;
      }
      if (currentMode === 'pcs') {
        const gPerPc = parseFloat(document.getElementById('qty-g-per-pc')?.value) || 0;
        const pcs    = parseFloat(document.getElementById('qty-pcs')?.value)    || 0;
        return gPerPc * pcs;
      }
      return 0;
    }

    function updateMacros() {
      const qty = getTotalG();
      const r   = qty / 100;

      // Update pieces total label
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

    // ── Live update listeners ────────────────────────────────
    ['qty-g','qty-srv','qty-g-per-pc','qty-pcs'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', updateMacros);
    });
    content.querySelectorAll('.quick-g').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('qty-g').value = btn.dataset.g;
        updateMacros();
      });
    });

    updateMacros();

    document.getElementById('qty-back').addEventListener('click', () => openFoodEntry(sessionId, onSuccess));
    document.getElementById('qty-close').addEventListener('click', hideSheet);

    document.getElementById('qty-confirm-btn').addEventListener('click', async () => {
      const qty = getTotalG();
      if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
      const btn = document.getElementById('qty-confirm-btn');
      btn.disabled = true;
      btn.textContent = 'Adding…';
      try {
        await api.post(`/api/meals/sessions/${sessionId}/entries`, { food_id: food.id, quantity_g: qty });
        hideSheet();
        showToast('Added to meal', 'success');
        onSuccess?.();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Add to Meal';
      }
    });
  });
}
