/**
 * Returns an emoji icon for a food based on its name.
 * Priority order matters — more specific rules first.
 */
const RULES = [
  // ── Custom / supplements ────────────────────────────────────
  [/protein.?(powder|shake|bar|supplement)|whey|casein|creatine/i, '💪'],
  [/vitamin|supplement|probiotic|omega/i,                          '💊'],

  // ── Eggs ────────────────────────────────────────────────────
  [/\begg/i,                                                        '🥚'],

  // ── Dairy ───────────────────────────────────────────────────
  [/butter|margarine/i,                                             '🧈'],
  [/milk\b|trim\b.*milk|full.fat.*milk|skim.*milk|oat.milk|soy.milk|almond.milk|plant.milk/i, '🥛'],
  [/yogh?urt|yogurt/i,                                              '🫙'],
  [/cheese|cheddar|mozzarella|parmesan|feta|ricotta|brie|gouda|camembert|colby/i, '🧀'],
  [/cream\b|ice.?cream|sour.cream|crème/i,                          '🍦'],
  [/\bmilk\b/i,                                                     '🥛'],

  // ── Poultry ─────────────────────────────────────────────────
  [/chicken|turkey|duck|poultry|hen\b/i,                            '🍗'],

  // ── Seafood / fish ──────────────────────────────────────────
  [/prawn|shrimp|crab|lobster|crayfish/i,                           '🦐'],
  [/mussel|oyster|scallop|clam|pipi|cockle|paua|kina/i,             '🦪'],
  [/squid|calamari|octopus/i,                                       '🦑'],
  [/salmon/i,                                                       '🍣'],
  [/tuna|snapper|basa|cod|hoki|tarakihi|kahawai|sole|eel|trout|sardine|anchovy|mackerel|dory|grouper|terakihi|warehou|gurnard|flounder|bluefin|swordfish|mahi|fish/i, '🐟'],

  // ── Red meat ────────────────────────────────────────────────
  [/lamb|mutton|hogget/i,                                           '🐑'],
  [/pork|bacon|ham\b|prosciutto|pancetta|salami|sausage|chorizo|pepperoni/i, '🥓'],
  [/beef|steak|veal|venison|bison|mince|corned|silverside/i,        '🥩'],
  [/meat\b/i,                                                       '🥩'],

  // ── Legumes / plant protein ─────────────────────────────────
  [/tofu|tempeh/i,                                                  '🧊'],
  [/edamame/i,                                                      '🫛'],
  [/lentil|chickpea|bean|soybean|hummus|dhal|dal\b|pea\b|peas\b|legume|pulse/i, '🫘'],

  // ── Vegetables ──────────────────────────────────────────────
  [/avocado/i,                                                      '🥑'],
  [/tomato/i,                                                       '🍅'],
  [/potato\b|kumara|sweet.potato/i,                                 '🥔'],
  [/corn\b|maize|sweetcorn/i,                                       '🌽'],
  [/carrot|parsnip|turnip|swede|radish|beetroot|beet\b/i,           '🥕'],
  [/mushroom|fungi/i,                                               '🍄'],
  [/broccoli|cauliflower|brussels/i,                                '🥦'],
  [/capsicum|pepper\b|chilli|chile/i,                               '🌶️'],
  [/eggplant|aubergine|zucchini|courgette|pumpkin|squash|marrow/i,  '🍆'],
  [/spinach|silverbeet|kale|watercress|bok.choy|chard|lettuce|rocket|mesclun|salad.green/i, '🥬'],
  [/cabbage/i,                                                      '🥦'],
  [/onion|shallot|leek|spring.onion|scallion/i,                     '🧅'],
  [/garlic/i,                                                       '🧄'],
  [/asparagus|celery|fennel|artichoke|okra|yam/i,                   '🥦'],
  [/frozen.veg|mixed.veg|stir.fry.mix/i,                            '🥦'],
  [/\bveg/i,                                                        '🥦'],

  // ── Fruit ───────────────────────────────────────────────────
  [/apple/i,                                                        '🍎'],
  [/banana/i,                                                       '🍌'],
  [/orange|mandarin|tangerine|clementine/i,                         '🍊'],
  [/grape/i,                                                        '🍇'],
  [/strawberr/i,                                                    '🍓'],
  [/blueberr/i,                                                     '🫐'],
  [/raspberr|blackberr|boysenberr/i,                                '🍓'],
  [/cherry|cherries/i,                                              '🍒'],
  [/peach|nectarine|apricot|plum/i,                                 '🍑'],
  [/mango/i,                                                        '🥭'],
  [/pineapple/i,                                                    '🍍'],
  [/watermelon|melon/i,                                             '🍉'],
  [/kiwi.?fruit|kiwifruit/i,                                        '🥝'],
  [/lemon|lime/i,                                                   '🍋'],
  [/pear\b/i,                                                       '🍐'],
  [/coconut/i,                                                      '🥥'],
  [/fig\b|date\b|prune|raisin|sultana|currant/i,                    '🍇'],
  [/passion.?fruit|feijoa/i,                                        '🍈'],
  [/frozen.berr|mixed.berr/i,                                       '🍓'],
  [/fruit/i,                                                        '🍎'],

  // ── Nuts & seeds ────────────────────────────────────────────
  [/peanut.butter|almond.butter|nut.butter/i,                       '🥜'],
  [/peanut|almond|cashew|walnut|pecan|pistachio|hazelnut|macadamia|brazil.nut|pine.nut|mixed.nut/i, '🥜'],
  [/seed|chia|sesame|sunflower|pumpkin.seed|flax|linseed|hemp/i,    '🌱'],
  [/tahini/i,                                                       '🥜'],

  // ── Oils & fats ─────────────────────────────────────────────
  [/olive.oil|canola|vegetable.oil|rice.bran|coconut.oil|sesame.oil|sunflower.oil|avocado.oil/i, '🫒'],
  [/\boil\b/i,                                                      '🫒'],
  [/lard|dripping|ghee|shortening/i,                                '🧈'],

  // ── Bread & bakery ──────────────────────────────────────────
  [/croissant|danish|pastry/i,                                      '🥐'],
  [/cake|muffin|cupcake|brownie|slice|loaf|pudding/i,               '🍰'],
  [/biscuit|cookie|cracker|wafer/i,                                 '🍪'],
  [/donut|doughnut/i,                                               '🍩'],
  [/bread|toast|wrap|pita|bagel|roll\b|bun\b|sourdough|roti|naan|focaccia/i, '🍞'],
  [/tortilla/i,                                                     '🫓'],

  // ── Grains & cereals ────────────────────────────────────────
  [/oat|porridge|muesli|granola|weet.?bix|weetbix|cornflake|cereal/i,'🥣'],
  [/rice\b|risotto|paella/i,                                        '🍚'],
  [/pasta|spaghetti|penne|fettuccine|linguine|lasagne|macaroni|gnocchi/i, '🍝'],
  [/noodle|ramen|udon|soba|glass.noodle|vermicelli/i,               '🍜'],
  [/flour|cornmeal|polenta|semolina|breadcrumb/i,                   '🌾'],
  [/quinoa|couscous|bulgur|buckwheat|millet|barley|teff/i,          '🌾'],
  [/crumpet|pikelet|pancake|waffle/i,                               '🥞'],

  // ── Sweets & spreads ────────────────────────────────────────
  [/honey/i,                                                        '🍯'],
  [/maple.syrup|golden.syrup|treacle|molasses/i,                    '🍯'],
  [/jam|jelly|marmalade|preserve/i,                                 '🍓'],
  [/chocolate|cocoa|cacao/i,                                        '🍫'],
  [/sugar|icing|candy|lolly|lollies|sweet\b|confection|caramel|toffee|fudge|nougat/i, '🍬'],
  [/marmite|vegemite|peanut.butter|nutella|spread/i,                '🫙'],
  [/ice.?cream|gelato|sorbet|frozen.yogh/i,                         '🍦'],

  // ── Condiments & sauces ─────────────────────────────────────
  [/tomato.sauce|ketchup|passata|pasta.sauce/i,                     '🍅'],
  [/soy.sauce|teriyaki|hoisin|oyster.sauce|fish.sauce|worcestershire/i, '🫙'],
  [/mayo|mayonnaise/i,                                              '🫙'],
  [/mustard/i,                                                      '🌭'],
  [/vinegar|balsamic/i,                                             '🫙'],
  [/chilli.sauce|sriracha|hot.sauce|tabasco/i,                      '🌶️'],
  [/sweet.chilli|chutney|relish|pickle/i,                           '🫙'],
  [/curry.paste|curry.powder|curry.sauce/i,                         '🍛'],
  [/dressing|caesar|ranch|thousand|vinaigrette/i,                   '🥗'],
  [/miso|kimchi|sauerkraut/i,                                       '🫙'],
  [/stock|broth|gravy/i,                                            '🍲'],
  [/sauce/i,                                                        '🫙'],

  // ── Herbs & spices ──────────────────────────────────────────
  [/herb|basil|oregano|thyme|rosemary|parsley|coriander|dill|mint\b|sage|tarragon|chive/i, '🌿'],
  [/spice|cumin|turmeric|paprika|cinnamon|ginger|pepper\b|cardamom|clove|nutmeg|allspice/i, '🫙'],
  [/salt\b/i,                                                       '🧂'],

  // ── Soups & stews ───────────────────────────────────────────
  [/soup|stew|broth|chowder|bisque|minestrone|pho/i,                '🍲'],

  // ── Fast food & takeaway ────────────────────────────────────
  [/burger|hamburger|cheeseburger/i,                                '🍔'],
  [/pizza/i,                                                        '🍕'],
  [/hot.dog|frankfurter/i,                                          '🌭'],
  [/sushi|sashimi|maki|nigiri/i,                                    '🍣'],
  [/dumpling|gyoza|wonton|dim.sum/i,                                '🥟'],
  [/fried.rice|stir.fry/i,                                          '🍳'],
  [/sandwich|sub\b|panini|wrap/i,                                   '🥪'],
  [/salad/i,                                                        '🥗'],
  [/chips|fries|fry/i,                                              '🍟'],
  [/kebab|shawarma|falafel/i,                                       '🌯'],
  [/curry|korma|tikka|masala|vindaloo/i,                            '🍛'],
  [/steak.house|schnitzel/i,                                        '🥩'],

  // ── Drinks ──────────────────────────────────────────────────
  [/coffee|espresso|latte|cappuccino|flat.white|long.black|macchiato|mocha/i, '☕'],
  [/tea\b|chai|matcha|herbal/i,                                     '🍵'],
  [/juice|smoothie|nectar/i,                                        '🧃'],
  [/water\b|sparkling/i,                                            '💧'],
  [/milk.drink|milkshake|shake/i,                                   '🥤'],
  [/energy.drink|soft.drink|soda|cola|lemonade|cordial/i,           '🥤'],
  [/milo|horlicks|ovaltine/i,                                       '☕'],
  [/protein.drink|protein.shake/i,                                  '💪'],

  // ── Processed / packaged ────────────────────────────────────
  [/chip\b|crisp\b|popcorn|rice.cake|cracker|pretzel/i,             '🍿'],
  [/bar\b|snack.bar|muesli.bar|energy.bar/i,                        '🍫'],
  [/cereal.bar|breakfast.bar/i,                                     '🥣'],

  // ── Misc ────────────────────────────────────────────────────
  [/nutritional.yeast/i,                                            '🌱'],
  [/topping|sprinkle|garnish/i,                                     '✨'],
];

export function getFoodIcon(name) {
  if (!name) return '🍽';
  for (const [pattern, icon] of RULES) {
    if (pattern.test(name)) return icon;
  }
  return '🍽';
}
