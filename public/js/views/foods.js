import { api }           from '../api.js';
import { showToast, showSheet, hideSheet, showPrompt, getProfile } from '../app.js';
import { getFoodIcon }  from '../utils/foodIcon.js';
import { wireEnergyUnitToggle, wireDualNutrition } from '../utils/energy.js';
import { renderBatches } from './batches.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Badge for user-added foods. Returns '' for the built-in database foods.
export function foodTagHtml(food) {
  if (food.source === 'custom') return '<span class="food-tag tag-custom">Custom</span>';
  // Only badge a scanned food if YOU scanned it — shared/built-in foods that
  // happen to carry an OFF source shouldn't read as "Scanned" to everyone.
  if (food.source === 'openfoodfacts' && isMine(food)) return '<span class="food-tag tag-scanned">Scanned</span>';
  return '';
}
// Whether the current profile may delete this food (creator or admin).
export function canDeleteFood(food) {
  const me = getProfile();
  return !!me && (me.is_admin || food.created_by_profile === me.id);
}
// Whether the current profile created this food.
export function isMine(food) {
  const me = getProfile();
  return !!me && food.created_by_profile === me.id;
}

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
    <div style="padding:0 16px 10px;display:flex;gap:8px;align-items:center">
      <div class="search-tabs" id="foods-tabs" style="padding:0;flex:1;overflow-x:auto;flex-wrap:nowrap">
        <button class="search-tab active" data-tab="all">All</button>
        <button class="search-tab" data-tab="favourites">★ Favourites</button>
        <button class="search-tab" data-tab="batches">🍱 Batches</button>
        <button class="search-tab" data-tab="custom">Custom</button>
        <button class="search-tab" data-tab="scanned">Scanned</button>
      </div>
      <button class="btn btn-secondary" id="add-custom-btn" style="height:36px;font-size:12px;flex-shrink:0">+ Add</button>
    </div>
    <div id="foods-list"></div>
  `;

  let currentTab = 'all';
  let query = '';

  async function loadList() {
    const list = document.getElementById('foods-list');
    if (!list) return;   // view torn down (tab switch) before/while loading
    // Batches are their own thing, not a food list.
    const nonFoodTab = currentTab === 'batches';
    document.getElementById('foods-search').closest('.search-input-wrap').style.display = nonFoodTab ? 'none' : '';
    document.getElementById('add-custom-btn').style.display = nonFoodTab ? 'none' : '';
    if (currentTab === 'batches')   { renderBatches(list); return; }
    list.innerHTML = '<div class="skeleton skel-line" style="margin:8px 16px"></div>';

    try {
      let rows;
      const q = query.trim();
      if (currentTab === 'favourites') {
        rows = await api.get('/api/foods/favourites');
        if (q) rows = rows.filter(f => `${f.name} ${f.brand || ''}`.toLowerCase().includes(q.toLowerCase()));
      } else if (currentTab === 'custom' || currentTab === 'scanned') {
        rows = await api.get(`/api/foods/by-source?source=${currentTab}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      } else if (q) {
        rows = await api.get(`/api/foods/search?q=${encodeURIComponent(q)}`);
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
      <div class="food-list-icon" style="font-size:18px">${food.is_favourite ? '⭐' : getFoodIcon(food.name)}</div>
      <div class="food-list-info">
        <div class="food-list-name">${esc(food.name)} ${foodTagHtml(food)}</div>
        <div class="food-list-sub">${food.brand ? esc(food.brand) + ' · ' : ''}${food.calories_per_100g != null ? food.calories_per_100g.toFixed(0) + ' kcal/100g' : 'no cal data'}${isMine(food) ? ' · <span style="color:var(--accent)">by you</span>' : ''}</div>
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
      function renderDetail() {
        content.innerHTML = `
          <div class="sheet-header">
            <span class="sheet-title">${esc(food.name)}</span>
            <button class="sheet-close" id="detail-close">✕</button>
          </div>
          <div style="padding:0 16px">
            <div style="margin-bottom:12px">${food.brand ? `<span class="muted">${esc(food.brand)}</span> ` : ''}${foodTagHtml(food)}${isMine(food) ? ' <span class="food-tag" style="background:var(--accent-dim);color:var(--accent)">BY YOU</span>' : ''}</div>
            <div class="card" style="margin-bottom:12px">
              <div class="label" style="margin-bottom:10px">Per 100g</div>
              <div class="macro-totals-row">
                <div class="macro-total"><div class="macro-total-val num">${food.calories_per_100g?.toFixed(0) ?? '–'}</div><div class="macro-total-lbl label">kcal</div></div>
                <div class="macro-total"><div class="macro-total-val num" style="color:var(--protein)">${food.protein_per_100g?.toFixed(1) ?? '–'}g</div><div class="macro-total-lbl label">protein</div></div>
                <div class="macro-total"><div class="macro-total-val num" style="color:var(--carbs)">${food.carbs_per_100g?.toFixed(1) ?? '–'}g</div><div class="macro-total-lbl label">carbs</div></div>
                <div class="macro-total"><div class="macro-total-val num" style="color:var(--fat)">${food.fat_per_100g?.toFixed(1) ?? '–'}g</div><div class="macro-total-lbl label">fat</div></div>
                <div class="macro-total"><div class="macro-total-val num" style="color:var(--fiber)">${food.fiber_per_100g?.toFixed(1) ?? '–'}g</div><div class="macro-total-lbl label">fiber</div></div>
              </div>
            </div>
            <div style="display:flex;gap:8px">
              ${canDeleteFood(food) ? `<button class="btn btn-secondary btn-full" id="detail-edit">✏️ Edit</button>
              <button class="btn btn-danger btn-full" id="detail-delete">Delete</button>` : '<div style="font-size:12px;color:var(--text-faint);padding:6px 0">Only the creator can edit this food.</div>'}
            </div>
          </div>
        `;
        document.getElementById('detail-close').addEventListener('click', hideSheet);
        document.getElementById('detail-edit')?.addEventListener('click', renderEdit);
        document.getElementById('detail-delete')?.addEventListener('click', async () => {
          if (!confirm(`Delete "${food.name}"? It'll disappear from search but your past logs stay intact.`)) return;
          try {
            await api.delete(`/api/foods/${food.id}`);
            hideSheet();
            showToast('Food deleted', 'success');
            loadList();
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      }

      function renderEdit() {
        const v = (n) => n != null ? n : '';
        content.innerHTML = `
          <div class="sheet-header">
            <button id="edit-back" style="font-size:13px;color:var(--text-muted);display:flex;align-items:center;gap:4px">‹ Back</button>
            <span class="sheet-title">Edit food</span>
            <div style="width:32px"></div>
          </div>
          <div style="padding:0 16px">
            <div class="form-group">
              <label class="form-label">Name *</label>
              <input class="input" id="ef-name" value="" />
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Brand</label>
                <input class="input" id="ef-brand" value="" />
              </div>
              <div class="form-group">
                <label class="form-label">Serving (g)</label>
                <input class="input" id="ef-srv" type="text" inputmode="decimal" value="" />
              </div>
            </div>
            <div class="label" style="margin-bottom:8px">Nutrition</div>
            <div class="nutr-table">
              <div></div>
              <div class="nutr-col-head">per 100 g</div>
              <div class="nutr-col-head" id="ef-srv-head">per serving</div>

              <div class="nutr-lbl">Energy</div>
              <input class="input nutr-input" id="ef-cal" type="text" inputmode="decimal" />
              <input class="input nutr-input" id="ef-cal-srv" type="text" inputmode="decimal" />

              <div></div>
              <div style="grid-column:span 2;display:flex;gap:4px;padding-top:2px" id="ef-cal-unit">
                <button type="button" class="eunit-btn active" data-unit="kcal">kcal</button>
                <button type="button" class="eunit-btn" data-unit="kj">kJ</button>
              </div>

              <div class="nutr-lbl">Protein</div>
              <input class="input nutr-input" id="ef-pro" type="text" inputmode="decimal" placeholder="g" />
              <input class="input nutr-input" id="ef-pro-srv" type="text" inputmode="decimal" placeholder="g" />

              <div class="nutr-lbl">Carbs</div>
              <input class="input nutr-input" id="ef-crb" type="text" inputmode="decimal" placeholder="g" />
              <input class="input nutr-input" id="ef-crb-srv" type="text" inputmode="decimal" placeholder="g" />

              <div class="nutr-lbl">Fat</div>
              <input class="input nutr-input" id="ef-fat" type="text" inputmode="decimal" placeholder="g" />
              <input class="input nutr-input" id="ef-fat-srv" type="text" inputmode="decimal" placeholder="g" />

              <div class="nutr-lbl">Fiber</div>
              <input class="input nutr-input" id="ef-fib" type="text" inputmode="decimal" placeholder="g" />
              <input class="input nutr-input" id="ef-fib-srv" type="text" inputmode="decimal" placeholder="g" />
            </div>
            <button class="btn btn-primary btn-full" id="ef-save">Save Changes</button>
          </div>
        `;
        // Set values via JS to avoid HTML-injection issues with food.name
        content.querySelector('#ef-name').value = food.name || '';
        content.querySelector('#ef-brand').value = food.brand || '';
        const efSrvInput = content.querySelector('#ef-srv');
        efSrvInput.value = food.serving_size_g ?? 100;
        content.querySelector('#ef-cal').value = v(food.calories_per_100g);
        content.querySelector('#ef-pro').value = v(food.protein_per_100g);
        content.querySelector('#ef-crb').value = v(food.carbs_per_100g);
        content.querySelector('#ef-fat').value = v(food.fat_per_100g);
        content.querySelector('#ef-fib').value = v(food.fiber_per_100g);

        const getEditCalKcal = wireEnergyUnitToggle(
          content.querySelector('#ef-cal-unit'),
          content.querySelector('#ef-cal')
        );
        const efSrvHead = content.querySelector('#ef-srv-head');
        const updateEfSrvHead = () => {
          efSrvHead.textContent = `per serving (${parseFloat(efSrvInput.value) || 100}g)`;
        };
        updateEfSrvHead();
        efSrvInput.addEventListener('input', updateEfSrvHead);
        const refreshEfSrv = wireDualNutrition(efSrvInput, [
          { per100: content.querySelector('#ef-cal'), srv: content.querySelector('#ef-cal-srv') },
          { per100: content.querySelector('#ef-pro'), srv: content.querySelector('#ef-pro-srv') },
          { per100: content.querySelector('#ef-crb'), srv: content.querySelector('#ef-crb-srv') },
          { per100: content.querySelector('#ef-fat'), srv: content.querySelector('#ef-fat-srv') },
          { per100: content.querySelector('#ef-fib'), srv: content.querySelector('#ef-fib-srv') },
        ]);
        refreshEfSrv();

        document.getElementById('edit-back').addEventListener('click', renderDetail);
        document.getElementById('ef-save').addEventListener('click', async () => {
          const name = content.querySelector('#ef-name').value.trim();
          if (!name) { showToast('Name is required', 'error'); return; }
          const body = {
            name,
            brand:             content.querySelector('#ef-brand').value.trim() || null,
            serving_size_g:    parseFloat(content.querySelector('#ef-srv').value)  || 100,
            calories_per_100g: getEditCalKcal(),
            protein_per_100g:  parseFloat(content.querySelector('#ef-pro').value)  || null,
            carbs_per_100g:    parseFloat(content.querySelector('#ef-crb').value)  || null,
            fat_per_100g:      parseFloat(content.querySelector('#ef-fat').value)  || null,
            fiber_per_100g:    parseFloat(content.querySelector('#ef-fib').value)  || null,
          };
          const btn = document.getElementById('ef-save');
          btn.disabled = true; btn.textContent = 'Saving…';
          try {
            const updated = await api.patch(`/api/foods/${food.id}`, body);
            Object.assign(food, updated);
            showToast('Food updated', 'success');
            loadList();
            renderDetail();
          } catch (err) {
            showToast(err.message, 'error');
            btn.disabled = false; btn.textContent = 'Save Changes';
          }
        });
      }

      renderDetail();
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
            <input class="input" id="f-serving" type="text" inputmode="decimal" value="100" />
          </div>
          <div class="label" style="margin-bottom:8px">Nutrition</div>
          <div class="nutr-table">
            <div></div>
            <div class="nutr-col-head">per 100 g</div>
            <div class="nutr-col-head" id="f-srv-head">per serving</div>

            <div class="nutr-lbl">Energy</div>
            <input class="input nutr-input" id="f-cal" type="text" inputmode="decimal" placeholder="0" />
            <input class="input nutr-input" id="f-cal-srv" type="text" inputmode="decimal" placeholder="0" />

            <div></div>
            <div style="grid-column:span 2;display:flex;gap:4px;padding-top:2px" id="f-cal-unit">
              <button type="button" class="eunit-btn active" data-unit="kcal">kcal</button>
              <button type="button" class="eunit-btn" data-unit="kj">kJ</button>
            </div>

            <div class="nutr-lbl">Protein</div>
            <input class="input nutr-input" id="f-pro" type="text" inputmode="decimal" placeholder="g" />
            <input class="input nutr-input" id="f-pro-srv" type="text" inputmode="decimal" placeholder="g" />

            <div class="nutr-lbl">Carbs</div>
            <input class="input nutr-input" id="f-crb" type="text" inputmode="decimal" placeholder="g" />
            <input class="input nutr-input" id="f-crb-srv" type="text" inputmode="decimal" placeholder="g" />

            <div class="nutr-lbl">Fat</div>
            <input class="input nutr-input" id="f-fat" type="text" inputmode="decimal" placeholder="g" />
            <input class="input nutr-input" id="f-fat-srv" type="text" inputmode="decimal" placeholder="g" />

            <div class="nutr-lbl">Fiber</div>
            <input class="input nutr-input" id="f-fib" type="text" inputmode="decimal" placeholder="g" />
            <input class="input nutr-input" id="f-fib-srv" type="text" inputmode="decimal" placeholder="g" />
          </div>
          <button class="btn btn-primary btn-full" id="custom-save" style="margin-top:4px">Save Food</button>
        </div>
      `;
      const getCustomCalKcal = wireEnergyUnitToggle(
        document.getElementById('f-cal-unit'),
        document.getElementById('f-cal')
      );
      const fSrvInput = document.getElementById('f-serving');
      const fSrvHead  = document.getElementById('f-srv-head');
      const updateFSrvHead = () => {
        fSrvHead.textContent = `per serving (${parseFloat(fSrvInput.value) || 100}g)`;
      };
      updateFSrvHead();
      fSrvInput.addEventListener('input', updateFSrvHead);
      wireDualNutrition(fSrvInput, [
        { per100: document.getElementById('f-cal'), srv: document.getElementById('f-cal-srv') },
        { per100: document.getElementById('f-pro'), srv: document.getElementById('f-pro-srv') },
        { per100: document.getElementById('f-crb'), srv: document.getElementById('f-crb-srv') },
        { per100: document.getElementById('f-fat'), srv: document.getElementById('f-fat-srv') },
        { per100: document.getElementById('f-fib'), srv: document.getElementById('f-fib-srv') },
      ]);

      document.getElementById('custom-close').addEventListener('click', hideSheet);
      document.getElementById('custom-save').addEventListener('click', async () => {
        const name = document.getElementById('f-name').value.trim();
        if (!name) { showToast('Name is required', 'error'); return; }
        const body = {
          name,
          brand:             document.getElementById('f-brand').value.trim()   || null,
          barcode:           document.getElementById('f-barcode').value.trim() || null,
          serving_size_g:    parseFloat(fSrvInput.value) || 100,
          calories_per_100g: getCustomCalKcal(),
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
