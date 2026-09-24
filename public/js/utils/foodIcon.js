/**
 * Returns an emoji icon for a food based on its name.
 * Priority order matters — more specific rules first.
 *
 * FIRST MATCH WINS, so a pattern repeated further down the list can never fire.
 * 18 such rules had accumulated (tahini, pavlova, sausage roll, miso…), every
 * one of them shadowed by an identical earlier rule mapping to the same emoji —
 * dead weight that read like coverage. Before adding a rule, check the term
 * isn't already matched above.
 */
const RULES = [
  // ── Must come first — specific combos that would match general rules ──
  [/bubble.tea|boba|pearl.milk.tea/i,                                                 '🧋'],
  // Hoisted: each of these sat BELOW a general rule that matches the same text
  // ("butter", "apple", "egg", "cake", "milk", "cream", "muffin", "salmon",
  // "mushroom", "lettuce", "pumpkin", "bean", an oil), so first-match-wins
  // meant the specific rule never ran and the icon shown was the general one's
  // — peanut butter drew 🧈, pineapple 🍎, eggplant 🥚, pancake 🎂, kidney bean
  // 🫀. The file header already warned that a repeated pattern can never fire;
  // these were the cases where the shadowed rule wanted a DIFFERENT emoji, so
  // the intent was silently lost rather than merely duplicated.
  [/peanut.butter|almond.butter|cashew.butter|nut.butter/i,                           '🥜'],
  [/butter.lettuce/i,                                                                 '🥬'],
  [/butternut/i,                                                                      '🎃'],
  [/pineapple/i,                                                                      '🍍'],
  [/eggplant|aubergine/i,                                                             '🍆'],
  [/pancake|hotcake|waffle\b/i,                                                       '🥞'],
  [/coconut.milk|coconut.cream|coconut.oil/i,                                         '🥥'],
  [/kidney.bean/i,                                                                    '🫘'],
  [/oyster.mushroom/i,                                                                '🍄'],
  [/smoked.salmon|smoked.trout|smoked.fish/i,                                         '🐟'],
  [/english.muffin/i,                                                                 '🍞'],
  [/popcorn/i,                                                                       '🍿'],
  [/bone.broth/i,                                                                      '🦴'],
  [/meatloaf|meat.loaf/i,                                                             '🥩'],
  [/meat.pie|steak.pie|mince.pie/i,                                                   '🥧'],
  [/sausage.roll/i,                                                                    '🌭'],
  [/beyond.meat|impossible.burger|impossible.meat|plant.based.meat|plant.based.mince|meat.free|meat.alternative|veggie.burger|veggie.mince|quorn\b/i, '🌱'],
  [/fish.and.chips/i,                                                                  '🐟'],
  [/fried.chicken/i,                                                                   '🍗'],
  [/poke.bowl/i,                                                                       '🥗'],
  [/rice.paper.roll|summer.roll|fresh.roll/i,                                         '🌯'],
  [/sushi.roll|california.roll|dragon.roll/i,                                         '🍣'],
  [/cold.brew|nitro.coffee|iced.coffee|protein.coffee/i,                              '☕'],
  [/hot.chocolate|drinking.chocolate/i,                                               '☕'],
  [/turmeric.latte|golden.milk/i,                                                     '☕'],
  [/green.tea|matcha\b/i,                                                              '🍵'],
  [/pavlova/i,                                                                         '🎂'],
  [/lamington/i,                                                                       '🍰'],
  [/afghan.biscuit|anzac/i,                                                            '🍪'],
  [/pork.crackling|pork.rind/i,                                                        '🥓'],
  [/biltong|jerky|dried.meat|beef.stick/i,                                            '🥩'],

  // ── Supplements & sports nutrition ──────────────────────────
  [/protein.?(powder|shake|bar|supplement)|whey|casein|creatine|bcaa|pre.?workout/i, '💪'],
  [/vitamin|supplement|probiotic|omega.?3|fish.?oil|collagen|electrolyte/i,          '💊'],
  [/spirulina|chlorella|moringa|supergreen|superfood/i,                              '🌱'],
  [/meal.replacement|slim.fast|optifast/i,                                            '💊'],

  // ── Eggs ────────────────────────────────────────────────────
  [/\begg/i,                                                                           '🥚'],

  // ── Dairy & alternatives ─────────────────────────────────────
  [/\bbutter\b|margarine/i,                                                                '🧈'],
  [/ghee/i,                                                                            '🧈'],
  [/kefir|labneh|skyr/i,                                                               '🥛'],
  [/yogh?urt|yogurt/i,                                                                 '🫙'],
  [/kombucha|kefir.water/i,                                                            '🧃'],
  [/cheddar|mozzarella|parmesan|feta|ricotta|brie|gouda|camembert|colby|\bedam\b|gruyere|haloumi|halloumi|cottage.cheese|cream.cheese/i, '🧀'],
  [/\bcheese\b/i,                                                                      '🧀'],
  [/ice.?cream|gelato|sorbet|frozen.yogh/i,                                            '🍦'],
  [/whipped.cream|thickened.cream|sour.cream|double.cream/i,                           '🫙'],
  [/cream\b|crème/i,                                                                   '🍦'],
  [/oat.milk|soy.milk|almond.milk|rice.milk|coconut.milk.drink|plant.milk|plant.based.milk/i, '🥛'],
  [/buttermilk|skim.milk|trim.milk|full.fat.milk|whole.milk|low.fat.milk|evaporated.milk|condensed.milk|milk.powder/i, '🥛'],
  [/\bmilk\b/i,                                                                        '🥛'],
  [/custard|pudding\b/i,                                                                '🍮'],

  // ── Poultry ─────────────────────────────────────────────────
  [/chicken|turkey|duck|\bgoose\b|quail|poultry|hen\b|game.bird/i,                         '🍗'],

  // ── Seafood & shellfish ──────────────────────────────────────
  [/prawn|shrimp|crab|lobster|crayfish|langoustine|krill/i,                            '🦐'],
  [/mussel|oyster|\bscallops?\b|clam|pipi|cockle|paua|kina|abalone|geoduck/i,               '🦪'],
  [/squid|calamari|octopus|cuttlefish/i,                                               '🦑'],
  [/whitebait/i,                                                                        '🐟'],
  [/salmon/i,                                                                           '🍣'],
  [/tuna|albacore/i,                                                                    '🐟'],
  [/snapper|tarakihi|terakihi|warehou|gurnard|blue.cod|bluecod|john.dory|blue.moki|hapuku|kahawai|kingfish|yellowfin|marlin|swordfish/i, '🐟'],
  [/basa|barramundi|tilapia|pangasius/i,                                               '🐟'],
  // \bling\b, not ling\b. The trailing boundary alone matched the END of any
  // word finishing in -ling, so 28 of the 4,873 seeded foods drew a fish:
  // sparkling wine, sparkling juice, biscuits with a caramel filling and
  // garlic bread among them. Leading boundary added; `dory` was the same
  // trap and `sole` already had it right.
  [/hoki|\bling\b|orange.roughy|\bdory\b|\bsole\b|plaice|flounder|halibut|turbot/i, '🐟'],
  [/trout|perch|bass\b|bream|mullet/i,                                                 '🐟'],
  [/sardine|pilchard|herring|anchovy|whitebait|sprat/i,                                        '🐟'],
  [/\beel\b|lamprey/i,                                                                      '🐍'],
  [/smoked.fish|smoked.salmon|smoked.trout/i,                                          '🐟'],
  [/fish.cake|fish.finger|fish.ball|seafood/i,                                         '🐟'],
  [/\bfish\b/i,                                                                        '🐟'],

  // ── Organ meats ─────────────────────────────────────────────
  [/liver|kidney\b|heart\b|tripe|offal|sweetbread|brain\b/i,                          '🫀'],

  // ── Pork & processed meats ───────────────────────────────────
  [/bacon|pancetta|prosciutto/i,                                                        '🥓'],
  [/sausage|chorizo|pepperoni|salami|frankfurter|hot.dog|bratwurst|mortadella|devon\b|luncheon/i, '🌭'],
  [/ham\b|gammon/i,                                                                    '🥓'],
  [/pork\b|pig\b|suckling/i,                                                           '🥓'],

  // ── Lamb & mutton ────────────────────────────────────────────
  [/\bgoat\b/i,                                                                        '🐐'],
  [/lamb|mutton|hogget/i,                                                               '🐑'],

  // ── Beef & veal ─────────────────────────────────────────────
  [/beef|steak|veal|venison|bison|silverside|topside|sirloin|rump\b|fillet\b|ribeye|brisket|chuck\b|oxtail/i, '🥩'],
  [/mince\b|ground.meat/i,                                                             '🥩'],
  [/corned.beef|roast.beef/i,                                                           '🥩'],
  [/\bmeat\b/i,                                                                        '🥩'],

  // ── Legumes & plant protein ──────────────────────────────────
  [/beyond.meat|impossible|plant.based.meat|meat.free|meat.alternative|veggie.burger|veggie.mince|quorn\b/i, '🌱'],
  [/tofu|tempeh|seitan/i,                                                               '🧊'],
  [/natto/i,                                                                            '🫘'],
  [/edamame/i,                                                                          '🫛'],
  [/lentil/i,                                                                           '🫘'],
  [/chickpea|garbanzo/i,                                                                '🫘'],
  [/black.bean|kidney.bean|cannellini|borlotti|navy.bean|pinto.bean|broad.bean|fava.bean|adzuki|mung.bean/i, '🫘'],
  [/\bbean\b|\bbeans\b/i,                                                              '🫘'],
  [/soybean|soya/i,                                                                     '🫘'],
  [/hummus|dhal|dal\b|legume|pulse/i,                                                   '🫘'],
  [/pea\b|peas\b|split.pea/i,                                                          '🫛'],

  // ── Vegetables ──────────────────────────────────────────────
  [/avocado/i,                                                                          '🥑'],
  [/tomato/i,                                                                           '🍅'],
  [/kumara|sweet.potato/i,                                                              '🍠'],
  [/potato\b/i,                                                                         '🥔'],
  [/\bcorn\b|maize|sweetcorn|corn.on.the.cob/i,                                          '🌽'],
  [/carrot/i,                                                                           '🥕'],
  [/parsnip|turnip|swede|celeriac|cassava|\byams?\b|\btaro\b|\bradish\b|horseradish/i,                                             '🥕'],
  [/beetroot|\bbeet\b/i,                                                                  '🫀'],
  [/truffle\b/i,                                                                        '🍄'],
  [/mushroom|shiitake|portobello|oyster.mushroom|enoki|porcini|fungi/i,                '🍄'],
  [/broccoli/i,                                                                         '🥦'],
  [/cauliflower/i,                                                                      '🥦'],
  [/brussels.sprout/i,                                                                  '🥦'],
  [/capsicum|bell.pepper/i,                                                             '🫑'],
  [/chilli|chile\b|jalapeno|habanero/i,                                                 '🌶️'],
  [/pepper\b/i,                                                                         '🌶️'],
  [/zucchini|courgette/i,                                                               '🥒'],
  [/cucumber/i,                                                                         '🥒'],
  [/pumpkin|butternut|acorn.squash|squash\b|marrow/i,                                  '🎃'],
  [/spinach|silverbeet|swiss.chard|chard\b/i,                                           '🥬'],
  [/kale\b/i,                                                                           '🥬'],
  [/bok.choy|pak.choy|bok.choi|chinese.cabbage|wombok/i,                               '🥬'],
  [/watercress|rocket\b|arugula|mesclun|salad.green|mixed.green/i,                     '🥬'],
  [/lettuce|cos\b|iceberg|butter.lettuce|romaine/i,                                    '🥬'],
  [/cabbage/i,                                                                          '🥦'],
  [/leek/i,                                                                             '🧅'],
  [/onion|shallot|spring.onion|scallion/i,                                              '🧅'],
  [/garlic/i,                                                                           '🧄'],
  [/ginger\b/i,                                                                         '🫚'],
  [/asparagus/i,                                                                        '🌿'],
  [/celery/i,                                                                           '🌿'],
  [/fennel/i,                                                                           '🌿'],
  [/artichoke/i,                                                                        '🥦'],
  [/okra\b/i,                                                                           '🥦'],
  [/yam\b|taro\b/i,                                                                    '🍠'],
  [/sprout|microgreen|alfalfa/i,                                                        '🌱'],
  [/seaweed|nori\b|wakame|kelp/i,                                                      '🌿'],
  [/frozen.veg|mixed.veg|stir.fry.mix|asian.veg/i,                                     '🥦'],
  [/\bveg(etable)?\b/i,                                                                '🥦'],

  // ── Fruit ───────────────────────────────────────────────────
  [/apple/i,                                                                            '🍎'],
  [/banana|plantain/i,                                                                           '🍌'],
  [/grapefruit|orange\b|mandarin|tangelo|tangerine|clementine|navel/i,                                    '🍊'],
  [/grape/i,                                                                            '🍇'],
  [/strawberr/i,                                                                        '🍓'],
  [/blueberr/i,                                                                         '🫐'],
  [/raspberr|blackberr|boysenberr|loganberr/i,                                         '🍓'],
  [/gooseberr|elderberr/i,                                                              '🍓'],
  [/cherry|cherries/i,                                                                  '🍒'],
  [/peach\b|nectarine/i,                                                               '🍑'],
  [/apricot|plum\b|prune/i,                                                             '🍑'],
  [/mango/i,                                                                            '🥭'],
  [/watermelon/i,                                                                       '🍉'],
  [/rockmelon|honeydew|cantaloupe|melon\b/i,                                           '🍈'],
  [/kiwi.?fruit|kiwifruit/i,                                                            '🥝'],
  [/lemon/i,                                                                            '🍋'],
  [/lime\b/i,                                                                           '🍋'],
  [/pear\b/i,                                                                           '🍐'],
  [/coconut\b/i,                                                                        '🥥'],
  [/\braisins?\b|sultana|currant/i,                                                           '🍇'],
  [/fig\b/i,                                                                            '🟫'],
  [/date\b/i,                                                                           '🟫'],
  [/passion.?fruit/i,                                                                   '🍈'],
  [/feijoa/i,                                                                           '🍈'],
  [/tamarillo/i,                                                                        '🍅'],
  [/lychee|longan/i,                                                                    '🍈'],
  [/jackfruit|durian|papaya|guava|star.fruit|dragon.fruit|rambutan/i,                  '🍈'],
  [/acai|açaí/i,                                                                        '🫐'],
  [/goji.berr/i,                                                                        '🍓'],
  [/frozen.berr|mixed.berr|berry.mix/i,                                                '🍓'],
  [/dried.fruit|fruit.mix/i,                                                            '🍇'],
  [/\bfruit\b/i,                                                                       '🍎'],

  // ── Nuts & seeds ────────────────────────────────────────────
  [/peanut/i,                                                                           '🥜'],
  [/almond/i,                                                                           '🥜'],
  [/cashew/i,                                                                           '🥜'],
  [/walnut/i,                                                                           '🥜'],
  [/pecan/i,                                                                            '🥜'],
  [/pistachio/i,                                                                        '🥜'],
  [/hazelnut/i,                                                                         '🥜'],
  [/macadamia/i,                                                                        '🥜'],
  [/brazil.nut|pine.nut|mixed.nut/i,                                                   '🥜'],
  [/chestnut/i,                                                                         '🌰'],
  [/tahini/i,                                                                           '🥜'],
  [/chia.seed/i,                                                                        '🌱'],
  [/flax|linseed/i,                                                                     '🌱'],
  [/hemp.seed/i,                                                                        '🌱'],
  [/sesame.seed|sesame/i,                                                               '🌱'],
  [/sunflower.seed/i,                                                                   '🌻'],
  [/pumpkin.seed/i,                                                                     '🌱'],
  [/poppy.seed/i,                                                                       '🌱'],
  [/\bseed\b/i,                                                                        '🌱'],
  [/\bnut\b|\bnuts\b/i,                                                                '🥜'],

  // ── Oils & fats ─────────────────────────────────────────────
  // Back down here, deliberately, and NOT hoisted with the specific-food rules
  // above it.
  //
  // These words turn up as an incidental ingredient in thousands of AUSNUT/NZ
  // names — "pan-fried with canola oil", "deep-fried in peanut oil", "garlic
  // filling with vegetable oil" — so matching them early lets the cooking
  // medium name the dish. Measured over the 4,873 seeded food names: hoisting
  // this line changed 118 icons and the bulk of them were losses. A dozen fish
  // fillets became olives, as did every canola margarine and a fried tempeh.
  // The icon describes the food, so the food rules go first and this one
  // catches what is actually an oil.
  [/olive.oil|avocado.oil|sesame.oil|peanut.oil|canola|vegetable.oil|rice.bran|sunflower.oil|grapeseed|palm.oil/i, '🫒'],
  [/\boil\b/i,                                                                         '🫒'],
  [/lard|dripping|shortening|tallow/i,                                                  '🧈'],
  [/spray.oil|cooking.spray/i,                                                          '🫒'],

  // ── Bread & bakery ──────────────────────────────────────────
  [/croissant/i,                                                                        '🥐'],
  [/danish|pastry\b/i,                                                                  '🥐'],
  [/donut|doughnut/i,                                                                   '🍩'],
  [/cupcake/i,                                                                          '🧁'],
  [/cake\b|birthday.cake/i,                                                             '🎂'],
  [/muffin\b/i,                                                                         '🧁'],
  [/brownie|blondie/i,                                                                  '🍫'],
  [/scone/i,                                                                            '🥐'],
  [/biscuit|cookie/i,                                                                   '🍪'],
  [/cracker|rice.cracker/i,                                                             '🍘'],
  [/wafer|tim.tam/i,                                                                    '🍪'],
  [/pretzel/i,                                                                          '🥨'],
  [/bagel/i,                                                                            '🥯'],
  [/sourdough/i,                                                                        '🍞'],
  [/pita|pitta/i,                                                                       '🫓'],
  [/roti|naan|chapati|tortilla\b|flatbread/i,                                          '🫓'],
  [/bread\b|toast\b|roll\b|bun\b|focaccia|brioche|ciabatta|baguette|\bloaf\b/i,           '🍞'],

  // ── Grains & cereals ────────────────────────────────────────
  [/weet.?bix|weetbix/i,                                                                '🥣'],
  [/\boats?\b|oatmeal|porridge|rolled.oat/i,                                                       '🥣'],
  [/muesli|granola/i,                                                                   '🥣'],
  [/cornflake|bran.flake|corn.puff|rice.bubble|cocoa.puff/i,                           '🥣'],
  [/cereal\b/i,                                                                         '🥣'],
  [/risotto|paella|fried.rice/i,                                                        '🍚'],
  [/\brice\b/i,                                                                           '🍚'],
  [/pasta\b|spaghetti|penne|fettuccine|linguine|lasagne|macaroni|gnocchi|rigatoni|tagliatelle|orzo/i, '🍝'],
  [/noodle|ramen|udon|soba|glass.noodle|vermicelli|pad.thai|laksa/i,                   '🍜'],
  [/flour\b/i,                                                                          '🌾'],
  [/cornmeal|polenta|semolina|breadcrumb/i,                                             '🌾'],
  [/quinoa|couscous|bulgur|buckwheat|millet|barley|teff|spelt|amaranth/i,              '🌾'],
  [/crumpet|pikelet/i,                                                                  '🥞'],

  // ── Sweets, desserts & spreads ───────────────────────────────
  [/honey/i,                                                                            '🍯'],
  [/maple.syrup|golden.syrup|treacle|molasses|agave/i,                                 '🍯'],
  [/jam\b|jelly\b|marmalade|preserve\b/i,                                              '🍓'],
  [/chocolate\b|cocoa\b|cacao/i,                                                       '🍫'],
  [/dark.chocolate|milk.chocolate|white.chocolate|cacao.nib/i,                         '🍫'],
  [/lolly|lollies|candy|caramel|toffee|fudge|nougat|mints\b|boiled.sweet/i,           '🍬'],
  [/sugar\b/i,                                                                          '🍬'],
  [/icing\b|frosting/i,                                                                 '🎂'],
  [/marmite|vegemite/i,                                                                 '🫙'],
  [/nutella|choc.spread/i,                                                              '🍫'],
  [/jelly.bean|gummy|marshmallow|licorice|liquorice/i,                                 '🍬'],
  [/gelatin|jello/i,                                                                    '🍮'],
  [/custard/i,                                                                          '🍮'],
  [/mousse\b|panna.cotta|tiramisu/i,                                                   '🍮'],

  // ── Condiments & sauces ─────────────────────────────────────
  [/tomato.sauce|ketchup|passata/i,                                                     '🍅'],
  [/pasta.sauce|bolognese.sauce|marinara/i,                                             '🍝'],
  [/soy.sauce\b/i,                                                                      '🫙'],
  [/teriyaki/i,                                                                         '🍱'],
  [/hoisin|oyster.sauce|plum.sauce/i,                                                   '🫙'],
  [/fish.sauce/i,                                                                       '🐟'],
  [/worcestershire/i,                                                                    '🫙'],
  [/mayo|mayonnaise/i,                                                                   '🫙'],
  [/mustard/i,                                                                           '🌭'],
  [/relish|chutney/i,                                                                    '🫙'],
  [/pickle|pickled/i,                                                                    '🥒'],
  [/balsamic/i,                                                                          '🫙'],
  [/vinegar/i,                                                                           '🫙'],
  [/sriracha|hot.sauce|tabasco|chilli.sauce/i,                                          '🌶️'],
  [/sweet.chilli/i,                                                                     '🌶️'],
  [/bbq.sauce|barbecue.sauce/i,                                                         '🍖'],
  [/curry.paste|curry.powder/i,                                                         '🍛'],
  [/salsa\b/i,                                                                          '🍅'],
  [/guacamole/i,                                                                        '🥑'],
  [/tzatziki|raita|labneh/i,                                                            '🫙'],
  [/chimichurri|salsa.verde|gremolata/i,                                               '🌿'],
  [/aioli\b/i,                                                                          '🫙'],
  [/harissa|dukkah|za.?atar|romesco/i,                                                 '🫙'],
  [/gochujang|doenjang|sambal\b/i,                                                     '🌶️'],
  [/xo.sauce|black.bean.sauce/i,                                                       '🫙'],
  [/miso\b/i,                                                                           '🍜'],
  [/kimchi/i,                                                                            '🥬'],
  [/sauerkraut/i,                                                                        '🥬'],
  [/dressing\b|caesar|ranch|vinaigrette/i,                                              '🥗'],
  [/stock\b|broth\b/i,                                                                  '🍲'],
  [/gravy\b/i,                                                                          '🍖'],
  [/\bsauce\b/i,                                                                        '🫙'],

  // ── Herbs ───────────────────────────────────────────────────
  [/basil\b/i,                                                                           '🌿'],
  [/mint\b|peppermint/i,                                                                '🌿'],
  [/parsley|coriander|cilantro|dill\b|chive|tarragon|chervil/i,                        '🌿'],
  [/oregano|thyme\b|rosemary|sage\b|bay.leaf|marjoram/i,                               '🌿'],
  [/\bherb\b/i,                                                                         '🌿'],

  // ── Spices ──────────────────────────────────────────────────
  [/cinnamon/i,                                                                          '🫙'],
  [/cumin|turmeric|paprika|cardamom|clove\b|nutmeg|allspice|star.anise|sumac|saffron|fenugreek/i, '🫙'],
  [/chilli.flake|chilli.powder|cayenne/i,                                               '🌶️'],
  [/black.pepper|white.pepper|peppercorn/i,                                             '🧂'],
  [/\bspice\b|\bspices\b/i,                                                             '🫙'],
  [/salt\b|sea.salt|rock.salt|himalayan/i,                                              '🧂'],
  [/yeast\b|baking.powder|baking.soda|bicarb/i,                                        '🌾'],
  [/vanilla/i,                                                                           '🫙'],

  // ── Soups & hot dishes ───────────────────────────────────────
  [/pho\b|laksa\b|tom.yum|miso.soup/i,                                                 '🍜'],
  [/ramen\b/i,                                                                          '🍜'],
  [/soup\b|chowder|bisque|minestrone|gazpacho|bouillabaisse/i,                         '🍲'],
  [/stew\b|casserole|hotpot|tagine/i,                                                   '🍲'],
  [/broth\b/i,                                                                           '🍲'],

  // ── Prepared meals & takeaway ────────────────────────────────
  [/burger|hamburger|cheeseburger/i,                                                     '🍔'],
  [/pizza\b/i,                                                                           '🍕'],
  [/hot.dog|frankfurter\b/i,                                                            '🌭'],
  [/sushi|sashimi|maki\b|nigiri\b|hand.roll/i,                                         '🍣'],
  [/dumpling|gyoza|wonton|dim.sum|bao\b|xiao.long.bao/i,                               '🥟'],
  [/spring.roll|rice.paper.roll|san.choy/i,                                             '🌯'],
  [/sandwich\b|sub\b|panini|toastie/i,                                                  '🥪'],
  [/wrap\b/i,                                                                            '🌯'],
  [/kebab|shawarma|doner/i,                                                              '🌯'],
  [/falafel/i,                                                                           '🧆'],
  [/taco\b/i,                                                                            '🌮'],
  [/burrito|quesadilla|enchilada|nachos/i,                                              '🌮'],
  [/curry\b|korma|tikka|masala|vindaloo|rendang|butter.chicken/i,                       '🍛'],
  [/stir.fry|stir-fry|pad.thai/i,                                                       '🥘'],
  [/fried.rice/i,                                                                        '🍚'],
  [/chips\b|french.fries\b|wedges/i,                                                    '🍟'],
  [/roast\b|sunday.roast/i,                                                              '🍖'],
  [/schnitzel|crumbed/i,                                                                 '🍽'],
  [/pie\b|quiche/i,                                                                      '🥧'],
  [/fritter|hash.brown|rosti/i,                                                          '🥔'],
  [/omelette|frittata/i,                                                                 '🍳'],
  [/scrambled|fried.egg|poached.egg|boiled.egg|eggs.benedict/i,                         '🍳'],
  [/salad\b/i,                                                                           '🥗'],
  [/spaghetti.bol|bolognese\b/i,                                                        '🍝'],
  [/lasagne\b|lasagna/i,                                                                 '🍝'],
  [/fried.chicken|kfc\b/i,                                                               '🍗'],
  [/takeaway|takeout|fast.food/i,                                                        '🥡'],
  [/mixed.dish|\bmeal\b/i,                                                                 '🍽'],

  // ── Snacks & packaged foods ──────────────────────────────────
  [/popcorn/i,                                                                           '🍿'],
  [/rice.cake/i,                                                                         '🍘'],
  [/chip\b|crisp\b|corn.chip|potato.chip|nacho\b/i,                                    '🍿'],
  [/pretzel\b/i,                                                                         '🥨'],
  [/protein.bar|quest.bar|rx.bar/i,                                                     '💪'],
  [/muesli.bar|cereal.bar|fruit.bar|snack.bar/i,                                       '🥣'],
  [/trail.mix|fruit.and.nut/i,                                                          '🥜'],
  [/rice.bubble|puffed.rice/i,                                                          '🍘'],
  [/crispbread|cracker\b|rice.cracker/i,                                                '🍘'],

  // ── Drinks ──────────────────────────────────────────────────
  [/espresso|long.black/i,                                                               '☕'],
  [/flat.white|latte|cappuccino|macchiato|mocha|café/i,                                '☕'],
  [/coffee\b/i,                                                                          '☕'],
  [/green.tea|matcha/i,                                                                  '🍵'],
  [/chai\b|herbal.tea|chamomile|peppermint.tea/i,                                       '🍵'],
  [/tea\b/i,                                                                             '🍵'],
  [/orange.juice|apple.juice|grape.juice/i,                                              '🧃'],
  [/smoothie|juice\b|nectar\b/i,                                                        '🧃'],
  [/milkshake|milk.drink\b/i,                                                           '🥛'],
  [/protein.shake|protein.drink/i,                                                      '💪'],
  [/milo\b|horlicks|ovaltine/i,                                                         '☕'],
  [/energy.drink|sports.drink|powerade|gatorade/i,                                      '🥤'],
  [/soft.drink|soda\b|cola\b|lemonade\b|ginger.beer|tonic.water/i,                    '🥤'],
  [/cordial\b|squash\b/i,                                                               '🥤'],
  [/coconut.water/i,                                                                     '🥥'],
  [/sparkling.water|mineral.water/i,                                                     '💧'],
  [/water\b/i,                                                                           '💧'],

  // ── Breakfast items ──────────────────────────────────────────
  [/muesli\b|granola\b/i,                                                                '🥣'],
  [/crumpet\b|pikelet\b/i,                                                               '🥞'],
  [/hash.brown/i,                                                                        '🥔'],
  [/baked.bean/i,                                                                        '🫘'],
  [/vegemite|marmite/i,                                                                  '🫙'],

  // ── NZ-specific foods ────────────────────────────────────────
  [/hangi\b/i,                                                                            '🍖'],
  [/rewena/i,                                                                             '🍞'],

  // ── Biltong & jerky ──────────────────────────────────────────
  [/pork.crackling|pork.rind|crackling/i,                                                '🥓'],

  // ── Bubble tea & specialty drinks ────────────────────────────
  [/cold.brew|nitro.coffee|iced.coffee/i,                                                '☕'],
  [/hot.chocolate|drinking.chocolate|cacao.drink/i,                                      '☕'],
  [/protein.coffee|proffee/i,                                                             '☕'],

  // ── Specific sauces not yet covered ──────────────────────────
  [/peri.peri|nandos/i,                                                                   '🌶️'],

  // ── Wraps & rolls ─────────────────────────────────────────────
  [/poke.bowl\b/i,                                                                        '🥗'],

  // ── Fermented & specialty ─────────────────────────────────────
  [/tempeh/i,                                                                             '🧊'],

  // ── Misc ─────────────────────────────────────────────────────
  [/nutritional.yeast/i,                                                                  '🌱'],
  [/topping|sprinkle|garnish/i,                                                           '✨'],
  [/glaze|marinade|brine/i,                                                               '🫙'],
  [/stuffing|filling/i,                                                                   '🍗'],
  [/breadcrumb/i,                                                                         '🌾'],
  [/batter\b|coating\b/i,                                                                '🌾'],
];

export function getFoodIcon(name) {
  if (!name) return '🍽';
  for (const [pattern, icon] of RULES) {
    if (pattern.test(name)) return icon;
  }
  return '🍽';
}
