#!/usr/bin/env node
// S95 Flavor Intelligence: map inventory items to canonical flavor ingredients.
//
// Input (read-only snapshots and curated data, all in data/flavor/):
//   inventory-snapshot.json  id, name, category, subcategory, unit, active (no costs, no quantities)
//   recipes-snapshot.json    recipe ids/names/types and recipe_ingredients item links (report only)
//   ingredients.json         canonical ingredients + aliases
//   preparations.json        preparation slugs
// Output:
//   data/flavor/item-links.json    one entry per inventory item: confirmed | needs_review | unmapped | excluded
//   docs/flavor/Mapping_Report.md  counts and tables for manager review
//
// Deterministic: ordered rules (category + name tokens), then an alias-token
// fallback that can only ever produce needs_review. 'confirmed' comes only from
// an explicit, unambiguous rule. Inventory rows are never modified; product
// facts (brand, size, ABV, stock, cost) stay in inventory and are not copied.
//
// Usage: node scripts/build_flavor_item_links.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { aliasKey, stableJson } from "./build_flavor_common.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data/flavor");
const read = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));

// ------------------------------------------------------------------ rules
// [categoryRegex | null, nameRegex | null, outcome]
// Regexes run on aliasKey(category) / aliasKey(name) (lower case, no accents, þ->th, ð->d).
// outcome: { slug, prep?, status: 'confirmed'|'needs_review', confidence, note?, candidates? }
//          or { exclude: reason } or { unmapped: reason, candidates? }
const C = (slug, confidence = 0.9, extra = {}) => ({ slug, status: "confirmed", confidence, ...extra });
const R = (slug, note, candidates = [slug], confidence = 0.6, extra = {}) =>
  ({ slug, status: "needs_review", confidence, note, candidates, ...extra });
const U = (reason, candidates = []) => ({ unmapped: reason, candidates });
const X = (reason) => ({ exclude: reason });

export const RULES = [
  // Non-ingredients -------------------------------------------------------
  [/^(consumables|bar equipment)$/, null, X("non-ingredient: consumable or equipment")],
  [null, /\b(recipe reference|recipe choice)\b/, X("reference row with no flavour of its own (ice, water, tea choice)")],

  // Spirits ---------------------------------------------------------------
  [/^aquavit/, /rugbraud/, R("brennivin", "flavoured edition (rye bread); base style is Brennivín", ["brennivin", "rye-bread"])],
  [/^aquavit/, /brennivin/, C("brennivin", 0.95)],
  [/^gin$/, /\bpink\b/, C("pink-gin", 0.9)],
  [/^gin$/, /blood orange/, R("gin", "flavoured gin (blood orange)", ["gin", "blood-orange"])],
  [/^gin$/, /blackcurrant/, R("gin", "flavoured gin (blackcurrant)", ["gin", "blackcurrant"])],
  [/^gin$/, /flor de sevilla/, R("gin", "flavoured gin (Seville orange)", ["gin", "orange"])],
  [/^gin$/, /barrel aged/, R("gin", "barrel-aged gin: oak and vanilla beyond a dry gin", ["gin", "old-tom-gin"])],
  [/^gin$/, null, C("gin", 0.9)],
  [/^vodka$/, null, C("vodka", 0.95)],
  [/^rum$/, /spiced/, C("spiced-rum", 0.9)],
  [/^rum$/, /malibu/, C("coconut-rum", 0.9)],
  [/^rum$/, /\b(blanc|blanca|white|silver)\b/, C("white-rum", 0.9)],
  [/^rum$/, /\b(noir|dark|black)\b/, C("dark-rum", 0.85)],
  [/^rum$/, /\b(diez|oro|zacapa|reserva|eminente|anejo|gold|centenario)\b/, C("aged-rum", 0.85)],
  [/^rum$/, null, R("white-rum", "rum style not stated in the name", ["white-rum", "aged-rum"])],
  [/^tequila/, /\b(mezcal|maguey|vida)\b/, C("mezcal", 0.9)],
  [/^tequila/, /reposado/, C("reposado-tequila", 0.9)],
  [/^tequila/, /anejo/, C("anejo-tequila", 0.9)],
  [/^tequila/, /\b(blanco|silver|plata)\b/, C("blanco-tequila", 0.9)],
  [/^tequila/, null, R("blanco-tequila", "tequila age not stated", ["blanco-tequila", "reposado-tequila"])],
  [/^whiskey$/, /\b(ardbeg|lagavulin)\b/, C("islay-scotch", 0.9)],
  [/^whiskey$/, /talisker/, R("islay-scotch", "peated island malt (Skye), close to but not Islay", ["islay-scotch", "scotch-blended"], 0.7)],
  [/^whiskey$/, /\b(chivas|johnnie walker|blended)\b/, C("scotch-blended", 0.85)],
  [/^whiskey$/, /\bhoney\b/, R("tennessee-whiskey", "honey-flavoured whiskey liqueur", ["tennessee-whiskey", "honey-liqueur"])],
  [/^whiskey$/, /jack daniel/, C("tennessee-whiskey", 0.9)],
  [/^whiskey$/, /\brye\b/, C("rye-whiskey", 0.9)],
  [/^whiskey$/, /\b(bourbon|woodford reserve|wild turkey|four roses|bulleit)\b/, C("bourbon", 0.9)],
  [/^whiskey$/, /\b(jameson)\b/, C("irish-whiskey", 0.9)],
  [/^whiskey$/, /\b(hibiki|japanese)\b/, C("japanese-whisky", 0.85)],
  [/^whiskey$/, /icelandic/, R("scotch-blended", "Icelandic single malt; closest style needs a tasting", ["scotch-blended", "japanese-whisky"], 0.5)],
  [/^whiskey cognac$/, null, R("cognac", "brandy of unstated origin and style", ["cognac"], 0.5)],
  [/^cognac/, null, C("cognac", 0.95)],

  // Liqueurs --------------------------------------------------------------
  [/^liqueur$/, /amaretto/, C("amaretto", 0.95)],
  [/^liqueur$/, /amaro di angostura/, C("amaro-medium", 0.8)],
  [/^liqueur$/, /fernet/, C("fernet-amaro", 0.95)],
  [/^liqueur$/, /bailey/, C("irish-cream-liqueur", 0.95)],
  [/^liqueur$/, /shanky/, R("irish-cream-liqueur", "whiskey cream liqueur (Irish whiskey with cream flavour)", ["irish-cream-liqueur"], 0.6)],
  [/^liqueur$/, /tiramisu/, R("irish-cream-liqueur", "tiramisu-flavoured cream liqueur (coffee, cocoa, mascarpone)", ["irish-cream-liqueur", "coffee-liqueur", "mascarpone"], 0.5)],
  [/^liqueur$/, /non alco/, R("limoncello", "alcohol-free lemon liqueur alternative", ["limoncello", "lemon"], 0.6)],
  [/^liqueur$/, /limoncello/, C("limoncello", 0.95)],
  [/^liqueur$/, /banana/, C("banana-liqueur", 0.9)],
  [/^liqueur$/, /\bcacao\b/, C("creme-de-cacao", 0.9)],
  [/^liqueur$/, /cointreau cassis/, R("creme-de-cassis", "orange liqueur with blackcurrant", ["creme-de-cassis", "orange-liqueur"], 0.6)],
  [/^liqueur$/, /cassis/, C("creme-de-cassis", 0.95)],
  [/^liqueur$/, /myrtille/, C("blueberry-liqueur", 0.9)],
  [/^liqueur$/, /curacao/, C("orange-liqueur", 0.85, { note: "blue curaçao: orange liqueur coloured blue" })],
  [/^liqueur$/, /\b(fraise|strawberry)\b/, C("strawberry-liqueur", 0.9)],
  [/^liqueur$/, /\bmango\b/, C("mango-liqueur", 0.9)],
  [/^liqueur$/, /\bmiel\b/, C("honey-liqueur", 0.9)],
  [/^liqueur$/, /\b(pasteque|watermelon)\b/, C("watermelon-liqueur", 0.9)],
  [/^liqueur$/, /pomme verte/, C("green-apple-liqueur", 0.9)],
  [/^liqueur$/, /\b(peche|peach)\b/, C("peach-liqueur", 0.9)],
  [/^liqueur$/, /\b(sureau|elderflower)\b/, C("elderflower-liqueur", 0.95)],
  [/^liqueur$/, /violette/, C("creme-de-violette", 0.9)],
  [/^liqueur$/, /chambord/, C("raspberry-liqueur", 0.9)],
  [/^liqueur$/, /\b(cointreau|grand marnier|triple sec)\b/, C("orange-liqueur", 0.9)],
  [/^liqueur$/, /benedictine/, C("honeyed-herbal-liqueur", 0.9)],
  [/^liqueur$/, /frangelico/, C("hazelnut-liqueur", 0.95)],
  [/^liqueur$/, /\b(italicus|bergamot|bergamotto)\b/, C("bergamot-liqueur", 0.9)],
  [/^liqueur$/, /passion/, C("passion-fruit-liqueur", 0.9)],
  [/^liqueur$/, /jagermeister/, R("amaro-medium", "German herbal liqueur; sweeter than most amari", ["amaro-medium", "fernet-amaro"], 0.5)],
  [/^liqueur$/, /kahlua/, C("coffee-liqueur", 0.95)],
  [/^liqueur$/, /licor 43/, U("vanilla-citrus Spanish liqueur; no canonical ingredient yet", ["vanilla", "orange-liqueur"])],
  [/^liqueur$/, /\bopal\b/, R("salty-liquorice", "Icelandic liquorice/menthol shot liqueur; flavour varies by colour", ["salty-liquorice", "anise-liqueur"], 0.5)],
  [/^liqueur$/, /sambuca/, C("anise-liqueur", 0.9)],

  // Vermouth / aperitivo / wine / beer --------------------------------------
  [/^vermouth/, /antica formula/, C("sweet-vermouth", 0.9)],
  [/^vermouth/, /\b1757\b/, R("sweet-vermouth", "vermouth style not in the name (rosso assumed)", ["sweet-vermouth", "dry-vermouth", "blanc-vermouth"], 0.6)],
  [/^vermouth/, /dolin/, R("dry-vermouth", "Dolin makes dry, blanc and rouge; style not in the name", ["dry-vermouth", "blanc-vermouth", "sweet-vermouth"], 0.5)],
  [/^vermouth/, /aperol/, C("orange-aperitivo", 0.95)],
  [/^vermouth/, /campari/, C("red-bitter-aperitivo", 0.95)],
  [/^vermouth/, /sarti/, R("orange-aperitivo", "fruit-forward spritz aperitivo", ["orange-aperitivo", "red-bitter-aperitivo"], 0.6)],
  [/^sparkling$/, /(non alco|alcohol free)/, R("sparkling-wine", "alcohol-free sparkling alternative", ["sparkling-wine"], 0.6)],
  [/^sparkling$/, null, C("sparkling-wine", 0.9)],
  [/^red wine$/, null, C("red-wine", 0.85)],
  [/^white wine$/, /riesling/, R("dry-white-wine", "Riesling may be off-dry", ["dry-white-wine"], 0.7)],
  [/^white wine$/, null, C("dry-white-wine", 0.85)],
  [/^rose$/, null, C("rose-wine", 0.85)],
  [/^beer cider$/, /guinness/, C("stout", 0.95)],
  [/^beer cider$/, /\bipa\b/, C("ipa", 0.9)],
  [/^beer cider$/, /somersby pear/, R("dry-cider", "alcohol-free pear cider", ["dry-cider", "pear"], 0.5)],
  [/^beer cider$/, /\b(somersby|kopparberg)\b/, R("dry-cider", "sweet fruit-style cider, not dry", ["dry-cider"], 0.6)],
  [/^beer cider$/, /(0 0|alcohol free|\bbrio\b)/, R("lager", "alcohol-free beer", ["lager"], 0.6)],
  [/^beer cider$/, /boli x/, R("lager", "beer style not in the name", ["lager"], 0.5)],
  [/^beer cider$/, /\b(boli|gull|tuborg)\b.*keg/, C("lager", 0.85)],
  [/^beer cider$/, /\bbara\b.*maracuja/, U("flavoured ready-to-drink; not a single ingredient", ["passion-fruit", "lime"])],
  [/^beer cider$/, /\bbara\b.*strawberry/, U("flavoured ready-to-drink; not a single ingredient", ["strawberry", "lime"])],
  [/^beer cider$/, /passion fruit mango breezer/, U("flavoured ready-to-drink; not a single ingredient", ["passion-fruit", "mango"])],
  [/^beer cider$/, /strawberry breezer/, U("flavoured ready-to-drink; not a single ingredient", ["strawberry"])],
  [/^bitters$/, /angostura/, C("aromatic-bitters", 0.95)],

  // Coffee, tea, milk -------------------------------------------------------
  [/^coffee/, /decaf/, R("espresso", "decaffeinated coffee", ["espresso"], 0.7, { prep: "espresso" })],
  [/^coffee/, /(espresso|\bl or\b)/, C("espresso", 0.9, { prep: "espresso" })],
  [/^coffee/, /(g mjolk)/, C("whole-milk", 0.85, { note: "UHT milk" })],
  [/^coffee/, /haframjolk/, C("oat-milk", 0.95)],
  [/^coffee/, /jurtarjomi/, R("heavy-cream", "plant-based whipping cream", ["heavy-cream", "coconut-cream"], 0.6)],
  [/^coffee/, /earl grey/, C("earl-grey-tea", 0.95, { prep: "brewed" })],
  [/^coffee/, /(english|breakfast)/, C("black-tea", 0.9, { prep: "brewed" })],
  [/^coffee/, /green tea with lemon/, R("green-tea", "flavoured green tea (lemon)", ["green-tea", "lemon"], 0.7, { prep: "brewed" })],
  [/^coffee/, /green tea/, C("green-tea", 0.9, { prep: "brewed" })],
  [/^coffee/, /peppermint/, C("mint", 0.8, { prep: "brewed", note: "peppermint tea" })],
  [/^coffee/, /(camomile|chamomile)/, C("chamomile", 0.9, { prep: "brewed" })],
  [/^coffee/, /ginger tea/, R("fresh-ginger", "ginger tea blend", ["fresh-ginger"], 0.6, { prep: "brewed" })],
  [/^coffee/, /matcha/, C("matcha", 0.95)],
  [/^coffee/, /hot chocolate base/, R("cocoa", "house prep base (cocoa with milk and sugar)", ["cocoa", "whole-milk"], 0.6)],
  [/^coffee/, /\b(kako|cacao|cocoa)\b/, C("cocoa", 0.9)],
  [/^milk$/, /\boat\b/, C("oat-milk", 0.95)],
  [/^milk$/, /milk/, C("whole-milk", 0.85)],

  // Desserts, fruit, herbs, garnish ----------------------------------------
  [/^dessert$/, /(cookie|smakak)/, C("chocolate-chip-cookie", 0.85)],
  [/^dessert$/, /(eplapae|apple)/, C("apple-cake", 0.9)],
  [/^dessert$/, /pecan/, C("pecan-pie", 0.95)],
  [/^fresh fruit$/, /grapefruit/, C("grapefruit", 0.95)],
  [/^fresh fruit$/, /(lemon|sitron)/, C("lemon", 0.95)],
  [/^fresh fruit$/, /\blime\b/, C("lime", 0.95)],
  [/^fresh fruit$/, /price observation/, R("orange", "price-observation row, not a stocked product", ["orange"], 0.5)],
  [/^fresh fruit$/, /orange/, C("orange", 0.95)],
  [/^fresh fruit$/, /passion/, C("passion-fruit", 0.95)],
  [/^food fruit$/, /(perur|pear)/, C("pear", 0.8, { note: "canned pears" })],
  [/^fresh herbs$/, /basil/, C("basil", 0.95)],
  [/^fresh herbs$/, /(mynta|mint)/, C("mint", 0.95)],
  [/^garnish$/, /(ananas|pineapple)/, C("pineapple", 0.9, { prep: "dehydrated" })],
  [/^garnish$/, /dehydrated apple/, C("apple", 0.9, { prep: "dehydrated" })],
  [/^garnish$/, /dehydrated pear/, C("pear", 0.9, { prep: "dehydrated" })],
  [/^garnish$/, /dehydrated lime/, C("lime", 0.9, { prep: "dehydrated" })],
  [/^garnish$/, /dehydrated chili/, C("chili", 0.85, { prep: "dehydrated" })],
  [/^garnish$/, /chili powder/, C("chili", 0.8, { prep: "powder" })],
  [/^garnish$/, /kirsuber/, R("cherry", "preserved cocktail cherry in syrup", ["cherry", "maraschino-liqueur"], 0.6, { prep: "caramelised" })],
  [/^garnish$/, /^cherries$/, C("cherry", 0.8)],

  // Bar ingredients, preps ---------------------------------------------------
  [/^bar ingredients$/, /aquafaba/, C("aquafaba", 0.95)],
  [/^bar ingredients$/, /chupa chups infused/, R("blanco-tequila", "house infusion of tequila with lollipops", ["blanco-tequila"], 0.6, { prep: "infusion" })],
  [/^bar ingredients$/, /^chupa chups$/, U("candy used for a house infusion; no canonical ingredient", [])],
  [/^bar ingredients$/, /popcorn infused/, C("bourbon", 0.8, { prep: "infusion", note: "house popcorn infusion of bourbon" })],
  [/^bar ingredients$/, /^popcorn$/, U("infusion ingredient without a canonical ingredient yet", [])],
  [/^bar ingredients$/, /demerara/, C("demerara-sugar", 0.9)],
  [/^bar ingredients$/, /pudursykur/, R("demerara-sugar", "Icelandic brown sugar; closer to light muscovado", ["demerara-sugar", "muscovado-sugar"], 0.6)],
  [/^bar ingredients$/, /\b(sykur|white sugar)\b/, C("sugar", 0.9)],
  [/^bar ingredients$/, /orange juice/, C("orange", 0.9, { prep: "juice" })],
  [/^bar ingredients$/, /lemon juice/, C("lemon", 0.95, { prep: "juice" })],
  [/^bar ingredients$/, /lime juice/, C("lime", 0.95, { prep: "juice" })],
  [/^bar ingredients$/, /hunang/, C("honey", 0.95)],
  [/^bar ingredients$/, /(jardarberja|strawberry)/, C("strawberry", 0.9, { prep: "puree" })],
  [/^bar ingredients$/, /kristalssalt/, C("sea-salt", 0.9)],
  [/^bar ingredients$/, /saline/, C("sea-salt", 0.9, { prep: "saline-solution" })],
  [/^bar ingredients$/, /kokosrjomi/, C("coconut-cream", 0.95)],
  [/^bar ingredients$/, /mango/, C("mango", 0.9, { prep: "puree" })],
  [/^bar ingredients$/, /passion/, C("passion-fruit", 0.9, { prep: "puree" })],
  [/^bar ingredients$/, /peach/, C("peach", 0.9, { prep: "puree" })],
  [/^bar ingredients$/, /\b(peru|pear)\b/, C("pear", 0.9, { prep: "puree" })],
  [/^bar ingredients$/, /ananas/, C("pineapple", 0.9, { prep: "puree" })],
  [/^prep fruit$/, /pear/, C("pear", 0.85, { prep: "puree" })],
  [/^other$/, /pineapple/, C("pineapple", 0.85, { prep: "dehydrated" })],
  [/^other$/, /\begg\b/, R("egg-white", "whole eggs: white for foam, yolk for flips", ["egg-white", "egg-yolk"], 0.6)],

  // Soda and mixers ----------------------------------------------------------
  [/^soda mixer$/, /\b7up\b/, C("lemon-lime-soda", 0.9)],
  [/^soda mixer$/, /appelsinusafi|orange juice/, C("orange", 0.85, { prep: "juice" })],
  [/^soda mixer$/, /appelsin an sykurs/, C("orange-soda", 0.85, { note: "sugar-free" })],
  [/^soda mixer$/, /\bappelsin\b/, C("orange-soda", 0.9)],
  [/^soda mixer$/, /pineapple juice/, C("pineapple", 0.9, { prep: "juice" })],
  [/^soda mixer$/, /(\bapple juice|eplasafi)/, C("apple", 0.85, { prep: "juice" })],
  [/^soda mixer$/, /ginger ale/, C("ginger-ale", 0.95)],
  [/^soda mixer$/, /ginger beer/, C("ginger-beer", 0.95)],
  [/^soda mixer$/, /tonic/, C("tonic-water", 0.95)],
  [/^soda mixer$/, /(collab|homie)/, U("energy/functional drink; not a flavour ingredient", [])],
  [/^soda mixer$/, /(coca cola|pepsi)/, C("cola", 0.9)],
  [/^soda mixer$/, /(cranberry|tronuberjasafi)/, C("cranberry", 0.85, { prep: "juice" })],
  [/^soda mixer$/, /grapefruit/, C("grapefruit-soda", 0.9)],
  [/^soda mixer$/, /kristall mexican lime/, R("soda-water", "lime-flavoured sparkling water", ["soda-water", "lime"], 0.7)],
  [/^soda mixer$/, /kristall/, C("soda-water", 0.9)],

  // Syrups -------------------------------------------------------------------
  [/^syrups$/, /basil/, C("basil", 0.9, { prep: "syrup" })],
  [/^syrups$/, /(ananas|pineapple)/, C("pineapple", 0.9, { prep: "syrup" })],
  [/^syrups$/, /banana/, C("banana", 0.9, { prep: "syrup" })],
  [/^syrups$/, /caramel/, C("caramel", 0.85)],
  [/^syrups$/, /mango/, C("mango", 0.9, { prep: "syrup" })],
  [/^syrups$/, /(orgeat|mondlu)/, C("orgeat", 0.95)],
  [/^syrups$/, /(noix de coco|coconut)/, C("coconut", 0.85, { prep: "syrup" })],
  [/^syrups$/, /peach/, C("peach", 0.9, { prep: "syrup" })],
  [/^syrups$/, /pistachio/, C("pistachio", 0.9, { prep: "syrup" })],
  [/^syrups$/, /strawberry/, C("strawberry", 0.9, { prep: "syrup" })],
  [/^syrups$/, /vanill/, C("vanilla", 0.9, { prep: "syrup" })],
  [/^syrups$/, /agave/, C("agave-syrup", 0.95)],
  [/^syrups$/, /(noisette|hazelnut)/, C("hazelnut", 0.9, { prep: "syrup" })],
  [/^syrups$/, /pear/, C("pear", 0.9, { prep: "syrup" })],
  [/^syrups$/, /rhubarb/, C("rhubarb", 0.85, { prep: "syrup" })],
  [/^syrups$/, /simple syrup/, C("simple-syrup", 0.95)],
  [/^syrups$/, /cinnamon/, C("cinnamon", 0.9, { prep: "syrup" })],
  [/^syrups$/, /passion/, C("passion-fruit", 0.9, { prep: "syrup" })],
  [/^syrups$/, /grenadine/, C("grenadine", 0.95)],
  [/^syrups$/, /pomme verte/, C("apple", 0.85, { prep: "syrup", note: "green apple syrup" })],
  [/^syrups$/, /yuzu/, C("yuzu", 0.9, { prep: "syrup" })],
];

// ------------------------------------------------------------------ build
export function buildItemLinks({ inventory, recipes, ingredients, preparations }) {
  const slugs = new Set(ingredients.map((i) => i.slug));
  const prepSlugs = new Set(preparations.map((p) => p.slug));
  for (const [, , out] of RULES) {
    for (const s of [out.slug, ...(out.candidates ?? [])].filter(Boolean)) {
      if (!slugs.has(s)) throw new Error(`rule references unknown ingredient ${s}`);
    }
    if (out.prep && !prepSlugs.has(out.prep)) throw new Error(`rule references unknown preparation ${out.prep}`);
  }
  // alias index for the fallback: alias_key -> slugs
  const aliasIndex = new Map();
  for (const ing of ingredients) {
    for (const a of ing.aliases ?? []) {
      const key = aliasKey(a.alias);
      if (key.length < 3) continue;
      if (!aliasIndex.has(key)) aliasIndex.set(key, new Set());
      aliasIndex.get(key).add(ing.slug);
    }
  }
  const usage = new Map();
  const recipeById = new Map(recipes.recipes.map((r) => [r.id, r]));
  for (const line of recipes.lines) {
    if (!line.item_id || !recipeById.has(line.recipe_id)) continue;
    if (!usage.has(line.item_id)) usage.set(line.item_id, new Set());
    usage.get(line.item_id).add(line.recipe_id);
  }

  const entries = [];
  for (const item of inventory.items) {
    const cat = aliasKey(item.category);
    const name = aliasKey(item.name);
    const base = {
      inventory_item_id: item.id, item_name: item.name, category: item.category,
      subcategory: item.subcategory ?? null, active: item.active,
      recipe_count: usage.get(item.id)?.size ?? 0,
    };
    let entry = null;
    for (const [catRe, nameRe, out] of RULES) {
      if (catRe && !catRe.test(cat)) continue;
      if (nameRe && !nameRe.test(name)) continue;
      const method = `rule:${catRe ? "category" : ""}${catRe && nameRe ? "+" : ""}${nameRe ? "name" : ""}`;
      if (out.exclude) entry = { ...base, status: "excluded", reason: out.exclude, match_method: method };
      else if (out.unmapped) entry = { ...base, status: "unmapped", reason: out.unmapped, candidates: out.candidates, match_method: method };
      else entry = {
        ...base, status: out.status, slug: out.slug, preparation: out.prep ?? null,
        confidence: out.confidence, match_method: method, note: out.note ?? null,
        candidates: out.status === "needs_review" ? out.candidates : [],
      };
      break;
    }
    if (!entry) {
      // Fallback: alias tokens found in the name. Never confirmed.
      const found = new Map();
      for (const [key, set] of aliasIndex) {
        if (new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(name)) {
          for (const s of set) found.set(s, Math.max(found.get(s) ?? 0, key.length));
        }
      }
      const candidates = [...found].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s).slice(0, 4);
      entry = candidates.length
        ? { ...base, status: "needs_review", slug: candidates[0], preparation: null, confidence: 0.4,
            match_method: "alias_token", note: "matched by alias words only; no category rule", candidates }
        : { ...base, status: "unmapped", reason: "no rule and no alias match", candidates: [], match_method: "none" };
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.item_name.localeCompare(b.item_name) || a.inventory_item_id.localeCompare(b.inventory_item_id));
  return entries;
}

function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|");
}

export function renderReport(entries, { ingredients, edges, snapshotNote, recipesCount }) {
  const count = (s) => entries.filter((e) => e.status === s).length;
  const nameOf = new Map(ingredients.map((i) => [i.slug, i.name]));
  const degree = new Map();
  for (const e of edges) for (const s of [e.a, e.b]) degree.set(s, (degree.get(s) ?? 0) + 1);
  const linkedSlugs = [...new Set(entries.filter((e) => e.slug).map((e) => e.slug))].sort();
  const lines = [];
  lines.push("# Flavor Intelligence: inventory mapping report");
  lines.push("");
  lines.push("Generated by `node scripts/build_flavor_item_links.mjs` from `data/flavor/inventory-snapshot.json` (" + snapshotNote + ").");
  lines.push("Inventory is read-only: this mapping only adds rows to `atlas_private.flavor_item_links`. No inventory row, name, stock, cost or supplier is changed or copied.");
  lines.push("");
  lines.push("- **confirmed**: an explicit, unambiguous rule (category + name). Used as the item's canonical ingredient.");
  lines.push("- **needs_review**: a plausible match that a manager must confirm (flavoured variants, unstated styles, alcohol-free alternatives, alias-only matches). Shown as a *possible match*; never counted as available stock for that ingredient.");
  lines.push("- **unmapped**: an ingredient with no canonical concept yet (no link row).");
  lines.push("- **excluded**: not an ingredient (consumables, equipment, gas) or a reference row with no flavour.");
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push("| Status | Items | Active |");
  lines.push("|---|---|---|");
  for (const s of ["confirmed", "needs_review", "unmapped", "excluded"]) {
    lines.push(`| ${s} | ${count(s)} | ${entries.filter((e) => e.status === s && e.active).length} |`);
  }
  lines.push(`| **total** | **${entries.length}** | **${entries.filter((e) => e.active).length}** |`);
  lines.push("");
  lines.push(`Canonical ingredients linked: ${linkedSlugs.length}. Recipes in snapshot: ${recipesCount}. "Recipes" below = number of recipes whose lines reference the item.`);
  lines.push("");
  const thin = linkedSlugs.filter((s) => (degree.get(s) ?? 0) < 4);
  lines.push(`Linked ingredients with fewer than 4 pairing edges: ${thin.length ? thin.join(", ") : "none"}.`);
  lines.push("");
  lines.push("## Confirmed");
  lines.push("");
  lines.push("| Item | Category | Ingredient | Preparation | Confidence | Recipes | Active | Note |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const e of entries.filter((x) => x.status === "confirmed")) {
    lines.push(`| ${mdEscape(e.item_name)} | ${mdEscape(e.category)} | ${e.slug} (${mdEscape(nameOf.get(e.slug))}) | ${e.preparation ?? ""} | ${e.confidence} | ${e.recipe_count} | ${e.active ? "yes" : "no"} | ${mdEscape(e.note ?? "")} |`);
  }
  lines.push("");
  lines.push("## Needs review");
  lines.push("");
  lines.push("The first candidate is stored as the `needs_review` link; the others are listed for the reviewer.");
  lines.push("");
  lines.push("| Item | Category | Proposed | Candidates | Reason | Method | Recipes | Active |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const e of entries.filter((x) => x.status === "needs_review")) {
    lines.push(`| ${mdEscape(e.item_name)} | ${mdEscape(e.category)} | ${e.slug}${e.preparation ? ` [${e.preparation}]` : ""} | ${e.candidates.join(", ")} | ${mdEscape(e.note)} | ${e.match_method} | ${e.recipe_count} | ${e.active ? "yes" : "no"} |`);
  }
  lines.push("");
  lines.push("## Unmapped");
  lines.push("");
  lines.push("| Item | Category | Reason | Possible concepts | Recipes | Active |");
  lines.push("|---|---|---|---|---|---|");
  for (const e of entries.filter((x) => x.status === "unmapped")) {
    lines.push(`| ${mdEscape(e.item_name)} | ${mdEscape(e.category)} | ${mdEscape(e.reason)} | ${(e.candidates ?? []).join(", ")} | ${e.recipe_count} | ${e.active ? "yes" : "no"} |`);
  }
  lines.push("");
  lines.push("## Excluded");
  lines.push("");
  lines.push("| Item | Category | Reason | Active |");
  lines.push("|---|---|---|---|");
  for (const e of entries.filter((x) => x.status === "excluded")) {
    lines.push(`| ${mdEscape(e.item_name)} | ${mdEscape(e.category)} | ${mdEscape(e.reason)} | ${e.active ? "yes" : "no"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildAll() {
  const inventory = read("inventory-snapshot.json");
  const recipes = read("recipes-snapshot.json");
  const { ingredients } = read("ingredients.json");
  const { preparations } = read("preparations.json");
  const { edges } = read("pairings.json");
  const entries = buildItemLinks({ inventory, recipes, ingredients, preparations });
  const counts = Object.fromEntries(["confirmed", "needs_review", "unmapped", "excluded"].map((s) => [s, entries.filter((e) => e.status === s).length]));
  const links = {
    version: 1,
    generated_by: "scripts/build_flavor_item_links.mjs",
    snapshot_exported_at: inventory.exported_at,
    note: "Only confirmed and needs_review entries become flavor_item_links rows (the seed guards each with where exists on public.inventory_items). item_name/category are here for review only and are not written to the database.",
    counts,
    entries,
  };
  const report = renderReport(entries, {
    ingredients, edges, recipesCount: recipes.recipes.length,
    snapshotNote: `exported ${inventory.exported_at}, ${inventory.items.length} items`,
  });
  return { linksJson: stableJson(links), report: report.endsWith("\n") ? report : report + "\n", counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { linksJson, report, counts } = buildAll();
  const linksPath = join(DATA, "item-links.json");
  const reportPath = join(ROOT, "docs/flavor/Mapping_Report.md");
  if (process.argv.includes("--check")) {
    const same = readFileSync(linksPath, "utf8") === linksJson && readFileSync(reportPath, "utf8") === report;
    if (!same) {
      console.error("item-links.json or Mapping_Report.md is out of date: run node scripts/build_flavor_item_links.mjs");
      process.exit(1);
    }
    console.log("item links up to date", JSON.stringify(counts));
  } else {
    writeFileSync(linksPath, linksJson);
    writeFileSync(reportPath, report);
    console.log("wrote item-links.json and Mapping_Report.md", JSON.stringify(counts));
  }
}
