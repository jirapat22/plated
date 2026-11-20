// The Edit Quick Log sheet: the Meal chips must not sit on the macro boxes.
//
// Pat's bug 20/11/2026 ("meal button overlap"): the P/C/F grid in the Edit
// sheet had no bottom margin, so the Meal chip row started at exactly the
// boxes' bottom edge. Measured in a throwaway instance on a 390px phone: 0px
// apart at 100% and at 150%, borders touching, reading as overlapping buttons.
// The Quick Log sheet's copy of the same grid always had margin-bottom:16px,
// which is how the two drifted apart. This pins both grids to a real gap.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/views/log.js', import.meta.url), 'utf8');

test('every P/C/F macro grid leaves a gap before what comes next', () => {
  const grids = src.match(/<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px[^"]*">\s*\$\{\['pro','carb','fat'\]/g) || [];
  assert.ok(grids.length >= 2, 'expected the Quick Log and the Edit sheet macro grids');
  for (const g of grids) {
    assert.match(g, /margin-bottom:\s*\d+px/, `a macro grid lost its margin-bottom: ${g.slice(0, 90)}`);
  }
});
