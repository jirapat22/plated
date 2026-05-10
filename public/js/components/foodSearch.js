import { api }                from '../api.js';
import { showToast }          from '../app.js';
import { openBarcodeScanner } from './barcode.js';

let searchDebounce = null;

export function renderFoodSearch(container, onSelect) {
  container.insertAdjacentHTML('beforeend', `
    <!-- Search bar -->
    <div class="search-bar-wrap" style="position:sticky;top:0;background:var(--surface);z-index:2;padding:0 16px 10px">
      <div style="display:flex;gap:8px;align-items:center">
        <div class="search-input-wrap" style="flex:1;position:relative">
          <svg style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-faint);pointer-events:none" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
            <path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <input id="fs-input" class="input" placeholder="Search or type a food name…"
            autocomplete="off" autocorrect="off" spellcheck="false"
            style="padding-left:38px;padding-right:36px" />
          <button id="fs-clear" style="display:none;position:absolute;right:10px;top:50%;transform:translateY(-50%);color:var(--text-faint);font-size:18px;padding:4px">×</button>
        </div>
        <button id="fs-barcode" title="Scan barcode"
          style="width:48px;height:48px;flex-shrink:0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;color:var(--text-muted)">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="1"  y="4" width="2"  height="12" fill="currentColor" rx="0.5"/>
            <rect x="5"  y="4" width="1"  height="12" fill="currentColor"/>
            <rect x="8"  y="4" width="2"  height="12" fill="currentColor" rx="0.5"/>
            <rect x="12" y="4" width="1"  height="12" fill="currentColor"/>
            <rect x="15" y="4" width="2"  height="12" fill="currentColor" rx="0.5"/>
            <rect x="18" y="4" width="1"  height="12" fill="currentColor"/>
          </svg>
        </button>
      </div>

      <!-- Quick filter chips -->
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="fs-chip active" data-filter="recent">🕐 Recent</button>
        <button class="fs-chip" data-filter="favourites">⭐ Favourites</button>
      </div>
    </div>

    <div id="fs-results"></div>
  `);

  const input   = container.querySelector('#fs-input');
  const clearBtn= container.querySelector('#fs-clear');
  const results = container.querySelector('#fs-results');
  let filter = 'recent';
  let query  = '';
  let remoteRows = [];

  // ── Chip filter ─────────────────────────────────────────────
  container.querySelectorAll('.fs-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      filter = chip.dataset.filter;
      container.querySelectorAll('.fs-chip').forEach(c => c.classList.toggle('active', c === chip));
      search();
    });
  });

  // ── Search ───────────────────────────────────────────────────
  async function search() {
    results.innerHTML = `<div class="skeleton skel-line" style="margin:12px 16px;width:60%"></div>
      <div class="skeleton skel-line" style="margin:8px 16px"></div>
      <div class="skeleton skel-line" style="margin:8px 16px;width:80%"></div>`;

    try {
      let rows = [];
      const q = query.trim();

      if (q) {
        // Local search first
        rows = await api.get(`/api/foods/search?q=${encodeURIComponent(q)}&limit=15`);
        // Always also search remote in background and merge
        api.get(`/api/foods/search/remote?q=${encodeURIComponent(q)}`)
          .then(remote => {
            const existing = new Set(rows.map(r => r.name.toLowerCase()));
            const newRemote = remote.filter(r => !existing.has(r.name.toLowerCase()));
            remoteRows = newRemote;
            if (newRemote.length && query.trim() === q) {
              appendRemoteRows(newRemote);
            }
          }).catch(() => {});
      } else if (filter === 'favourites') {
        rows = await api.get('/api/foods/favourites');
      } else {
        rows = await api.get('/api/foods/recent');
      }

      renderResults(rows, q);
    } catch (err) {
      results.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function renderResults(rows, q) {
    results.innerHTML = '';
    remoteRows = [];

    if (rows.length === 0 && !q) {
      results.innerHTML = `<div class="empty-state"><div class="empty-icon" style="font-size:28px">🍽</div>
        <div class="empty-text">No foods logged yet<br/><span style="font-size:12px;color:var(--text-faint)">Search above to find foods</span></div></div>`;
      appendQuickAdd('');
      return;
    }

    rows.forEach(food => results.appendChild(buildFoodRow(food)));

    if (q) {
      // Separator for remote results (filled in async)
      const remoteSep = document.createElement('div');
      remoteSep.id = 'fs-remote-sep';
      results.appendChild(remoteSep);
      // "Not found?" quick-add at bottom
      appendQuickAdd(q);
    }
  }

  function appendRemoteRows(remote) {
    const sep = document.getElementById('fs-remote-sep');
    if (!sep) return;
    const label = document.createElement('div');
    label.style.cssText = 'padding:6px 16px 2px;font-size:11px;font-weight:600;color:var(--text-faint);letter-spacing:.06em;text-transform:uppercase';
    label.textContent = 'From Open Food Facts';
    sep.replaceWith(label);
    remote.forEach(food => results.insertBefore(buildFoodRow(food), results.querySelector('#fs-quick-add')));
  }

  function buildFoodRow(food) {
    const el = document.createElement('div');
    el.className = 'food-list-item';
    const kcal = food.calories_per_100g != null ? `${Math.round(food.calories_per_100g)} kcal` : '–';
    const pro  = food.protein_per_100g  != null ? `${food.protein_per_100g.toFixed(1)}P` : '';
    const carb = food.carbs_per_100g    != null ? `${food.carbs_per_100g.toFixed(1)}C` : '';
    const fat  = food.fat_per_100g      != null ? `${food.fat_per_100g.toFixed(1)}F` : '';
    const macroStr = [pro, carb, fat].filter(Boolean).join(' · ');

    el.innerHTML = `
      <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:var(--surface-2);
        display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px">
        ${food.is_favourite ? '⭐' : food.source === 'nz_seed' ? '🥗' : food.source === 'custom' ? '✏️' : '🌍'}
      </div>
      <div class="food-list-info" style="flex:1;min-width:0">
        <div class="food-list-name">${food.name}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
          ${food.brand ? `<span>${food.brand} · </span>` : ''}
          <span style="font-variant-numeric:tabular-nums">${kcal}/100g</span>
          ${macroStr ? `<span style="color:var(--text-faint)"> · ${macroStr}</span>` : ''}
        </div>
      </div>
      <svg width="7" height="12" viewBox="0 0 7 12" fill="none" style="color:var(--text-faint);flex-shrink:0">
        <path d="M1 1l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    el.addEventListener('click', () => handleSelect(food));
    return el;
  }

  // ── Inline quick-add form ────────────────────────────────────
  function appendQuickAdd(prefill) {
    const wrap = document.createElement('div');
    wrap.id = 'fs-quick-add';
    wrap.style.cssText = 'padding:12px 16px 8px;border-top:1px solid var(--border);margin-top:4px';
    wrap.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px">
        ${prefill ? `"${prefill}" not found — add it:` : 'Add a custom food:'}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <input id="qa-name" class="input" placeholder="Food name *" value="${prefill}" style="height:42px" />
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="position:relative">
            <input id="qa-cal" class="input" type="number" placeholder="Calories" style="height:42px;padding-right:52px" />
            <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--text-faint)">kcal/100g</span>
          </div>
          <div style="position:relative">
            <input id="qa-srv" class="input" type="number" placeholder="Serving" value="100" style="height:42px;padding-right:24px" />
            <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--text-faint)">g</span>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
          <div style="position:relative">
            <input id="qa-pro" class="input" type="number" placeholder="Protein" style="height:38px;font-size:13px;padding-right:18px;border-color:var(--protein)44" />
            <span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--protein)">P</span>
          </div>
          <div style="position:relative">
            <input id="qa-carb" class="input" type="number" placeholder="Carbs" style="height:38px;font-size:13px;padding-right:18px;border-color:var(--carbs)44" />
            <span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--carbs)">C</span>
          </div>
          <div style="position:relative">
            <input id="qa-fat" class="input" type="number" placeholder="Fat" style="height:38px;font-size:13px;padding-right:18px;border-color:var(--fat)44" />
            <span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--fat)">F</span>
          </div>
        </div>
        <button id="qa-save" class="btn btn-primary btn-full" style="height:44px">Save & Add to Meal</button>
      </div>
    `;
    results.appendChild(wrap);

    wrap.querySelector('#qa-save').addEventListener('click', async () => {
      const name = wrap.querySelector('#qa-name').value.trim();
      if (!name) { showToast('Food name is required', 'error'); return; }
      const body = {
        name,
        calories_per_100g: parseFloat(wrap.querySelector('#qa-cal').value)  || null,
        protein_per_100g:  parseFloat(wrap.querySelector('#qa-pro').value)  || null,
        carbs_per_100g:    parseFloat(wrap.querySelector('#qa-carb').value) || null,
        fat_per_100g:      parseFloat(wrap.querySelector('#qa-fat').value)  || null,
        serving_size_g:    parseFloat(wrap.querySelector('#qa-srv').value)  || 100,
      };
      try {
        const saved = await api.post('/api/foods', body);
        onSelect(saved);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  async function handleSelect(food) {
    if (!food.id) {
      try { food = await api.post('/api/foods', food); } catch { /* use as-is */ }
    }
    onSelect(food);
  }

  // ── Clear button ─────────────────────────────────────────────
  input.addEventListener('input', e => {
    query = e.target.value;
    clearBtn.style.display = query ? 'block' : 'none';
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(search, 280);
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    query = '';
    clearBtn.style.display = 'none';
    input.focus();
    search();
  });

  // ── Barcode ──────────────────────────────────────────────────
  container.querySelector('#fs-barcode').addEventListener('click', () => {
    openBarcodeScanner(async barcode => {
      try {
        const { food } = await api.get(`/api/foods/barcode/${barcode}`);
        onSelect(food);
      } catch (err) {
        if (err.message.toLowerCase().includes('not found')) {
          input.value = barcode;
          query = barcode;
          clearBtn.style.display = 'block';
          search();
          showToast('Barcode not found — fill in the details below', 'info');
        } else {
          showToast(err.message, 'error');
        }
      }
    });
  });

  // Focus input and load defaults
  setTimeout(() => input.focus(), 100);
  search();
}
