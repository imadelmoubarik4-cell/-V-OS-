import { useCallback, useEffect, useState } from "react";
import { Component as HorizonHero } from "@/components/ui/horizon-hero-section";
import { FlowButton } from "@/components/ui/flow-button";
import { SiteHeader } from "@/components/site/site-header";
import { MenuSection } from "@/components/site/menu-section";
import { BarSection } from "@/components/site/bar-section";
import { AboutSection } from "@/components/site/about-section";
import { HappyHourSection } from "@/components/site/happy-hour-section";
import { ReviewsSection } from "@/components/site/reviews-section";
import { EventsSection } from "@/components/site/events-section";
import { FaqSection } from "@/components/site/faq-section";
import { ShakeSection } from "@/components/site/shake-section";
import { SkalSection } from "@/components/site/skal-section";
import { VisitSection } from "@/components/site/visit-section";
import { CursorGlow } from "@/components/site/helpers";
import { alcedo, copy, heroPalette, heroScenes, partners, site, type Lang } from "@/content";
import logoUrl from "@/assets/brand/va-logo.svg";

const LANG_KEY = "va-lang";

const initialLang = (): Lang => {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "is") return saved;
  } catch {
    /* storage blocked */
  }
  return navigator.language.toLowerCase().startsWith("is") ? "is" : "en";
};

export default function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [navOpen, setNavOpen] = useState(false);
  const t = copy[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* storage blocked */
    }
  }, [lang]);

  const toggleLang = useCallback(() => setLang((l) => (l === "en" ? "is" : "en")), []);
  const openNav = useCallback(() => setNavOpen(true), []);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-foreground focus:px-4 focus:py-2 focus:text-background"
      >
        Skip to content
      </a>
      <CursorGlow />
      <SiteHeader t={t} lang={lang} onToggleLang={toggleLang} navOpen={navOpen} setNavOpen={setNavOpen} />

      <main id="top" inert={navOpen || undefined}>
        <HorizonHero
          slides={t.slides.map((slide, i) => ({ ...slide, ...heroScenes[i] }))}
          srTitle={t.heroHeading}
          playHint={t.heroPlay}
          menuLabel={t.heroMenu}
          scrollLabel={t.heroScroll}
          palette={heroPalette}
          onMenuClick={openNav}
        >
          <FlowButton href={site.menuUrl} text={t.heroCtaMenu} tone="light" className="bg-background/30 backdrop-blur" />
          <FlowButton href="#visit" text={t.heroCtaVisit} tone="light" className="bg-background/30 backdrop-blur" />
        </HorizonHero>

        <div id="main" className="relative z-10 bg-background">
          <Marquee words={t.marquee} />
          <AboutSection t={t} />
          <MenuSection t={t} lang={lang} />
          <HappyHourSection t={t} lang={lang} />
          <EventsSection t={t} lang={lang} />
          <BarSection t={t} lang={lang} />
          <ShakeSection t={t} lang={lang} />
          <ReviewsSection t={t} />
          <SkalSection t={t} />
          <FaqSection t={t} />
          <VisitSection t={t} />
        </div>
      </main>

      <footer className="relative z-10 border-t border-foreground/10 bg-background px-4 pb-10 pt-12 sm:px-6" inert={navOpen || undefined}>
        <div className="mx-auto flex max-w-6xl flex-col gap-10">
          {/* Partners and the platform VÁ runs on */}
          <div className="flex flex-col gap-8 border-b border-foreground/10 pb-10 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.25em] text-foreground/60">{t.partners.title}</p>
              <ul className="flex flex-wrap items-center gap-4">
                {partners.map((p, i) => (
                  <li key={p.name}>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener"
                      aria-label={p.name}
                      className={`grid h-24 w-56 place-items-center rounded-2xl bg-[#f5f1ec] px-6 shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:scale-[1.03] motion-reduce:transform-none ${i % 2 ? "hover:rotate-1" : "hover:-rotate-1"}`}
                    >
                      <img
                        src={p.logo}
                        alt={p.name}
                        width={p.width}
                        height={p.height}
                        loading="lazy"
                        className="max-h-16 w-auto max-w-full object-contain"
                      />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <a
              href={alcedo.url}
              target="_blank"
              rel="noopener"
              className="group flex flex-col items-start gap-1 md:items-end"
              aria-label={`${t.partners.powered} ${alcedo.name}`}
            >
              <span className="text-xs font-semibold uppercase tracking-[0.25em] text-foreground/60">{t.partners.powered}</span>
              <img
                src={alcedo.logo}
                alt=""
                width={200}
                height={163}
                loading="lazy"
                className="h-auto w-[200px] opacity-85 transition-all duration-300 group-hover:-translate-y-0.5 group-hover:opacity-100 motion-reduce:transform-none"
              />
            </a>
          </div>
          <div className="flex flex-col justify-between gap-6 text-sm text-foreground/60 sm:flex-row sm:items-end">
            <div>
              <img src={logoUrl} alt={site.name} width={64} height={43} className="h-auto w-[64px]" />
              <p className="mt-4 text-foreground/80">
                {site.name} · {site.venue} · {site.street}, {site.postcode} {site.city}
              </p>
              <p className="mt-1 tabular-nums">{t.footer.hours}</p>
              <p className="mt-1">
                <a href={site.emailHref} className="text-copper underline-offset-4 hover:underline">
                  {site.email}
                </a>
              </p>
              <p className="mt-4 text-xs">© 2026 {site.company}</p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <a href={site.staffUrl} className="underline-offset-4 hover:text-foreground hover:underline">
                {t.footer.staff}
              </a>
              <FlowButton href="#top" text={t.footer.top} tone="light" />
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}

function Marquee({ words }: { words: string[] }) {
  const row = [...words, ...words];
  return (
    // The band is wider than the screen and pulled up over the hero's bottom edge, so its tilt
    // never shows a wedge of page background at either end.
    <div className="relative z-20 -mt-8 mb-2" aria-hidden="true">
      <div className="relative -left-[5vw] w-[110vw] -rotate-1 overflow-hidden border-y border-foreground/10 bg-gradient-to-r from-rust via-copper to-rust py-4 text-background shadow-[0_12px_30px_-12px_rgba(0,0,0,0.6)]">
        <div className="animate-marquee flex w-max gap-10 whitespace-nowrap font-display text-3xl font-bold uppercase tracking-[0.12em] sm:text-4xl">
          {[...row, ...row].map((w, i) => (
            <span key={i} className="flex items-center gap-10">
              {w}
              <span aria-hidden="true">✦</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
