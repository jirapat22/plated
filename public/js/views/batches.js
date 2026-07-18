import { api }                        from '../api.js';
import { showToast, showSheet, hideSheet } from '../app.js';
import { renderFoodSearch }           from '../components/foodSearch.js';
import { fmtE, unitLabel }            from '../utils/energy.js';
import { localDate }                  from '../utils/date.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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
    document.getElementById('new-batch').addEventListener('click', () => openBuilder(load));
    container.querySelectorAll('[data-portion]').forEach(btn =>
      btn.addEventListener('click', () => openPortion(batches.find(x => x.id == btn.dataset.portion), load)));
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
    return `
      <div style="padding:0 16px 12px">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:2px">
            <div style="font-weight:700;font-size:15px">${esc(b.name)}</div>
            <button data-del="${b.id}" title="Delete" style="color:var(--error);font-size:15px;flex-shrink:0">✕</button>
          </div>
          ${ingTxt ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${ingTxt}</div>` : ''}
          <div class="water-bar-outer"><div class="water-bar-fill" style="width:${pct}%"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-top:6px">
            <span><strong style="color:var(--text)">${Math.round(b.remaining_g)} g</strong> of ${Math.round(b.cooked_g)} g left</span>
            <span>≈ ${fmtE(b.kcal_left)} ${ul} left · ${b.kcal_per_100g}/100g</span>
          </div>
          <button data-portion="${b.id}" class="btn btn-secondary btn-full" style="margin-top:10px">Log a portion</button>
        </div>
      </div>`;
  }

  // ── New batch builder ──────────────────────────────────────
  function openBuilder(onDone) {
    showSheet(content => {
      const ingredients = [];   // { food_id, name, grams, cal }
      content.innerHTML = `
        <div class="sheet-header">
          <span class="sheet-title">New batch</span>
          <button class="sheet-close" id="b-close">✕</button>
        </div>
        <div style="padding:0 16px">
          <label class="form-label">Batch name</label>
          <input class="input" id="b-name" placeholder="e.g. Beef & veg prep" style="margin-bottom:14px"/>
          <label class="form-label">Ingredients</label>
          <div id="b-list" style="margin:6px 0"></div>
          <div id="b-totals" style="font-size:12px;color:var(--accent);font-weight:600;margin:6px 0 10px"></div>
          <div id="b-search" style="margin-bottom:8px"></div>
          <label class="form-label" style="margin-top:6px">Cooked weight — weigh the finished batch</label>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
            <input class="input" id="b-cooked" type="text" inputmode="decimal" placeholder="e.g. 1300" style="flex:1"/>
            <span style="color:var(--text-muted)">g</span>
          </div>
          <button class="btn btn-primary btn-full" id="b-save">Save batch</button>
        </div>`;

      renderFoodSearch(document.getElementById('b-search'), food => {
        ingredients.push({ food_id: food.id, name: food.name, grams: 100, cal: food.calories_per_100g || 0 });
        renderList();
      }, {});

      const totalsEl = () => document.getElementById('b-totals');
      function updTotals() {
        const tot = ingredients.reduce((s, it) => s + it.cal * it.grams / 100, 0);
        totalsEl().textContent = ingredients.length ? `≈ ${Math.round(tot)} ${unitLabel()} from ${ingredients.length} ingredient${ingredients.length === 1 ? '' : 's'}` : '';
      }
      function renderList() {
        const list = document.getElementById('b-list');
        list.innerHTML = ingredients.length
          ? ingredients.map((it, i) => `
            <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
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
      }
      renderList();

      document.getElementById('b-close').addEventListener('click', hideSheet);
      document.getElementById('b-save').addEventListener('click', async () => {
        const name = document.getElementById('b-name').value.trim();
        const cooked_g = parseFloat(document.getElementById('b-cooked').value);
        if (!name) return showToast('Name your batch', 'error');
        if (!ingredients.length) return showToast('Add at least one ingredient', 'error');
        if (!(cooked_g > 0)) return showToast('Enter the cooked weight', 'error');
        const btn = document.getElementById('b-save');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          await api.post('/api/batches', { name, cooked_g, items: ingredients.map(it => ({ food_id: it.food_id, quantity_g: it.grams })) });
          hideSheet(); showToast('Batch saved', 'success'); onDone?.();
        } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Save batch'; }
      });
    });
  }

  // ── Log a portion ──────────────────────────────────────────
  function openPortion(batch, onDone) {
    if (!batch) return;
    showSheet(content => {
      content.innerHTML = `
        <div class="sheet-header">
          <span class="sheet-title">Portion · ${esc(batch.name)}</span>
          <button class="sheet-close" id="p-close">✕</button>
        </div>
        <div style="padding:0 16px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${Math.round(batch.remaining_g)} g left · ${batch.kcal_per_100g} ${unitLabel()}/100g</div>
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
        const cal = Math.round(batch.calories * g / batch.cooked_g);
        document.getElementById('p-cals').textContent = g
          ? `≈ ${fmtE(cal)} ${unitLabel()} · ${Math.max(0, Math.round(batch.remaining_g - g))} g will be left`
          : '';
      };
      gi.addEventListener('input', upd); upd();
      document.getElementById('p-close').addEventListener('click', hideSheet);
      document.getElementById('p-save').addEventListener('click', async () => {
        const grams = parseFloat(gi.value);
        if (!(grams > 0)) return showToast('Enter how many grams', 'error');
        const btn = document.getElementById('p-save');
        btn.disabled = true; btn.textContent = 'Logging…';
        try {
          const r = await api.post(`/api/batches/${batch.id}/portion`, { grams, date: localDate() });
          hideSheet();
          showToast(`Logged ${Math.round(r.logged_g)} g · ${Math.round(r.remaining_g)} g left`, 'success');
          onDone?.();
        } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Log portion'; }
      });
    });
  }
}
