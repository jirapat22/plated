// A day total built partly from unknowns is a floor, not a measurement.
//
// The entry has said "-P -C -F" for a while; the day above it did not, and
// reported "Protein 202 / 166g · +36g over" on a day where 900 kcal of Quick Log
// contributed nothing to any macro. These cover both halves of the fix: the
// server saying which totals are incomplete, and the bar deciding what it may
// still claim about them.
import { test } from 'node:test';
import assert from 'node:assert';

const { renderMacroBar } = await import('../public/js/components/macroBar.js');
const goals = { protein: 166, carbs: 137, fat: 61, fiber: 30 };
const render = (totals, partial) => {
  const el = { innerHTML: '' };
  renderMacroBar(el, totals, goals, true, partial);
  return el.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

test('a complete day is untouched — no marks, no note', () => {
  const out = render({ protein: 99, carbs: 67, fat: 54, fiber: 10 }, null);
  assert.match(out, /Protein 99 \/ 166g · 67g left/);
  assert.doesNotMatch(out, /\+/, 'nothing should be marked as a minimum');
  assert.doesNotMatch(out, /at least/);
});

// The claim that cannot survive an unknown: the missing grams could close the
// gap or blow straight past it, so "left" is a number nobody has.
test('an incomplete macro under goal loses its "left" figure', () => {
  const out = render({ protein: 80, carbs: 40, fat: 20, fiber: 9 }, { protein: true });
  assert.match(out, /Protein 80\+ \/ 166g/);
  assert.doesNotMatch(out, /Protein 80\+ \/ 166g · \d+g left/, '"left" is not knowable here');
  // …while a macro that IS complete keeps its figure. Partial is per-macro.
  assert.match(out, /Carbs 40 \/ 137g · 97g left/);
});

// The claim that does survive: a floor already past the goal proves you are
// over. Only the size is a minimum, which the leading + already says.
test('an incomplete macro over goal keeps "over"', () => {
  const out = render({ protein: 202, carbs: 257, fat: 167, fiber: 56 }, { protein: true });
  assert.match(out, /Protein 202\+ \/ 166g · \+36g over/);
});

test('the explanation appears once for the card, not once per row', () => {
  const out = render({ protein: 80, carbs: 40, fat: 20, fiber: 9 },
    { protein: true, carbs: true, fat: true, fiber: true });
  assert.strictEqual(out.match(/at least this much/g).length, 1);
});

test('showRemaining:false (History) still marks the minimums', () => {
  const el = { innerHTML: '' };
  renderMacroBar(el, { protein: 80, carbs: 40, fat: 20, fiber: 9 }, goals, false, { protein: true });
  const out = el.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(out, /Protein 80\+/);
});
