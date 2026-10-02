import { useRef, useState, type KeyboardEvent } from "react";
import { FlowButton } from "@/components/ui/flow-button";
import { cn } from "@/lib/utils";
import { site, type Copy, type Lang } from "@/content";
import { menu, type MenuItem } from "@/menu-data";
import { Eyebrow, Reveal } from "./helpers";

export const formatIsk = (n: number, lang: Lang) =>
  `${new Intl.NumberFormat(lang === "is" ? "is-IS" : "en-GB").format(n)} ${lang === "is" ? "kr." : "kr"}`;

/** The full menu (from the printed menus) in tabs, with prices. */
export function MenuSection({ t, lang }: { t: Copy; lang: Lang }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tab = menu[active];

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKeyDown = (e: KeyboardEvent) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (active + delta + menu.length) % menu.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  const price = (i: MenuItem) =>
    tab.wine ? (
      <span className="grid shrink-0 grid-cols-[5.5rem_5.5rem] gap-2 whitespace-nowrap text-right text-sm tabular-nums sm:grid-cols-[6rem_6rem] sm:gap-4 sm:text-base">
        <span>{i.glass ? formatIsk(i.glass, lang) : "—"}</span>
        <span>{i.bottle ? formatIsk(i.bottle, lang) : "—"}</span>
      </span>
    ) : i.price ? (
      <span className="shrink-0 whitespace-nowrap tabular-nums">{formatIsk(i.price, lang)}</span>
    ) : null;

  return (
    <section id="drinks" className="relative scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <Eyebrow>{t.menu.eyebrow}</Eyebrow>
          <h2 className="max-w-3xl font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.menu.title}</h2>
          <p className="mt-5 max-w-xl text-lg text-muted-foreground">{t.menu.lead}</p>
        </Reveal>

        <Reveal delay={120} className="mt-10">
          <div role="tablist" aria-label={t.menu.tabsLabel} onKeyDown={onKeyDown} className="flex flex-wrap gap-2">
            {menu.map((m, i) => {
              const on = i === active;
              return (
                <button
                  key={m.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  role="tab"
                  id={`tab-${m.id}`}
                  aria-selected={on}
                  aria-controls={`panel-${m.id}`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setActive(i)}
                  className={cn(
                    "group inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-95 motion-reduce:transform-none",
                    on
                      ? "border-copper bg-copper text-charcoal shadow-[0_10px_30px_-10px_rgba(224,141,109,0.7)]"
                      : "border-foreground/20 text-foreground/80 hover:-translate-y-0.5 hover:border-foreground/50",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn("inline-block transition-transform duration-500", on ? "scale-125 -rotate-12" : "group-hover:rotate-12")}
                  >
                    {m.icon}
                  </span>
                  {m.label[lang]}
                </button>
              );
            })}
          </div>

          <div
            key={tab.id}
            role="tabpanel"
            id={`panel-${tab.id}`}
            aria-labelledby={`tab-${tab.id}`}
            className="animate-flip-in mt-6 rounded-3xl border border-foreground/10 bg-card p-6 sm:p-10"
          >
            <div className="grid gap-x-12 gap-y-10 lg:grid-cols-2">
              {tab.groups.map((g) => (
                <div key={g.title.en} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-4 border-b border-copper/40 pb-2">
                    <h3 className="text-sm font-bold uppercase tracking-[0.25em] text-copper">{g.title[lang]}</h3>
                    {tab.wine ? (
                      <span className="grid shrink-0 grid-cols-[5.5rem_5.5rem] gap-2 whitespace-nowrap text-right text-[11px] font-semibold uppercase tracking-wider text-foreground/60 sm:grid-cols-[6rem_6rem] sm:gap-4">
                        <span>{t.menu.glass}</span>
                        <span>{t.menu.bottle}</span>
                      </span>
                    ) : g.note ? (
                      <span className="text-xs text-foreground/60">{g.note[lang]}</span>
                    ) : null}
                  </div>
                  <ul>
                    {g.items.map((i) => (
                      <li key={i.name.en} className="group border-b border-foreground/10 py-3">
                        <div className="flex items-baseline justify-between gap-4">
                          <span className="font-display text-lg font-semibold transition-colors group-hover:text-copper">
                            {i.name[lang]}
                            {i.signature ? (
                              <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wider text-copper">
                                ★ {t.menu.signature}
                              </span>
                            ) : null}
                            {i.favourite ? (
                              <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wider text-copper">
                                ♥ {t.menu.favourite}
                              </span>
                            ) : null}
                          </span>
                          <span className="font-semibold text-foreground/90">{price(i)}</span>
                        </div>
                        {i.desc ? <p className="mt-0.5 text-sm text-muted-foreground">{i.desc[lang]}</p> : null}
                      </li>
                    ))}
                  </ul>
                  {tab.wine && g.note ? <p className="mt-2 text-xs text-foreground/60">{g.note[lang]}</p> : null}
                </div>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-foreground/70">{t.menu.allergies}</p>
              <FlowButton href={site.menuUrl} text={t.menu.full} tone="light" />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
