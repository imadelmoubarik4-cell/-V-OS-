// All copy, links and venue facts for the page, in English and Icelandic.
// [CONFIRM] marks values that are not verified from the repository and must be checked
// with the owner before this goes live (see README.md › "Before launch").
import type { HeroPalette, HeroSlide } from "@/components/ui/horizon-hero-section";

export type Lang = "en" | "is";

export type Drink = {
  id: string;
  name: string;
  moods: Mood[];
  notes: Record<Lang, string>;
  emoji: string;
};

export type Mood = "fresh" | "sour" | "bitter" | "sweet" | "strong" | "coffee";

/** Opening hours per weekday (0 = Sunday), "HH:MM" in Reykjavík time. Close may pass midnight. */
export type Hours = Record<number, { open: string; close: string } | null>;

export const site = {
  name: "VÁ",
  // Confirmed in the repo: apps/web/menu.html heads the public menu "VÁ · Hafnartorg · Reykjavík".
  area: "Hafnartorg · Reykjavík",
  // Confirmed: the operating company (prototypes/alcedo-website footer and privacy notice).
  company: "Coffee & Cocktails ehf. · kt. 671124-0220 · Geirsgata 17, 101 Reykjavík",
  // [CONFIRM] The app's public menu page (apps/web/menu.html) on the app's domain.
  menuUrl: "https://app.alcedo.is/menu.html",
  // Confirmed: Staff login for the Alcedo app (prototypes/alcedo-website/README.md).
  staffUrl: "https://app.alcedo.is/",
  // [CONFIRM] A maps search, not a pinned place. Replace with the venue's own Maps link.
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=V%C3%81%20bar%20Hafnartorg%20Reykjav%C3%ADk",
  // [CONFIRM] Opening hours. null = not published yet; the page then says so.
  hours: null as Hours | null,
};

/** Brand palette for the hero scene: a terracotta glow over navy mountains (MANUAL_DE_MARCA). */
export const heroPalette: HeroPalette = {
  nebula: [0x2d5668, 0xa15c3f],
  mountains: [0x0c2431, 0x143a4d, 0x1f4a5d, 0x2d5668],
  atmosphere: [0.36, 0.2, 0.13],
};

// Classic cocktails used by the "Shake" game. [CONFIRM] Swap for VÁ's own drinks;
// the section is labelled "classics · not the full menu" until then. No prices are shown.
export const drinks: Drink[] = [
  {
    id: "negroni",
    name: "Negroni",
    moods: ["bitter", "strong"],
    emoji: "🍊",
    notes: { en: "Gin, Campari, sweet vermouth. Bitter, bold, beautiful.", is: "Gin, Campari, sætur vermút. Beiskur, djarfur, fallegur." },
  },
  {
    id: "espresso-martini",
    name: "Espresso Martini",
    moods: ["coffee", "sweet", "strong"],
    emoji: "☕",
    notes: { en: "Vodka, fresh espresso, coffee liqueur. Wakes up the night.", is: "Vodka, nýlagað espressó, kaffilíkjör. Vekur kvöldið." },
  },
  {
    id: "whiskey-sour",
    name: "Whiskey Sour",
    moods: ["sour", "strong"],
    emoji: "🍋",
    notes: { en: "Whiskey, lemon, sugar, a silky foam.", is: "Viskí, sítróna, sykur og silkimjúk froða." },
  },
  {
    id: "margarita",
    name: "Margarita",
    moods: ["sour", "fresh"],
    emoji: "🧂",
    notes: { en: "Tequila, lime, orange liqueur, a salted rim.", is: "Tekíla, límóna, appelsínulíkjör og saltbrún." },
  },
  {
    id: "aperol-spritz",
    name: "Aperol Spritz",
    moods: ["fresh", "bitter", "sweet"],
    emoji: "🫧",
    notes: { en: "Aperol, prosecco, soda. Summer, even in winter.", is: "Aperol, prosecco, sódavatn. Sumar, líka um vetur." },
  },
  {
    id: "old-fashioned",
    name: "Old Fashioned",
    moods: ["strong", "sweet"],
    emoji: "🥃",
    notes: { en: "Whiskey, sugar, bitters, orange peel. Slow sipping.", is: "Viskí, sykur, bitter, appelsínubörkur. Til að njóta hægt." },
  },
  {
    id: "gin-tonic",
    name: "Gin & Tonic",
    moods: ["fresh", "bitter"],
    emoji: "🌿",
    notes: { en: "Gin, tonic, plenty of ice. Crisp as a cold harbour breeze.", is: "Gin, tónik og nóg af klaka. Ferskur eins og hafgolan." },
  },
  {
    id: "mojito",
    name: "Mojito",
    moods: ["fresh", "sweet", "sour"],
    emoji: "🌱",
    notes: { en: "Rum, mint, lime, soda. Green and lively.", is: "Romm, mynta, límóna, sódavatn. Grænn og líflegur." },
  },
];

export const moodLabels: Record<Mood, Record<Lang, string>> = {
  fresh: { en: "Fresh", is: "Ferskt" },
  sour: { en: "Sour", is: "Súrt" },
  bitter: { en: "Bitter", is: "Beiskt" },
  sweet: { en: "Sweet", is: "Sætt" },
  strong: { en: "Strong", is: "Sterkt" },
  coffee: { en: "Coffee", is: "Kaffi" },
};

export const copy = {
  en: {
    banner: "Prototype · drinks, hours and some links are placeholders until confirmed",
    nav: { drinks: "Shake", skal: "Skál", visit: "Visit", menu: "Menu", lang: "Íslenska", langShort: "IS" },
    heroMenu: "EXPLORE",
    heroScroll: "SCROLL",
    slides: [
      { title: "VÁ", line1: "Cocktails, tapas and wines", line2: "by the old harbour in Reykjavík" },
      { title: "SKÁL", line1: "Shaken, stirred and poured with care,", line2: "small plates to share" },
      { title: "HAFNARTORG", line1: "Find us at Hafnartorg,", line2: "come in from the cold" },
    ] satisfies HeroSlide[],
    heroCtaMenu: "See the menu",
    heroCtaVisit: "Find us",
    marquee: ["Cocktails", "Tapas", "Wines", "Skál", "Hafnartorg", "Reykjavík"],
    shake: {
      eyebrow: "Play · cocktail shaker",
      title: "Can't decide? Shake for it.",
      lead: "Pick a mood or two, then shake. We'll pour you a suggestion.",
      moodsLabel: "Your mood",
      any: "Surprise me",
      button: "Shake",
      shaking: "Shaking…",
      again: "Shake again",
      result: "Tonight you're having",
      footnote: "Classic cocktails, not the full menu. Ask the bar what's pouring tonight.",
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
      lead: "Find us at Hafnartorg, by Reykjavík's old harbour.",
      where: "Where",
      hours: "Hours",
      hoursUnset: "Opening hours will be posted here soon.",
      openNow: "Open now",
      closedNow: "Closed now",
      days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      directions: "Get directions",
      menu: "See the menu",
    },
    footer: { staff: "Staff login", top: "Back to top", rights: "VÁ" },
  },
  is: {
    banner: "Frumgerð · drykkir, opnunartími og sumir tenglar eru til bráðabirgða",
    nav: { drinks: "Hrista", skal: "Skál", visit: "Heimsókn", menu: "Matseðill", lang: "English", langShort: "EN" },
    heroMenu: "KANNA",
    heroScroll: "SKRUNA",
    slides: [
      { title: "VÁ", line1: "Kokteilar, tapas og vín", line2: "við gömlu höfnina í Reykjavík" },
      { title: "SKÁL", line1: "Hristir, hrærðir og bornir fram af alúð,", line2: "smáréttir til að deila" },
      { title: "HAFNARTORG", line1: "Þú finnur okkur á Hafnartorgi,", line2: "komdu inn úr kuldanum" },
    ] satisfies HeroSlide[],
    heroCtaMenu: "Sjá matseðil",
    heroCtaVisit: "Finna okkur",
    marquee: ["Kokteilar", "Tapas", "Vín", "Skál", "Hafnartorg", "Reykjavík"],
    shake: {
      eyebrow: "Leikur · kokteilahristari",
      title: "Getur ekki valið? Hristu.",
      lead: "Veldu stemningu, svo hristirðu. Við hellum upp á tillögu.",
      moodsLabel: "Stemningin þín",
      any: "Komdu mér á óvart",
      button: "Hrista",
      shaking: "Hristi…",
      again: "Hrista aftur",
      result: "Í kvöld færðu þér",
      footnote: "Klassískir kokteilar, ekki allur matseðillinn. Spurðu barinn hvað er í boði í kvöld.",
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
      lead: "Þú finnur okkur á Hafnartorgi, við gömlu höfnina í Reykjavík.",
      where: "Hvar",
      hours: "Opnunartími",
      hoursUnset: "Opnunartími verður birtur hér fljótlega.",
      openNow: "Opið núna",
      closedNow: "Lokað núna",
      days: ["sun", "mán", "þri", "mið", "fim", "fös", "lau"],
      directions: "Leiðarlýsing",
      menu: "Sjá matseðil",
    },
    footer: { staff: "Innskráning starfsfólks", top: "Efst á síðu", rights: "VÁ" },
  },
};

export type Copy = (typeof copy)["en"];
