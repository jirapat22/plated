import { api }                 from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }   from '../components/foodSearch.js';

export function openFoodEntry(sessionId, onSuccess) {
  showSheet(content => {
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Add Food</span>
        <button class="sheet-close" id="close-search">✕</button>
      </div>
    `;
    document.getElementById('close-search').addEventListener('click', hideSheet);

    renderFoodSearch(content, async (food) => {
      showQuantitySheet(food, sessionId, onSuccess);
    });
  });
}

function showQuantitySheet(food, sessionId, onSuccess) {
  showSheet(content => {
    const defaultQty = food.serving_size_g || 100;

    content.innerHTML = `
      <div class="sheet-header">
        <button id="qty-back" style="color:var(--accent);font-weight:600;font-size:14px">← Back</button>
        <button class="sheet-close" id="qty-close">✕</button>
      </div>
      <div class="qty-food-name">${food.name}</div>
      ${food.brand ? `<div class="qty-food-brand">${food.brand}</div>` : '<div style="height:8px"></div>'}

      <div class="qty-input-wrap">
        <input type="number" id="qty-input" class="qty-input" value="${defaultQty}" min="1" step="1" />
        <span class="qty-unit">g</span>
      </div>

      <div class="qty-macros" id="qty-macros"></div>

      <div class="qty-confirm">
        <button class="btn btn-primary btn-full" id="qty-confirm-btn">Add to Meal</button>
      </div>

      <div style="padding:12px 16px">
        <div class="label" style="margin-bottom:8px">Quick amounts</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${[50,75,100,150,200,250,300].map(g =>
            `<button class="water-btn quick-qty" data-g="${g}">${g}g</button>`
          ).join('')}
        </div>
      </div>
    `;

    const qtyInput   = document.getElementById('qty-input');
    const macrosDiv  = document.getElementById('qty-macros');
    const confirmBtn = document.getElementById('qty-confirm-btn');

    function calcAndRender() {
      const qty = parseFloat(qtyInput.value) || 0;
      const r   = qty / 100;
      const cal = food.calories_per_100g != null ? (food.calories_per_100g * r).toFixed(0) : '–';
      const pro = food.protein_per_100g  != null ? (food.protein_per_100g  * r).toFixed(1) : '–';
      const crb = food.carbs_per_100g    != null ? (food.carbs_per_100g    * r).toFixed(1) : '–';
      const fat = food.fat_per_100g      != null ? (food.fat_per_100g      * r).toFixed(1) : '–';
      macrosDiv.innerHTML = `
        <div class="qty-macro"><div class="qty-macro-val num">${cal}</div><div class="qty-macro-lbl">kcal</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--protein)">${pro}g</div><div class="qty-macro-lbl">protein</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--carbs)">${crb}g</div><div class="qty-macro-lbl">carbs</div></div>
        <div class="qty-macro"><div class="qty-macro-val num" style="color:var(--fat)">${fat}g</div><div class="qty-macro-lbl">fat</div></div>
      `;
    }

    calcAndRender();
    qtyInput.addEventListener('input', calcAndRender);

    // Quick amounts
    content.querySelectorAll('.quick-qty').forEach(btn => {
      btn.addEventListener('click', () => {
        qtyInput.value = btn.dataset.g;
        calcAndRender();
      });
    });

    document.getElementById('qty-back').addEventListener('click', () => {
      openFoodEntry(sessionId, onSuccess);
    });
    document.getElementById('qty-close').addEventListener('click', hideSheet);

    confirmBtn.addEventListener('click', async () => {
      const qty = parseFloat(qtyInput.value);
      if (!qty || qty <= 0) {
        showToast('Enter a valid quantity', 'error');
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Adding…';
      try {
        await api.post(`/api/meals/sessions/${sessionId}/entries`, {
          food_id: food.id,
          quantity_g: qty,
        });
        hideSheet();
        showToast('Added to meal', 'success');
        onSuccess?.();
      } catch (err) {
        showToast(err.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Add to Meal';
      }
    });
  });
}
