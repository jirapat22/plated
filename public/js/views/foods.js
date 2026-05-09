import { api }           from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';

let debounceTimer = null;

function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), ms);
  };
}

export function renderFoods(container) {
  container.innerHTML = `
    <div class="today-header"><div class="today-date">Foods</div></div>
    <div style="padding:0 16px 10px">
      <div class="search-input-wrap">
        <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
          <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <input class="input" id="foods-search" placeholder="Search foods…" autocomplete="off" />
      </div>
    </div>
    <div style="padding:0 16px 10px;display:flex;justify-content:space-between;align-items:center">
      <div class="search-tabs" id="foods-tabs" style="padding:0">
        <button class="search-tab active" data-tab="all">All</button>
        <button class="search-tab" data-tab="favourites">Favourites</button>
      </div>
      <button class="btn btn-secondary" id="add-custom-btn" style="height:36px;font-size:12px">+ Add Custom</button>
    </div>
    <div id="foods-list"></div>
  `;

  let currentTab = 'all';
  let query = '';

  async function loadList() {
    const list = document.getElementById('foods-list');
    list.innerHTML = '<div class="skeleton skel-line" style="margin:8px 16px"></div>';

    try {
      let rows;
      if (currentTab === 'favourites') {
        rows = await api.get('/api/foods/favourites');
      } else if (query.trim()) {
        rows = await api.get(`/api/foods/search?q=${encodeURIComponent(query)}`);
      } else {
        rows = await api.get('/api/foods/recent');
      }
      renderList(list, rows);
    } catch (err) {
      list.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function renderList(list, rows) {
    if (rows.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">No foods found</div></div>';
      return;
    }
    list.innerHTML = '';
    rows.forEach(food => list.appendChild(buildFoodItem(food)));
  }

  function buildFoodItem(food) {
    const el = document.createElement('div');
    el.className = 'food-list-item';
    el.innerHTML = `
      <div class="food-list-icon">${food.source === 'openfoodfacts' ? '🌍' : '✏️'}</div>
      <div class="food-list-info">
        <div class="food-list-name">${food.name}</div>
        <div class="food-list-sub">${food.brand || 'Custom'} · ${food.calories_per_100g != null ? food.calories_per_100g.toFixed(0) + ' kcal/100g' : 'no cal data'}</div>
      </div>
      <button class="fav-btn${food.is_favourite ? ' active' : ''}" data-id="${food.id}" title="Toggle favourite">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="${food.is_favourite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7">
          <path d="M9 13.5l-4.5 2.4 .86-5-3.64-3.55 5.03-.73L9 2l2.25 4.62 5.03.73-3.64 3.55.86 5z"/>
        </svg>
      </button>
    `;

    el.addEventListener('click', e => {
      if (e.target.closest('.fav-btn')) return;
      openFoodDetail(food);
    });

    el.querySelector('.fav-btn').addEventListener('click', async e => {
      e.stopPropagation();
      try {
        const { is_favourite } = await api.patch(`/api/foods/${food.id}/favourite`);
        food.is_favourite = is_favourite;
        const btn = el.querySelector('.fav-btn');
        btn.classList.toggle('active', !!is_favourite);
        btn.querySelector('path').setAttribute('fill', is_favourite ? 'currentColor' : 'none');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    return el;
  }

  function openFoodDetail(food) {
    showSheet(content => {
      content.innerHTML = `
        <div class="sheet-header">
          <span class="sheet-title">${food.name}</span>
          <button class="sheet-close" id="detail-close">✕</button>
        </div>
        <div style="padding:0 16px">
          ${food.brand ? `<div class="muted" style="margin-bottom:12px">${food.brand}</div>` : ''}
          <div class="card" style="margin-bottom:12px">
            <div class="label" style="margin-bottom:10px">Per 100g</div>
            <div class="macro-totals-row">
              <div class="macro-total"><div class="macro-total-val num">${food.calories_per_100g?.toFixed(0) ?? '–'}</div><div class="macro-total-lbl label">kcal</div></div>
              <div class="macro-total"><div class="macro-total-val num" style="color:var(--protein)">${food.protein_per_100g?.toFixed(1) ?? '–'}g</div><div class="macro-total-lbl label">protein</div></div>
              <div class="macro-total"><div class="macro-total-val num" style="color:var(--carbs)">${food.carbs_per_100g?.toFixed(1) ?? '–'}g</div><div class="macro-total-lbl label">carbs</div></div>
              <div class="macro-total"><div class="macro-total-val num" style="color:var(--fat)">${food.fat_per_100g?.toFixed(1) ?? '–'}g</div><div class="macro-total-lbl label">fat</div></div>
            </div>
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-danger btn-full" id="detail-delete">Delete food</button>
          </div>
        </div>
      `;
      document.getElementById('detail-close').addEventListener('click', hideSheet);
      document.getElementById('detail-delete').addEventListener('click', async () => {
        if (!confirm(`Delete "${food.name}"?`)) return;
        try {
          await api.delete(`/api/foods/${food.id}`);
          hideSheet();
          showToast('Food deleted', 'success');
          loadList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  }

  function openAddCustom() {
    showSheet(content => {
      content.innerHTML = `
        <div class="sheet-header">
          <span class="sheet-title">Add Custom Food</span>
          <button class="sheet-close" id="custom-close">✕</button>
        </div>
        <div style="padding:0 16px">
          <div class="form-group">
            <label class="form-label">Name *</label>
            <input class="input" id="f-name" placeholder="e.g. Chicken Breast" />
          </div>
          <div class="form-group">
            <label class="form-label">Brand</label>
            <input class="input" id="f-brand" placeholder="Optional" />
          </div>
          <div class="form-group">
            <label class="form-label">Barcode</label>
            <input class="input" id="f-barcode" placeholder="Optional" />
          </div>
          <div class="form-group">
            <label class="form-label">Serving size (g)</label>
            <input class="input" id="f-serving" type="number" value="100" />
          </div>
          <div class="label" style="margin-bottom:10px">Nutrition per 100g</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Calories (kcal)</label>
              <input class="input" id="f-cal" type="number" placeholder="0" />
            </div>
            <div class="form-group">
              <label class="form-label">Protein (g)</label>
              <input class="input" id="f-pro" type="number" placeholder="0" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Carbs (g)</label>
              <input class="input" id="f-crb" type="number" placeholder="0" />
            </div>
            <div class="form-group">
              <label class="form-label">Fat (g)</label>
              <input class="input" id="f-fat" type="number" placeholder="0" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Fiber (g)</label>
            <input class="input" id="f-fib" type="number" placeholder="0" />
          </div>
          <button class="btn btn-primary btn-full" id="custom-save" style="margin-top:4px">Save Food</button>
        </div>
      `;
      document.getElementById('custom-close').addEventListener('click', hideSheet);
      document.getElementById('custom-save').addEventListener('click', async () => {
        const name = document.getElementById('f-name').value.trim();
        if (!name) { showToast('Name is required', 'error'); return; }
        const body = {
          name,
          brand:             document.getElementById('f-brand').value.trim()   || null,
          barcode:           document.getElementById('f-barcode').value.trim() || null,
          serving_size_g:    parseFloat(document.getElementById('f-serving').value) || 100,
          calories_per_100g: parseFloat(document.getElementById('f-cal').value) || null,
          protein_per_100g:  parseFloat(document.getElementById('f-pro').value) || null,
          carbs_per_100g:    parseFloat(document.getElementById('f-crb').value) || null,
          fat_per_100g:      parseFloat(document.getElementById('f-fat').value) || null,
          fiber_per_100g:    parseFloat(document.getElementById('f-fib').value) || null,
        };
        try {
          await api.post('/api/foods', body);
          hideSheet();
          showToast('Food saved', 'success');
          loadList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  }

  // Events
  const debouncedSearch = debounce(() => loadList(), 300);
  document.getElementById('foods-search').addEventListener('input', e => {
    query = e.target.value;
    debouncedSearch();
  });

  document.getElementById('foods-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    currentTab = tab.dataset.tab;
    document.querySelectorAll('#foods-tabs .search-tab').forEach(b => b.classList.toggle('active', b === tab));
    loadList();
  });

  document.getElementById('add-custom-btn').addEventListener('click', openAddCustom);

  loadList();
}
