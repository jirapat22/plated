// Presets — the saved-recipe / saved-meal tab, and the two things other views
// need from it: "save this as a preset" and "use this preset".
//
// A batch preset carries an ingredient list and nothing else; using it opens
// the batch builder with the ingredients in and the cooked weight BLANK,
// because the same recipe rarely cooks down to the same weight and a carried
// weight would silently rescale every portion's macros.
//
// A meal preset carries foods and grams; using it opens a sheet where the
// weights can be nudged for today, then lands the lot on a day as one meal.
// Nothing is written until that sheet is confirmed — the answer to "what should
// happen when you use one" was "opens pre-filled, I confirm".
import { api } from '../api.js';
import { showToast, showSheet, hideSheet, showPrompt, showConfirm } from '../app.js';
import { renderFoodSearch } from '../components/foodSearch.js';
import { fmtE, unitLabel } from '../utils/energy.js';
import { localDate, addDaysIso } from '../utils/date.js';
import { openBuilder } from './batches.js';
import { newClientId } from '../utils/offlineStore.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const g0 = n => String(Math.round(Number(n) || 0));

// ── used by other views ─────────────────────────────────────────────────────

// "Save this as a preset". Called from a batch card and from a logged meal, so
// it takes items already shaped rather than knowing about either.
export async function savePresetFrom(kind, suggestedName, items, onDone) {
  if (!items?.length) return showToast('Nothing in there to save', 'error');
  showPrompt({
    title: kind === 'batch' ? 'Save as a recipe' : 'Save as a preset',
    label: kind === 'batch'
      ? 'Cook this again without retyping the ingredients'
      : 'Log these foods again in one go',
    placeholder: suggestedName || 'Name it',
    cta: 'Save',
    maxLength: 40,
    value: suggestedName || '',
  }, async name => {
    // Let it throw. showPrompt's contract is that a rejection shows the message
    // and KEEPS THE SHEET OPEN so the input isn't lost — catching it here made
    // submit() see success, close the sheet, and take the typed name with it.
    // An empty name throws too, rather than closing in silence.
    const n = String(name || '').trim();
    if (!n) throw new Error('Give it a name');
    await api.post('/api/presets', { kind, name: n, items });
    showToast(`Saved "${n}"`, 'success');
    onDone?.();
  });
}

// ── the tab ─────────────────────────────────────────────────────────────────

export function renderPresets(container, isCurrent = () => true) {
  container.innerHTML = '<div class="skeleton skel-line" style="margin:8px 16px"></div>';
  load();

  async function load() {
    let presets;
    try { presets = await api.get('/api/presets'); }
    catch (err) {
      if (!container.isConnected || !isCurrent()) return;
      container.innerHTML = `<div class="empty-state"><div class="empty-text">${esc(err.message)}</div></div>`;
      return;
    }
    render(presets);
  }

  function render(presets) {
    // Same rule as every other view: a tab that has been switched away from
    // stops drawing. Foods reuses one container for all its tabs, so being
    // still attached is not the same as being on screen.
    if (!container.isConnected || !isCurrent()) return;
    const ul = unitLabel();
    const card = p => `
      <div class="card" style="margin:0 16px 10px;padding:12px 14px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="flex-shrink:0">${p.kind === 'batch' ? '🍲' : '🍽️'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">
              ${p.items.length} item${p.items.length === 1 ? '' : 's'}${p.calories != null ? ` · ${fmtE(p.calories)} ${ul}` : ''}
              ${p.kind === 'batch' ? ' · recipe' : ''}
            </div>
          </div>
          <button data-pr-rename="${p.id}" title="Rename" style="color:var(--text-faint);font-size:13px;padding:4px">✏️</button>
          <button data-pr-del="${p.id}" title="Delete" style="color:var(--error);font-size:15px;padding:4px">✕</button>
        </div>
        <div style="font-size:11px;color:var(--text-faint);margin:8px 0 10px;line-height:1.5">
          ${p.items.slice(0, 4).map(i => `${esc(i.food_name)} ${g0(i.quantity_g)}g`).join(' · ')}${p.items.length > 4 ? ` +${p.items.length - 4} more` : ''}
        </div>
        <button data-pr-use="${p.id}" class="btn btn-secondary btn-full">
          ${p.kind === 'batch' ? 'Cook this again' : 'Log this meal'}
        </button>
      </div>`;

    container.innerHTML = `
      <div style="padding:0 16px 12px">
        <button class="btn btn-primary btn-full" id="pr-new">+ New preset</button>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;line-height:1.5">
          A recipe you cook again, or a set of foods you eat together. Using one fills everything in — nothing is logged until you confirm.
        </div>
      </div>
      ${presets.length
        ? presets.map(card).join('')
        : `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">
             No presets yet.<br><span style="font-size:12px;color:var(--text-faint)">Save a batch as a recipe, or a meal you eat often, from its ⋮ menu.</span>
           </div></div>`}
    `;

    const find = id => presets.find(p => String(p.id) === String(id));
    container.querySelector('#pr-new')?.addEventListener('click', () => openPresetBuilder(load));

    container.querySelectorAll('[data-pr-use]').forEach(btn => btn.addEventListener('click', () => {
      const p = find(btn.dataset.prUse);
      if (!p) return;
      if (p.kind === 'batch') {
        // Ingredients in, cooked weight left for the scales.
        openBuilder(load, {
          name: p.name,
          ingredients: p.items.map(i => ({ food_id: i.food_id, name: i.food_name, grams: i.quantity_g })),
        });
      } else {
        openPresetLog(p, load);
      }
    }));

    container.querySelectorAll('[data-pr-rename]').forEach(btn => btn.addEventListener('click', () => {
      const p = find(btn.dataset.prRename);
      showPrompt({ title: 'Rename preset', label: 'Name', cta: 'Save', maxLength: 40, value: p?.name || '' },
        async name => {                       // see savePresetFrom — let it throw
          const n = String(name || '').trim();
          if (!n) throw new Error('Give it a name');
          await api.patch(`/api/presets/${btn.dataset.prRename}`, { name: n });
          load();
        });
    }));

    container.querySelectorAll('[data-pr-del]').forEach(btn => btn.addEventListener('click', async () => {
      const p = find(btn.dataset.prDel);
      // Deleting a preset touches nothing you have already logged or cooked.
      if (!await showConfirm({ title: `Delete "${p?.name}"?`,
        body: 'Meals and batches you made from it stay exactly as they are.',
        cta: 'Delete', danger: true })) return;
      try { await api.delete(`/api/presets/${btn.dataset.prDel}`); load(); }
      catch (err) { showToast(err.message, 'error'); }
    }));
  }
}

// ── using a meal preset ─────────────────────────────────────────────────────
// Pre-filled and editable, nothing written until Log. Adjusting a weight here
// is for this meal only; the preset keeps its own numbers.
// opts.date: the day being logged to. Exported because presets belong where you
// log, not only in the Foods tab — Today's + button and a History day both open
// this, and both mean "put it on THAT day", not on whatever today happens to be.
export function openPresetLog(preset, onDone, opts = {}) {
  showSheet(content => {
    const today = localDate();
    const near = [today, addDaysIso(today, -1), addDaysIso(today, 1)];
    const want = opts.date || today;
    // The three quick chips stay for the common case; a day further back joins
    // them rather than replacing them, so you can still change your mind.
    const days = near.includes(want) ? near : [want, ...near];
    const dayLabel = d => d === today ? 'Today'
      : d === addDaysIso(today, -1) ? 'Yesterday'
      : d === addDaysIso(today, 1) ? 'Tomorrow'
      : new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    let date = want;
    const rows = preset.items.map(i => ({ ...i, grams: i.quantity_g }));
    // One id per intent — see the block in log.js's quantity sheet. A preset
    // writes a whole meal in one transaction, so a lost response and a retap is
    // a duplicated meal, not a duplicated food. Re-minted whenever a weight or
    // the day changes, because that is a different meal being asked for.
    let clientId = newClientId();

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">${esc(preset.name)}</span>
        <button class="sheet-close" id="pl-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div class="search-tabs" style="padding:0;margin-bottom:12px">
          ${days.map(d => `<button type="button" class="fs-chip pl-day${d === want ? ' active' : ''}" data-date="${d}" style="flex-shrink:0">${dayLabel(d)}</button>`).join('')}
        </div>
        <label class="form-label">Weights — change any of them just this once</label>
        <div id="pl-list" style="margin:6px 0 4px"></div>
        <div id="pl-total" style="font-size:12px;color:var(--accent);font-weight:600;margin:6px 0 14px"></div>
        <button class="btn btn-primary btn-full" id="pl-go">Log it</button>
        <div style="height:14px"></div>
      </div>`;

    const listEl = () => document.getElementById('pl-list');
    const totalEl = () => document.getElementById('pl-total');
    function draw() {
      listEl().innerHTML = rows.map((r, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0">
          <span style="flex:1;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.food_name)}</span>
          <input class="input pl-g" data-i="${i}" type="text" inputmode="decimal" value="${g0(r.grams)}"
                 style="width:78px;height:36px;text-align:right"/>
          <span style="color:var(--text-muted);font-size:12px">g</span>
        </div>`).join('');
      listEl().querySelectorAll('.pl-g').forEach(inp => inp.addEventListener('input', () => {
        rows[Number(inp.dataset.i)].grams = parseFloat(inp.value) || 0;
        clientId = newClientId();
        total();
      }));
      total();
    }
    function total() {
      // null in, null out — one food with no calorie data makes the total a
      // lower bound, and saying "≈" is not the same as pretending it is exact.
      let sum = 0, unknown = false;
      for (const r of rows) {
        if (r.calories_per_100g == null) { unknown = true; continue; }
        sum += r.calories_per_100g * r.grams / 100;
      }
      totalEl().textContent = `≈ ${fmtE(sum)} ${unitLabel()}${unknown ? ' + some not recorded' : ''}`;
    }
    draw();

    content.querySelectorAll('.pl-day').forEach(b => b.addEventListener('click', () => {
      content.querySelectorAll('.pl-day').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      date = b.dataset.date;
      clientId = newClientId();
    }));
    document.getElementById('pl-close').addEventListener('click', hideSheet);

    document.getElementById('pl-go').addEventListener('click', async () => {
      const items = rows.filter(r => r.grams > 0).map(r => ({ food_id: r.food_id, quantity_g: r.grams }));
      if (!items.length) return showToast('Set a weight on at least one food', 'error');
      const btn = document.getElementById('pl-go');
      btn.disabled = true; btn.textContent = 'Logging…';
      try {
        await api.post(`/api/presets/${preset.id}/log`, { date, items, client_id: clientId });
        hideSheet();
        // Lowercased only for the relative words — "logged to yesterday" reads,
        // "logged to sun, sep 6" looks like a bug.
        const where = near.includes(date) ? dayLabel(date).toLowerCase() : dayLabel(date);
        showToast(`${preset.name} logged${date === today ? '' : ` to ${where}`}`, 'success');
        onDone?.();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Log it';
        showToast(err.message, 'error');
      }
    });
  });
}

// ── building one from scratch ───────────────────────────────────────────────
function openPresetBuilder(onDone) {
  showSheet(content => {
    let kind = 'meal';
    const items = [];   // { food_id, name, grams, cal }

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">New preset</span>
        <button class="sheet-close" id="pb-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div class="search-tabs" style="padding:0;margin-bottom:12px">
          <button type="button" class="fs-chip pb-kind active" data-k="meal">🍽️ Meal</button>
          <button type="button" class="fs-chip pb-kind" data-k="batch">🍲 Recipe</button>
        </div>
        <div id="pb-hint" style="font-size:11px;color:var(--text-faint);margin-bottom:12px;line-height:1.5"></div>
        <label class="form-label">Name</label>
        <input class="input" id="pb-name" placeholder="e.g. Usual breakfast" style="margin-bottom:14px"/>
        <label class="form-label">Foods</label>
        <div id="pb-list" style="margin:6px 0"></div>
        <div id="pb-total" style="font-size:12px;color:var(--accent);font-weight:600;margin:6px 0 10px"></div>
        <div id="pb-search" style="margin-bottom:14px"></div>
        <button class="btn btn-primary btn-full" id="pb-save">Save preset</button>
        <div style="height:14px"></div>
      </div>`;

    const hint = () => {
      document.getElementById('pb-hint').textContent = kind === 'batch'
        ? 'A recipe: the ingredients you cook. Using it opens the batch builder — you weigh the finished batch then.'
        : 'A meal: foods you eat together. Using it fills in these weights and lands them on a day.';
    };
    hint();

    content.querySelectorAll('.pb-kind').forEach(b => b.addEventListener('click', () => {
      content.querySelectorAll('.pb-kind').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      kind = b.dataset.k;
      hint();
    }));
    document.getElementById('pb-close').addEventListener('click', hideSheet);

    renderFoodSearch(document.getElementById('pb-search'), food => {
      items.push({ food_id: food.id, name: food.name, grams: 100, cal: food.calories_per_100g ?? null });
      draw();
      showToast(`${food.name} added — set the weight`, 'success');
    }, { autofocus: false });   // the name field above keeps the caret

    function draw() {
      const list = document.getElementById('pb-list');
      list.innerHTML = items.length
        ? items.map((it, i) => `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
            <span style="flex:1;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name)}</span>
            <input class="input pb-g" data-i="${i}" type="text" inputmode="decimal" value="${g0(it.grams)}" style="width:72px;height:36px;text-align:right"/>
            <button class="pb-rm" data-i="${i}" style="color:var(--error);font-size:14px;padding:0 4px">✕</button>
          </div>`).join('')
        : '<div style="font-size:12px;color:var(--text-faint);padding:4px 0">Search below to add foods.</div>';
      list.querySelectorAll('.pb-g').forEach(inp => inp.addEventListener('input', () => {
        items[Number(inp.dataset.i)].grams = parseFloat(inp.value) || 0;
        totals();
      }));
      list.querySelectorAll('.pb-rm').forEach(b => b.addEventListener('click', () => {
        items.splice(Number(b.dataset.i), 1);
        draw();
      }));
      totals();
    }
    function totals() {
      let sum = 0, unknown = false;
      for (const it of items) {
        if (it.cal == null) { unknown = true; continue; }
        sum += it.cal * it.grams / 100;
      }
      document.getElementById('pb-total').textContent = items.length
        ? `≈ ${fmtE(sum)} ${unitLabel()}${unknown ? ' + some not recorded' : ''}` : '';
    }
    draw();

    document.getElementById('pb-save').addEventListener('click', async () => {
      const name = document.getElementById('pb-name').value.trim();
      if (!name) return showToast('Give it a name', 'error');
      const payload = items.filter(i => i.grams > 0).map(i => ({ food_id: i.food_id, quantity_g: i.grams }));
      if (!payload.length) return showToast('Add at least one food with a weight', 'error');
      const btn = document.getElementById('pb-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await api.post('/api/presets', { kind, name, items: payload });
        hideSheet();
        showToast(`Saved "${name}"`, 'success');
        onDone?.();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Save preset';
        showToast(err.message, 'error');
      }
    });
  });
}
