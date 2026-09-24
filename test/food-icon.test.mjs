// Rule ORDER in foodIcon.js is the whole algorithm — first match wins — and
// nothing else records it.
//
// A reorder hoisted a dozen specific rules above the general ones that had been
// shadowing them, which was right: peanut butter drew the butter icon, pineapple
// the apple, eggplant the egg. But the cooking-oil rule went up with them, and
// its terms appear as an incidental ingredient in thousands of AUSNUT/NZ names.
// Measured across the 4,873 seeded names, that one line changed 118 icons and
// most were losses: every "pan-fried with canola oil" fish fillet became an
// olive, as did each canola margarine and a fried tempeh. The frying medium had
// started naming the dish.
//
// Nothing failed, because an icon cannot fail — which is exactly why the
// ordering needs a test rather than a reading.
import { test } from 'node:test';
import assert from 'node:assert';
import { getFoodIcon } from '../public/js/utils/foodIcon.js';

// The specific rule must beat the general one that used to shadow it.
test('a specific food beats the general rule above it', () => {
  for (const [name, want] of [
    ['Peanut butter, smooth',        '🥜'],   // not 🧈 butter
    ['Butter lettuce',               '🥬'],   // not 🧈
    ['Butternut pumpkin, raw',       '🎃'],   // not 🧈
    ['Pineapple, flesh, raw',        '🍍'],   // not 🍎 apple
    ['Eggplant, steamed',            '🍆'],   // not 🥚 egg
    ['Crepe or pancake, plain',      '🥞'],   // not 🎂 cake
    ['Coconut milk, unsweetened',    '🥥'],   // not 🥛 milk
    ['Red kidney bean, canned',      '🫘'],   // not 🫀 (kid*ney*)
    ['Butter, salted',               '🧈'],   // and the general rule still works
  ]) assert.strictEqual(getFoodIcon(name), want, `${name} drew the wrong icon`);
});

// …and the cooking medium must NOT beat the food. This is the direction that
// broke, and it is the one with thousands of rows behind it.
test('the oil a thing was fried in does not name the dish', () => {
  for (const [name, want] of [
    ['Hoki, fillet, fresh, pan-fried with canola oil',     '🐟'],
    ['Fish, fingers, deep-fried in peanut oil',            '🐟'],
    ['Margarine, canola, monounsaturated, 70% fat',        '🧈'],
    ['Margarine, rice bran, Alfa One',                     '🧈'],
    ['Bread, white, garlic filling with vegetable oil',    '🧄'],
  ]) assert.strictEqual(getFoodIcon(name), want,
    `"${name}" was named after its frying oil`);
});

// A name that really is an oil still lands on the oil.
test('an actual oil still reads as one', () => {
  // Sesame is deliberately absent: it matches the seed rule further up, which
  // predates this and is arguably the better answer for sesame anything.
  for (const name of ['Olive oil, extra virgin', 'Canola oil', 'Rice bran oil']) {
    assert.strictEqual(getFoodIcon(name), '🫒', `${name} should be the oil icon`);
  }
});

// A word boundary on ONE side is not a word boundary.
//
// /ling\b/ matched the end of any word finishing in -ling, so 28 of the 4,873
// seeded foods drew a fish: sparkling wine, sparkling juice, biscuits with a
// caramel filling, garlic bread. Nothing about an icon fails loudly, so it sat
// there. Found while checking something else.
test('a word ending in -ling is not a ling', () => {
  for (const [name, word] of [
    ['Wine, red, sparkling', 'sparkling'],
    ['Juice, apple, sparkling, commercial', 'sparkling'],
    ['Biscuit, sweet, caramel or mint filling', 'filling'],
  ]) assert.notStrictEqual(getFoodIcon(name), '🐟', `"${word}" was read as the fish`);

  // The actual fish, and its neighbours in the same rule, still match.
  for (const name of ['Ling, fillet, raw', 'Hoki, fillet', 'John dory, raw', 'Sole, grilled']) {
    assert.strictEqual(getFoodIcon(name), '🐟', `${name} stopped being a fish`);
  }
});
