/**
 * Renders individual progress bars for each macro vs its goal.
 * @param {Element} container
 * @param {Object}  totals  — { protein, carbs, fat, fiber } consumed
 * @param {Object}  goals   — { protein, carbs, fat, fiber } targets
 */
export function renderMacroBar(container, totals, goals) {
  const macros = [
    { key: 'protein', label: 'Protein', color: 'var(--protein)', unit: 'g' },
    { key: 'carbs',   label: 'Carbs',   color: 'var(--carbs)',   unit: 'g' },
    { key: 'fat',     label: 'Fat',     color: 'var(--fat)',     unit: 'g' },
    { key: 'fiber',   label: 'Fiber',   color: 'var(--fiber)',   unit: 'g' },
  ];

  container.innerHTML = macros.map(m => {
    const consumed = totals[m.key] ?? 0;
    const goal     = goals[m.key]  ?? 0;
    const pct      = goal > 0 ? Math.min((consumed / goal) * 100, 100) : 0;
    const over     = goal > 0 && consumed > goal;
    const pctLabel = goal > 0 ? `${Math.round(pct)}%` : '';

    return `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:12px;font-weight:600;color:${m.color}">${m.label}</span>
          <span style="font-size:12px;font-variant-numeric:tabular-nums;color:${over ? m.color : 'var(--text-muted)'}">
            <strong style="color:${m.color}">${consumed.toFixed(1)}${m.unit}</strong>
            ${goal > 0 ? `<span style="color:var(--text-faint)"> / ${goal}${m.unit}</span>` : ''}
            ${pctLabel ? `<span style="color:var(--text-faint);margin-left:4px">${pctLabel}</span>` : ''}
          </span>
        </div>
        <div style="height:7px;background:var(--surface-2);border-radius:999px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${m.color};border-radius:999px;transition:width 600ms ease-out;opacity:${over ? 1 : 0.85}"></div>
        </div>
      </div>
    `;
  }).join('');
}
