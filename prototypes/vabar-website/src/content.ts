// All copy, links and venue facts for the page, in English and Icelandic.
// Sources: opening hours, address and menu link from the owner (2 October 2026); drinks from
// VÁ's own recipes in Atlas (data/flavor/recipes-snapshot.json, names and ingredients only, no
// prices); the description is the business profile of the current Wix site.
import type { HeroPalette, HeroSlide } from "@/components/ui/horizon-hero-section";

export type Lang = "en" | "is";

export type Mood = "fresh" | "sour" | "bitter" | "sweet" | "strong" | "coffee" | "frozen" | "warm" | "zero";

export type Drink = {
  id: string;
  name: string;
  moods: Mood[];
  notes: Record<Lang, string>;
  emoji: string;
  signature?: boolean;
};

/** Opening hours per weekday (0 = Sunday), "HH:MM" in Reykjavík time. "00:00" closes at midnight. */
export type Hours = Record<number, { open: string; close: string } | null>;

const weekday = { open: "11:30", close: "22:00" };
const weekend = { open: "11:30", close: "00:00" };

export const site = {
  name: "VÁ BAR",
  url: "https://www.xn--vbar-5na.is/",
  area: "Hafnartorg · Reykjavík",
  venue: "Hafnartorg Gallery Food Hall",
  street: "Geirsgata 17",
  postcode: "101",
  city: "Reykjavík",
  company: "Coffee & Cocktails ehf. · kt. 671124-0220 · Geirsgata 17, 101 Reykjavík",
  menuUrl: "https://app.alcedo.is/menu.html",
  staffUrl: "https://app.alcedo.is/",
  // A Maps search for the full address. Swap for the Google Business Profile link when you have it.
  mapsUrl:
    "https://www.google.com/maps/search/?api=1&query=" +
    encodeURIComponent("VÁ BAR, Hafnartorg Gallery, Geirsgata 17, 101 Reykjavík"),
  // Sunday to Thursday 11:30–22:00, Friday and Saturday 11:30–00:00.
  hours: { 0: weekday, 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekend, 6: weekend } as Hours | null,
};

/** Brand palette for the hero scene: a terracotta glow over navy mountains (MANUAL_DE_MARCA). */
export const heroPalette: HeroPalette = {
  nebula: [0x2d5668, 0xa15c3f],
  mountains: [0x0c2431, 0x143a4d, 0x1f4a5d, 0x2d5668],
  atmosphere: [0.36, 0.2, 0.13],
};

// Drinks for the "Shake" game: VÁ's own cocktails, spritzes and alcohol-free drinks.
export const drinks: Drink[] = [
  {
    id: "va-espresso-martini",
    name: "VÁ Espresso Martini",
    signature: true,
    moods: ["coffee", "strong", "sweet"],
    emoji: "☕",
    notes: {
      en: "Our house version: dark spiced rum, fresh espresso, coffee liqueur, vanilla and a pinch of salt.",
      is: "Okkar útgáfa: dökkt kryddromm, nýlagað espressó, kaffilíkjör, vanilla og ögn af salti.",
    },
  },
  {
    id: "popcorn",
    name: "Popcorn",
    signature: true,
    moods: ["strong", "sweet"],
    emoji: "🍿",
    notes: {
      en: "Popcorn-infused Woodford bourbon with salted caramel and bitters.",
      is: "Woodford bourbon með poppkornsbragði, saltkaramellu og bitter.",
    },
  },
  {
    id: "tiki-me",
    name: "Tiki Me",
    signature: true,
    moods: ["sweet", "strong", "fresh"],
    emoji: "🍍",
    notes: {
      en: "Spiced rum and cognac with passion fruit, pineapple, coconut and lime.",
      is: "Kryddromm og koníak með ástaraldin, ananas, kókos og límónu.",
    },
  },
  {
    id: "chupa-chups",
    name: "Chupa Chups",
    signature: true,
    moods: ["sweet", "sour"],
    emoji: "🍭",
    notes: {
      en: "Lollipop-infused Patrón tequila with peach and lime.",
      is: "Patrón tekíla með sleikjóbragði, ferskju og límónu.",
    },
  },
  {
    id: "basil-gimlet",
    name: "Basil Gimlet",
    moods: ["fresh", "sour"],
    emoji: "🌿",
    notes: { en: "Gin, lime and our own basil syrup.", is: "Gin, límóna og basilsíróp hússins." },
  },
  {
    id: "porn-star-martini",
    name: "Porn Star Martini",
    moods: ["sweet", "sour"],
    emoji: "💛",
    notes: { en: "Vodka, passion fruit, vanilla and lime.", is: "Vodka, ástaraldin, vanilla og límóna." },
  },
  {
    id: "negroni",
    name: "Negroni",
    moods: ["bitter", "strong"],
    emoji: "🍊",
    notes: { en: "Gin, Campari and Antica Formula vermouth.", is: "Gin, Campari og Antica Formula vermút." },
  },
  {
    id: "whisky-sour",
    name: "Whisky Sour",
    moods: ["sour", "strong"],
    emoji: "🍋",
    notes: {
      en: "Woodford Reserve, lemon, sugar and a silky aquafaba foam.",
      is: "Woodford Reserve, sítróna, sykur og silkimjúk aquafaba-froða.",
    },
  },
  {
    id: "margarita",
    name: "Margarita",
    moods: ["sour", "fresh"],
    emoji: "🧂",
    notes: { en: "Tequila, triple sec, lime and agave.", is: "Tekíla, triple sec, límóna og agave." },
  },
  {
    id: "old-fashioned",
    name: "Old Fashioned",
    moods: ["strong", "sweet"],
    emoji: "🥃",
    notes: { en: "Woodford Reserve, demerara sugar and Angostura bitters.", is: "Woodford Reserve, demerara-sykur og Angostura bitter." },
  },
  {
    id: "moscow-mule",
    name: "Moscow Mule",
    moods: ["fresh", "sour"],
    emoji: "🫚",
    notes: { en: "Vodka, ginger beer and lime.", is: "Vodka, engiferbjór og límóna." },
  },
  {
    id: "aperol-spritz",
    name: "Aperol Spritz",
    moods: ["fresh", "bitter"],
    emoji: "🫧",
    notes: { en: "Aperol, prosecco and soda.", is: "Aperol, prosecco og sódavatn." },
  },
  {
    id: "hugo-spritz",
    name: "Hugo Spritz",
    moods: ["fresh", "sweet"],
    emoji: "🌼",
    notes: { en: "St-Germain elderflower, prosecco and soda.", is: "St-Germain ylliblómalíkjör, prosecco og sódavatn." },
  },
  {
    id: "frozen-pina-colada",
    name: "Frozen Piña Colada",
    moods: ["frozen", "sweet"],
    emoji: "🥥",
    notes: { en: "Rum, coconut and pineapple, blended with ice.", is: "Romm, kókos og ananas, blandað með klaka." },
  },
  {
    id: "frozen-strawberry-daiquiri",
    name: "Frozen Strawberry Daiquiri",
    moods: ["frozen", "sweet", "sour"],
    emoji: "🍓",
    notes: { en: "Rum, strawberry and lime, blended with ice.", is: "Romm, jarðarber og límóna, blandað með klaka." },
  },
  {
    id: "irish-coffee",
    name: "Irish Coffee",
    moods: ["warm", "coffee", "strong"],
    emoji: "🔥",
    notes: { en: "Jameson, hot coffee, brown sugar and cream.", is: "Jameson, heitt kaffi, púðursykur og rjómi." },
  },
  {
    id: "hot-toddy",
    name: "Hot Toddy",
    moods: ["warm", "sweet"],
    emoji: "🍯",
    notes: { en: "Woodford Reserve, honey, lemon and hot water.", is: "Woodford Reserve, hunang, sítróna og heitt vatn." },
  },
  {
    id: "nojito",
    name: "Nojito",
    moods: ["zero", "fresh"],
    emoji: "🌱",
    notes: { en: "Alcohol-free: mint, lime and Bottega 0.0 Bianco.", is: "Áfengislaus: mynta, límóna og Bottega 0.0 Bianco." },
  },
  {
    id: "apple-sour",
    name: "Apple Sour",
    moods: ["zero", "sour"],
    emoji: "🍏",
    notes: { en: "Alcohol-free: apple, lemon and a silky aquafaba foam.", is: "Áfengislaus: epli, sítróna og silkimjúk aquafaba-froða." },
  },
  {
    id: "na-limoncello-spritz",
    name: "N/A Limoncello Spritz",
    moods: ["zero", "fresh", "sweet"],
    emoji: "🍋",
    notes: { en: "Alcohol-free limoncino and bubbles.", is: "Áfengislaust limoncino og búbblur." },
  },
];

export const moodLabels: Record<Mood, Record<Lang, string>> = {
  fresh: { en: "Fresh", is: "Ferskt" },
  sour: { en: "Sour", is: "Súrt" },
  bitter: { en: "Bitter", is: "Beiskt" },
  sweet: { en: "Sweet", is: "Sætt" },
  strong: { en: "Strong", is: "Sterkt" },
  coffee: { en: "Coffee", is: "Kaffi" },
  frozen: { en: "Frozen", is: "Frosið" },
  warm: { en: "Warm", is: "Heitt" },
  zero: { en: "Alcohol-free", is: "Áfengislaust" },
};

/** Menu highlights by tab: real item names from VÁ's recipes. Prices live on the full menu. */
export type MenuTab = { id: string; label: Record<Lang, string>; lead: Record<Lang, string>; items: { name: string; tag?: Record<Lang, string> }[] };

const sig = { en: "Signature", is: "Einkenni" };
const frozen = { en: "Frozen", is: "Frosinn" };
const hot = { en: "Hot", is: "Heitur" };
const zero = { en: "0.0%", is: "0,0%" };
const sweetTag = { en: "Sweet", is: "Sætt" };
const draught = { en: "Draught", is: "Á krana" };
const house = { en: "House", is: "Hússins" };

export const menuTabs: MenuTab[] = [
  {
    id: "coffee",
    label: { en: "Coffee", is: "Kaffi" },
    lead: { en: "From 11:30 every day.", is: "Frá 11:30 alla daga." },
    items: [
      { name: "Espresso" }, { name: "Double Espresso" }, { name: "Americano" }, { name: "Iced Americano" },
      { name: "Cortado" }, { name: "Cappuccino" }, { name: "Flat White" }, { name: "Latte" }, { name: "Iced Latte" },
      { name: "Vanilla Latte" }, { name: "Caramel Latte" }, { name: "Mocha" }, { name: "Oat Matcha Latte" },
      { name: "Hot Chocolate" }, { name: "Tea Selection" },
      { name: "Apple Pie", tag: sweetTag }, { name: "Pecan Pie", tag: sweetTag }, { name: "Chocolate cookies", tag: sweetTag },
    ],
  },
  {
    id: "cocktails",
    label: { en: "Cocktails", is: "Kokteilar" },
    lead: { en: "Our signatures, the classics, frozen and hot.", is: "Okkar einkennisdrykkir, klassíkin, frosnir og heitir." },
    items: [
      { name: "VÁ Espresso Martini", tag: sig }, { name: "Popcorn", tag: sig }, { name: "Tiki Me", tag: sig },
      { name: "Chupa Chups", tag: sig }, { name: "Bartender's Choice", tag: sig },
      { name: "Basil Gimlet" }, { name: "Espresso Martini" }, { name: "Porn Star Martini" }, { name: "Margarita" },
      { name: "Paloma" }, { name: "Mojito" }, { name: "Whisky Sour" }, { name: "Negroni" }, { name: "Old Fashioned" },
      { name: "Manhattan" }, { name: "Moscow Mule" }, { name: "Tom Collins" }, { name: "Cuba Libre" },
      { name: "Gin & Tonic" }, { name: "Tequila Sunrise" },
      { name: "Frozen Piña Colada", tag: frozen }, { name: "Frozen Strawberry Daiquiri", tag: frozen },
      { name: "Frozen Pear Daiquiri", tag: frozen }, { name: "Frozen Porn Star Martini", tag: frozen },
      { name: "Irish Coffee", tag: hot }, { name: "Hot Toddy", tag: hot }, { name: "Spiked Hot Chocolate", tag: hot },
    ],
  },
  {
    id: "spritz",
    label: { en: "Spritz & zero", is: "Spritz & 0,0%" },
    lead: { en: "Bubbles, and plenty without alcohol.", is: "Búbblur, og nóg án áfengis." },
    items: [
      { name: "Aperol Spritz" }, { name: "Hugo Spritz" }, { name: "Limoncello Spritz" }, { name: "Sarti Spritz" },
      { name: "Nojito", tag: zero }, { name: "Apple Sour", tag: zero }, { name: "N/A Limoncello Spritz", tag: zero },
      { name: "Lemonade", tag: zero }, { name: "Strawberry Lemonade", tag: zero }, { name: "Passion Fruit Lemonade", tag: zero },
      { name: "Tropical Passion", tag: zero }, { name: "Strawberry & Pear", tag: zero },
    ],
  },
  {
    id: "wine",
    label: { en: "Wine & beer", is: "Vín & bjór" },
    lead: { en: "House wines by the glass, a few special bottles, beer on draught.", is: "Húsvín í glasi, nokkrar sérvaldar flöskur og bjór á krana." },
    items: [
      { name: "House Red", tag: house }, { name: "House White", tag: house }, { name: "House Rosé", tag: house },
      { name: "House Sparkling", tag: house },
      { name: "Vionta Albariño" }, { name: "Von Winning Sauvignon Blanc" }, { name: "Schloss Johannisberg Riesling Bronzelack" },
      { name: "La Celia Reserva Malbec" }, { name: "Tommasi Amarone" }, { name: "Veuve Clicquot Brut Champagne" },
      { name: "Boli", tag: draught }, { name: "Gull Lite", tag: draught }, { name: "Tuborg Classic", tag: draught },
      { name: "Somersby", tag: draught }, { name: "Guinness" }, { name: "Úlfrún Nr.34" },
    ],
  },
];

export const copy = {
  en: {
    nav: { drinks: "Drinks", shake: "Shake", skal: "Skál", visit: "Visit", menu: "Menu", lang: "Íslenska", langShort: "IS" },
    heroHeading: "VÁ BAR: cocktail bar, wine bar and coffee with tapas at Hafnartorg, Reykjavík",
    heroMenu: "EXPLORE",
    heroScroll: "SCROLL",
    slides: [
      { title: "SKÁL", line1: "Handcrafted cocktails, curated wines", line2: "and Mediterranean-inspired tapas" },
      { title: "COFFEE", line1: "Coffee from 11:30,", line2: "cocktails until late" },
      { title: "HAFNARTORG", line1: "Inside Hafnartorg Gallery Food Hall,", line2: "Geirsgata 17, by the old harbour" },
    ] satisfies HeroSlide[],
    heroCtaMenu: "See the menu",
    heroCtaVisit: "Find us",
    marquee: ["Cocktails", "Coffee", "Tapas", "Wines", "Skál", "Hafnartorg"],
    menu: {
      eyebrow: "On the menu",
      title: "Coffee by day, cocktails by night.",
      lead: "A taste of what we pour. The full menu has everything, with prices.",
      tabsLabel: "Menu sections",
      full: "Full menu & prices",
    },
    shake: {
      eyebrow: "Play · cocktail shaker",
      title: "Can't decide? Shake for it.",
      lead: "Pick a mood or two, then shake. We'll pour you one of our drinks.",
      moodsLabel: "Your mood",
      any: "Surprise me",
      button: "Shake",
      shaking: "Shaking…",
      again: "Shake again",
      result: "Today you're having",
      signature: "VÁ signature",
      footnote: "From the VÁ BAR menu. Ask the bar about today's specials.",
      menu: "See the full menu",
    },
    skal: {
      eyebrow: "Play · skál counter",
      title: "Say skál.",
      lead: "Icelandic for cheers. Every glass you raise here clinks a little louder.",
      button: "Skál!",
      count: (n: number) => (n === 0 ? "No glasses raised yet" : n === 1 ? "1 glass raised" : `${n} glasses raised`),
      levels: ["Warming up", "Getting cosy", "Party at the harbour", "Northern lights mode"],
      reset: "Reset",
      note: "Counted on this device only.",
    },
    visit: {
      eyebrow: "Visit",
      title: "Come in from the cold.",
      lead: "VÁ BAR is a cocktail and wine bar with coffee and tapas, inside Hafnartorg Gallery Food Hall by Reykjavík's old harbour.",
      where: "Where",
      hours: "Opening hours",
      hoursUnset: "Opening hours will be posted here soon.",
      openNow: "Open now",
      closedNow: "Closed now",
      days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      midnight: "midnight",
      directions: "Get directions",
      menu: "See the menu",
    },
    footer: { staff: "Staff login", top: "Back to top", hours: "Sun–Thu 11:30–22:00 · Fri–Sat 11:30–00:00" },
  },
  is: {
    nav: { drinks: "Drykkir", shake: "Hrista", skal: "Skál", visit: "Heimsókn", menu: "Matseðill", lang: "English", langShort: "EN" },
    heroHeading: "VÁ BAR: kokteilabar, vínbar og kaffi með tapas á Hafnartorgi í Reykjavík",
    heroMenu: "KANNA",
    heroScroll: "SKRUNA",
    slides: [
      { title: "SKÁL", line1: "Handgerðir kokteilar, sérvalin vín", line2: "og tapas að hætti Miðjarðarhafsins" },
      { title: "KAFFI", line1: "Kaffi frá 11:30,", line2: "kokteilar fram á kvöld" },
      { title: "HAFNARTORG", line1: "Í mathöllinni Hafnartorg Gallery,", line2: "Geirsgötu 17, við gömlu höfnina" },
    ] satisfies HeroSlide[],
    heroCtaMenu: "Sjá matseðil",
    heroCtaVisit: "Finna okkur",
    marquee: ["Kokteilar", "Kaffi", "Tapas", "Vín", "Skál", "Hafnartorg"],
    menu: {
      eyebrow: "Á matseðlinum",
      title: "Kaffi á daginn, kokteilar á kvöldin.",
      lead: "Smá forsmekkur. Allur matseðillinn, með verðum, er á matseðilssíðunni.",
      tabsLabel: "Hlutar matseðils",
      full: "Allur matseðill og verð",
    },
    shake: {
      eyebrow: "Leikur · kokteilahristari",
      title: "Getur ekki valið? Hristu.",
      lead: "Veldu stemningu, svo hristirðu. Við hellum upp á einn af okkar drykkjum.",
      moodsLabel: "Stemningin þín",
      any: "Komdu mér á óvart",
      button: "Hrista",
      shaking: "Hristi…",
      again: "Hrista aftur",
      result: "Í dag færðu þér",
      signature: "Einkennisdrykkur VÁ",
      footnote: "Af matseðli VÁ BAR. Spurðu barinn um sérrétti dagsins.",
      menu: "Sjá allan matseðilinn",
    },
    skal: {
      eyebrow: "Leikur · skálateljari",
      title: "Segðu skál.",
      lead: "Hvert glas sem þú lyftir hér klingir aðeins hærra.",
      button: "Skál!",
      count: (n: number) => (n === 0 ? "Engu glasi lyft enn" : n === 1 ? "1 glasi lyft" : `${n} glösum lyft`),
      levels: ["Að hitna", "Orðið notalegt", "Partí við höfnina", "Norðurljósastemning"],
      reset: "Núllstilla",
      note: "Talið aðeins í þessu tæki.",
    },
    visit: {
      eyebrow: "Heimsókn",
      title: "Komdu inn úr kuldanum.",
      lead: "VÁ BAR er kokteila- og vínbar með kaffi og tapas, í mathöllinni Hafnartorg Gallery við gömlu höfnina í Reykjavík.",
      where: "Hvar",
      hours: "Opnunartími",
      hoursUnset: "Opnunartími verður birtur hér fljótlega.",
      openNow: "Opið núna",
      closedNow: "Lokað núna",
      days: ["sunnudagur", "mánudagur", "þriðjudagur", "miðvikudagur", "fimmtudagur", "föstudagur", "laugardagur"],
      midnight: "miðnætti",
      directions: "Leiðarlýsing",
      menu: "Sjá matseðil",
    },
    footer: { staff: "Innskráning starfsfólks", top: "Efst á síðu", hours: "sun–fim 11:30–22:00 · fös–lau 11:30–00:00" },
  },
};

export type Copy = (typeof copy)["en"];
