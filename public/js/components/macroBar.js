/**
 * Renders a stacked horizontal macro bar with legend.
 * @param {Element} container - Target DOM element
 * @param {Object}  totals    - { protein, carbs, fat, fiber }
 * @param {Object}  goals     - { protein, carbs, fat, fiber }
 */
export function renderMacroBar(container, totals, goals) {
  const total = (totals.protein || 0) + (totals.carbs || 0) + (totals.fat || 0) + (totals.fiber || 0);

  function pct(val) {
    if (!total || !val) return 0;
    return Math.min((val / total) * 100, 100);
  }

  function goalPct(val, goal) {
    if (!goal) return '';
    const p = Math.min(Math.round((val / goal) * 100), 100);
    return ` (${p}%)`;
  }

  container.innerHTML = `
    <div class="macro-bar-outer">
      <div class="macro-seg protein" style="width:${pct(totals.protein)}%"></div>
      <div class="macro-seg carbs"   style="width:${pct(totals.carbs)}%"></div>
      <div class="macro-seg fat"     style="width:${pct(totals.fat)}%"></div>
      <div class="macro-seg fiber"   style="width:${pct(totals.fiber)}%"></div>
    </div>
    <div class="macro-legend">
      <div class="macro-item">
        <div class="macro-dot" style="background:var(--protein)"></div>
        <span class="num">${(totals.protein || 0).toFixed(1)}g</span>
        <span class="muted">protein${goalPct(totals.protein, goals?.protein)}</span>
      </div>
      <div class="macro-item">
        <div class="macro-dot" style="background:var(--carbs)"></div>
        <span class="num">${(totals.carbs || 0).toFixed(1)}g</span>
        <span class="muted">carbs${goalPct(totals.carbs, goals?.carbs)}</span>
      </div>
      <div class="macro-item">
        <div class="macro-dot" style="background:var(--fat)"></div>
        <span class="num">${(totals.fat || 0).toFixed(1)}g</span>
        <span class="muted">fat${goalPct(totals.fat, goals?.fat)}</span>
      </div>
      <div class="macro-item">
        <div class="macro-dot" style="background:var(--fiber)"></div>
        <span class="num">${(totals.fiber || 0).toFixed(1)}g</span>
        <span class="muted">fiber${goalPct(totals.fiber, goals?.fiber)}</span>
      </div>
    </div>
  `;
}
