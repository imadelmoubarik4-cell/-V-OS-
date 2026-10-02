import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { events, type Copy, type Lang } from "@/content";
import { Eyebrow, Reveal } from "./helpers";
import { reykjavikNow } from "./visit-section";

/** "What's happening": the weekly events, with the one that's on now (or tonight) lit up. */
export function EventsSection({ t, lang }: { t: Copy; lang: Lang }) {
  // Live state depends on the visitor's clock, so it is only worked out in the browser.
  const [now, setNow] = useState<ReturnType<typeof reykjavikNow> | null>(null);
  useEffect(() => {
    setNow(reykjavikNow());
    const id = window.setInterval(() => setNow(reykjavikNow()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const state = (e: (typeof events)[number]) => {
    if (!now || !e.days.includes(now.day)) return null;
    if (now.minutes >= e.start && now.minutes < e.end) return "on" as const;
    if (now.minutes < e.start) return "tonight" as const;
    return null;
  };

  return (
    <section id="events" className="relative scroll-mt-20 bg-navy px-4 pb-24 sm:px-6 sm:pb-32">
      <div className="mx-auto max-w-6xl border-t border-foreground/15 pt-20">
        <Reveal className="text-center">
          <Eyebrow>{t.events.eyebrow}</Eyebrow>
          <h2 className="font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.events.title}</h2>
        </Reveal>
        <ul className="mt-12 grid gap-5 md:grid-cols-3">
          {events.map((e, i) => {
            const s = state(e);
            return (
              <Reveal as="li" key={e.id} delay={i * 120}>
                <div
                  className={cn(
                    "group relative flex h-full flex-col items-center rounded-3xl border p-8 text-center transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-2 hover:-rotate-1 motion-reduce:transform-none",
                    s === "on"
                      ? "border-copper bg-copper/15 shadow-[0_0_60px_-10px_rgba(224,141,109,0.6)]"
                      : "border-foreground/15 bg-background/40 hover:border-copper/60",
                  )}
                >
                  {s ? (
                    <span
                      className={cn(
                        "absolute -top-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider",
                        s === "on" ? "bg-copper text-charcoal" : "bg-foreground text-background",
                      )}
                    >
                      {s === "on" ? (
                        <span className="size-1.5 animate-pulse rounded-full bg-charcoal motion-reduce:animate-none" />
                      ) : null}
                      {s === "on" ? t.events.onNow : t.events.tonight}
                    </span>
                  ) : null}
                  <span
                    aria-hidden="true"
                    className="text-5xl transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-125 group-hover:rotate-12 motion-reduce:transform-none"
                  >
                    {e.emoji}
                  </span>
                  <h3 className="mt-4 font-display text-3xl font-semibold text-copper">{e.title[lang]}</h3>
                  <p className="mt-2 text-sm font-semibold uppercase tracking-[0.12em] tabular-nums text-foreground/75">
                    {e.when[lang]}
                  </p>
                  <p className="mt-4 text-lg text-foreground/90">{e.text[lang]}</p>
                </div>
              </Reveal>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
