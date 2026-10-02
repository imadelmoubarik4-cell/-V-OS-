import { useCallback, useEffect, useState } from "react";
import { Component as HorizonHero } from "@/components/ui/horizon-hero-section";
import { FlowButton } from "@/components/ui/flow-button";
import { SiteHeader } from "@/components/site/site-header";
import { ShakeSection } from "@/components/site/shake-section";
import { SkalSection } from "@/components/site/skal-section";
import { VisitSection } from "@/components/site/visit-section";
import { CursorGlow } from "@/components/site/helpers";
import { copy, heroPalette, site, type Lang } from "@/content";
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
          slides={t.slides}
          menuLabel={t.heroMenu}
          scrollLabel={t.heroScroll}
          palette={heroPalette}
          onMenuClick={openNav}
          logo={<img src={logoUrl} alt="" width={438} height={296} />}
        >
          <FlowButton href={site.menuUrl} text={t.heroCtaMenu} tone="light" className="bg-background/30 backdrop-blur" />
          <FlowButton href="#visit" text={t.heroCtaVisit} tone="light" className="bg-background/30 backdrop-blur" />
        </HorizonHero>

        <div id="main" className="relative z-10 bg-background">
          <Marquee words={t.marquee} />
          <ShakeSection t={t} lang={lang} />
          <SkalSection t={t} />
          <VisitSection t={t} />
        </div>
      </main>

      <footer className="relative z-10 border-t border-foreground/10 bg-background px-4 pb-10 pt-16 sm:px-6" inert={navOpen || undefined}>
        <div className="mx-auto flex max-w-6xl flex-col gap-10">
          <p className="font-display text-[22vw] font-semibold leading-none tracking-tight text-foreground/[0.06] select-none sm:text-[16vw]" aria-hidden="true">
            VÁ · SKÁL
          </p>
          <div className="flex flex-col justify-between gap-6 text-sm text-foreground/60 sm:flex-row sm:items-end">
            <div>
              <img src={logoUrl} alt={site.name} width={110} height={74} className="h-auto w-[110px]" />
              <p className="mt-4">{site.area}</p>
              <p className="mt-4 text-xs">© 2026 {site.company}</p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <a href={site.staffUrl} className="underline-offset-4 hover:text-foreground hover:underline">
                {t.footer.staff}
              </a>
              <FlowButton href="#top" text={t.footer.top} tone="light" />
            </div>
          </div>
          <p className="text-center text-[11px] text-foreground/40">{t.banner}</p>
        </div>
      </footer>
    </>
  );
}

function Marquee({ words }: { words: string[] }) {
  const row = [...words, ...words];
  return (
    <div className="relative -rotate-1 overflow-hidden border-y border-foreground/10 bg-gradient-to-r from-rust via-copper to-rust py-4 text-background" aria-hidden="true">
      <div className="animate-marquee flex w-max gap-10 whitespace-nowrap font-display text-3xl font-bold uppercase tracking-[0.12em] sm:text-4xl">
        {[...row, ...row].map((w, i) => (
          <span key={i} className="flex items-center gap-10">
            {w}
            <span aria-hidden="true">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}
