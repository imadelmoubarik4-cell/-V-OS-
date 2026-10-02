import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { FlowButton } from "@/components/ui/flow-button";
import { cn } from "@/lib/utils";
import { site, type Copy, type Lang } from "@/content";
import logoUrl from "@/assets/brand/va-logo.svg";

type Props = {
  t: Copy;
  lang: Lang;
  onToggleLang: () => void;
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
};

export function SiteHeader({ t, lang, onToggleLang, navOpen, setNavOpen }: Props) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the overlay on Escape and lock page scroll while it is open.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [navOpen, setNavOpen]);

  const links = [
    { href: "#shake", label: t.nav.drinks },
    { href: "#skal", label: t.nav.skal },
    { href: "#visit", label: t.nav.visit },
  ];

  const langButton = (
    <button
      type="button"
      onClick={onToggleLang}
      lang={lang === "en" ? "is" : "en"}
      aria-label={t.nav.lang}
      className="relative h-9 w-[4.5rem] rounded-full border border-foreground/25 text-xs font-semibold tracking-widest transition-colors hover:border-copper"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1 h-7 w-8 rounded-full bg-foreground transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          lang === "en" ? "left-1" : "left-[calc(100%-2.25rem)]",
        )}
      />
      <span aria-hidden="true" className="relative z-[1] grid grid-cols-2">
        <span className={lang === "en" ? "text-background" : "text-foreground/70"}>EN</span>
        <span className={lang === "is" ? "text-background" : "text-foreground/70"}>IS</span>
      </span>
    </button>
  );

  return (
    <>
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-40 transition-all duration-500",
          scrolled ? "bg-background/70 py-2 backdrop-blur-xl shadow-[0_1px_0_rgba(237,232,224,0.08)]" : "py-4",
        )}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <a
            href="#top"
            className="group block"
            aria-label={`${site.name}, ${t.footer.top.toLowerCase()}`}
          >
            {/* Solo logo (no slogan), always small in the top-left; a playful wobble on hover */}
            <img
              src={logoUrl}
              alt=""
              width={64}
              height={43}
              className={cn(
                "h-auto w-[56px] transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:-rotate-6 group-hover:scale-110 motion-reduce:transform-none sm:w-[64px]",
              )}
            />
          </a>

          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="group relative rounded-full px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground"
              >
                {l.label}
                <span className="absolute inset-x-4 bottom-1 h-px origin-left scale-x-0 bg-copper transition-transform duration-300 group-hover:scale-x-100" />
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {langButton}
            <FlowButton href={site.menuUrl} text={t.nav.menu} tone="light" className="hidden px-6 py-2 sm:inline-flex" />
            <button
              type="button"
              className="grid size-10 place-items-center rounded-full border border-foreground/25 transition-colors hover:border-copper md:hidden"
              aria-label={t.nav.menu}
              aria-expanded={navOpen}
              aria-controls="nav-overlay"
              onClick={() => setNavOpen(true)}
            >
              <Menu className="size-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Full-screen navigation, opened from the mobile button or the hero's side menu */}
      <div
        id="nav-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        hidden={!navOpen}
        className="fixed inset-0 z-50 bg-background/95 backdrop-blur-xl"
      >
        <button
          type="button"
          onClick={() => setNavOpen(false)}
          className="absolute right-4 top-4 grid size-12 place-items-center rounded-full border border-foreground/25 transition-transform duration-500 hover:rotate-90 hover:border-copper"
          aria-label="Close"
          autoFocus
        >
          <X className="size-6" />
        </button>
        <nav className="flex h-full flex-col items-center justify-center gap-4" aria-label="Overlay">
          <img src={logoUrl} alt="" width={64} height={43} className="mb-4 h-auto w-[64px]" />
          {[...links, { href: site.menuUrl, label: t.nav.menu }].map((l, i) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setNavOpen(false)}
              className="group font-display text-5xl font-semibold transition-all duration-300 hover:tracking-wide hover:text-copper sm:text-7xl"
              style={{ transitionDelay: `${i * 30}ms` }}
            >
              <span className="mr-3 align-top font-sans text-sm text-copper">0{i + 1}</span>
              {l.label}
            </a>
          ))}
          <div className="mt-6">{langButton}</div>
        </nav>
      </div>
    </>
  );
}
