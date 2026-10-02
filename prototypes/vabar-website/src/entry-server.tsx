// Build-time render for SEO: scripts/prerender.mjs puts this HTML and the JSON-LD into
// dist/index.html, so crawlers and link previews see the real content without running JS.
import { renderToString } from "react-dom/server";
import App from "./App";
import { copy, site } from "./content";

export function faqLd() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: copy.en.faq.items.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function render() {
  return renderToString(<App />);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** schema.org data for Google: a bar and coffee shop inside Hafnartorg Gallery, with hours and menu. */
export function jsonLd() {
  const groups = new Map<string, string[]>();
  for (const [day, h] of Object.entries(site.hours ?? {})) {
    if (!h) continue;
    // schema.org has no "24:00"; Google reads 23:59 as "until midnight".
    const key = `${h.open}|${h.close === "00:00" ? "23:59" : h.close}`;
    groups.set(key, [...(groups.get(key) ?? []), DAY_NAMES[Number(day)]]);
  }
  return {
    "@context": "https://schema.org",
    "@type": ["BarOrPub", "CafeOrCoffeeShop"],
    name: site.name,
    alternateName: ["VÁ", "Vá bar"],
    url: site.url,
    email: site.email,
    image: `${site.url}og-image.jpg`,
    description:
      "VÁ BAR combines handcrafted cocktails, curated wines, and Mediterranean-inspired tapas, with coffee from 11:30, inside Hafnartorg Gallery Food Hall in Reykjavík.",
    servesCuisine: ["Cocktails", "Wine", "Tapas", "Mediterranean", "Coffee"],
    hasMenu: site.menuUrl,
    address: {
      "@type": "PostalAddress",
      streetAddress: site.street,
      postalCode: site.postcode,
      addressLocality: site.city,
      addressCountry: "IS",
    },
    containedInPlace: { "@type": "Place", name: site.venue },
    openingHoursSpecification: [...groups].map(([key, days]) => {
      const [opens, closes] = key.split("|");
      return { "@type": "OpeningHoursSpecification", dayOfWeek: days, opens, closes };
    }),
    parentOrganization: {
      "@type": "Organization",
      name: "Coffee & Cocktails ehf.",
      identifier: "671124-0220",
    },
  };
}
