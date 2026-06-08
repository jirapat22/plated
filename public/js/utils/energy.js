// Central energy unit utility — import this wherever energy is displayed

let _unit = 'kcal'; // 'kcal' | 'kj'

export function setEnergyUnit(u) { _unit = u; }
export function getEnergyUnit()  { return _unit; }
export function unitLabel()      { return _unit === 'kj' ? 'kJ' : 'kcal'; }

// Convert stored kcal value to display unit
export function toDisplay(kcal) {
  if (kcal == null) return null;
  return _unit === 'kj' ? Math.round(kcal * 4.184) : kcal;
}

// Format for display, with rounding
export function fmtE(kcal, decimals = 0) {
  if (kcal == null || kcal === '') return '–';
  const v = toDisplay(parseFloat(kcal));
  return decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
}

// Convert kJ input back to kcal for storage (if user types in kJ mode)
export function toKcal(displayVal) {
  if (displayVal == null) return null;
  return _unit === 'kj' ? Math.round(displayVal / 4.184) : displayVal;
}

// Wires a kcal/kJ pill toggle (two `.eunit-btn[data-unit]` buttons inside
// `unitWrap`) next to an energy `input`. Converts the displayed number when
// the unit changes (so it keeps representing the same energy), and returns a
// getter that converts back to kcal for storage on save. The toggle starts in
// kcal — the unit a food's stored value is always in — so a freshly-rendered
// or pre-filled input always matches what's shown.
export function wireEnergyUnitToggle(unitWrap, input) {
  let unit = 'kcal';
  unitWrap.querySelectorAll('.eunit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.unit === unit) return;
      const cur = parseFloat(input.value);
      if (!isNaN(cur)) {
        input.value = btn.dataset.unit === 'kj' ? Math.round(cur * 4.184) : Math.round(cur / 4.184);
      }
      unit = btn.dataset.unit;
      unitWrap.querySelectorAll('.eunit-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  return () => {
    const val = parseFloat(input.value);
    if (isNaN(val)) return null;
    return unit === 'kj' ? Math.round(val / 4.184) : val;
  };
}

// Parse NZ nutrition panel text — returns {calories_per_100g, protein, carbs, fat, fiber, serving_size_g}
export function parseNutritionLabel(text) {
  const result = {};

  // Serving size: "Serving size: 18g"
  const srvMatch = text.match(/serving\s+size[:\s]+(\d+\.?\d*)\s*g/i);
  if (srvMatch) result.serving_size_g = parseFloat(srvMatch[1]);

  // Parse tab-separated rows — take the FIRST numeric column (= Per 100g)
  for (const line of text.split(/\r?\n/)) {
    const cols    = line.split(/\t+/);
    const label   = (cols[0] || '').trim().toLowerCase();
    const per100  = (cols[1] || '').trim();
    if (!label || !per100) continue;

    if (/^energy/.test(label)) {
      // e.g. "1,600kJ" or "382kcal"
      const m = per100.match(/([0-9][0-9,]*\.?\d*)\s*(kj|kcal)/i);
      if (m) {
        const val  = parseFloat(m[1].replace(/,/g, ''));
        const unit = m[2].toLowerCase();
        result.calories_per_100g = unit === 'kj' ? Math.round(val / 4.184) : val;
      }
    } else if (/^protein/.test(label)) {
      const m = per100.match(/(\d+\.?\d*)/);
      if (m) result.protein_per_100g = parseFloat(m[1]);
    } else if (/^fat\s*[-–]\s*total|^total\s+fat|^fat$/.test(label)) {
      const m = per100.match(/(\d+\.?\d*)/);
      if (m) result.fat_per_100g = parseFloat(m[1]);
    } else if (/^carbohydrate/.test(label)) {
      const m = per100.match(/(\d+\.?\d*)/);
      if (m) result.carbs_per_100g = parseFloat(m[1]);
    } else if (/fi(?:bre|ber)/.test(label) && !/sugar/.test(label)) {
      const m = per100.match(/(\d+\.?\d*)/);
      if (m) result.fiber_per_100g = parseFloat(m[1]);
    }
  }

  return result;
}
