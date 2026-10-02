// All copy, links and venue facts for the page, in English and Icelandic.
// Sources: opening hours, address and menu link from the owner (2 October 2026); drinks from
// VÁ's own recipes in Atlas (data/flavor/recipes-snapshot.json, names and ingredients only, no
// prices); the description is the business profile of the current Wix site.
import type { HeroPalette, HeroSlide } from "@/components/ui/horizon-hero-section";
import type { SocialKey } from "@/components/site/social-icons";
import barPhoto from "@/assets/photos/bar.webp";
import cocktailPhoto from "@/assets/photos/cocktail.webp";
import pourPhoto from "@/assets/photos/pour.webp";
import muddlePhoto from "@/assets/photos/muddle.webp";
import glassPhoto from "@/assets/photos/glass.webp";
// COCKTAILS hero story: pour → garnish → present. Placeholders until Imad's three photos arrive;
// replace these three files (same names) and rebuild.
import heroPour from "@/assets/hero/cocktails-pour.webp";
import heroGarnish from "@/assets/hero/cocktails-garnish.webp";
import heroPresent from "@/assets/hero/cocktails-present.webp";
// TAPAS hero photo (supplied 2 October 2026; small source, shown soft-focus).
import heroTapas from "@/assets/hero/tapas.webp";
// WINE hero photo: the owner's photo of a wine glass with the VÁ logo etched in its base.
import heroWine from "@/assets/hero/wine-glass.webp";

export type Lang = "en" | "is";

export type Mood = "fresh" | "sour" | "bitter" | "sweet" | "strong" | "coffee" | "frozen" | "warm" | "zero";

export type Drink = {
  id: string;
  name: string;
  moods: Mood[];
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
  // Contact address shown on the current vábar.is. The link uses the punycode domain so every mail app accepts it.
  email: "info@vábar.is",
  emailHref: "mailto:info@xn--vbar-5na.is",
  // Table bookings move to Alcedo. When Alcedo's guest booking page is live, paste its link here and
  // every "Book a table" button opens it. Until then (null) the buttons open a booking request email.
  bookingUrl: null as string | null,
  // VÁ's social profiles, in display order. Each link adds an icon to the footer and the phone menu,
  // and is listed for Google (schema.org sameAs); null hides it.
  socials: [
    { key: "instagram", label: "Instagram", url: null },
    { key: "facebook", label: "Facebook", url: null },
    { key: "tiktok", label: "TikTok", url: null },
  ] as { key: SocialKey; label: string; url: string | null }[],
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

/**
 * One mood per hero word; the scene blends between them as you scroll.
 * COCKTAILS: cool ice-blue and teal, like the backlit blue stone wall behind the bar.
 * TAPAS: warm Mediterranean saffron, olive and sun-baked earth.
 * WINE: deep burgundy and plum.
 */
export const heroScenes: Pick<HeroSlide, "palette" | "background" | "glow" | "particle" | "photos">[] = [
  {
    palette: {
      nebula: [0x1d6f8f, 0x2d5668],
      mountains: [0x081a26, 0x0e2a3a, 0x15394d, 0x1f4d66],
      atmosphere: [0.08, 0.3, 0.46],
    },
    background: "radial-gradient(ellipse at 50% 115%, #1d6f8f 0%, #123447 40%, #0d1820 75%, #0a0f13 100%)",
    glow: "rgba(90, 180, 230, 0.5)",
    particle: { kind: "bubbles", rgb: "200, 235, 255" },
    photos: [{ src: heroPour }, { src: heroGarnish }, { src: heroPresent, position: "50% 30%" }],
  },
  {
    palette: {
      nebula: [0xd9822b, 0x6f7d2c],
      mountains: [0x24160d, 0x3a2312, 0x553118, 0x704020],
      atmosphere: [0.5, 0.3, 0.08],
    },
    background: "radial-gradient(ellipse at 50% 115%, #9a5a1e 0%, #5a3414 40%, #24180f 75%, #120d09 100%)",
    glow: "rgba(232, 160, 60, 0.5)",
    particle: { kind: "sparks", rgb: "240, 170, 70" },
    photos: [{ src: heroTapas, position: "50% 50%", soft: true }],
  },
  {
    palette: {
      nebula: [0x6e1230, 0x3d1450],
      mountains: [0x1a0810, 0x2a0c1a, 0x3a1026, 0x4c1432],
      atmosphere: [0.2, 0.015, 0.07],
    },
    background: "radial-gradient(ellipse at 50% 110%, #6a1230 0%, #400d22 38%, #1e0c16 72%, #0f080c 100%)",
    glow: "rgba(170, 30, 75, 0.6)",
    particle: { kind: "drops", rgb: "255, 110, 150" },
    photos: [{ src: heroWine, position: "50% 62%", tint: "rgba(110, 10, 45, 0.35)" }],
  },
];

// Drinks for the "Shake" game. Names match src/menu-data.ts, which supplies description and price.
export const drinks: Drink[] = [
  { id: "va-espresso-martini", name: "VÁ Espresso Martini", signature: true, moods: ["coffee", "strong", "sweet"], emoji: "☕" },
  { id: "popcorn", name: "Popcorn", signature: true, moods: ["strong", "sweet"], emoji: "🍿" },
  { id: "tiki-me", name: "Tiki Me", signature: true, moods: ["sweet", "strong", "fresh"], emoji: "🍍" },
  { id: "chupa-chups", name: "Chupa Chups", signature: true, moods: ["sweet", "sour"], emoji: "🍭" },
  { id: "espresso-martini", name: "Espresso Martini", moods: ["coffee", "strong"], emoji: "☕" },
  { id: "basil-gimlet", name: "Basil Gimlet", moods: ["fresh", "sour"], emoji: "🌿" },
  { id: "porn-star-martini", name: "Porn Star Martini", moods: ["sweet", "sour"], emoji: "💛" },
  { id: "whisky-sour", name: "Whisky Sour", moods: ["sour", "strong"], emoji: "🍋" },
  { id: "margarita", name: "Margarita", moods: ["sour", "fresh"], emoji: "🧂" },
  { id: "mojito", name: "Mojito", moods: ["fresh", "sour", "sweet"], emoji: "🌱" },
  { id: "gin-tonic", name: "Gin & Tonic", moods: ["fresh", "bitter"], emoji: "🫒" },
  { id: "aperol-spritz", name: "Aperol Spritz", moods: ["fresh", "bitter"], emoji: "🫧" },
  { id: "hugo-spritz", name: "Hugo Spritz", moods: ["fresh", "sweet"], emoji: "🌼" },
  { id: "frozen-pina-colada", name: "Frozen Piña Colada", moods: ["frozen", "sweet"], emoji: "🥥" },
  { id: "frozen-strawberry-daiquiri", name: "Frozen Strawberry Daiquiri", moods: ["frozen", "sweet", "sour"], emoji: "🍓" },
  { id: "frozen-pear-daiquiri", name: "Frozen Pear Daiquiri", moods: ["frozen", "sweet"], emoji: "🍐" },
  { id: "irish-coffee", name: "Irish Coffee", moods: ["warm", "coffee", "strong"], emoji: "🔥" },
  { id: "hot-toddy", name: "Hot Toddy", moods: ["warm", "sweet"], emoji: "🍯" },
  { id: "spiked-hot-chocolate", name: "Spiked Hot Chocolate", moods: ["warm", "sweet"], emoji: "🍫" },
  { id: "nojito", name: "Nojito", moods: ["zero", "fresh"], emoji: "🌱" },
  { id: "apple-sour", name: "Apple Sour", moods: ["zero", "sour"], emoji: "🍏" },
  { id: "na-limoncello-spritz", name: "N/A Limoncello Spritz", moods: ["zero", "fresh", "sweet"], emoji: "🍋" },
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

/** Happy hour, as on the current vábar.is (2 October 2026). Minutes since midnight; 1440 = midnight. */
export const happyHour = {
  periods: [
    { days: [0, 1, 2, 3, 4, 5, 6], start: 15 * 60, end: 18 * 60 },
    { days: [5, 6], start: 22 * 60, end: 24 * 60 },
  ],
};

/** Weekly events ("What's happening"). Minutes since midnight; 1440 = midnight. */
export const events = [
  {
    id: "girls-night",
    emoji: "💃",
    days: [4],
    start: 18 * 60,
    end: 22 * 60,
    title: { en: "Girls' Night", is: "Stelpukvöld" },
    when: { en: "Every Thursday · 18:00–22:00", is: "Alla fimmtudaga · 18:00–22:00" },
    text: { en: "50% off cocktails.", is: "50% afsláttur af kokteilum." },
  },
  {
    id: "late-hour",
    emoji: "🌙",
    days: [5, 6],
    start: 22 * 60,
    end: 24 * 60,
    title: { en: "Weekend Late Hour", is: "Gleðistund um helgar" },
    when: { en: "Friday & Saturday · 22:00–00:00", is: "Föstudaga og laugardaga · 22:00–00:00" },
    text: { en: "Happy hour returns before closing.", is: "Gleðistundin snýr aftur fyrir lokun." },
  },
  {
    id: "sunday-2for1",
    emoji: "🍻",
    days: [0],
    start: 18 * 60,
    end: 20 * 60,
    title: { en: "Sunday 2-for-1", is: "Sunnudagur 2 fyrir 1" },
    when: { en: "Every Sunday · 18:00–20:00", is: "Alla sunnudaga · 18:00–20:00" },
    text: { en: "2-for-1 on all beers.", is: "2 fyrir 1 af öllum bjór." },
  },
];

/** Reviews quoted on the current vábar.is. Kept word for word; see README before launch. */
export const reviews = [
  {
    quote: "Great cocktails and the tapas are genuinely good, not an afterthought. Perfect spot before dinner elsewhere or to stay all night.",
    author: "Jón K.",
    source: "Google",
  },
  {
    quote: "Happy hour prices are excellent for the location. Wine list is small but well chosen. Will be back.",
    author: "Maria S.",
    source: "Google",
  },
  {
    quote: "A lively environment but not so loud you can't have a conversation. Staff were very friendly and knowledgeable and I thoroughly enjoyed spending time at this bar. Would highly recommend!",
    author: "kylier946",
    source: "Tripadvisor",
  },
];

/** "Behind the bar" photos (supplied by the owner, 2 October 2026; 720×1280 web copies). */
export type Photo = { id: string; src: string; alt: Record<Lang, string>; caption: Record<Lang, string>; position?: string };

export const photos: Photo[] = [
  {
    id: "bar",
    src: barPhoto,
    position: "60% 50%",
    caption: { en: "Behind the bar at Hafnartorg", is: "Á bak við barinn á Hafnartorgi" },
    alt: {
      en: "A bartender in a flat cap mixes a drink at the VÁ BAR counter, with glasses hanging above.",
      is: "Barþjónn með derhúfu blandar drykk við barborð VÁ BAR, með glös hangandi fyrir ofan.",
    },
  },
  {
    id: "cocktail",
    src: cocktailPhoto,
    caption: { en: "Crushed ice, fresh lime", is: "Mulinn klaki, fersk límóna" },
    alt: {
      en: "A tall green cocktail with lime and crushed ice, finished with a red pour from a jigger.",
      is: "Hár grænn kokteill með límónu og muldum klaka, toppaður með rauðu úr mæliglasi.",
    },
  },
  {
    id: "pour",
    src: pourPhoto,
    caption: { en: "Every pour measured", is: "Hver skammtur mældur" },
    alt: {
      en: "A bartender pours into a jigger in front of the bar's backlit blue stone wall.",
      is: "Barþjónn hellir í mæliglas fyrir framan upplýstan bláan steinvegg barsins.",
    },
  },
  {
    id: "muddle",
    src: muddlePhoto,
    caption: { en: "Muddled to order", is: "Marið á staðnum" },
    alt: {
      en: "A bartender muddles lime in a glass under a row of hanging martini glasses.",
      is: "Barþjónn merur límónu í glasi undir röð af hangandi martini-glösum.",
    },
  },
  {
    id: "glass",
    src: glassPhoto,
    caption: { en: "Our logo, etched in the glass", is: "Merkið okkar, grafið í glasið" },
    alt: {
      en: "The base of a wine glass with the VÁ logo etched into it, on a black napkin.",
      is: "Fótur á vínglasi með VÁ-merkinu gröfnu í glerið, á svartri servíettu.",
    },
  },
];

import mekkaLogo from "@/assets/partners/mekka.png";
import olgerdinLogo from "@/assets/partners/olgerdin.png";
import alcedoLogo from "@/assets/partners/alcedo-white.svg";

/** Partner logos (supplied by the owner, 2 October 2026), shown on ivory tiles in their own colours. */
export const partners = [
  { name: "Mekka Wines & Spirits", logo: mekkaLogo, url: "https://www.mekka.is/", width: 386, height: 48 },
  { name: "Ölgerðin", logo: olgerdinLogo, url: "https://www.olgerdin.is/", width: 520, height: 402 },
];

/** Alcedo, the operations platform VÁ runs on: white logo from the Alcedo Logo Kit v1 (for dark backgrounds). */
export const alcedo = { name: "Alcedo", logo: alcedoLogo, url: "https://www.alcedo.is/" };

export const copy = {
  en: {
    nav: { book: "Book a table", drinks: "Drinks", happy: "Happy hour", shake: "Shake", skal: "VÁ", visit: "Visit", menu: "Menu", lang: "Íslenska", langShort: "IS" },
    // Pre-filled email used by the "Book a table" buttons until Alcedo's booking page is live.
    bookingEmail: {
      subject: "Table booking at VÁ BAR",
      body: "Hi VÁ BAR,\n\nI'd like to book a table.\n\nDate:\nTime:\nNumber of guests:\nName:\nPhone:\n\nThank you!",
    },
    follow: "Follow VÁ",
    heroHeading: "VÁ BAR: cocktail bar, wine bar and coffee with tapas at Hafnartorg, Reykjavík",
    heroMenu: "EXPLORE",
    heroPlay: "Tap to play",
    heroScroll: "SCROLL",
    slides: [
      { title: "COCKTAILS", line1: "Handcrafted at the bar,", line2: "from our signatures to the classics" },
      { title: "TAPAS", line1: "Mediterranean-inspired plates,", line2: "made for sharing" },
      { title: "WINE", line1: "Curated wines by the glass or bottle,", line2: "at Hafnartorg in Reykjavík" },
    ] satisfies HeroSlide[],
    heroCtaMenu: "See the menu",
    heroCtaVisit: "Find us",
    marquee: ["Cocktails", "Coffee", "Tapas", "Wines", "Happy hour 15–18", "Hafnartorg"],
    menu: {
      eyebrow: "On the menu",
      title: "Coffee by day, cocktails by night.",
      lead: "Everything we pour and serve, straight from our menu. Prices in Icelandic krónur; wine by the 150 ml glass or the bottle.",
      glass: "Glass",
      bottle: "Bottle",
      signature: "Signature",
      favourite: "House favourite",
      allergies: "Please tell your server about any allergies or dietary needs.",
      tabsLabel: "Menu sections",
      full: "Open the live menu",
    },
    about: {
      eyebrow: "Our story",
      title: "One shared vision.",
      body: "VÁ Cocktail bar in Reykjavík was created by two friends with different backgrounds but one shared vision: to build a unique hospitality experience centred on atmosphere, quality and unforgettable moments in the heart of Reykjavík.",
      stats: [
        { value: 20, label: "Years of experience" },
        { value: 2024, label: "Opened" },
        { value: 101, label: "Downtown Reykjavík" },
      ],
    },
    happy: {
      eyebrow: "Every day, 15:00–18:00",
      title: "The best deal at Hafnartorg.",
      lead: "Daily happy hour on cocktails, wine and beer, plus a late one on Friday and Saturday.",
      when: "When",
      daily: "Every day",
      late: "Late night · Friday & Saturday",
      lineup: "On happy hour",
      finePrint: "Happy hour applies only to the items listed · No substitutions · Not valid with other offers",
      on: (left: string) => `Happy hour is on · ends in ${left}`,
      next: (when: string, until: string) => `Next happy hour ${when} · in ${until}`,
      today: (time: string) => `today at ${time}`,
      tomorrow: (time: string) => `tomorrow at ${time}`,
      onDay: (day: string, time: string) => `${day} at ${time}`,
      days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      h: "h",
      min: "min",
    },
    faq: {
      eyebrow: "FAQ",
      title: "Good questions.",
      items: [
        { q: "Where is VÁ Bar?", a: "VÁ Bar is in Hafnartorg Gallery (Geirsgata 17, 101 Reykjavík), in the heart of Reykjavík, within walking distance of Harpa and the city centre." },
        { q: "What are VÁ Bar's opening hours?", a: "VÁ Bar is open Sunday to Thursday 11:30–22:00 and Friday to Saturday 11:30–00:00. Opening hours may vary on public holidays." },
        { q: "Does VÁ Bar have a happy hour?", a: "Yes. VÁ has happy hour deals on selected cocktails for 1,990 kr, wines for 1,090 kr and all beers for 990 kr. See the happy hour section for current times and offers." },
        { q: "When is happy hour at VÁ Bar?", a: "Happy hour is every day 15:00–18:00. There is also a late-night happy hour every Friday and Saturday 22:00–00:00." },
        { q: "Can I book a table at VÁ Bar?", a: "Yes. Use the “Book a table” button on this page. We recommend booking ahead at weekends, for celebrations and for larger groups." },
        { q: "Does VÁ Bar offer alcohol-free cocktails?", a: "Yes. We offer a selection of creative alcohol-free cocktails, wines and other non-alcoholic drinks." },
        { q: "Is VÁ good for dates and celebrations?", a: "Absolutely. VÁ's warm atmosphere, carefully mixed cocktails, tapas and curated wines make it ideal for dates, birthdays, celebrations and relaxed evenings with friends." },
        { q: "What makes VÁ different from other bars in Reykjavík?", a: "VÁ brings together creative cocktails, flavourful tapas, curated wines and personal service in one memorable experience. Our aim is simple: to create moments that make people say “VÁ”." },
        { q: "What food and drinks do you serve at VÁ Bar?", a: "We serve handcrafted cocktails, curated wines, and Mediterranean-inspired tapas. It is a focused menu, made for sharing, pairing, and enjoying at the bar or table." },
        { q: "Do you host private events or group bookings?", a: "Yes. We can help with group bookings and private events. Contact us at info@vábar.is with your date, group size, and what you need, and we will get back to you." },
        { q: "Do you have vegetarian, vegan, or allergen-friendly options?", a: "Yes, we offer options for different preferences. Please ask our team when you visit, and we will help you choose dishes that work for you." },
        { q: "Can I walk in, or do I need a reservation?", a: "Walk-ins are welcome when we have space. For busy times, we recommend booking a table to secure your spot." },
      ],
    },
    events: { eyebrow: "Good to know", title: "What's happening.", onNow: "On now", tonight: "Tonight" },
    reviews: {
      eyebrow: "What people say",
      title: "Don't take our word for it.",
      review: (source: string) => `${source} review`,
    },
    bar: {
      eyebrow: "Behind the bar",
      title: "Made by hand, right in front of you.",
      lead: "Tap the photo or swipe to deal the next one.",
      next: "Next photo",
      prev: "Previous photo",
      deck: "Photos from VÁ BAR",
      of: "of",
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
      eyebrow: "Play · VÁ counter",
      title: "Say VÁ!",
      lead: "Vá (said like “vow”) is Icelandic for “wow!”, what you say when something amazes you. That's our whole idea: moments that make you say VÁ. Go on, say it.",
      button: "VÁ!",
      count: (n: number) => (n === 0 ? "No VÁs yet" : n === 1 ? "1 VÁ" : `${n} VÁs`),
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
      email: "Email",
      directions: "Get directions",
      menu: "See the menu",
    },
    partners: { title: "Our partners", powered: "Powered by" },
    footer: { staff: "Staff login", top: "Back to top", hours: "Sun–Thu 11:30–22:00 · Fri–Sat 11:30–00:00" },
  },
  is: {
    nav: { book: "Bóka borð", drinks: "Drykkir", happy: "Gleðistund", shake: "Hrista", skal: "VÁ", visit: "Heimsókn", menu: "Matseðill", lang: "English", langShort: "EN" },
    bookingEmail: {
      subject: "Borðapöntun á VÁ BAR",
      body: "Halló VÁ BAR,\n\nMig langar að bóka borð.\n\nDagsetning:\nTími:\nFjöldi gesta:\nNafn:\nSími:\n\nTakk fyrir!",
    },
    follow: "Fylgdu VÁ",
    heroHeading: "VÁ BAR: kokteilabar, vínbar og kaffi með tapas á Hafnartorgi í Reykjavík",
    heroMenu: "KANNA",
    heroPlay: "Pikkaðu til að leika",
    heroScroll: "SKRUNA",
    slides: [
      { title: "KOKTEILAR", line1: "Handgerðir við barinn,", line2: "frá einkennisdrykkjum til klassíkur" },
      { title: "TAPAS", line1: "Smáréttir að hætti Miðjarðarhafsins,", line2: "gerðir til að deila" },
      { title: "VÍN", line1: "Sérvalin vín í glasi eða flösku,", line2: "á Hafnartorgi í Reykjavík" },
    ] satisfies HeroSlide[],
    heroCtaMenu: "Sjá matseðil",
    heroCtaVisit: "Finna okkur",
    marquee: ["Kokteilar", "Kaffi", "Tapas", "Vín", "Gleðistund 15–18", "Hafnartorg"],
    menu: {
      eyebrow: "Á matseðlinum",
      title: "Kaffi á daginn, kokteilar á kvöldin.",
      lead: "Allt sem við hellum upp á og berum fram, beint af matseðlinum. Verð í íslenskum krónum; vín í 150 ml glasi eða flösku.",
      glass: "Glas",
      bottle: "Flaska",
      signature: "Sérkokteill",
      favourite: "Vinsælt hjá okkur",
      allergies: "Vinsamlegast láttu þjóninn vita um ofnæmi eða sérþarfir.",
      tabsLabel: "Hlutar matseðils",
      full: "Opna matseðilinn",
    },
    about: {
      eyebrow: "Sagan okkar",
      title: "Ein sameiginleg sýn.",
      body: "VÁ kokteilabar í Reykjavík var stofnaður af tveimur vinum með ólíkan bakgrunn en eina sameiginlega sýn: að skapa einstaka gestrisni þar sem andrúmsloft, gæði og ógleymanlegar stundir eru í fyrirrúmi, í hjarta Reykjavíkur.",
      stats: [
        { value: 20, label: "Ára reynsla" },
        { value: 2024, label: "Opnaði" },
        { value: 101, label: "Miðbær Reykjavíkur" },
      ],
    },
    happy: {
      eyebrow: "Alla daga, 15:00–18:00",
      title: "Besta tilboðið á Hafnartorgi.",
      lead: "Gleðistund alla daga á kokteilum, víni og bjór, og önnur seint á föstudags- og laugardagskvöldum.",
      when: "Hvenær",
      daily: "Alla daga",
      late: "Næturstund · föstudaga og laugardaga",
      lineup: "Á gleðistund",
      finePrint: "Gleðistundin gildir aðeins um það sem talið er upp · Engar skiptingar · Gildir ekki með öðrum tilboðum",
      on: (left: string) => `Gleðistund núna · lýkur eftir ${left}`,
      next: (when: string, until: string) => `Næsta gleðistund ${when} · eftir ${until}`,
      today: (time: string) => `í dag kl. ${time}`,
      tomorrow: (time: string) => `á morgun kl. ${time}`,
      onDay: (day: string, time: string) => `á ${day} kl. ${time}`,
      days: ["sunnudag", "mánudag", "þriðjudag", "miðvikudag", "fimmtudag", "föstudag", "laugardag"],
      h: "klst.",
      min: "mín.",
    },
    faq: {
      eyebrow: "Spurt og svarað",
      title: "Góðar spurningar.",
      items: [
        { q: "Hvar er VÁ Bar staðsettur?", a: "VÁ Bar er staðsettur í Hafnartorg Gallery (Geirsgötu 17, 101 Reykjavík), í hjarta Reykjavíkur, í göngufæri frá Hörpu og miðbænum." },
        { q: "Hver er opnunartími VÁ Bar?", a: "VÁ Bar er opinn sunnudaga til fimmtudaga frá 11:30–22:00 og föstudaga til laugardaga frá 11:30–00:00. Opnunartími getur verið breytilegur á almennum frídögum." },
        { q: "Er VÁ Bar með Happy Hour?", a: "Já. VÁ býður upp á Happy Hour-tilboð á völdum kokteilum á 1.990 kr., vínum á 1.090 kr. og öllum bjórum á 990 kr. Skoðaðu gleðistundarhlutann fyrir gildandi tíma og tilboð." },
        { q: "Hvenær er Happy Hour á VÁ Bar?", a: "Happy Hour er alla daga frá 15:00–18:00. Auk þess er síðkvölds Happy Hour alla föstudaga og laugardaga frá 22:00–00:00." },
        { q: "Er hægt að bóka borð á VÁ Bar?", a: "Já. Notaðu hnappinn „Bóka borð“ hér á síðunni. Mælt er með því að bóka fyrirfram um helgar, fyrir hátíðarhöld og stærri hópa." },
        { q: "Býður VÁ Bar upp á áfengislausa kokteila?", a: "Já. Við bjóðum upp á úrval af frumlegum áfengislausum kokteilum, vínum og öðrum óáfengum drykkjum." },
        { q: "Hentar VÁ fyrir stefnumót og hátíðarhöld?", a: "Algjörlega. Hlýlegt andrúmsloft VÁ, vandlega blandaðir kokteilar, tapasréttir og sérvalin vín gera staðinn tilvalinn fyrir stefnumót, afmæli, hátíðarhöld og afslappaðar stundir með vinum." },
        { q: "Hvað aðgreinir VÁ frá öðrum börum í Reykjavík?", a: "VÁ sameinar frumlega kokteila, bragðmikla tapasrétti, sérvalin vín og persónulega þjónustu í eina eftirminnilega upplifun. Markmið okkar er einfalt: að skapa augnablik sem fá fólk til að segja „VÁ“." },
        { q: "Hvaða mat og drykki bjóðið þið upp á?", a: "Við bjóðum upp á handgerða kokteila, sérvalin vín og tapas að hætti Miðjarðarhafsins. Matseðillinn er hnitmiðaður, gerður til að deila, para saman og njóta við barinn eða borðið." },
        { q: "Takið þið að ykkur einkasamkvæmi eða hópbókanir?", a: "Já. Við aðstoðum með hópbókanir og einkasamkvæmi. Sendu okkur línu á info@vábar.is með dagsetningu, fjölda gesta og því sem þú þarft, og við höfum samband." },
        { q: "Er í boði grænmetis-, vegan- eða ofnæmisvænt?", a: "Já, við bjóðum upp á valkosti fyrir ólíkar þarfir. Spurðu starfsfólkið þegar þú kemur og við hjálpum þér að velja það sem hentar þér." },
        { q: "Get ég komið án bókunar, eða þarf ég að panta?", a: "Það er velkomið að koma án bókunar þegar pláss leyfir. Á annatímum mælum við með að bóka borð til að tryggja sér sæti." },
      ],
    },
    events: { eyebrow: "Gott að vita", title: "Hvað er að gerast.", onNow: "Í gangi núna", tonight: "Í kvöld" },
    reviews: {
      eyebrow: "Það sem fólk segir",
      title: "Ekki trúa okkur bara.",
      review: (source: string) => `Umsögn á ${source}`,
    },
    bar: {
      eyebrow: "Á bak við barinn",
      title: "Handgert, beint fyrir framan þig.",
      lead: "Pikkaðu á myndina eða strjúktu til að sjá þá næstu.",
      next: "Næsta mynd",
      prev: "Fyrri mynd",
      deck: "Myndir frá VÁ BAR",
      of: "af",
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
      eyebrow: "Leikur · VÁ-teljari",
      title: "Segðu VÁ!",
      lead: "„Vá!“ segjum við þegar eitthvað kemur okkur skemmtilega á óvart. Það er hugmyndin á bak við nafnið: augnablik sem fá þig til að segja VÁ. Prófaðu.",
      button: "VÁ!",
      count: (n: number) => (n === 0 ? "Ekkert VÁ enn" : `${n} × VÁ`),
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
      email: "Netfang",
      directions: "Leiðarlýsing",
      menu: "Sjá matseðil",
    },
    partners: { title: "Samstarfsaðilar", powered: "Knúið af" },
    footer: { staff: "Innskráning starfsfólks", top: "Efst á síðu", hours: "sun–fim 11:30–22:00 · fös–lau 11:30–00:00" },
  },
};

export type Copy = (typeof copy)["en"];

/** Where "Book a table" goes: Alcedo's booking page when set, otherwise a pre-filled request email. */
export function bookingHref(t: Copy) {
  if (site.bookingUrl) return site.bookingUrl;
  const q = new URLSearchParams({ subject: t.bookingEmail.subject, body: t.bookingEmail.body });
  // mailto wants %20 for spaces, not "+".
  return `${site.emailHref}?${q.toString().replace(/\+/g, "%20")}`;
}

/** Social profiles that have a link; the rest stay hidden. */
export const socialLinks = site.socials.filter((s): s is typeof s & { url: string } => Boolean(s.url));
