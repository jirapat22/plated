import { api }                  from '../api.js';
import { showToast }            from '../app.js';
import { openBarcodeScanner }   from './barcode.js';

let searchDebounce = null;

/**
 * Renders a full food-search UI into `container`.
 * Calls `onSelect(food)` when the user taps a food item.
 */
export function renderFoodSearch(container, onSelect) {
  const searchWrap = document.createElement('div');
  searchWrap.innerHTML = `
    <div class="search-bar-wrap">
      <div class="search-bar">
        <div class="search-input-wrap" style="flex:1">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <input class="input" id="fs-input" placeholder="Search foods…" autocomplete="off" />
        </div>
        <button id="fs-barcode" title="Scan barcode" style="width:48px;height:48px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect x="2" y="5" width="2" height="12" fill="currentColor"/>
            <rect x="6" y="5" width="1" height="12" fill="currentColor"/>
            <rect x="9" y="5" width="2" height="12" fill="currentColor"/>
            <rect x="13" y="5" width="1" height="12" fill="currentColor"/>
            <rect x="16" y="5" width="2" height="12" fill="currentColor"/>
            <rect x="19" y="5" width="1" height="12" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="search-tabs" style="padding:0 16px 10px">
      <button class="search-tab active" data-tab="recent">Recent</button>
      <button class="search-tab" data-tab="favourites">Favourites</button>
      <button class="search-tab" data-tab="remote">🌍 Search</button>
    </div>

    <div id="fs-results"></div>
  `;
  container.appendChild(searchWrap);

  let activeTab = 'recent';
  let query = '';

  const input   = container.querySelector('#fs-input');
  const results = container.querySelector('#fs-results');

  async function loadTab() {
    results.innerHTML = '<div class="skeleton skel-line" style="margin:8px 16px"></div>';
    try {
      let rows = [];
      if (query.trim()) {
        // text search — always local first
        rows = await api.get(`/api/foods/search?q=${encodeURIComponent(query)}`);
        if (activeTab === 'remote' && rows.length < 5) {
          const remote = await api.get(`/api/foods/search/remote?q=${encodeURIComponent(query)}`);
          // dedup by name
          const existing = new Set(rows.map(r => r.name.toLowerCase()));
          remote.forEach(r => { if (!existing.has(r.name.toLowerCase())) rows.push(r); });
        }
      } else if (activeTab === 'favourites') {
        rows = await api.get('/api/foods/favourites');
      } else {
        rows = await api.get('/api/foods/recent');
      }
      renderResults(rows);
    } catch (err) {
      results.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function renderResults(rows) {
    if (rows.length === 0) {
      results.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">No foods found</div></div>';
      return;
    }
    results.innerHTML = '';
    rows.forEach(food => {
      const el = document.createElement('div');
      el.className = 'food-list-item';
      const kcal = food.calories_per_100g != null ? `${food.calories_per_100g.toFixed(0)} kcal/100g` : 'no data';
      el.innerHTML = `
        <div class="food-list-icon">${food.is_favourite ? '⭐' : food.source === 'openfoodfacts' ? '🌍' : '✏️'}</div>
        <div class="food-list-info">
          <div class="food-list-name">${food.name}</div>
          <div class="food-list-sub">${food.brand || ''} ${kcal}</div>
        </div>
        <svg width="8" height="14" viewBox="0 0 8 14" fill="none" style="color:var(--text-faint)">
          <path d="M1 1l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      el.addEventListener('click', () => handleSelect(food));
      results.appendChild(el);
    });
  }

  async function handleSelect(food) {
    // If food came from remote (no id yet), save it first
    if (!food.id) {
      try {
        const saved = await api.post('/api/foods', food);
        onSelect(saved);
      } catch {
        onSelect(food); // proceed anyway
      }
    } else {
      onSelect(food);
    }
  }

  // Tab switching
  container.querySelectorAll('[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      container.querySelectorAll('[data-tab]').forEach(t =>
        t.classList.toggle('active', t === tab)
      );
      loadTab();
    });
  });

  // Search input
  input.addEventListener('input', e => {
    query = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadTab, 300);
  });

  // Barcode scanner
  container.querySelector('#fs-barcode').addEventListener('click', () => {
    openBarcodeScanner(async (barcode) => {
      try {
        const { food } = await api.get(`/api/foods/barcode/${barcode}`);
        onSelect(food);
      } catch (err) {
        if (err.message.includes('not found')) {
          // Pre-fill custom form with barcode
          input.value = '';
          showToast('Barcode not found — add it manually', 'info');
        } else {
          showToast(err.message, 'error');
        }
      }
    });
  });

  loadTab();
}
