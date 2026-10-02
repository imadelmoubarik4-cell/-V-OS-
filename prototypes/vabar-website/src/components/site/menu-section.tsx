import { useRef, useState, type KeyboardEvent } from "react";
import { FlowButton } from "@/components/ui/flow-button";
import { cn } from "@/lib/utils";
import { menuTabs, site, type Copy, type Lang } from "@/content";
import { Eyebrow, Reveal } from "./helpers";

const TAB_ICONS: Record<string, string> = { coffee: "☕", cocktails: "🍸", spritz: "🫧", wine: "🍷" };

/** "On the menu": tabbed highlights (real item names, no prices) with a link to the full menu. */
export function MenuSection({ t, lang }: { t: Copy; lang: Lang }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tab = menuTabs[active];

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKeyDown = (e: KeyboardEvent) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (active + delta + menuTabs.length) % menuTabs.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section id="drinks" className="relative scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <Eyebrow>{t.menu.eyebrow}</Eyebrow>
          <h2 className="max-w-3xl font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.menu.title}</h2>
          <p className="mt-5 max-w-xl text-lg text-muted-foreground">{t.menu.lead}</p>
        </Reveal>

        <Reveal delay={120} className="mt-10">
          <div
            role="tablist"
            aria-label={t.menu.tabsLabel}
            onKeyDown={onKeyDown}
            className="flex flex-wrap gap-2"
          >
            {menuTabs.map((m, i) => {
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
                    {TAB_ICONS[m.id]}
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
            className="animate-flip-in mt-6 rounded-3xl border border-foreground/10 bg-card p-6 sm:p-8"
          >
            <p className="text-sm uppercase tracking-[0.2em] text-copper">{tab.lead[lang]}</p>
            <ul className="mt-5 grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {tab.items.map((item, i) => (
                <li
                  key={item.name}
                  className="group flex items-baseline justify-between gap-3 border-b border-foreground/10 py-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
                  style={{ animationDelay: `${Math.min(i * 25, 400)}ms`, animationFillMode: "both" }}
                >
                  <span className="font-display text-lg font-medium transition-colors group-hover:text-copper">{item.name}</span>
                  {item.tag ? (
                    <span className="shrink-0 rounded-full bg-foreground/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-foreground/75">
                      {item.tag[lang]}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <FlowButton href={site.menuUrl} text={t.menu.full} tone="light" />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
