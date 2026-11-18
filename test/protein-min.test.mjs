// Protein minimum (18/11/2026): "must hit 120, aim 145".
// renderMacroBar only writes container.innerHTML, so a plain object stands in for the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMacroBar } from '../public/js/components/macroBar.js';
import validate from '../src/utils/validate.js';

const goals = { protein: 145, carbs: 180, fat: 50, fiber: 22, proteinMin: 120 };
const bar = (protein, g = goals) => {
  const box = { innerHTML: '' };
  renderMacroBar(box, { protein, carbs: 0, fat: 0, fiber: 0 }, g, true);
  return box.innerHTML;
};

test('under the minimum: says how far to the min, shows the tick', () => {
  const html = bar(100);
  assert.match(html, /20g to min/);
  assert.match(html, /\(min 120\)/);
  assert.match(html, /Minimum 120g/);
});

test('between min and goal: min ticked, grams to the aim', () => {
  const html = bar(130);
  assert.match(html, /min ✓/);
  assert.match(html, /15g to aim/);
  assert.doesNotMatch(html, /to min/);
});

test('over the goal: plain "over", like before', () => {
  assert.match(bar(150), /\+5g over/);
});

test('no minimum set: exactly the old labels', () => {
  const html = bar(100, { ...goals, proteinMin: 0 });
  assert.match(html, /45g left/);
  assert.doesNotMatch(html, /min/);
});

test('a minimum at or above the goal is ignored', () => {
  assert.doesNotMatch(bar(100, { ...goals, proteinMin: 150 }), /to min/);
});

test('protein_min is validated like the other gram goals', () => {
  assert.equal(validate.badSetting('protein_min', '120'), null);
  assert.equal(validate.badSetting('protein_min', ''), null);
  assert.match(validate.badSetting('protein_min', '99999'), /between 0 and 2,000 g|between 0 and 2000 g/);
});
