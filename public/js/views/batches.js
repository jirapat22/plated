import { api }                        from '../api.js';
import { showToast, showSheet, hideSheet, showPrompt, showConfirm } from '../app.js';
import { renderFoodSearch }           from '../components/foodSearch.js';
import { fmtE, unitLabel, toKcal }    from '../utils/energy.js';
import { localDate }                  from '../utils/date.js';
import { isFinishedBatch }            from '../utils/batchState.js';
import { savePresetFrom }             from './presets.js';
import { newClientId }                from '../utils/offlineStore.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const g0  = n => Math.round(n || 0);                                    // whole grams
// A NUMBER rounded to 1dp, for arithmetic — not a formatted string like g1.
// The reconcile step does gram sums (cooked − left, last portion + missing) and
// floats produce 399.99999999999994, which then renders as a different figure
// in the copy than the one sent to the server. Named to match the identical
// helper in src/routes/batches.js, since both ends round the same way.
const round1 = n => Math.round(n * 10) / 10;
// Whole grams of a MACRO, where null means "no ingredient recorded this" and
// has to stay a dash. Separate from g0 because g0 also formats weights —
// remaining_g, cooked_g, an input's value, an operand in arithmetic — which are
// never null and must stay numeric. Splitting them was the missing half of the
// g1 fix: the per-100g line already said "–P · –C" while the row above it,
// describing the very same unknown macros, still read "0g P  0g C".
const mg  = n => (n == null ? '–' : Math.round(n));
const g1  = n => {                                                      // 1dp, trimmed
  // A dash for unknown, not a zero. The server now sends null for a macro no
  // ingredient in the pot recorded, and `n || 0` would have printed that as a
  // confident "0P" — undoing at the last inch the whole point of tracking it.
  if (n == null) return '–';
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

// Renders the Batches view (active meal-prep batches + a "new batch" builder)
// into the given container.
// isCurrent: Foods owns the container and swaps tabs inside it without ever
// detaching it, so isConnected cannot tell whether this view is still the one
// being shown. Foods passes its own "is this still the batches tab" check.
// Defaults to yes for any caller that owns its container outright.
export function renderBatches(container, isCurrent = () => true) {
  container.innerHTML = '<div class="skeleton skel-line" style="margin:8px 16px"></div>';
  load();

  async function load() {
    let batches, leftovers = [];
    try { batches = await api.get('/api/batches'); }
    catch (err) { container.innerHTML = `<div class="empty-state"><div class="empty-text">${esc(err.message)}</div></div>`; return; }
    // Best-effort: a batch list that renders is worth more than an error page
    // because the leftovers call failed.
    try { leftovers = await api.get('/api/leftovers'); } catch { /* leave empty */ }
    render(batches, leftovers);
  }

  function render(batches, leftovers) {
    // The tab can be switched while the fetch above is still out, and switchView
    // empties #view-container — which DETACHES this wrapper without emptying it.
    // innerHTML and container.querySelectorAll still work on a detached node, so
    // the render looks fine right up until a document.getElementById() below
    // returns null and the view dies. foods.js and history.js already bail this
    // way; the lesson never made it to the other three.
    if (!container.isConnected || !isCurrent()) return;
    const ul = unitLabel();
    // A pot you have finished is not gone. The list route stopped filtering on
    // `remaining_g > 1` so that an emptied or over-drawn one could still reach
    // ⚖️ Fix and Delete — before that, a portion logged at the wrong weight
    // made the pot vanish while its food was still in the fridge, with nothing
    // anywhere that could correct it.
    //
    // The cost of removing the filter landed here: every pot ever cooked now
    // stacks up, a full card each — ingredients, macros, per-100 g, its own
    // Log a portion button — so the tab became a graveyard you scroll past to
    // reach the one you are actually eating from. Reported from the phone as
    // "why is there a batch of 0", against seven finished pots in a row.
    //
    // So they stay listed and stay fixable, just folded away. An over-drawn pot
    // is NOT finished: it is mis-recorded, it is asking to be corrected, and it
    // belongs where the warning can be seen.
    // The line now lives in utils/batchState.js, with its own tests. It was
    // `remaining_g <= 1`, which is tighter than any real scale reading, so pots
    // holding 2-10 g of scrapings kept a full card. 10 g alone would be wrong
    // the other way (a fifth of a 50 g pot), so it is 10 g AND under a
    // twentieth of what was cooked.
    const live = batches.filter(b => !isFinishedBatch(b));
    const done = batches.filter(isFinishedBatch);
    container.innerHTML = `
      <div style="padding:0 16px 12px">
        <button class="btn btn-primary btn-full" id="new-batch">+ New meal-prep batch</button>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;line-height:1.5">Log everything you cooked, weigh the finished batch, then portion it out by weight — calories scale to what's left.</div>
      </div>
      ${live.length ? live.map(b => batchCard(b, ul)).join('')
        : `<div class="empty-state"><div class="empty-icon">🍱</div><div class="empty-text">${done.length
            ? 'Nothing on the go right now — your finished pots are below.'
            : 'No batches yet. Cook a big batch, save it once, then log portions by weight.'}</div></div>`}
      ${done.length ? `
      <details style="margin:16px 0 4px">
        <summary style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-faint);font-family:var(--font-display);padding:12px 20px;cursor:pointer">
          Finished · ${done.length}
        </summary>
        ${done.map(b => batchCard(b, ul)).join('')}
      </details>` : ''}
      ${leftoversSection(leftovers, ul)}
    `;
    const find = id => batches.find(x => x.id == id);
    const findL = id => leftovers.find(x => x.id == id);

    container.querySelectorAll('[data-lo-log]').forEach(btn =>
      btn.addEventListener('click', () => {
        const l = findL(btn.dataset.loLog);
        if (l) openLeftoverLog(l, load);
      }));
    container.querySelectorAll('[data-lo-bin]').forEach(btn =>
      btn.addEventListener('click', async () => {
        const l = findL(btn.dataset.loBin);
        if (!await showConfirm({ title: `Bin "${l?.name}"?`,
          body: 'Nothing gets logged — this is for food you threw out.',
          cta: 'Bin it', danger: true })) return;
        try { await api.delete(`/api/leftovers/${btn.dataset.loBin}`); load(); }
        catch (err) { showToast(err.message, 'error'); }
      }));
    container.querySelectorAll('[data-lo-rename]').forEach(btn =>
      btn.addEventListener('click', () => {
        const l = findL(btn.dataset.loRename);
        // showPrompt, not window.prompt. app.js built the themed one precisely
        // because an installed PWA renders the system dialog as a bare box
        // dropped into an otherwise fully custom UI — "and on iOS can be
        // suppressed entirely", in which case this button did nothing at all,
        // silently. Two leftovers from different days look identical apart from
        // their names, so renaming is the thing that makes the list usable.
        showPrompt({
          title: 'Name this leftover',
          label: 'What is it?',
          value: l?.name || '',
          placeholder: 'e.g. Sunday chilli',
          cta: 'Save',
          maxLength: 80,
        }, async name => {
          const n = String(name || '').trim();
          if (!n) return;
          await api.patch(`/api/leftovers/${btn.dataset.loRename}`, { name: n });
          load();
        });
      }));
    container.querySelector('#new-batch').addEventListener('click', () => openBuilder(load));
    container.querySelectorAll('[data-portion]').forEach(btn =>
      btn.addEventListener('click', () => openPortion(find(btn.dataset.portion), load)));
    container.querySelectorAll('[data-edit]').forEach(btn =>
      btn.addEventListener('click', () => openBuilder(load, find(btn.dataset.edit))));
    container.querySelectorAll('[data-preset]').forEach(btn =>
      btn.addEventListener('click', () => {
        const b = find(btn.dataset.preset);
        // The ingredients, not the cooked weight — that is the whole point of a
        // recipe. An ingredient with no food_id (an old hand-typed row) cannot
        // be saved: a preset item needs a real food to compute macros from.
        const items = (b?.ingredients || [])
          .filter(i => i.food_id && i.grams > 0)
          .map(i => ({ food_id: i.food_id, quantity_g: i.grams }));
        if (!items.length) return showToast('This batch has no ingredients linked to foods', 'error');
        savePresetFrom('batch', b.name, items);
      }));
    container.querySelectorAll('[data-adjust]').forEach(btn =>
      btn.addEventListener('click', () => {
        const b = find(btn.dataset.adjust);
        if (b) openAdjust(b, load);
      }));
    container.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', async () => {
        if (!await showConfirm({ title: 'Delete this batch?',
          body: 'Portions you already logged stay in your history.',
          cta: 'Delete', danger: true })) return;
        try { await api.delete(`/api/batches/${btn.dataset.del}`); load(); }
        catch (err) { showToast(err.message, 'error'); }
      }));
  }

  // Its own section below the batches. A batch is bulk food measured out over
  // days; a leftover is one plated portion eaten in one go. Related enough to
  // share a screen, different enough that one list would put the same food in
  // twice meaning two different things.
  function leftoversSection(list, ul) {
    if (!list.length) return '';
    // No expiry by choice, so age is the only signal that something has been
    // sitting there — shown rather than acted on, and a nudge once the list is
    // long enough that scanning it stops being free.
    const age = iso => {
      const d = Math.floor((Date.now() - Date.parse(String(iso).replace(' ', 'T') + 'Z')) / 864e5);
      return !Number.isFinite(d) ? '' : d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
    };
    return `
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-faint);font-family:var(--font-display);margin:18px 20px 10px">
        Leftovers${list.length > 5 ? ` <span style="color:var(--warning);font-weight:600;letter-spacing:0;text-transform:none">· ${list.length} saved, some may be old</span>` : ''}
      </div>
      ${list.map(l => `
      <div style="padding:0 16px 10px">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="min-width:0">
              <div style="font-weight:700;font-size:15px">${esc(l.name)}</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:3px">
                ${l.quantity_g != null ? `<strong style="color:var(--text)">${g0(l.quantity_g)} g</strong> · ` : ''}${fmtE(l.calories)} ${ul}
                <span style="color:var(--text-faint)">· ${age(l.created_at)}</span>
              </div>
              <div style="display:flex;gap:10px;font-size:12px;font-variant-numeric:tabular-nums;margin-top:5px">
                <span style="color:var(--protein)">${mg(l.protein)}g P</span>
                <span style="color:var(--carbs)">${mg(l.carbs)}g C</span>
                <span style="color:var(--fat)">${mg(l.fat)}g F</span>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0">
              <button data-lo-rename="${l.id}" title="Rename" style="color:var(--text-faint);font-size:13px">✏️</button>
              <button data-lo-bin="${l.id}" title="Threw it out — logs nothing" style="color:var(--error);font-size:15px">🗑</button>
            </div>
          </div>
          <button data-lo-log="${l.id}" class="btn btn-secondary btn-full" style="margin-top:10px">Log it</button>
        </div>
      </div>`).join('')}`;
  }

  function batchCard(b, ul) {
    const ingTxt = (b.ingredients || []).map(i => `${esc(i.name)} ${Math.round(i.grams)}g`).join(' · ');
    const pct = Math.max(2, Math.round(b.remaining_g / b.cooked_g * 100));
    const L = b.left || {};        // macros in what's still left
    const P = b.per_100g || {};    // density — what a portion size buys you
    // An over-drawn pot is not an empty one, and it used to say it was.
    //
    // remaining_g is floored at 0 for display (shapeBatch), so the headline read
    // "0 g of 900 g left" — character for character what a pot you finished
    // says — while the only thing distinguishing them was an 11px line
    // underneath. And because an over-drawn pot is deliberately NOT folded away
    // (it is asking to be corrected), the one card that looked spent was the one
    // sitting at the top of the list. Reported from the phone as a food with
    // "0 g left lingering around", which is exactly how it reads.
    //
    // Reproduced two ways, both ordinary use: logging the pot's own backing food
    // to a meal past what is left (a preset, or Recent foods) left -500 g, and
    // editing a portion's weight upward left -4500 g. Neither clamps, on
    // purpose — that is what keeps subtract-then-add reversible.
    //
    // So the headline now states the actual problem, and the card stops
    // offering to portion food it does not have. ⚖️ Fix becomes the only
    // action, because it is the only one that helps.
    const over = b.overdrawn_g > 0;
    return `
      <div style="padding:0 16px 12px">
        <div class="card"${over ? ' style="border-color:var(--warning);box-shadow:inset 3px 0 0 var(--warning)"' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:2px">
            <div style="font-weight:700;font-size:15px">${esc(b.name)}</div>
            <div style="display:flex;gap:8px;flex-shrink:0">
              <button data-preset="${b.id}" title="Save these ingredients as a recipe" style="color:var(--text-faint);font-size:13px">⭐</button>
              <button data-edit="${b.id}" title="Edit this batch" style="color:var(--text-faint);font-size:13px">✏️</button>
              <button data-del="${b.id}" title="Delete" style="color:var(--error);font-size:15px">✕</button>
            </div>
          </div>
          ${ingTxt ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${ingTxt}</div>` : ''}
          ${over ? `
          <div style="font-size:13px;font-weight:700;color:var(--warning);margin-top:2px">
            ⚖️ Over by ${g0(b.overdrawn_g)} g — needs fixing
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.45">
            Your portions add up to ${g0(b.overdrawn_g)} g more than this ${g0(b.cooked_g)} g pot held, so one went in at the wrong weight. Tap ⚖️ Fix to say what is really left — or delete it if the pot is gone.
          </div>` : `
          <div class="water-bar-outer"><div class="water-bar-fill" style="width:${pct}%"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-top:6px">
            <span><strong style="color:var(--text)">${g0(b.remaining_g)} g</strong> of ${g0(b.cooked_g)} g left</span>
            <span>≈ ${fmtE(b.kcal_left)} ${ul} left</span>
          </div>
          <div style="display:flex;gap:10px;font-size:12px;font-variant-numeric:tabular-nums;margin-top:5px">
            <span style="color:var(--protein)">${mg(L.protein)}g P</span>
            <span style="color:var(--carbs)">${mg(L.carbs)}g C</span>
            <span style="color:var(--fat)">${mg(L.fat)}g F</span>
            ${L.fiber ? `<span style="color:var(--fiber)">${mg(L.fiber)}g fib</span>` : ''}
            <span style="color:var(--text-faint);margin-left:auto">still left</span>
          </div>`}
          <div style="font-size:11px;color:var(--text-faint);margin-top:7px;padding-top:7px;border-top:1px solid var(--border)">
            Per 100 g: ${fmtE(b.kcal_per_100g)} ${ul} · ${g1(P.protein)}P · ${g1(P.carbs)}C · ${g1(P.fat)}F${P.fiber ? ` · ${g1(P.fiber)} fib` : ''}
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            ${over ? '' : `<button data-portion="${b.id}" class="btn btn-secondary" style="flex:1">Log a portion</button>`}
            <button data-adjust="${b.id}" class="btn ${over ? 'btn-primary btn-full' : 'btn-secondary'}"${over ? '' : ' style="flex-shrink:0;padding:0 14px"'} title="Correct how much is actually left">⚖️ Fix${over ? ' how much is left' : ''}</button>
          </div>
        </div>
      </div>`;
  }
}

// Step two of the Fix sheet: the grams the correction cannot explain.
//
// Only reached when LESS is left than the log accounts for, i.e. the diary is
// light. The opposite direction (more left than expected, so the diary
// over-counted) keeps the old behaviour of correcting the pot alone: the
// reported case is this one, the leftover split already covers the common shape
// of the other, and a wrong guess there would delete calories someone ate.
function reconcileStep(content, batch, actual, delta, onDone) {
  const short  = delta > 0;                                            // diary is light
  const gap    = Math.abs(delta);
  const out    = round1(batch.cooked_g - actual);                      // really came out
  const logged = round1(batch.cooked_g - (batch.remaining_g ?? 0));    // what the log says
  const kcal   = batch.kcal_per_100g != null ? Math.round(gap / 100 * batch.kcal_per_100g) : null;
  const ul     = unitLabel();
  content.innerHTML = `
    <div class="sheet-header">
      <span class="sheet-title">${g0(gap)} g ${short ? 'unaccounted for' : 'you did not eat'}</span>
      <button class="sheet-close" id="rc-close">X</button>
    </div>
    <div style="padding:0 16px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.55">
        <strong style="color:var(--text)">${esc(batch.name)}</strong> &mdash; you cooked ${g0(batch.cooked_g)} g and ${g0(actual)} g is left,
        so ${g0(out)} g has come out of it. Your log ${short ? `only accounts for ${g0(logged)} g` : `says ${g0(logged)} g`}.
      </div>
      ${kcal != null ? `<div style="font-size:12px;color:var(--warning);margin-bottom:16px;line-height:1.5">
        That is <strong>${fmtE(kcal)} ${ul}</strong> ${short
          ? 'that has left the pot but is not in your diary.'
          : 'in your diary that never left the pot.'}
      </div>` : '<div style="height:8px"></div>'}
      ${short ? `<button class="btn btn-primary btn-full" id="rc-eat" style="margin-bottom:8px">I ate it &mdash; log ${g0(gap)} g today</button>` : ''}
      <div id="rc-resize"></div>
      <button class="btn btn-secondary btn-full" id="rc-pot">${short
        ? 'It was not eaten &mdash; just fix the pot'
        : 'I put some back &mdash; just fix the pot'}</button>
      <div style="font-size:11px;color:var(--text-faint);margin-top:10px;line-height:1.5">
        ${short
          ? 'Thrown out, spilled, or eaten by someone who logs their own food? That last button is the right one &mdash; the pot was wrong, your diary never was.'
          : 'Served a portion, ate half, tipped the rest back in? Correct the portion. If the pot simply weighs more than it was recorded as, fix the pot alone.'}
      </div>
    </div>`;

  const resizeBox = content.querySelector('#rc-resize');
  content.querySelector('#rc-close').addEventListener('click', hideSheet);

  // Disable the lot while one is in flight. Every other sheet in this file
  // learned this the same way: the sheet stays up for the whole round trip, so
  // a second tap runs a second reconciliation against stock the first moved.
  const run = async (label, fn) => {
    const all = [...content.querySelectorAll('#rc-eat, #rc-pot, #rc-resize button')];
    all.forEach(b => { b.disabled = true; });
    try {
      await fn();
      hideSheet();
      showToast(label, 'success');
      onDone?.();
    } catch (err) {
      showToast(err.message, 'error');
      all.forEach(b => { b.disabled = false; });
    }
  };

  // One id for the catch-up portion, minted once: this draws down stock, so a
  // retry after a lost response must not take the grams twice.
  const catchUpId = newClientId();
  // Which meal to file it into, once the fetch below says. Null until then, and
  // null means a new meal — which is what this did unconditionally, and it split
  // one sitting across two cards: "Dinner · 300 g" plus a second card called
  // after the batch holding the 400 g catch-up. Same food, same meal, same
  // moment, two rows in the day. Only used when the original portion is on
  // TODAY; an older one means these grams are being eaten now, not then, and a
  // new meal today is then the honest place for them.
  let sameMeal = null;
  content.querySelector('#rc-eat')?.addEventListener('click', () => run(
    `Logged ${g0(gap)} g today`,
    () => api.post(`/api/batches/${batch.id}/portion`, {
      grams: gap, client_id: catchUpId,
      ...(sameMeal ? { meal_session_id: sameMeal } : {}),
    })));

  content.querySelector('#rc-pot').addEventListener('click', () => run(
    `${g0(actual)} g left`,
    () => api.patch(`/api/batches/${batch.id}`, { remaining_g: actual })));

  // "That portion was wrong" needs to know which entry it was. The node is
  // captured now and checked with isConnected, not looked up by id when the
  // fetch lands: showSheet reuses one #sheet-content element, so a dismissed
  // sheet's response would otherwise paint whichever sheet is open by then.
  api.get(`/api/batches/${batch.id}/portions`).then(list => {
    if (!resizeBox?.isConnected || !Array.isArray(list) || !list.length) return;
    const last = list[0];
    // The route already drops anything dated after today, so list[0] is the
    // most recent portion that has actually been eaten.
    if (last.date === localDate() && last.meal_session_id) {
      sameMeal = last.meal_session_id;
      const eat = content.querySelector('#rc-eat');
      // Say where it is going, now that there is somewhere to name.
      if (eat && last.meal_name) eat.textContent = `I ate it \u2014 add ${g0(gap)} g to ${last.meal_name}`;
    }
    const when = new Date(last.date + 'T00:00:00')
      .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const to = round1(short ? last.quantity_g + gap : last.quantity_g - gap);
    // Shrinking it has a floor: an entry of 0 g or less is not an entry, and
    // PATCH would refuse it anyway. When one portion cannot absorb the whole
    // difference the button is simply not offered, leaving the pot-only answer
    // rather than a button that 400s.
    if (!short && to <= 0) return;
    resizeBox.innerHTML = `
      <button class="btn btn-secondary btn-full" id="rc-resize-btn" style="margin-bottom:8px;height:auto;padding:10px 14px;line-height:1.4">
        That portion was wrong &mdash; make it ${g0(to)} g
        <div style="font-size:11px;color:var(--text-faint);font-weight:400">${g0(last.quantity_g)} g on ${when}${last.meal_name ? ` &middot; ${esc(last.meal_name)}` : ''}</div>
      </button>`;
    resizeBox.querySelector('#rc-resize-btn').addEventListener('click', () => run(
      `Portion corrected to ${g0(to)} g`,
      // Resizing re-derives the entry's macros and moves the pot by the delta
      // in one request: the same call the quantity sheet makes, so the stock
      // arithmetic is the one that is already tested.
      () => api.patch(`/api/meals/entries/${last.id}`, { quantity_g: to })));
  }).catch(() => { /* no list, no button; the other two still work */ });
}

// ── Correct what's left ──────────────────────────────────────
// Was a prompt() — a system dialog in an otherwise fully themed app, with the
// max weight buried in a paragraph of text and no way to tap a common answer.
function openAdjust(batch, onDone) {
  showSheet(content => {
    const max = g0(batch.cooked_g);
    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">⚖️ How much is left?</span>
        <button class="sheet-close" id="a-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.5">
          <strong style="color:var(--text)">${esc(batch.name)}</strong> — use this if a portion went in at the wrong weight, or some got eaten without logging.
        </div>
        <label class="form-label">Grams left · up to ${max}</label>
        <div style="display:flex;gap:8px;align-items:center;margin:6px 0 10px">
          <input class="input" id="a-g" type="text" inputmode="decimal" value="${g0(batch.remaining_g)}" style="flex:1"/>
          <span style="color:var(--text-muted)">g</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px">
          <button type="button" class="fs-chip a-quick" data-g="0">Finished it</button>
          <button type="button" class="fs-chip a-quick" data-g="${g0(batch.cooked_g / 2)}">Half left</button>
          <button type="button" class="fs-chip a-quick" data-g="${max}">Untouched</button>
        </div>
        <button class="btn btn-primary btn-full" id="a-save">Save</button>
      </div>`;
    const gi = document.getElementById('a-g');
    document.getElementById('a-close').addEventListener('click', hideSheet);
    content.querySelectorAll('.a-quick').forEach(b =>
      b.addEventListener('click', () => { gi.value = b.dataset.g; }));
    document.getElementById('a-save').addEventListener('click', async () => {
      const grams = parseFloat(gi.value);
      if (!Number.isFinite(grams) || grams < 0) return showToast('Enter grams (0 or more)', 'error');
      // Correcting the pot used to be the whole of this button, and the grams
      // it reconciled never reached the diary.
      //
      // Measured on the reported case: cook 900 g, log a 300 g portion, weigh
      // the pot and find 200 g. Fix set the pot to 200 and stopped there, so
      // 400 g and 1,520 kcal had come out of the fridge with no record of it
      // anywhere. Nothing warned either: overdrawn_g is 0, because after the
      // Fix the pot's own number IS right. The only wrong number was the day's,
      // and it was wrong silently.
      //
      // So when the correction implies grams nobody logged, ask what they were.
      // The two answers that matter land the calories on different days, and
      // only the person who ate it knows which: a portion that went in at the
      // wrong weight belongs on the day it was eaten, food eaten unlogged
      // belongs today. Guessing either way would be inventing history.
      // Both directions now. `delta` is what the correction cannot explain:
      // positive means MORE came out than the log accounts for (the diary is
      // light), negative means LESS did (the diary over-counted, e.g. a portion
      // was served, half eaten, and the rest tipped back into the pot).
      //
      // The second case was deliberately left alone when this shipped, on the
      // grounds that guessing would delete calories someone really ate. Guessing
      // would; offering a choice does not, and without it the only way to
      // correct an over-counted day was to go and find the entry by hand.
      const delta = round1((batch.remaining_g ?? 0) - grams);
      if (Math.abs(delta) > 1) return reconcileStep(content, batch, grams, delta, onDone);
      const btn = document.getElementById('a-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api.patch(`/api/batches/${batch.id}`, { remaining_g: grams });
        hideSheet();
        showToast(`${g0(r.remaining_g)} g left`, 'success');
        onDone?.();
      } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Save'; }
    });
  });
}

// ── New / edit batch builder ─────────────────────────────────
// Pass an existing batch to edit it in place; omit for a new one.
// batch may be a real one (has an id → editing it) or a seed from a preset:
// { name, ingredients } with no id, which pre-fills the form and still SAVES a
// new batch. Keying edit-mode on the id rather than on the object is what lets
// one builder serve both without a second parameter.
export function openBuilder(onDone, batch = null) {
  const isEdit = !!batch?.id;
  showSheet(content => {
    // { food_id, name, grams, cal }. On edit, seed from the saved ingredients —
    // cal is refetched below so the running total is right without trusting a
    // stale snapshot.
    const ingredients = batch
      ? (batch.ingredients || []).map(i => ({ food_id: i.food_id ?? null, name: i.name, grams: i.grams, cal: 0 }))
      : [];

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">${isEdit ? 'Edit batch' : 'New batch'}</span>
        <button class="sheet-close" id="b-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <label class="form-label">Batch name</label>
        <input class="input" id="b-name" placeholder="e.g. Beef &amp; veg prep" style="margin-bottom:14px"/>
        <label class="form-label">Ingredients</label>
        <div id="b-list" style="margin:6px 0"></div>
        <div id="b-totals" style="font-size:12px;color:var(--accent);font-weight:600;margin:6px 0 10px"></div>
        <div id="b-search" style="margin-bottom:8px"></div>
        <label class="form-label" style="margin-top:6px">Cooked weight — weigh the finished batch</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
          <input class="input" id="b-cooked" type="text" inputmode="decimal" placeholder="e.g. 1300" style="flex:1"/>
          <span style="color:var(--text-muted)">g</span>
        </div>
        <div id="b-leftover"></div>
        ${isEdit ? `<div style="font-size:11px;color:var(--text-faint);margin-bottom:12px;line-height:1.5">
          Portions you already logged keep the macros they were logged with — only future portions use the updated numbers.
        </div>` : ''}
        <button class="btn btn-primary btn-full" id="b-save">${isEdit ? 'Save changes' : 'Save batch'}</button>
      </div>`;

    // Values set via JS so a name with quotes/angle brackets can't break out.
    const nameInput   = document.getElementById('b-name');
    const cookedInput = document.getElementById('b-cooked');
    if (batch) {
      nameInput.value = batch.name || '';
      // Only an actual batch carries a cooked weight forward. A preset leaves it
      // blank on purpose: the same recipe rarely cooks down to the same weight,
      // and a carried-over one would rescale every portion's macros in silence.
      if (batch.cooked_g) cookedInput.value = g0(batch.cooked_g);
    }

    renderFoodSearch(document.getElementById('b-search'), food => {
      // Adding is instant at 100g. On a phone the list sits above the search
      // box and can be off-screen, so make the landing obvious: toast, flash
      // the new row, scroll it into view, and focus its grams field so the
      // next thing you type is the weight.
      ingredients.push({ food_id: food.id, name: food.name, grams: 100, cal: food.calories_per_100g || 0 });
      renderList(ingredients.length - 1);
      showToast(`${food.name} added — set the weight`, 'success');
    }, { autofocus: false });   // the name field above keeps the caret

    const totalsEl = () => document.getElementById('b-totals');
    function updTotals() {
      const tot = ingredients.reduce((s, it) => s + it.cal * it.grams / 100, 0);
      totalsEl().textContent = ingredients.length
        ? `≈ ${fmtE(tot)} ${unitLabel()} from ${ingredients.length} ingredient${ingredients.length === 1 ? '' : 's'}`
        : '';
    }

    function renderList(flashIndex = -1) {
      const list = document.getElementById('b-list');
      list.innerHTML = ingredients.length
        ? ingredients.map((it, i) => `
          <div class="b-row${i === flashIndex ? ' flash-in' : ''}" style="display:flex;align-items:center;gap:8px;padding:4px 0">
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

      if (flashIndex >= 0) {
        const row = list.querySelectorAll('.b-row')[flashIndex];
        row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const gramsInput = row?.querySelector('.b-g');
        if (gramsInput) { gramsInput.focus(); gramsInput.select(); }
      }
    }
    renderList();

    // Seeded ingredients arrive with no per-100g calories — a saved batch stores
    // name + grams, and so does a recipe preset — so the running total has to
    // fetch them. Gated on `isEdit` until presets arrived, when "seeded from a
    // batch" stopped being the same thing as "editing one": cooking a recipe
    // again seeds ingredients with NO batch id, so the fetch never ran and the
    // total read "≈ 0 kcal from 2 ingredients" all the way to Save, next to a
    // preset card saying 4560. Display only — the save posts food_id + grams and
    // the server computes from the food — but it is wrong exactly where you'd
    // check the pot against the recipe.
    if (ingredients.length) {
      Promise.all(ingredients.map(it =>
        it.food_id != null ? api.get(`/api/foods/${it.food_id}`).catch(() => null) : null
      )).then(foods => {
        foods.forEach((f, i) => { if (f) ingredients[i].cal = f.calories_per_100g || 0; });
        updTotals();
      });
    }

    // A changed cooked weight makes "how much is left" ambiguous once some has
    // been eaten: was the original weighing wrong (so the error applies to
    // what's left too), or only the total? This used to be a confirm() where
    // OK and Cancel were two different answers — so Cancel didn't abort, and
    // there was no way to back out once it appeared. It's now an inline choice
    // you can see, change, and simply not save.
    let leftoverMode = 'scale';
    function renderLeftover() {
      const box = document.getElementById('b-leftover');
      if (!box) return;
      const cooked = parseFloat(cookedInput.value);
      const eaten  = isEdit ? batch.cooked_g - batch.remaining_g : 0;
      if (!isEdit || !(cooked > 0) || cooked === batch.cooked_g || eaten <= 0.5) { box.innerHTML = ''; return; }
      const scaled = g0(batch.remaining_g * cooked / batch.cooked_g);
      const kept   = Math.min(g0(batch.remaining_g), g0(cooked));
      box.innerHTML = `
        <label class="form-label">${g0(batch.cooked_g)} g → ${g0(cooked)} g. You have ${g0(batch.remaining_g)} g left — what's actually left now?</label>
        <div style="display:flex;gap:6px;margin:8px 0 14px">
          <button type="button" class="fs-chip b-left-opt${leftoverMode === 'scale' ? ' active' : ''}" data-mode="scale" style="flex:1">${scaled} g<br><span style="font-size:10px;opacity:.75">same fraction left</span></button>
          <button type="button" class="fs-chip b-left-opt${leftoverMode === 'keep' ? ' active' : ''}" data-mode="keep" style="flex:1">${kept} g<br><span style="font-size:10px;opacity:.75">leave it as-is</span></button>
        </div>`;
      box.querySelectorAll('.b-left-opt').forEach(b =>
        b.addEventListener('click', () => { leftoverMode = b.dataset.mode; renderLeftover(); }));
    }
    cookedInput.addEventListener('input', renderLeftover);
    renderLeftover();

    document.getElementById('b-close').addEventListener('click', hideSheet);
    document.getElementById('b-save').addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const cooked_g = parseFloat(cookedInput.value);
      if (!name) return showToast('Name your batch', 'error');
      if (!ingredients.length) return showToast('Add at least one ingredient', 'error');
      if (!(cooked_g > 0)) return showToast('Enter the cooked weight', 'error');
      if (isEdit && ingredients.some(it => it.food_id == null)) {
        return showToast("One ingredient can't be matched to a food — remove and re-add it", 'error');
      }

      const body = { name, cooked_g, items: ingredients.map(it => ({ food_id: it.food_id, quantity_g: it.grams })) };

      // Nothing eaten yet → what's left is simply the new total. Otherwise take
      // whichever answer the inline choice above is showing.
      if (isEdit && cooked_g !== batch.cooked_g) {
        const eaten = batch.cooked_g - batch.remaining_g;
        body.remaining_g = eaten <= 0.5 ? cooked_g
          : leftoverMode === 'scale' ? g0(batch.remaining_g * cooked_g / batch.cooked_g)
          : Math.min(g0(batch.remaining_g), g0(cooked_g));
      }

      const btn = document.getElementById('b-save');
      const label = isEdit ? 'Save changes' : 'Save batch';
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (isEdit) await api.patch(`/api/batches/${batch.id}`, body);
        else        await api.post('/api/batches', body);
        hideSheet();
        showToast(isEdit ? 'Batch updated' : 'Batch saved', 'success');
        onDone?.();
      } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = label; }
    });
  });
}

// ── Log a portion ────────────────────────────────────────────
// opts.sessionId locks the portion to an existing meal (used when this is
// opened from a meal's Add Food flow) — the day and meal pickers are then
// redundant, so they're hidden.
// ── Eat a leftover ────────────────────────────────────────────
// Same day-and-meal picker portioning uses, because it sits on the same screen
// and doing the same job differently is how two screens teach two habits.
//
// opts.sessionId locks it to a meal, exactly as openPortion does: opened from
// inside Add Food, the day and the meal are already decided, so both pickers go
// away. It may be a lazySession thunk, so the meal is not created until the
// leftover actually lands — dismissing this sheet leaves nothing behind.
export function openLeftoverLog(l, onDone, opts = {}) {
  const lockedSession = opts.sessionId != null;
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
  // A container in a fridge gets opened more than once. The field is filled in
  // with the whole thing, so "I'm eating all of it" is still one tap — typing a
  // smaller number logs that much and puts the rest back.
  //
  // Weighed leftovers are grams; a Quick Log one has calories and no weight, so
  // for those the number IS energy and has to cross the kcal/kJ boundary the
  // same way the entry split does. Compare and send in kcal, only ever SHOW in
  // the user's unit — taking a typed kJ figure straight through would log a
  // quarter of what they meant.
  const byGrams = l.quantity_g != null && l.quantity_g > 0;
  const whole   = byGrams ? Math.round(l.quantity_g) : Math.round(l.calories || 0);
  const unit    = byGrams ? 'g' : unitLabel();
  const disp    = v => (byGrams ? String(Math.round(v)) : fmtE(v));
  const canon   = v => (byGrams ? v : toKcal(v));

  showSheet(async content => {
    const today = localDate();
    const days  = [today, addDays(today, 1), addDays(today, -1), addDays(today, -2)];
    // Compare dates rather than counting chip positions — the trap that made a
    // past-leaning strip label yesterday "Tomorrow" elsewhere in this app.
    const label = iso => iso === today ? 'Today' : iso === addDays(today, 1) ? 'Tomorrow'
      : iso === addDays(today, -1) ? 'Yesterday'
      : new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    let date = today;

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Log · ${esc(l.name)}</span>
        <button class="sheet-close" id="lg-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">${
          l.quantity_g != null ? `${g0(l.quantity_g)} g · ` : ''}${fmtE(l.calories)} ${unitLabel()} in the fridge</div>
        <div class="form-group">
          <label class="form-label">How much are you having?</label>
          <div style="position:relative">
            <input class="input" id="lg-amt" type="text" inputmode="decimal" value="${disp(whole)}"
              style="height:46px;font-size:17px;font-weight:700;padding-right:44px"/>
            <span style="position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--text-muted)">${unit}</span>
          </div>
          <div id="lg-rest" style="font-size:12px;color:var(--text-faint);min-height:17px;margin-top:6px"></div>
        </div>
        ${lockedSession ? `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">
          Adding to <strong style="color:var(--text)">${esc(opts.sessionName || 'this meal')}</strong>
        </div>` : `
        <label class="form-label">Day</label>
        <div id="lg-days" style="display:flex;gap:6px;overflow-x:auto;padding:6px 0 10px;-webkit-overflow-scrolling:touch">
          ${days.map(d => `<button type="button" class="fs-chip lg-day${d === today ? ' active' : ''}" data-date="${d}" style="flex-shrink:0">${label(d)}</button>`).join('')}
        </div>
        <label class="form-label">Add to</label>
        <select class="input" id="lg-meal" style="margin-bottom:16px"></select>`}
        <button class="btn btn-primary btn-full" id="lg-save">Log it</button>
      </div>`;

    const sel = document.getElementById('lg-meal');
    async function loadMeals() {
      if (!sel) return;                       // locked to a meal — no picker to fill
      sel.innerHTML = '<option value="new">+ New meal</option>';
      try {
        const d = await api.get(`/api/meals/day/${date}`);
        for (const s of (d.sessions || [])) {
          const o = document.createElement('option');
          o.value = s.id; o.textContent = s.name || 'Meal';
          sel.appendChild(o);
        }
      } catch { /* new meal is always available */ }
    }
    content.querySelectorAll('.lg-day').forEach(b => b.addEventListener('click', () => {
      date = b.dataset.date;
      content.querySelectorAll('.lg-day').forEach(x => x.classList.toggle('active', x === b));
      loadMeals();
    }));
    document.getElementById('lg-close').addEventListener('click', hideSheet);

    const amtEl  = document.getElementById('lg-amt');
    const restEl = document.getElementById('lg-rest');
    const askedC = () => canon(parseFloat(amtEl.value));
    const showRest = () => {
      const c = askedC();
      restEl.textContent = !(c > 0) ? ''
        : c >= whole ? 'All of it — nothing goes back in the fridge.'
        : `${disp(whole - c)} ${unit} stays in the fridge.`;
    };
    amtEl.addEventListener('input', showRest);
    showRest();

    document.getElementById('lg-save').addEventListener('click', async e => {
      const c = askedC();
      // `whole` is the DISPLAY figure, so a leftover under half a unit rounds
      // to 0 — and then this check refused to log it, prefilled box and all.
      // Those rows exist on phones today: they are what the round-trip bug
      // fixed in v253 left behind, the "still havw 0g left leftover" from the
      // report. Binning was the only way to clear one, which files food you
      // ate as food you threw out. Nothing is left to portion, so any answer
      // means all of it.
      if (!(c > 0) && whole > 0) return showToast(`Enter how much you're having, in ${unit}`, 'error');
      // Disabled while in flight, like every other save in this app.
      //
      // This one was missed, and partial logging is what made it bite: before
      // it existed a second tap hit an already-deleted row and 404'd, which is
      // ugly but harmless. Now the second tap eats another helping — measured,
      // two taps of "100 g" against a 300 g leftover logged 200 g as two
      // separate meals and left 100 g in the fridge. The route has no replay
      // protection to fall back on.
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Logging…';
      try {
        // May be a lazySession thunk — the meal is only created now, so backing
        // out of this sheet never leaves an empty one behind.
        const locked = typeof opts.sessionId === 'function' ? await opts.sessionId() : opts.sessionId;
        const sid = lockedSession ? locked : sel.value;
        // Accepting the prefilled amount means ALL of it, so say nothing at all
        // — the route reads an absent amount as the whole thing, exactly.
        // Sending the number back instead was the bug: the field is prefilled
        // with Math.round(quantity_g) for legibility, so on a 333.3 g leftover
        // the default tap asked for 333 and left 0.3 g behind, displayed as
        // "0 g". The server refuses slivers now too; this stops the round trip
        // from creating one in the first place.
        const all = whole <= 0 || c >= whole;
        const r = await api.post(`/api/leftovers/${l.id}/log`, {
          date: lockedSession ? (opts.date || date) : date,
          ...(all ? {} : byGrams ? { eat_g: c } : { eat_kcal: c }),
          ...(sid && sid !== 'new' ? { meal_session_id: sid } : {}),
        });
        hideSheet();
        const when = r.date === today ? '' : ` to ${r.date}`;
        showToast(r.partial
          ? `Logged${when} — ${disp(whole - c)} ${unit} left`
          : `${l.name} logged${when}`, 'success');
        onDone?.();
      } catch (err) {
        showToast(err.message, 'error');
        // A 404 means the leftover is gone — binned on another device, or eaten
        // in another tab. Re-enabling the button leaves a sheet whose only
        // possible outcome is the same error again; close it and refresh.
        if (err.status === 404) { hideSheet(); onDone?.(); return; }
        btn.disabled = false; btn.textContent = 'Log it';
      }
    });
    loadMeals();
  });
}

export function openPortion(batch, onDone, opts = {}) {
  if (!batch) return;
  const lockedSession = opts.sessionId != null;
  showSheet(content => {
    const today = localDate();
    const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); };
    // Backfilling an already-eaten portion is still the common reason to pick a
    // day, so the past keeps most of the strip — but it used to be the ONLY
    // direction, and the custom input was capped at max="today", so portioning
    // tomorrow's lunch out of tonight's batch was impossible. The route always
    // accepted any date; this was purely the picker refusing to offer one.
    // Meals could already be copied up to 7 days ahead, so a batch portion
    // being past-only was an inconsistency inside the same app.
    const quickDays = [today, addDays(today, 1), addDays(today, -1), addDays(today, -2), addDays(today, -3)];
    // Compare against real dates rather than chip position — the old
    // index-based version would have labelled tomorrow "Yesterday".
    const dayLabel = iso => iso === today ? 'Today'
      : iso === addDays(today, 1)  ? 'Tomorrow'
      : iso === addDays(today, -1) ? 'Yesterday'
      : new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    let selectedDate = today;

    content.innerHTML = `
      <div class="sheet-header">
        <span class="sheet-title">Portion · ${esc(batch.name)}</span>
        <button class="sheet-close" id="p-close">✕</button>
      </div>
      <div style="padding:0 16px">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${g0(batch.remaining_g)} g left · ${fmtE(batch.kcal_per_100g)} ${unitLabel()}/100g</div>
        ${lockedSession ? `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
          Adding to <strong style="color:var(--text)">${esc(opts.sessionName || 'this meal')}</strong>
        </div>` : `
        <label class="form-label">Day</label>
        <div id="p-days" style="display:flex;gap:6px;overflow-x:auto;padding:6px 0 4px;-webkit-overflow-scrolling:touch">
          ${quickDays.map((d, i) => `<button type="button" class="fs-chip p-day${i === 0 ? ' active' : ''}" data-date="${d}" style="flex-shrink:0">${dayLabel(d)}</button>`).join('')}
        </div>
        <button type="button" id="p-custom-toggle" style="font-size:12px;color:var(--accent);font-weight:600;padding:2px 0;margin-bottom:12px">Pick another date…</button>
        <!-- Forward window matches the meal-copy picker's 7 days. No min: the
             past stays open-ended, which is what backfilling needs. -->
        <input class="input" id="p-date-custom" type="date" max="${addDays(today, 7)}" style="display:none;margin-bottom:14px"/>
        <label class="form-label">Add to</label>
        <select class="input" id="p-meal" style="margin-bottom:14px"></select>`}
        <label class="form-label">How much are you eating?</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <!-- Your last portion of this batch, else the old 220g guess — and
               either way never more than is actually left. -->
          <input class="input" id="p-g" type="text" inputmode="decimal"
                 value="${g0(Math.min(batch.last_portion_g > 0 ? batch.last_portion_g : 220, batch.remaining_g))}" style="flex:1"/>
          <span style="color:var(--text-muted)">g</span>
        </div>
        <div id="p-cals" style="font-size:13px;color:var(--accent);font-weight:600;margin-bottom:16px"></div>
        <button class="btn btn-primary btn-full" id="p-save">Log portion</button>
      </div>`;

    const gi = document.getElementById('p-g');
    const upd = () => {
      const g = parseFloat(gi.value) || 0;
      const box = document.getElementById('p-cals');
      if (!g) { box.innerHTML = ''; return; }
      const r  = g / batch.cooked_g;
      // `|| 0` here would defeat g1's null handling one layer before it ran —
      // the preview said "0P · 0C" for macros the batch explicitly records as
      // unknown, right under a header that correctly said otherwise.
      const sc = k => (batch[k] == null ? null : batch[k] * r);
      const over = g > batch.remaining_g;
      box.innerHTML = `
        ≈ ${fmtE(Math.round(batch.calories * r))} ${unitLabel()}
        · <span style="color:var(--protein)">${g1(sc('protein'))}P</span>
        · <span style="color:var(--carbs)">${g1(sc('carbs'))}C</span>
        · <span style="color:var(--fat)">${g1(sc('fat'))}F</span>
        <div style="font-size:11px;font-weight:400;margin-top:3px;color:${over ? 'var(--warning)' : 'var(--text-faint)'}">
          ${over
            ? `Only ${g0(batch.remaining_g)} g left — it'll log that instead`
            : `${g0(batch.remaining_g - g)} g will be left`}
        </div>`;
    };
    // One id per intent — see the same block in log.js's quantity sheet. This
    // route draws the grams out of the batch as well as writing the entry, so a
    // lost response plus a retap is the case the server's replay table was
    // built for, and the client had never sent it an id to work with.
    let clientId = newClientId();
    gi.addEventListener('input', () => { clientId = newClientId(); upd(); }); upd();

    // Meals already on the chosen day, so a portion can join an existing meal
    // instead of always landing in its own. Reloads when the day changes.
    const mealSel = document.getElementById('p-meal');
    async function loadMeals() {
      if (!mealSel) return;
      mealSel.innerHTML = `<option value="">New meal — ${esc(batch.name)}</option>`;
      try {
        const day = await api.get(`/api/meals/day/${selectedDate}`);
        for (const s of (day.sessions || [])) {
          const o = document.createElement('option');
          o.value = s.id;
          o.textContent = s.name || `Meal ${s.meal_index}`;
          mealSel.appendChild(o);
        }
      } catch { /* keep the "new meal" default */ }
    }
    loadMeals();

    const daysBox = document.getElementById('p-days');
    if (daysBox) {
      const customToggle = document.getElementById('p-custom-toggle');
      const customInput  = document.getElementById('p-date-custom');
      // A new id on every change of destination, not just of grams. A stale id
      // replays the OLD answer: log a portion, lose the response, change the day
      // to Yesterday, tap again — and the server hands back the first 201 while
      // the toast says "Logged 200 g" as though it moved. Worse than no id.
      daysBox.querySelectorAll('.p-day').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedDate = btn.dataset.date;
          clientId = newClientId();
          daysBox.querySelectorAll('.p-day').forEach(b => b.classList.toggle('active', b === btn));
          customInput.style.display = 'none';
          loadMeals();
        });
      });
      mealSel?.addEventListener('change', () => { clientId = newClientId(); });
      customToggle.addEventListener('click', () => {
        const opening = customInput.style.display === 'none';
        customInput.style.display = opening ? 'block' : 'none';
        if (opening) customInput.focus();
      });
      customInput.addEventListener('change', () => {
        if (!customInput.value) return;
        selectedDate = customInput.value;
        clientId = newClientId();
        daysBox.querySelectorAll('.p-day').forEach(b => b.classList.remove('active'));
        loadMeals();
      });
    }

    document.getElementById('p-close').addEventListener('click', hideSheet);
    document.getElementById('p-save').addEventListener('click', async () => {
      const grams = parseFloat(gi.value);
      if (!(grams > 0)) return showToast('Enter how many grams', 'error');
      const btn = document.getElementById('p-save');
      btn.disabled = true; btn.textContent = 'Logging…';
      try {
        // opts.sessionId may be a lazySession thunk — the meal it targets isn't
        // created until here, so a dismissed sheet leaves nothing behind.
        const sid = typeof opts.sessionId === 'function' ? await opts.sessionId() : opts.sessionId;
        const r = await api.post(`/api/batches/${batch.id}/portion`, {
          grams,
          // The real date even when locked. The server nulls a meal_session_id
          // it can't resolve and then creates a session on `date` — absent, that
          // defaults to today, so a portion aimed at a History day whose meal
          // another tab deleted appeared on today with a success toast.
          date: lockedSession ? (opts.date || selectedDate) : selectedDate,
          meal_session_id: lockedSession ? sid : (mealSel?.value || undefined),
          client_id: clientId,
        });
        hideSheet();
        showToast(`Logged ${g0(r.logged_g)} g · ${g0(r.remaining_g)} g left`, 'success');
        onDone?.();
      } catch (err) { showToast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Log portion'; }
    });
  });
}
