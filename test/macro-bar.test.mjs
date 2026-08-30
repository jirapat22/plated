// renderMacroBar writes a string into container.innerHTML and touches nothing
// else, so a plain object with an innerHTML property is a good enough DOM to
// assert on what it renders. No jsdom, no framework.
import { test } from 'node:test';
import assert from 'node:assert';
import { renderMacroBar } from '../public/js/components/macroBar.js';

const box = () => ({ innerHTML: '' });
const goals = { protein: 150, carbs: 250, fat: 65, fiber: 30 };
const totals = { protein: 150, carbs: 200, fat: 40, fiber: 20 };

test('a known macro renders as a plain number with what is left', () => {
  const c = box();
  renderMacroBar(c, totals, goals, true, null);
  assert.match(c.innerHTML, />150</, 'the total should render bare');
  assert.doesNotMatch(c.innerHTML, /150\+/);
  assert.match(c.innerHTML, /50g left/, 'carbs had 50 g left');
  assert.doesNotMatch(c.innerHTML, /at least this much/, 'no caveat when nothing is missing');
});

test('a partial macro renders as a floor and drops the "left" claim', () => {
  const c = box();
  renderMacroBar(c, totals, goals, true, { carbs: true });
  assert.match(c.innerHTML, /200\+/, 'carbs is a floor');
  assert.doesNotMatch(c.innerHTML, /50g left/, '"left" cannot survive an unknown');
  // The macros that ARE known keep their remaining figure.
  assert.match(c.innerHTML, /25g left/, 'fat was known, so it keeps its remainder');
});

test('a floor already past the goal still says how far over', () => {
  const c = box();
  renderMacroBar(c, { ...totals, protein: 186 }, goals, true, { protein: true });
  assert.match(c.innerHTML, /186\+/);
  assert.match(c.innerHTML, /\+36g over/, 'a floor past the goal still proves you are over');
});

// The note is rendered by History too, for a day that is not today.
test('the partial note does not claim the day is today', () => {
  const c = box();
  renderMacroBar(c, totals, goals, false, { protein: true });
  assert.match(c.innerHTML, /at least this much/);
  assert.doesNotMatch(c.innerHTML, /meal today/,
    'History renders this for any past day — "today" is the wrong day there');
});
