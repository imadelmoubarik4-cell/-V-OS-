// Atlas Flavor Intelligence test fixture: a realistic snapshot in the exact
// shape of public.atlas_flavor_snapshot() (~30 canonical ingredients,
// preparations, curated culinary edges, aliases and inventory links) plus a
// small bar inventory whose projected stock covers every trust state:
//   verified current in stock      Tanqueray, Hennessy, Rhubarb syrup, ...
//   verified zero                  Limes, Martini Rosso
//   unknown (never counted)        Oat milk (raw quantity 12 — must NOT count),
//                                  Valrhona chocolate (raw quantity 3)
//   stale / expired count          Pineapple juice, Disaronno
//   owner-confirmed count          Kahlúa (current through the owner path)
//   needs_review link              "Tropical purée mix" → passion fruit
//   unmapped item                  Paper straws (no link)
// All values are fixture data for tests only.

import { createBackend, NOW } from './ai-tools-fixtures.js';

export { NOW };

const pad = (n) => String(n).padStart(12, '0');
const ingId = (n) => `f1000000-0000-4000-8000-${pad(n)}`;
const prepId = (n) => `f2000000-0000-4000-8000-${pad(n)}`;
const edgeId = (n) => `f3000000-0000-4000-8000-${pad(n)}`;
const itemId = (n) => `f4000000-0000-4000-8000-${pad(n)}`;
const recipeId = (n) => `f5000000-0000-4000-8000-${pad(n)}`;

// slug, name, family, subfamily, aroma, taste [sweet,sour,bitter,salty,umami,fat,alcohol,astringency], intensity, texture, abv, uses, allergens, dietary
const T = (sweet, sour, bitter, salty, umami, fat, alcohol, astringency) => ({ sweet, sour, bitter, salty, umami, fat, alcohol, astringency });
const RAW = [
  ['london-dry-gin', 'London dry gin', 'spirit', 'gin', { bitter_botanical: 0.5, green_herbal: 0.6, citrus: 0.6, spicy_warm: 0.3, floral: 0.2 }, T(0, 0, 1, 0, 0, 0, 4, 0), 4, 'thin', 43, ['cocktail']],
  ['cognac', 'Cognac', 'spirit', 'grape_brandy', { orchard_stone: 0.6, caramel_sweet: 0.6, woody: 0.6, floral: 0.4, spicy_warm: 0.3, nutty: 0.2 }, T(1, 0, 1, 0, 0, 0, 4, 1), 4, 'thin', 40, ['cocktail', 'dessert']],
  ['vodka', 'Vodka', 'spirit', 'vodka', { caramel_sweet: 0.1, dairy_creamy: 0.1 }, T(0, 0, 0, 0, 0, 0, 4, 0), 2, 'thin', 40, ['cocktail']],
  ['blanco-tequila', 'Blanco tequila', 'spirit', 'agave', { vegetal: 0.7, green_herbal: 0.5, spicy_warm: 0.3, citrus: 0.3, earthy: 0.3 }, T(1, 0, 1, 0, 0, 0, 4, 0), 4, 'thin', 40, ['cocktail']],
  ['rhubarb', 'Rhubarb', 'fruit', 'culinary_fruit', { green_herbal: 0.6, fruity_red: 0.4, vegetal: 0.4, citrus: 0.3 }, T(0, 5, 0, 0, 0, 0, 0, 2), 4, 'fibrous', 0, ['cocktail', 'mocktail', 'dessert', 'food']],
  ['lemon', 'Lemon', 'citrus', 'citrus', { citrus: 1, floral: 0.1, green_herbal: 0.1 }, T(0, 5, 1, 0, 0, 0, 0, 0), 5, 'juicy', 0, ['cocktail', 'mocktail', 'dessert', 'food']],
  ['lime', 'Lime', 'citrus', 'citrus', { citrus: 1, green_herbal: 0.3 }, T(0, 5, 1, 0, 0, 0, 0, 0), 5, 'juicy', 0, ['cocktail', 'mocktail', 'food']],
  ['honey', 'Honey', 'sweetener', 'honey', { floral: 0.6, caramel_sweet: 0.5 }, T(5, 0, 0, 0, 0, 0, 0, 0), 3, 'syrupy', 0, ['cocktail', 'mocktail', 'coffee', 'dessert', 'food'], [], ['vegetarian']],
  ['passion-fruit', 'Passion fruit', 'fruit', 'tropical', { tropical: 1, floral: 0.4, citrus: 0.4 }, T(3, 4, 0, 0, 0, 0, 0, 0), 5, 'juicy', 0, ['cocktail', 'mocktail', 'dessert']],
  ['pineapple', 'Pineapple', 'fruit', 'tropical', { tropical: 1, citrus: 0.3, caramel_sweet: 0.2 }, T(4, 3, 0, 0, 0, 0, 0, 0), 4, 'juicy', 0, ['cocktail', 'mocktail', 'dessert']],
  ['mango', 'Mango', 'fruit', 'tropical', { tropical: 1, floral: 0.3, green_herbal: 0.2 }, T(5, 1, 0, 0, 0, 0, 0, 0), 4, 'soft', 0, ['cocktail', 'mocktail', 'dessert']],
  ['vanilla', 'Vanilla', 'spice', 'pod', { caramel_sweet: 0.8, floral: 0.4, woody: 0.3 }, T(1, 0, 0, 0, 0, 0, 0, 0), 3, 'dry', 0, ['cocktail', 'mocktail', 'coffee', 'dessert']],
  ['coffee', 'Coffee', 'coffee', 'beans', { roasted: 1, nutty: 0.4, caramel_sweet: 0.3, earthy: 0.3 }, T(0, 1, 4, 0, 0, 0, 0, 1), 4, 'thin', 0, ['coffee', 'cocktail', 'dessert']],
  ['espresso', 'Espresso', 'coffee', 'espresso', { roasted: 1, caramel_sweet: 0.4, nutty: 0.4 }, T(0, 1, 4, 0, 0, 0, 0, 1), 5, 'thin', 0, ['coffee', 'cocktail', 'dessert']],
  ['oat-milk', 'Oat milk', 'dairy_alternative', 'plant_milk', { nutty: 0.4, dairy_creamy: 0.5, caramel_sweet: 0.2 }, T(2, 0, 0, 0, 0, 2, 0, 0), 2, 'creamy', 0, ['coffee', 'mocktail', 'dessert'], ['may:gluten'], ['vegan']],
  ['mint', 'Mint', 'herb', 'mint', { minty: 1, green_herbal: 0.5 }, T(0, 0, 0, 0, 0, 0, 0, 0), 4, 'leafy', 0, ['cocktail', 'mocktail', 'food', 'dessert']],
  ['basil', 'Basil', 'herb', 'leafy_herb', { green_herbal: 0.8, spicy_warm: 0.4, anise: 0.3, minty: 0.2 }, T(0, 0, 1, 0, 0, 0, 0, 0), 3, 'leafy', 0, ['cocktail', 'mocktail', 'food']],
  ['elderflower-liqueur', 'Elderflower liqueur', 'liqueur', 'floral_liqueur', { floral: 1, orchard_stone: 0.4, citrus: 0.3 }, T(5, 0, 0, 0, 0, 0, 2, 0), 3, 'medium', 20, ['cocktail']],
  ['amaretto', 'Amaretto', 'liqueur', 'nut_liqueur', { nutty: 1, orchard_stone: 0.5, caramel_sweet: 0.5 }, T(5, 0, 1, 0, 0, 0, 2, 0), 4, 'syrupy', 24, ['cocktail', 'coffee', 'dessert'], ['may:tree_nuts']],
  ['orange-liqueur', 'Orange liqueur', 'liqueur', 'citrus_liqueur', { citrus: 1, caramel_sweet: 0.3 }, T(4, 0, 1, 0, 0, 0, 3, 0), 4, 'medium', 40, ['cocktail', 'dessert']],
  ['coffee-liqueur', 'Coffee liqueur', 'liqueur', 'coffee_liqueur', { roasted: 1, caramel_sweet: 0.7 }, T(5, 0, 2, 0, 0, 0, 2, 0), 4, 'syrupy', 20, ['cocktail', 'coffee', 'dessert']],
  ['prosecco', 'Prosecco', 'wine_fortified', 'sparkling', { citrus: 0.5, orchard_stone: 0.5, fermented_funky: 0.4, floral: 0.2 }, T(1, 4, 0, 0, 0, 0, 2, 0), 3, 'light', 11, ['cocktail'], ['sulphites']],
  ['soda-water', 'Soda water', 'mixer', 'carbonated', {}, T(0, 0, 0, 0, 0, 0, 0, 0), 1, 'carbonated', 0, ['cocktail', 'mocktail']],
  ['tonic-water', 'Tonic water', 'mixer', 'carbonated', { bitter_botanical: 0.7, citrus: 0.4 }, T(3, 0, 3, 0, 0, 0, 0, 0), 3, 'carbonated', 0, ['cocktail', 'mocktail']],
  ['sugar-syrup', 'Sugar syrup', 'sweetener', 'syrup', { caramel_sweet: 0.1 }, T(5, 0, 0, 0, 0, 0, 0, 0), 2, 'syrupy', 0, ['cocktail', 'mocktail', 'coffee', 'dessert'], [], ['vegan']],
  ['aromatic-bitters', 'Aromatic bitters', 'bitters', 'aromatic', { spicy_warm: 1, bitter_botanical: 0.8, woody: 0.4, citrus: 0.3 }, T(0, 0, 5, 0, 0, 0, 5, 0), 5, 'dash', 45, ['cocktail']],
  ['sweet-vermouth', 'Sweet vermouth', 'wine_fortified', 'vermouth', { spicy_warm: 0.6, caramel_sweet: 0.6, bitter_botanical: 0.5, fruity_red: 0.4, woody: 0.3, citrus: 0.3 }, T(3, 1, 2, 0, 0, 0, 2, 1), 3, 'medium', 16, ['cocktail'], ['sulphites']],
  ['red-bitter-aperitivo', 'Red bitter aperitivo', 'liqueur', 'aperitivo', { bitter_botanical: 1, citrus: 0.7, fruity_red: 0.3, spicy_warm: 0.2 }, T(3, 0, 4, 0, 0, 0, 2, 0), 5, 'medium', 25, ['cocktail']],
  ['dark-chocolate', 'Dark chocolate', 'chocolate', 'dark', { roasted: 0.9, caramel_sweet: 0.5, nutty: 0.3, dairy_creamy: 0.2 }, T(3, 0, 3, 0, 0, 3, 0, 1), 4, 'melting', 0, ['dessert', 'coffee', 'cocktail'], ['may:milk'], ['vegetarian']],
  ['strawberry', 'Strawberry', 'fruit', 'berry', { fruity_red: 1, caramel_sweet: 0.2, green_herbal: 0.1 }, T(3, 2, 0, 0, 0, 0, 0, 0), 3, 'juicy', 0, ['cocktail', 'mocktail', 'dessert']],
];

export const INGREDIENT_IDS = Object.fromEntries(RAW.map((row, index) => [row[0], ingId(index + 1)]));

const INGREDIENTS = RAW.map(([slug, name, family, subfamily, aroma, taste, intensity, texture, abv, uses, allergens = [], dietary = []]) => ({
  id: INGREDIENT_IDS[slug], slug, name, family, subfamily, aroma, taste, intensity, texture, abv_typical: abv,
  allergens, dietary, uses, techniques: [], provider: 'atlas_curated', confidence: 0.7,
}));

const PREPS = [
  ['juice', 'Fresh juice', {}, 'juicy'],
  ['syrup', 'Syrup', { sweet: 4, sour: -1 }, 'syrupy'],
  ['cordial', 'Cordial', { sweet: 3 }, 'syrupy'],
  ['puree', 'Purée', {}, 'thick'],
  ['peel', 'Peel', {}, 'dry'],
];
export const PREPARATION_IDS = Object.fromEntries(PREPS.map((row, index) => [row[0], prepId(index + 1)]));
const PREPARATIONS = PREPS.map(([slug, name, taste_shift, texture]) => ({ id: PREPARATION_IDS[slug], slug, name, taste_shift, aroma_shift: {}, texture }));
const INGREDIENT_PREPARATIONS = [
  ['lemon', 'juice'], ['lemon', 'peel'], ['lime', 'juice'], ['rhubarb', 'syrup'], ['rhubarb', 'cordial'], ['vanilla', 'syrup'],
  ['passion-fruit', 'puree'], ['mango', 'puree'], ['pineapple', 'juice'], ['honey', 'syrup'], ['strawberry', 'syrup'],
].map(([slug, prep]) => ({ ingredient_id: INGREDIENT_IDS[slug], preparation_id: PREPARATION_IDS[prep] }));

// Curated culinary edges (provider atlas_curated). [a, b, relation, strength, explanation]
const E = [
  ['rhubarb', 'london-dry-gin', 'complement', 0.8, 'Gin botanicals lift rhubarb\'s green, tart fruit; a classic spring pairing.'],
  ['rhubarb', 'elderflower-liqueur', 'complement', 0.85, 'Floral elderflower softens rhubarb\'s sharp acidity.'],
  ['rhubarb', 'vanilla', 'complement', 0.8, 'Vanilla rounds rhubarb\'s tartness, as in rhubarb custard.'],
  ['rhubarb', 'honey', 'complement', 0.7, 'Honey balances rhubarb acidity with floral sweetness.'],
  ['rhubarb', 'prosecco', 'complement', 0.7, 'Dry sparkling wine carries rhubarb\'s red-fruit tartness.'],
  ['rhubarb', 'lemon', 'complement', 0.6, 'Lemon brightens rhubarb without adding sweetness.'],
  ['rhubarb', 'strawberry', 'complement', 0.85, 'Strawberry and rhubarb: sweet red fruit against tart stalk.'],
  ['rhubarb', 'mint', 'complement', 0.55, 'Mint freshens rhubarb in long drinks.'],
  ['rhubarb', 'soda-water', 'bridge', 0.6, 'Soda lengthens rhubarb syrup into a light highball.'],
  ['rhubarb', 'tonic-water', 'complement', 0.6, 'Tonic quinine meets rhubarb\'s tart edge.'],
  ['london-dry-gin', 'lemon', 'complement', 0.9, 'Citrus peel in the gin echoes fresh lemon; the base of sours and fizzes.'],
  ['london-dry-gin', 'lime', 'complement', 0.85, 'Juniper and lime: gimlets and rickeys.'],
  ['london-dry-gin', 'tonic-water', 'complement', 0.9, 'Quinine bitterness frames juniper.'],
  ['london-dry-gin', 'elderflower-liqueur', 'complement', 0.8, 'Floral elderflower suits juniper and citrus botanicals.'],
  ['london-dry-gin', 'basil', 'complement', 0.8, 'Green, peppery basil meets herbal gin (gin basil smash).'],
  ['london-dry-gin', 'sweet-vermouth', 'complement', 0.8, 'Spiced vermouth and gin: the martinez family.'],
  ['london-dry-gin', 'red-bitter-aperitivo', 'complement', 0.85, 'Bitter orange aperitivo and gin, as in the Negroni.'],
  ['london-dry-gin', 'honey', 'complement', 0.7, 'Honey and gin with lemon: the Bee\'s Knees.'],
  ['london-dry-gin', 'mint', 'complement', 0.6, 'Mint freshens gin in southsides.'],
  ['cognac', 'lemon', 'complement', 0.8, 'Lemon cuts cognac\'s richness (Sidecar).'],
  ['cognac', 'orange-liqueur', 'complement', 0.9, 'Orange liqueur and cognac: the Sidecar backbone.'],
  ['cognac', 'honey', 'complement', 0.8, 'Honey echoes cognac\'s caramel and dried fruit.'],
  ['cognac', 'vanilla', 'complement', 0.85, 'Oak-aged cognac already carries vanilla notes.'],
  ['cognac', 'coffee', 'complement', 0.75, 'Roasted coffee and aged brandy share caramel and nut notes.'],
  ['cognac', 'espresso', 'complement', 0.75, 'Espresso and cognac, as in café-cognac.'],
  ['cognac', 'dark-chocolate', 'complement', 0.8, 'Chocolate and cognac share roasted, dried-fruit depth.'],
  ['cognac', 'amaretto', 'complement', 0.8, 'Almond liqueur and cognac: the French Connection.'],
  ['cognac', 'aromatic-bitters', 'complement', 0.8, 'Aromatic bitters season cognac in old-fashioned styles.'],
  ['cognac', 'sweet-vermouth', 'complement', 0.7, 'Vermouth and cognac: the Metropolitan / Harvard family.'],
  ['cognac', 'sugar-syrup', 'complement', 0.6, 'A little sugar opens cognac in stirred drinks.'],
  ['cognac', 'prosecco', 'complement', 0.6, 'Sparkling wine lifts cognac (French 75 variation).'],
  ['cognac', 'soda-water', 'bridge', 0.55, 'Soda lengthens cognac into a light highball.'],
  ['passion-fruit', 'pineapple', 'complement', 0.85, 'Two tropical fruits with shared acidity.'],
  ['passion-fruit', 'mango', 'complement', 0.85, 'Mango\'s sweetness calms passion fruit\'s sharpness.'],
  ['passion-fruit', 'vanilla', 'complement', 0.85, 'Vanilla and passion fruit: the Pornstar Martini pairing.'],
  ['passion-fruit', 'prosecco', 'complement', 0.75, 'Sparkling wine alongside passion fruit.'],
  ['passion-fruit', 'lime', 'complement', 0.8, 'Lime sharpens tropical passion fruit.'],
  ['passion-fruit', 'vodka', 'complement', 0.8, 'Neutral vodka lets passion fruit lead.'],
  ['passion-fruit', 'mint', 'complement', 0.6, 'Mint freshens passion fruit.'],
  ['vanilla', 'coffee', 'complement', 0.8, 'Vanilla sweetens coffee\'s roast.'],
  ['vanilla', 'espresso', 'complement', 0.8, 'Vanilla and espresso: the vanilla latte.'],
  ['vanilla', 'dark-chocolate', 'complement', 0.85, 'Vanilla rounds chocolate.'],
  ['vanilla', 'oat-milk', 'complement', 0.7, 'Oat milk\'s cereal sweetness with vanilla.'],
  ['vanilla', 'vodka', 'complement', 0.7, 'Vanilla gives vodka a rounder body.'],
  ['coffee', 'oat-milk', 'complement', 0.85, 'Oat milk softens coffee bitterness.'],
  ['espresso', 'oat-milk', 'complement', 0.85, 'Oat milk steams and pours well with espresso.'],
  ['coffee', 'dark-chocolate', 'complement', 0.85, 'Coffee and chocolate share roasted notes (mocha).'],
  ['espresso', 'dark-chocolate', 'complement', 0.8, 'Espresso and chocolate: mocha.'],
  ['coffee', 'amaretto', 'complement', 0.8, 'Almond liqueur and coffee.'],
  ['espresso', 'amaretto', 'complement', 0.8, 'Amaretto with espresso.'],
  ['espresso', 'coffee-liqueur', 'complement', 0.9, 'Coffee liqueur doubles down on espresso (Espresso Martini).'],
  ['espresso', 'vodka', 'complement', 0.8, 'Vodka carries espresso cleanly (Espresso Martini).'],
  ['espresso', 'sugar-syrup', 'complement', 0.6, 'Sugar tames espresso bitterness.'],
  ['espresso', 'honey', 'complement', 0.6, 'Honey adds floral sweetness to espresso.'],
  ['dark-chocolate', 'amaretto', 'complement', 0.7, 'Almond and chocolate.'],
  ['dark-chocolate', 'mint', 'contrast', 0.7, 'Cooling mint against rich chocolate.'],
  ['dark-chocolate', 'oat-milk', 'complement', 0.7, 'Oat milk carries chocolate in hot drinks.'],
  ['mango', 'lime', 'complement', 0.8, 'Lime balances sweet mango.'],
  ['mango', 'vanilla', 'complement', 0.7, 'Vanilla with ripe mango.'],
  ['mango', 'prosecco', 'complement', 0.65, 'Mango and sparkling wine (Bellini variation).'],
  ['mango', 'soda-water', 'bridge', 0.55, 'Soda lengthens mango purée.'],
  ['pineapple', 'lime', 'complement', 0.75, 'Lime sharpens pineapple.'],
  ['pineapple', 'mint', 'complement', 0.6, 'Mint with pineapple.'],
  ['mint', 'lime', 'complement', 0.9, 'Mint and lime: the mojito pairing.'],
  ['mint', 'soda-water', 'bridge', 0.6, 'Soda carries mint in long drinks.'],
  ['basil', 'lemon', 'complement', 0.8, 'Basil and lemon.'],
  ['basil', 'strawberry', 'complement', 0.75, 'Basil and strawberry.'],
  ['elderflower-liqueur', 'prosecco', 'complement', 0.85, 'Elderflower and sparkling wine (Hugo spritz).'],
  ['elderflower-liqueur', 'lemon', 'complement', 0.8, 'Lemon balances elderflower\'s sweetness.'],
  ['elderflower-liqueur', 'soda-water', 'bridge', 0.7, 'Soda lengthens elderflower.'],
  ['elderflower-liqueur', 'mint', 'complement', 0.6, 'Mint with elderflower (Hugo).'],
  ['red-bitter-aperitivo', 'sweet-vermouth', 'complement', 0.9, 'Bitter aperitivo and vermouth (Americano, Negroni).'],
  ['red-bitter-aperitivo', 'prosecco', 'complement', 0.8, 'Bitter aperitivo spritz.'],
  ['red-bitter-aperitivo', 'soda-water', 'bridge', 0.8, 'Soda lengthens bitter aperitivo.'],
  ['sweet-vermouth', 'aromatic-bitters', 'complement', 0.8, 'Bitters season vermouth (Manhattan family).'],
  ['amaretto', 'lemon', 'complement', 0.8, 'Lemon cuts amaretto (Amaretto Sour).'],
  ['honey', 'lemon', 'complement', 0.85, 'Honey and lemon.'],
  ['honey', 'lime', 'complement', 0.6, 'Honey and lime.'],
  ['lemon', 'sugar-syrup', 'complement', 0.6, 'Sugar balances lemon in sours.'],
  ['lime', 'sugar-syrup', 'complement', 0.6, 'Sugar balances lime in sours.'],
  ['tonic-water', 'lime', 'complement', 0.7, 'Lime with tonic.'],
  ['tonic-water', 'lemon', 'complement', 0.6, 'Lemon with tonic.'],
  ['vodka', 'lime', 'complement', 0.7, 'Vodka and lime.'],
  ['vodka', 'coffee-liqueur', 'complement', 0.85, 'Vodka and coffee liqueur (Black Russian).'],
  ['blanco-tequila', 'lime', 'complement', 0.9, 'Tequila and lime (Margarita).'],
  ['blanco-tequila', 'orange-liqueur', 'complement', 0.85, 'Orange liqueur and tequila (Margarita).'],
  ['strawberry', 'vanilla', 'complement', 0.7, 'Strawberries and vanilla cream.'],
  ['strawberry', 'prosecco', 'complement', 0.75, 'Strawberry and sparkling wine.'],
  ['strawberry', 'dark-chocolate', 'complement', 0.75, 'Chocolate-dipped strawberries.'],
  // Substitutes
  ['passion-fruit', 'mango', 'substitute', 0.6, 'Mango purée replaces passion fruit\'s tropical body but is sweeter and less sharp.'],
  ['passion-fruit', 'pineapple', 'substitute', 0.55, 'Pineapple keeps the tropical acidity, with less perfume.'],
  ['lemon', 'lime', 'substitute', 0.8, 'Lime can replace lemon; slightly more bitter and aromatic.'],
  ['honey', 'sugar-syrup', 'substitute', 0.7, 'Sugar syrup replaces honey without the floral note.'],
  ['coffee', 'espresso', 'substitute', 0.9, 'Espresso and brewed coffee swap with a strength adjustment.'],
];
const EDGES = E.map(([a, b, relation, strength, explanation], index) => {
  const [first, second] = [INGREDIENT_IDS[a], INGREDIENT_IDS[b]].sort();
  return {
    id: edgeId(index + 1), a_id: first, a_prep: null, b_id: second, b_prep: null, relation, strength,
    aroma_score: null, taste_score: null, texture_score: null, evidence_type: 'culinary', provider: 'atlas_curated', confidence: 0.7, explanation,
  };
});

const ALIASES = [
  ['london-dry-gin', 'gin'], ['london-dry-gin', 'gin london dry'], ['cognac', 'koníak'], ['cognac', 'brandy'], ['rhubarb', 'rabarbari'],
  ['passion-fruit', 'passion fruit'], ['passion-fruit', 'passionfruit'], ['passion-fruit', 'ástríðuávöxtur'], ['lemon', 'sítróna'],
  ['lime', 'límóna'], ['oat-milk', 'haframjólk'], ['sugar-syrup', 'simple syrup'], ['aromatic-bitters', 'angostura'],
  ['red-bitter-aperitivo', 'campari'], ['sweet-vermouth', 'rosso vermouth'], ['orange-liqueur', 'triple sec'],
  ['elderflower-liqueur', 'st germain'], ['coffee-liqueur', 'kahlua'], ['dark-chocolate', 'chocolate'], ['soda-water', 'soda'],
  ['tonic-water', 'tonic'], ['prosecco', 'sparkling wine'], ['espresso', 'espresso shot'],
].map(([slug, alias]) => ({ ingredient_id: INGREDIENT_IDS[slug], alias, alias_key: alias.toLowerCase(), language: /[áíóúðþæö]/.test(alias) ? 'is' : 'en' }));

// ---------------------------------------------------------------------------
// Inventory (ai-tools-fixtures row shape) and projected-stock evidence.
// ---------------------------------------------------------------------------

export const ITEM_IDS = {
  tanqueray: itemId(1), hennessy: itemId(2), rhubarbSyrup: itemId(3), lemonJuice: itemId(4), limes: itemId(5), honey: itemId(6),
  tropicalMix: itemId(7), pineappleJuice: itemId(8), mangoPuree: itemId(9), vanillaSyrup: itemId(10), espressoBeans: itemId(11),
  oatMilk: itemId(12), mint: itemId(13), stGermain: itemId(14), disaronno: itemId(15), prosecco: itemId(16), soda: itemId(17),
  tonic: itemId(18), sugarSyrup: itemId(19), angostura: itemId(20), rosso: itemId(21), campari: itemId(22), chocolate: itemId(23),
  absolut: itemId(24), kahlua: itemId(25), cointreau: itemId(26), lemons: itemId(27), straws: itemId(28),
};

const CURRENT = (qty) => ({ verified_quantity: qty, verification_status: 'current', freshness_state: 'current', verified_at: '2026-09-22T10:00:00Z', expires_at: '2026-09-29T10:00:00Z' });
const EXPIRED = (qty) => ({ verified_quantity: qty, verification_status: 'expired', freshness_state: 'expired', verified_at: '2026-08-01T10:00:00Z', expires_at: '2026-08-08T10:00:00Z' });

// [key, name, category, unit, size_ml, cost_price, par_level, raw quantity, balance | null, extra]
const ITEMS = [
  ['tanqueray', 'Tanqueray Gin', 'Spirits', 'bottle', 700, 5200, 4, 9, CURRENT(4)],
  ['hennessy', 'Hennessy VS Cognac', 'Spirits', 'bottle', 700, 7800, null, 3, CURRENT(2)],
  ['rhubarbSyrup', 'Rhubarb Syrup (house)', 'Syrups', 'l', null, 900, 1, 2, CURRENT(1.5)],
  ['lemonJuice', 'Fresh Lemon Juice', 'Citrus', 'l', null, 1200, null, 2, CURRENT(1)],
  ['limes', 'Limes', 'Citrus', 'each', null, 45, 30, 60, CURRENT(0)],
  ['honey', 'Honey', 'Syrups', 'kg', null, 2400, null, 1, CURRENT(1)],
  ['tropicalMix', 'Tropical Purée Mix', 'Syrups', 'l', null, 1500, null, 2, CURRENT(2)],
  ['pineappleJuice', 'Pineapple Juice', 'Mixers', 'l', null, 450, null, 4, EXPIRED(3)],
  ['mangoPuree', 'Mango Purée', 'Syrups', 'l', null, 1300, null, 2, CURRENT(2)],
  ['vanillaSyrup', 'Monin Vanilla Syrup', 'Syrups', 'bottle', 700, 1900, null, 2, CURRENT(1)],
  ['espressoBeans', 'Espresso Beans', 'Food', 'kg', null, 4200, 2, 4, CURRENT(3)],
  ['oatMilk', 'Oatly Barista Oat Milk', 'Dairy', 'l', null, 380, null, 12, null],
  ['mint', 'Fresh Mint', 'Produce', 'bunch', null, 350, null, 6, CURRENT(5)],
  ['stGermain', 'St-Germain Elderflower Liqueur', 'Spirits', 'bottle', 700, 5900, null, 2, CURRENT(1)],
  ['disaronno', 'Disaronno Amaretto', 'Spirits', 'bottle', 700, 4300, null, 2, EXPIRED(2)],
  ['prosecco', 'Villa Sandi Prosecco', 'Wine', 'bottle', 750, 2500, 6, 20, CURRENT(9)],
  ['soda', 'Kristall Soda Water 330 ml', 'Mixers', 'can', 330, 110, 24, 40, CURRENT(24)],
  ['tonic', 'Fever-Tree Indian Tonic 200 ml', 'Mixers', 'bottle', 200, 180, 12, 60, CURRENT(30)],
  ['sugarSyrup', 'Sugar Syrup (house)', 'Syrups', 'l', null, 300, null, 2, CURRENT(2)],
  ['angostura', 'Angostura Bitters', 'Spirits', 'bottle', 200, 2900, null, 2, CURRENT(1)],
  ['rosso', 'Martini Rosso', 'Spirits', 'bottle', 1000, 2400, 2, 4, CURRENT(0)],
  ['campari', 'Campari', 'Spirits', 'bottle', 1000, 4100, 2, 9, CURRENT(2)],
  ['chocolate', 'Valrhona Dark Chocolate', 'Food', 'kg', null, 6500, null, 3, null],
  ['absolut', 'Absolut Vodka', 'Spirits', 'bottle', 700, 3900, 3, 14, CURRENT(3)],
  ['kahlua', 'Kahlúa', 'Spirits', 'bottle', 700, 3700, null, 5, null, { owner: { quantity: 2, at: '2026-09-21T10:00:00Z' } }],
  ['cointreau', 'Cointreau', 'Spirits', 'bottle', 700, 5600, null, 3, CURRENT(2)],
  ['lemons', 'Lemons', 'Citrus', 'each', null, 40, null, 50, CURRENT(20)],
  ['straws', 'Paper Straws', 'Consumables', 'each', null, 3, null, 500, CURRENT(400)],
];

export function flavorInventoryRows() {
  return ITEMS.map(([key, name, category, unit, sizeMl, cost, par, raw, , extra = {}]) => ({
    id: ITEM_IDS[key], name, category, unit, size_ml: sizeMl, cost_price: cost, par_level: par, quantity: raw, active: true,
    supplier: null, supplier_id: null, source_updated_at: '2026-09-01', updated_at: '2026-09-01T10:00:00Z',
    ...(extra.owner ? {
      source_confirmed_quantity: extra.owner.quantity, source_confirmed_at: extra.owner.at,
      owner_confirmed_quantity: extra.owner.quantity, owner_confirmed_at: extra.owner.at,
    } : {}),
  }));
}

export function flavorBalanceRows() {
  return ITEMS.filter((row) => row[8]).map(([key, , , , , , , , balance]) => ({ inventory_item_id: ITEM_IDS[key], ...balance }));
}

// Existing Atlas recipes (for atlas_learned co-occurrence, similarity and prices).
export const RECIPE_IDS = { beesKnees: recipeId(1), negroni: recipeId(2), espressoMartini: recipeId(3), sidecar: recipeId(4), gt: recipeId(5), oldDraft: recipeId(6) };
export function flavorRecipeRows() {
  const line = (n, recipe, item, name, quantity, unit) => ({ id: recipeId(100 + n), recipe_id: recipe, item_id: item, item_name: name, quantity, unit });
  return [
    { id: RECIPE_IDS.beesKnees, name: "Bee's Knees", type: 'Cocktail', yield_quantity: 1, menu_price: 2800, show_on_menu: true, active: true,
      recipe_ingredients: [line(1, RECIPE_IDS.beesKnees, ITEM_IDS.tanqueray, 'Tanqueray Gin', 50, 'ml'), line(2, RECIPE_IDS.beesKnees, ITEM_IDS.lemonJuice, 'Fresh Lemon Juice', 25, 'ml'), line(3, RECIPE_IDS.beesKnees, ITEM_IDS.honey, 'Honey', 20, 'g')] },
    { id: RECIPE_IDS.negroni, name: 'Negroni', type: 'Cocktail', yield_quantity: 1, menu_price: 2900, show_on_menu: true, active: true,
      recipe_ingredients: [line(4, RECIPE_IDS.negroni, ITEM_IDS.tanqueray, 'Tanqueray Gin', 30, 'ml'), line(5, RECIPE_IDS.negroni, ITEM_IDS.campari, 'Campari', 30, 'ml'), line(6, RECIPE_IDS.negroni, ITEM_IDS.rosso, 'Martini Rosso', 30, 'ml')] },
    { id: RECIPE_IDS.espressoMartini, name: 'Espresso Martini', type: 'Cocktail', yield_quantity: 1, menu_price: 3100, show_on_menu: true, active: true,
      recipe_ingredients: [line(7, RECIPE_IDS.espressoMartini, ITEM_IDS.absolut, 'Absolut Vodka', 40, 'ml'), line(8, RECIPE_IDS.espressoMartini, ITEM_IDS.kahlua, 'Kahlúa', 20, 'ml'), line(9, RECIPE_IDS.espressoMartini, ITEM_IDS.espressoBeans, 'Espresso Beans', 18, 'g'), line(10, RECIPE_IDS.espressoMartini, ITEM_IDS.sugarSyrup, 'Sugar Syrup (house)', 10, 'ml')] },
    { id: RECIPE_IDS.sidecar, name: 'Sidecar', type: 'Cocktail', yield_quantity: 1, menu_price: 3200, show_on_menu: true, active: true,
      recipe_ingredients: [line(11, RECIPE_IDS.sidecar, ITEM_IDS.hennessy, 'Hennessy VS Cognac', 50, 'ml'), line(12, RECIPE_IDS.sidecar, ITEM_IDS.cointreau, 'Cointreau', 25, 'ml'), line(13, RECIPE_IDS.sidecar, ITEM_IDS.lemonJuice, 'Fresh Lemon Juice', 20, 'ml')] },
    { id: RECIPE_IDS.gt, name: 'Gin & Tonic', type: 'Highball', yield_quantity: 1, menu_price: 2400, show_on_menu: true, active: true,
      recipe_ingredients: [line(14, RECIPE_IDS.gt, ITEM_IDS.tanqueray, 'Tanqueray Gin', 40, 'ml'), line(15, RECIPE_IDS.gt, ITEM_IDS.tonic, 'Fever-Tree Indian Tonic 200 ml', 1, 'bottle')] },
    { id: RECIPE_IDS.oldDraft, name: 'Rhubarb Fizz (old draft)', type: 'Cocktail', yield_quantity: 1, menu_price: null, show_on_menu: false, active: false,
      recipe_ingredients: [line(16, RECIPE_IDS.oldDraft, ITEM_IDS.rhubarbSyrup, 'Rhubarb Syrup (house)', 25, 'ml')] },
  ];
}

// Inventory → canonical links: [itemKey, ingredient slug, preparation slug|null, status, method, confidence]
export const DEFAULT_LINKS = [
  ['tanqueray', 'london-dry-gin', null, 'confirmed', 'rule:category+name', 0.95],
  ['hennessy', 'cognac', null, 'confirmed', 'rule:category+name', 0.95],
  ['rhubarbSyrup', 'rhubarb', 'syrup', 'confirmed', 'rule:name', 0.9],
  ['lemonJuice', 'lemon', 'juice', 'confirmed', 'rule:name', 0.95],
  ['limes', 'lime', null, 'confirmed', 'rule:name', 0.95],
  ['honey', 'honey', null, 'confirmed', 'rule:name', 0.95],
  ['tropicalMix', 'passion-fruit', 'puree', 'needs_review', 'rule:name_partial', 0.45],
  ['pineappleJuice', 'pineapple', 'juice', 'confirmed', 'rule:name', 0.9],
  ['mangoPuree', 'mango', 'puree', 'confirmed', 'rule:name', 0.9],
  ['vanillaSyrup', 'vanilla', 'syrup', 'confirmed', 'rule:name', 0.9],
  ['espressoBeans', 'espresso', null, 'confirmed', 'rule:name', 0.9],
  ['oatMilk', 'oat-milk', null, 'confirmed', 'rule:name', 0.95],
  ['mint', 'mint', null, 'confirmed', 'rule:name', 0.95],
  ['stGermain', 'elderflower-liqueur', null, 'confirmed', 'alias', 0.9],
  ['disaronno', 'amaretto', null, 'confirmed', 'alias', 0.9],
  ['prosecco', 'prosecco', null, 'confirmed', 'rule:name', 0.95],
  ['soda', 'soda-water', null, 'confirmed', 'rule:name', 0.95],
  ['tonic', 'tonic-water', null, 'confirmed', 'rule:name', 0.95],
  ['sugarSyrup', 'sugar-syrup', null, 'confirmed', 'rule:name', 0.95],
  ['angostura', 'aromatic-bitters', null, 'confirmed', 'alias', 0.95],
  ['rosso', 'sweet-vermouth', null, 'confirmed', 'alias', 0.9],
  ['campari', 'red-bitter-aperitivo', null, 'confirmed', 'alias', 0.95],
  ['chocolate', 'dark-chocolate', null, 'confirmed', 'rule:name', 0.9],
  ['absolut', 'vodka', null, 'confirmed', 'rule:category+name', 0.95],
  ['kahlua', 'coffee-liqueur', null, 'confirmed', 'alias', 0.95],
  ['cointreau', 'orange-liqueur', null, 'confirmed', 'alias', 0.9],
  ['lemons', 'lemon', null, 'confirmed', 'rule:name', 0.95],
  // Paper Straws: deliberately unmapped (not an ingredient).
];

// The snapshot exactly as atlas_flavor_snapshot() shapes it. `links` rows
// use real inventory item ids; `itemIds` maps link keys to ids.
export function flavorSnapshot({ links = DEFAULT_LINKS, itemIds = ITEM_IDS } = {}) {
  return {
    version: 'fixture-1',
    sources: [
      { id: 'atlas_curated', name: 'Atlas curated culinary pairings', license: 'Atlas-authored', verdict: 'use' },
      { id: 'flavornet', name: 'Flavornet', license: 'unclear', verdict: 'do_not_ingest' },
    ],
    ingredients: structuredClone(INGREDIENTS),
    aliases: structuredClone(ALIASES),
    preparations: structuredClone(PREPARATIONS),
    ingredient_preparations: structuredClone(INGREDIENT_PREPARATIONS),
    edges: structuredClone(EDGES),
    links: links.filter(([key]) => itemIds[key]).map(([key, slug, prep, status, method, confidence]) => ({
      inventory_item_id: itemIds[key], ingredient_id: INGREDIENT_IDS[slug], preparation_id: prep ? PREPARATION_IDS[prep] : null, status, match_method: method, confidence,
    })),
  };
}

// A saved-recipe store behind a fake atlas_save_recipe (manager JWT only,
// unique names like recipes_name_key).
export function recipeSaveRpc(data, writes, { nextId = () => recipeId(900 + data.recipes.length) } = {}) {
  return (args) => {
    const name = String(args?.p_recipe?.name ?? '').trim();
    if (data.recipes.some((recipe) => recipe.name.toLowerCase() === name.toLowerCase())) {
      return { __status: 409, code: '23505', message: 'duplicate key value violates unique constraint "recipes_name_key"' };
    }
    const id = nextId();
    writes.push({ name: 'atlas_save_recipe', args });
    data.recipes.push({ id, ...args.p_recipe, recipe_ingredients: (args.p_ingredients || []).map((line, index) => ({ id: `${id.slice(0, 24)}${String(index).padStart(12, '0')}`, recipe_id: id, ...line })) });
    return id;
  };
}

// createBackend with the flavour world: inventory, balances, recipes, the
// snapshot RPC (service role) and atlas_save_recipe (user JWT).
export function createFlavorBackend({ snapshot = flavorSnapshot(), inventory = flavorInventoryRows(), balances = flavorBalanceRows(), recipes = flavorRecipeRows(), snapshotError = null } = {}) {
  let backend;
  const serviceRpcs = {
    atlas_flavor_snapshot: () => snapshotError ?? snapshot,
  };
  const userRpcs = {
    atlas_save_recipe: (args) => recipeSaveRpc(backend.data, backend.writes)(args),
  };
  backend = createBackend({ inventory, balances, movements: [], recipes, serviceRpcs, userRpcs });
  return backend;
}
