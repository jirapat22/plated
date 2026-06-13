import { api }                           from '../api.js';
import { showToast }                    from '../app.js';
import { openBarcodeScanner }           from './barcode.js';
import { fmtE, unitLabel, parseNutritionLabel, wireEnergyUnitToggle, wireDualNutrition } from '../utils/energy.js';
import { getFoodIcon }                  from '../utils/foodIcon.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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
  let pendingBarcode = null;

  // ── Chip filter ─────────────────────────────────────────────
  container.querySelectorAll('.fs-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      filter = chip.dataset.filter;
      container.querySelectorAll('.fs-chip').forEach(c => c.classList.toggle('active', c === chip));
      search();
    });
  });

  // ── Search ───────────────────────────────────────────────────
  async function search(fetchRemote = false) {
    results.innerHTML = `<div class="skeleton skel-line" style="margin:12px 16px;width:60%"></div>
      <div class="skeleton skel-line" style="margin:8px 16px"></div>
      <div class="skeleton skel-line" style="margin:8px 16px;width:80%"></div>`;

    try {
      let rows = [];
      const q = query.trim();

      if (q) {
        rows = await api.get(`/api/foods/search?q=${encodeURIComponent(q)}&limit=20`);

        // Auto-fetch remote only when local has nothing; otherwise show button
        if (fetchRemote || rows.length === 0) {
          const remote = await api.get(`/api/foods/search/remote?q=${encodeURIComponent(q)}`);
          const existing = new Set(rows.map(r => r.name.toLowerCase()));
          remoteRows = remote.filter(r => !existing.has(r.name.toLowerCase()));
          rows = [...rows, ...remoteRows];
        }
      } else if (filter === 'favourites') {
        rows = await api.get('/api/foods/favourites');
      } else {
        rows = await api.get('/api/foods/recent');
      }

      renderResults(rows, q, fetchRemote);
    } catch (err) {
      results.innerHTML = `<div class="empty-state"><div class="empty-text">${err.message}</div></div>`;
    }
  }

  function renderResults(rows, q, alreadyFetchedRemote = false) {
    results.innerHTML = '';
    remoteRows = [];

    if (rows.length === 0 && !q) {
      results.innerHTML = `<div class="empty-state"><div class="empty-icon" style="font-size:28px">🍽</div>
        <div class="empty-text">No foods logged yet<br/><span style="font-size:12px;color:var(--text-faint)">Search above to find foods</span></div></div>`;
      appendQuickAdd('');
      return;
    }

    // Result count label
    const localCount = rows.filter(r => r.id).length;
    if (q && localCount > 0) {
      const countEl = document.createElement('div');
      countEl.style.cssText = 'padding:4px 16px 6px;font-size:11px;color:var(--text-faint)';
      countEl.textContent = `${localCount} found locally`;
      results.appendChild(countEl);
    }

    // Separate local (have DB id) from remote OFF results (no id yet)
    const localRows  = rows.filter(r =>  r.id);
    const remoteOnly = rows.filter(r => !r.id);

    localRows.forEach(food => results.appendChild(buildFoodRow(food)));

    if (remoteOnly.length) {
      const lbl = document.createElement('div');
      lbl.style.cssText = 'padding:10px 16px 4px;font-size:11px;font-weight:700;color:var(--text-faint);letter-spacing:.06em;text-transform:uppercase';
      lbl.textContent = 'From Open Food Facts';
      results.appendChild(lbl);
      remoteOnly.forEach(food => results.appendChild(buildFoodRow(food)));
    }

    if (q) {
      // Show "Search online" button only if we haven't fetched remote yet
      if (!alreadyFetchedRemote && remoteOnly.length === 0) {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:block;width:calc(100% - 32px);margin:10px 16px;height:40px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-weight:600;color:var(--text-muted);transition:all .15s';
        btn.textContent = '🌍 Search Open Food Facts';
        btn.addEventListener('click', () => search(true));
        results.appendChild(btn);
      }
      appendQuickAdd(q);
    }
  }

  function buildFoodRow(food) {
    const el = document.createElement('div');
    el.className = 'food-list-item';
    const ul       = unitLabel();
    const kcalStr  = food.calories_per_100g != null ? `${fmtE(food.calories_per_100g)} ${ul}/100g` : 'no cal data';
    const pro      = food.protein_per_100g  != null ? `${food.protein_per_100g.toFixed(1)}P` : '';
    const carb     = food.carbs_per_100g    != null ? `${food.carbs_per_100g.toFixed(1)}C` : '';
    const fat      = food.fat_per_100g      != null ? `${food.fat_per_100g.toFixed(1)}F` : '';
    const macroStr = [pro, carb, fat].filter(Boolean).join(' · ');

    el.innerHTML = `
      <div style="width:36px;height:36px;border-radius:var(--radius-sm);background:var(--surface-2);
        display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">
        ${getFoodIcon(food.name)}
      </div>
      <div class="food-list-info" style="flex:1;min-width:0">
        <div class="food-list-name">${esc(food.name)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
          ${food.brand ? `<span>${esc(food.brand)} · </span>` : ''}
          <span style="font-variant-numeric:tabular-nums">${kcalStr}</span>
          ${macroStr ? `<span style="color:var(--text-faint)"> · ${macroStr}</span>` : ''}
        </div>
      </div>
      ${food.id ? `<button class="fav-toggle"
        style="padding:6px 8px;font-size:16px;flex-shrink:0;color:${food.is_favourite ? '#ffd700' : 'var(--text-faint)'}">
        ${food.is_favourite ? '⭐' : '☆'}
      </button>` : ''}
      <svg width="7" height="12" viewBox="0 0 7 12" fill="none" style="color:var(--text-faint);flex-shrink:0">
        <path d="M1 1l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    const favBtn = el.querySelector('.fav-toggle');
    if (favBtn) {
      favBtn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const res = await api.patch(`/api/foods/${food.id}/favourite`);
          food.is_favourite = res.is_favourite;
          favBtn.textContent = res.is_favourite ? '⭐' : '☆';
          favBtn.style.color = res.is_favourite ? '#ffd700' : 'var(--text-faint)';
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    el.addEventListener('click', () => handleSelect(food));
    return el;
  }

  // ── Inline quick-add form ────────────────────────────────────
  function appendQuickAdd(prefill) {
    const wrap = document.createElement('div');
    wrap.id = 'fs-quick-add';
    wrap.style.cssText = 'padding:12px 16px 8px;border-top:1px solid var(--border);margin-top:4px';
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:12px;font-weight:600;color:var(--text-muted)" id="qa-label">
          ${pendingBarcode ? `Barcode ${esc(pendingBarcode)} not found — add it:` : prefill ? 'Not found — add it:' : 'Add a custom food:'}
        </span>
        <button id="qa-paste-btn" style="font-size:11px;font-weight:600;color:var(--accent);background:var(--accent-dim);padding:3px 10px;border-radius:999px;border:1px solid rgba(200,184,255,.2)">
          📋 Paste label
        </button>
      </div>

      <!-- Paste area (hidden by default) -->
      <div id="qa-paste-area" style="display:none;margin-bottom:10px">
        <textarea id="qa-paste-input" placeholder="Paste the nutrition panel text here…"
          style="width:100%;height:100px;background:var(--surface-2);border:1px solid var(--accent);border-radius:var(--radius-sm);padding:10px;font-size:12px;font-family:monospace;color:var(--text);resize:none;outline:none"></textarea>
        <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Paste the full nutrition table — values auto-fill below</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        <input id="qa-name" class="input" placeholder="Food name *" style="height:42px" />
        <div style="display:flex;gap:6px;align-items:center">
          <div style="position:relative;flex:1">
            <input id="qa-srv" class="input" type="text" inputmode="decimal" placeholder="Serving" value="100" style="height:42px;padding-right:26px" />
            <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--text-faint)">g</span>
          </div>
          <span style="font-size:11px;color:var(--text-faint);flex-shrink:0">serving size</span>
        </div>
        <div class="nutr-table" id="qa-nutr">
          <div></div>
          <div class="nutr-col-head">per 100 g</div>
          <div class="nutr-col-head" id="qa-srv-head">per serving</div>

          <div class="nutr-lbl">Energy</div>
          <input id="qa-cal" class="input nutr-input" type="text" inputmode="decimal" placeholder="0" />
          <input id="qa-cal-srv" class="input nutr-input" type="text" inputmode="decimal" placeholder="0" />

          <div></div>
          <div style="grid-column:span 2;display:flex;gap:4px;padding-top:2px" id="qa-cal-unit">
            <button type="button" class="eunit-btn active" data-unit="kcal">kcal</button>
            <button type="button" class="eunit-btn" data-unit="kj">kJ</button>
          </div>

          <div class="nutr-lbl" style="color:var(--protein)">Pro</div>
          <input id="qa-pro" class="input nutr-input" type="text" inputmode="decimal" placeholder="g" style="border-color:var(--protein)55" />
          <input id="qa-pro-srv" class="input nutr-input" type="text" inputmode="decimal" placeholder="g" style="border-color:var(--protein)55" />

          <div class="nutr-lbl" style="color:var(--carbs)">Crb</div>
          <input id="qa-carb" class="input nutr-input" type="text" inputmode="decimal" placeholder="g" style="border-color:var(--carbs)55" />
          <input id="qa-carb-srv" class="input nutr-input" type="text" inputmode="decimal" placeholder="g" style="border-color:var(--carbs)55" />

          <div class="nutr-lbl" style="color:var(--fat)">Fat</div>
          <input id="qa-fat" class="input nutr-input" type="text" inputmode="decimal" placeholder="g" style="border-color:var(--fat)55" />
          <input id="qa-fat-srv" class="input nutr-input" type="text" inputmode="decimal" placeholder="g" style="border-color:var(--fat)55" />
        </div>
        <button id="qa-save" class="btn btn-primary btn-full" style="height:44px">Save & Add to Meal</button>
      </div>
    `;
    results.appendChild(wrap);
    if (prefill && !pendingBarcode) wrap.querySelector('#qa-name').value = prefill;

    const getCalKcal = wireEnergyUnitToggle(wrap.querySelector('#qa-cal-unit'), wrap.querySelector('#qa-cal'));
    const qaSrv = wrap.querySelector('#qa-srv');
    const qaSrvHead = wrap.querySelector('#qa-srv-head');
    const updateQaSrvHead = () => {
      qaSrvHead.textContent = `per serving (${parseFloat(qaSrv.value) || 100}g)`;
    };
    updateQaSrvHead();
    qaSrv.addEventListener('input', updateQaSrvHead);
    const refreshQaSrv = wireDualNutrition(qaSrv, [
      { per100: wrap.querySelector('#qa-cal'),  srv: wrap.querySelector('#qa-cal-srv') },
      { per100: wrap.querySelector('#qa-pro'),  srv: wrap.querySelector('#qa-pro-srv') },
      { per100: wrap.querySelector('#qa-carb'), srv: wrap.querySelector('#qa-carb-srv') },
      { per100: wrap.querySelector('#qa-fat'),  srv: wrap.querySelector('#qa-fat-srv') },
    ]);

    // Paste label toggle
    const pasteBtn  = wrap.querySelector('#qa-paste-btn');
    const pasteArea = wrap.querySelector('#qa-paste-area');
    const pasteInput= wrap.querySelector('#qa-paste-input');

    pasteBtn.addEventListener('click', () => {
      const open = pasteArea.style.display !== 'none';
      pasteArea.style.display = open ? 'none' : 'block';
      if (!open) pasteInput.focus();
    });

    // Auto-parse on paste or input
    pasteInput.addEventListener('input', () => {
      const parsed = parseNutritionLabel(pasteInput.value);
      if (parsed.calories_per_100g != null) {
        // parseNutritionLabel already converts kJ labels to kcal, and the
        // unit toggle starts in kcal — so the raw value matches as-is.
        wrap.querySelector('#qa-cal').value = parsed.calories_per_100g;
      }
      if (parsed.protein_per_100g  != null) wrap.querySelector('#qa-pro').value  = parsed.protein_per_100g;
      if (parsed.carbs_per_100g    != null) wrap.querySelector('#qa-carb').value = parsed.carbs_per_100g;
      if (parsed.fat_per_100g      != null) wrap.querySelector('#qa-fat').value  = parsed.fat_per_100g;
      if (parsed.serving_size_g    != null) { wrap.querySelector('#qa-srv').value = parsed.serving_size_g; updateQaSrvHead(); }
      if (Object.keys(parsed).length > 0)   { refreshQaSrv(); pasteArea.style.display = 'none'; }
    });

    // Save
    wrap.querySelector('#qa-save').addEventListener('click', async () => {
      const name = wrap.querySelector('#qa-name').value.trim();
      if (!name) { showToast('Food name is required', 'error'); return; }

      const body = {
        name,
        barcode:           pendingBarcode || null,
        calories_per_100g: getCalKcal(),
        protein_per_100g:  parseFloat(wrap.querySelector('#qa-pro').value)  || null,
        carbs_per_100g:    parseFloat(wrap.querySelector('#qa-carb').value) || null,
        fat_per_100g:      parseFloat(wrap.querySelector('#qa-fat').value)  || null,
        serving_size_g:    parseFloat(wrap.querySelector('#qa-srv').value)  || 100,
      };
      try {
        const saved = await api.post('/api/foods', body);
        pendingBarcode = null;
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
    pendingBarcode = null;
    clearBtn.style.display = query ? 'block' : 'none';
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => search(false), 280);
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    query = '';
    pendingBarcode = null;
    clearBtn.style.display = 'none';
    input.focus();
    search(false);
  });

  // ── Barcode ──────────────────────────────────────────────────
  container.querySelector('#fs-barcode').addEventListener('click', () => {
    openBarcodeScanner(async barcode => {
      try {
        const { food } = await api.get(`/api/foods/barcode/${barcode}`);
        onSelect(food);
      } catch (err) {
        if (err.message.toLowerCase().includes('not found')) {
          // Show the quick-add form directly with the barcode tracked separately —
          // searching by the raw digits would just pollute the food name field
          // and (without this) the saved food never gets linked to the barcode,
          // so the same code shows "not found" again next time it's scanned.
          pendingBarcode = barcode;
          query = '';
          input.value = '';
          clearBtn.style.display = 'none';
          results.innerHTML = '';
          appendQuickAdd('');
          showToast('Barcode not found — add the food below to save it for next time', 'info');
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
