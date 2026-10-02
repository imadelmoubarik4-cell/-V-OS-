// The VÁ BAR menu, copied from the printed menus supplied by the owner on 2 October 2026:
// "VÁ Cocktails Menu Redesign" (A3, English and Icelandic) and "VÁ Happy hour Menu Redesign"
// (A4, English and Icelandic). Prices in ISK. When the printed menu changes, update this file.

export type L = { en: string; is: string };
const same = (s: string): L => ({ en: s, is: s });

export type MenuItem = {
  name: L;
  desc?: L;
  /** Single price. */
  price?: number;
  /** Wine: price per 150 ml glass and per bottle (null = bottle only). */
  glass?: number | null;
  bottle?: number;
  favourite?: boolean;
  signature?: boolean;
};

export type MenuGroup = { title: L; note?: L; items: MenuItem[] };
export type MenuTab = { id: string; icon: string; label: L; groups: MenuGroup[]; wine?: boolean };

const item = (name: string | L, price: number, desc?: L, extra: Partial<MenuItem> = {}): MenuItem => ({
  name: typeof name === "string" ? same(name) : name,
  price,
  desc,
  ...extra,
});
const wine = (name: string, desc: L, glass: number | null, bottle: number, extra: Partial<MenuItem> = {}): MenuItem => ({
  name: same(name),
  desc,
  glass,
  bottle,
  ...extra,
});

const pornStar: L = {
  en: "Finlandia vodka, passion fruit liqueur, passion fruit purée, vanilla syrup, lime",
  is: "Finlandia vodka, ástaraldinlíkjör, ástaraldinmauk, vanillusíróp, lime",
};

export const menu: MenuTab[] = [
  {
    id: "cocktails",
    icon: "🍸",
    label: { en: "Cocktails", is: "Kokteilar" },
    groups: [
      {
        title: { en: "Signature", is: "Sérkokteilar" },
        items: [
          item("VÁ Espresso Martini", 3390, { en: "Dark rum, coffee liqueur, fresh espresso, vanilla syrup, saline", is: "Dökkt romm, kaffilíkjör, ferskt espressó, vanillusíróp, saltlausn" }, { signature: true }),
          item("Chupa Chups", 3690, { en: "Patrón tequila infused with Chupa Chups, peach liqueur, peach syrup, lime", is: "Patrón tekíla lagað með Chupa Chups, ferskjulíkjör, ferskjusíróp, lime" }, { signature: true }),
          item({ en: "Popcorn", is: "Popp" }, 3490, { en: "Popcorn-infused Woodford bourbon, salted caramel, Angostura", is: "Woodford bourbon lagað með poppi, saltkaramella, Angostura" }, { signature: true }),
          item("Tiki Me", 3390, { en: "Hennessy V.S, dark rum, passion fruit purée, pineapple purée, coconut syrup, lime, Angostura", is: "Hennessy V.S, dökkt romm, ástaraldinmauk, ananasmauk, kókossíróp, lime, Angostura" }, { signature: true }),
        ],
      },
      {
        title: { en: "Most popular", is: "Vinsælast" },
        items: [
          item("Espresso Martini", 3290, { en: "Finlandia, Kahlúa, fresh espresso, simple syrup", is: "Finlandia, Kahlúa, ferskt espressó, sykursíróp" }),
          item("Porn Star Martini", 3490, pornStar),
          item("Basil Gimlet", 3190, { en: "Bombay gin, fresh lime, basil syrup, fresh basil", is: "Bombay gin, ferskt lime, basilsíróp, fersk basilika" }),
          item("Whisky Sour", 3190, { en: "Woodford Reserve bourbon, lemon, simple syrup, aquafaba", is: "Woodford Reserve bourbon, sítróna, sykursíróp, aquafaba" }),
          item("Mojito", 3190, {
            en: "Bacardi white rum, lime, brown sugar, mint, soda water. Classic, spicy, passion fruit or spicy strawberry",
            is: "Bacardi hvítt romm, lime, púðursykur, minta, sódavatn. Klassískur, sterkur, ástaraldin eða sterk jarðarber",
          }),
          item("Margarita", 3190, { en: "Olmeca tequila, triple sec, fresh lime, Tajín & salt rim", is: "Olmeca tekíla, triple sec, ferskt lime, Tajín og saltbrún" }),
          item({ en: "Gin & Tonic", is: "Gin og tónik" }, 2590, { en: "Bombay gin, tonic, citrus", is: "Bombay gin, tónik, sítrus" }),
          item({ en: "Bartender's Choice", is: "Val barþjónsins" }, 3990, { en: "Tell us what you like — we'll make it", is: "Segðu okkur hvað þú vilt — við reddum því" }),
        ],
      },
      {
        title: { en: "Frozen", is: "Frosnir" },
        items: [
          item({ en: "Frozen Piña Colada", is: "Frosin Piña Colada" }, 3290, { en: "Takamaka white rum, Malibu, pineapple, coconut cream, coconut syrup", is: "Takamaka hvítt romm, Malibu, ananas, kókosrjómi, kókossíróp" }),
          item({ en: "Frozen Strawberry Daiquiri", is: "Frosinn jarðarberja-daiquiri" }, 3190, { en: "Bacardi white rum, peach liqueur, strawberry purée, lime", is: "Bacardi hvítt romm, ferskjulíkjör, jarðarberjamauk, lime" }),
          item({ en: "Frozen Pear Daiquiri", is: "Frosinn peru-daiquiri" }, 3290, { en: "Bacardi spiced rum, Malibu, pear purée, pear syrup, lime", is: "Bacardi kryddromm, Malibu, perumauk, perusíróp, lime" }),
          item({ en: "Frozen Porn Star Martini", is: "Frosinn Porn Star Martini" }, 3490, pornStar),
        ],
      },
      {
        title: { en: "Hot", is: "Heitir" },
        items: [
          item({ en: "Irish Coffee", is: "Írskt kaffi" }, 2990, { en: "Jameson whiskey, hot coffee, brown sugar, light cream", is: "Jameson viskí, heitt kaffi, púðursykur, léttrjómi" }),
          item("Hot Toddy", 2990, { en: "Woodford Reserve bourbon, honey, lemon, hot water", is: "Woodford Reserve bourbon, hunang, sítróna, heitt vatn" }),
          item({ en: "Spiked Hot Chocolate", is: "Heitt kakó með sjússi" }, 3090, { en: "Dark rum, Baileys, hot chocolate, cream", is: "Dökkt romm, Baileys, heitt kakó, rjómi" }),
        ],
      },
    ],
  },
  {
    id: "spritz",
    icon: "🫧",
    label: { en: "Spritz & zero proof", is: "Spritz & óáfengt" },
    groups: [
      {
        title: same("Spritz"),
        items: [
          item("Limoncello Spritz", 2990, { en: "Limoncello, prosecco, sparkling water", is: "Limoncello, prosecco, sódavatn" }),
          item("Aperol Spritz", 2990, { en: "Aperol, prosecco, sparkling water", is: "Aperol, prosecco, sódavatn" }, { favourite: true }),
          item("Sarti Spritz", 3090, { en: "Sarti Rosa, prosecco, sparkling water", is: "Sarti Rosa, prosecco, sódavatn" }),
          item("Hugo Spritz", 3090, { en: "St-Germain, prosecco, sparkling water", is: "St-Germain, prosecco, sódavatn" }),
        ],
      },
      {
        title: { en: "Zero proof", is: "Óáfengt" },
        items: [
          item("N/A Limoncello Spritz", 1590, { en: "Limoncello 0%, prosecco 0%, sparkling water", is: "Limoncello 0%, prosecco 0%, sódavatn" }),
          item("Apple Sour", 1690, { en: "Apple juice, fresh lemon juice, simple syrup, aquafaba", is: "Eplasafi, ferskur sítrónusafi, sykursíróp, aquafaba" }),
          item("Nojito", 1490, { en: "Lime, mint, sugar syrup, prosecco 0%", is: "Lime, minta, sykursíróp, prosecco 0%" }),
        ],
      },
      {
        title: { en: "Shots", is: "Skot" },
        note: { en: "Tray of six — 9,990 kr", is: "Bakki með sex skotum — 9.990 kr." },
        items: [
          item("Baby Guinness", 1990, same("Baileys, Kahlúa")),
          item("Green Tea Shot", 2090, { en: "Jameson, peach liqueur, lemon, simple syrup", is: "Jameson, ferskjulíkjör, sítróna, sykursíróp" }),
          item("Mexican Candy Shot", 2090, { en: "Olmeca tequila, watermelon liqueur, lime, chili", is: "Olmeca tekíla, vatnsmelónulíkjör, lime, chili" }),
          item("Orgasm", 2090, same("Baileys, Kahlúa, amaretto")),
        ],
      },
    ],
  },
  {
    id: "wine",
    icon: "🍷",
    label: { en: "Wine", is: "Vín" },
    wine: true,
    groups: [
      {
        title: { en: "Sparkling", is: "Freyðivín" },
        items: [
          wine("Veuve Clicquot", { en: "Brut Champagne", is: "Brut kampavín" }, null, 22190),
          wine("Piccini", same("Prosecco"), 1890, 8990),
          wine("Segura Viudas", same("Brut Cava"), 1990, 9990),
          wine("Moillard", same("Crémant, Chardonnay"), null, 12900),
        ],
      },
      {
        title: { en: "White", is: "Hvítvín" },
        items: [
          wine("Frontera", same("Chardonnay"), 1690, 7990),
          wine("Angelo", same("Pinot Grigio"), 1900, 8990, { favourite: true }),
          wine("Vionta", same("Albariño"), 2290, 11290),
          wine("Von Winning", same("Sauvignon Blanc"), 2890, 14990),
          wine("Schloss Johannisberg", same("Riesling Bronzelack"), null, 19990),
        ],
      },
      {
        title: { en: "Red", is: "Rauðvín" },
        items: [
          wine("Tommasi Amarone", same("Valpolicella DOCG, Veneto"), null, 19900),
          wine("Francois Martenot", same("Pinot Noir"), 1690, 7990),
          wine("Castillo de Molina", same("Cabernet Sauvignon"), 1990, 8990),
          wine("La Celia Reserva", same("Malbec"), 2290, 10990),
        ],
      },
      {
        title: { en: "Rosé", is: "Rósavín" },
        items: [
          wine("Stemmari Rosé", same("Nero d'Avola"), 1690, 7990),
          wine("La Boume Rosé", same("Pinot Noir"), 2290, 11290),
        ],
      },
    ],
  },
  {
    id: "beer",
    icon: "🍺",
    label: { en: "Beer", is: "Bjór" },
    groups: [
      {
        title: { en: "Draught · 400 ml", is: "Á krana · 400 ml" },
        items: [
          item("Gull Lite", 1490, { en: "4.4% · light lager · local favourite", is: "4,4% · ljós lager · vinsælt hér" }),
          item("Tuborg Classic", 1490, { en: "4.6% · pilsner", is: "4,6% · pilsner" }),
          item("Boli X", 1490, { en: "4.8% · pale lager", is: "4,8% · ljós lager" }),
          item("Boli", 1690, { en: "5.6% · lager", is: "5,6% · lager" }),
          item("Somersby", 1690, { en: "4.5% · apple cider", is: "4,5% · eplasíder" }),
        ],
      },
      {
        title: { en: "Bottles & cans", is: "Flöskur og dósir" },
        items: [
          item("Guinness", 1590, { en: "4.2% · 500 ml draught can · Irish stout", is: "4,2% · 500 ml kranadós · írskur stout" }),
          item("Úlfrún Nr.34", 1490, { en: "4.5% · 330 ml · seasonal IPA", is: "4,5% · 330 ml · árstíðabundinn IPA" }),
          item("Bara", 1490, { en: "4% · 330 ml · strawberry & lime, passion fruit", is: "4% · 330 ml · jarðarber og lime, ástaraldin" }),
        ],
      },
      {
        title: { en: "Alcohol free", is: "Óáfengt" },
        items: [
          item("Carlsberg 0.0%", 890, same("330 ml")),
          item("Bríó Nr.75", 990, { en: "0.5% · 330 ml", is: "0,5% · 330 ml" }),
          item("Somersby Pear 0.0%", 990, { en: "Pear cider", is: "Perusíder" }),
        ],
      },
    ],
  },
  {
    id: "coffee",
    icon: "☕",
    label: { en: "Coffee", is: "Kaffi" },
    groups: [
      {
        title: { en: "Espresso bar", is: "Espressóbar" },
        items: [
          item({ en: "Espresso", is: "Espressó" }, 690),
          item({ en: "Double Espresso", is: "Tvöfalt espressó" }, 790),
          item("Americano", 790),
        ],
      },
      {
        title: { en: "Milk coffee", is: "Mjólkurkaffi" },
        note: { en: "Regular, oat or almond milk", is: "Venjuleg, hafra- eða möndlumjólk" },
        items: [item("Cortado", 850), item("Cappuccino", 890), item("Flat White", 990), item("Latte", 990)],
      },
      {
        title: { en: "Specialty", is: "Sérkaffi" },
        note: { en: "Cream +150", is: "Rjómi +150" },
        items: [
          item({ en: "Mocha", is: "Mokka" }, 990),
          item({ en: "Caramel Latte", is: "Karamellulatte" }, 1090),
          item({ en: "Vanilla Latte", is: "Vanillulatte" }, 1090),
        ],
      },
      {
        title: { en: "Not coffee", is: "Ekki kaffi" },
        note: { en: "Cream or honey +150", is: "Rjómi eða hunang +150" },
        items: [
          item({ en: "Hot Chocolate", is: "Heitt kakó" }, 850),
          item({ en: "Oat Matcha Latte", is: "Hafra matcha latte" }, 850),
          item({ en: "Tea Selection", is: "Teúrval" }, 690),
        ],
      },
      {
        title: { en: "Iced", is: "Ískalt" },
        items: [item({ en: "Iced Americano", is: "Ís-americano" }, 750), item({ en: "Iced Latte", is: "Íslatte" }, 890)],
      },
    ],
  },
  {
    id: "treats",
    icon: "🥧",
    label: { en: "Treats & juices", is: "Sætindi & safar" },
    groups: [
      {
        title: { en: "Sweet treats", is: "Sætindi" },
        items: [
          item({ en: "Apple Pie", is: "Eplakaka" }, 1290, { en: "Classic apple pie with cinnamon, whipped cream", is: "Klassísk eplakaka með kanil og þeyttum rjóma" }),
          item({ en: "Pecan Pie", is: "Pekanbaka" }, 1390, { en: "Rich pecan pie, sweet caramel filling, whipped cream", is: "Pekanbaka með sætri karamellufyllingu og þeyttum rjóma" }),
        ],
      },
      {
        title: { en: "Fresh juices", is: "Ferskir safar" },
        items: [
          item({ en: "Orange Juice", is: "Appelsínusafi" }, 1090, { en: "Freshly squeezed", is: "Nýkreistur" }),
          item({ en: "Passion Fruit Lemonade", is: "Ástaraldinslímonaði" }, 1390, { en: "Pineapple juice, passion fruit purée, fresh lime", is: "Ananassafi, ástaraldinmauk, ferskt lime" }),
          item({ en: "Strawberry Lemonade", is: "Jarðarberjalímonaði" }, 1290, { en: "Strawberry purée, fresh lemon, simple syrup, sparkling water", is: "Jarðarberjamauk, fersk sítróna, sykursíróp, sódavatn" }),
          item({ en: "Lemonade", is: "Límonaði" }, 1190, { en: "Fresh lemon, simple syrup, sparkling water", is: "Fersk sítróna, sykursíróp, sódavatn" }),
        ],
      },
      {
        title: { en: "Smoothies", is: "Þeytingar" },
        items: [
          item({ en: "Strawberry & Pear", is: "Jarðarber og pera" }, 2090, { en: "600 ml · strawberry purée, pear purée, apple juice, fresh lime", is: "600 ml · jarðarberjamauk, perumauk, eplasafi, ferskt lime" }),
          item("Tropical Passion", 2090, { en: "600 ml · pineapple, passion fruit purée, coconut cream, fresh lime", is: "600 ml · ananas, ástaraldinmauk, kókosrjómi, ferskt lime" }),
        ],
      },
    ],
  },
];

/** Find a menu item by its English name (used by the shaker game for description and price). */
export function findMenuItem(enName: string): MenuItem | undefined {
  for (const tab of menu) for (const g of tab.groups) for (const i of g.items) if (i.name.en === enName) return i;
  return undefined;
}

/** The happy hour lineup, from the printed happy hour menu. */
export const happyHourMenu: { title: L; price: number; items: { name: L; desc?: L }[] }[] = [
  {
    title: { en: "Cocktails", is: "Kokteilar" },
    price: 1990,
    items: [
      { name: same("Paloma"), desc: { en: "Olmeca Blanco tequila, grapefruit soda, fresh lime", is: "Olmeca Blanco tekíla, greipsódi, ferskt lime" } },
      { name: same("Cuba Libre"), desc: { en: "Bacardi white rum, Coca-Cola, fresh lime", is: "Bacardi hvítt romm, Coca-Cola, ferskt lime" } },
      { name: same("Gin & Tonic"), desc: { en: "Bombay gin, FT tonic water, lime", is: "Bombay gin, FT tónik, lime" } },
      { name: same("Basil Gimlet"), desc: { en: "Bombay gin, fresh lime juice, basil syrup, fresh basil", is: "Bombay gin, ferskur limesafi, basilsíróp, fersk basilika" } },
      { name: same("Sarti Spritz"), desc: { en: "Sarti Rosa, prosecco, sparkling water", is: "Sarti Rosa, prosecco, sódavatn" } },
      { name: same("Tom Collins"), desc: { en: "Bombay gin, fresh lemon, simple syrup, soda water", is: "Bombay gin, fersk sítróna, sykursíróp, sódavatn" } },
      { name: same("Vodka Lemon"), desc: { en: "Finlandia vodka, lemon soda, fresh lemon", is: "Finlandia vodka, sítrónusódi, fersk sítróna" } },
      { name: same("Tequila Sunrise"), desc: { en: "Olmeca Blanco tequila, orange juice, grenadine", is: "Olmeca Blanco tekíla, appelsínusafi, grenadín" } },
    ],
  },
  {
    title: { en: "Wine", is: "Vín" },
    price: 1090,
    items: [
      { name: { en: "House red", is: "Húsrauðvín" }, desc: same("Francois Martenot Pinot Noir") },
      { name: { en: "House white", is: "Húshvítvín" }, desc: same("Frontera Chardonnay") },
      { name: { en: "House rosé", is: "Húsrósavín" }, desc: same("Stemmari Rosé, Nero d'Avola") },
      { name: { en: "House sparkling", is: "Húsfreyðivín" }, desc: same("Piccini 1882") },
    ],
  },
  {
    title: { en: "Draught beer", is: "Bjór á krana" },
    price: 990,
    items: ["Gull Lite", "Tuborg Classic", "Boli X", "Boli", "Somersby"].map((n) => ({ name: same(n) })),
  },
  {
    title: { en: "Bottles & cans", is: "Flöskur og dósir" },
    price: 990,
    items: [{ name: same("Bara") }, { name: same("Úlfrún Nr.34") }],
  },
  {
    title: { en: "Shots", is: "Skot" },
    price: 990,
    items: [
      { name: { en: "Olmeca tequila", is: "Olmeca tekíla" } },
      { name: same("Finlandia vodka") },
      { name: same("Brennivín") },
      { name: same("Ópal") },
    ],
  },
];
