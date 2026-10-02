import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { happyHour, type Copy, type Lang } from "@/content";
import { happyHourMenu } from "@/menu-data";
import { formatIsk } from "./menu-section";
import { Reveal } from "./helpers";
import { reykjavikNow } from "./visit-section";

const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

type Status = { on: true; left: number } | { on: false; until: number; dayOffset: number; start: number };

/** Whether happy hour is on now in Reykjavík, or when the next one starts. */
export function happyHourStatus(day: number, minutes: number): Status {
  for (const p of happyHour.periods) {
    if (p.days.includes(day) && minutes >= p.start && minutes < p.end) return { on: true, left: p.end - minutes };
  }
  for (let offset = 0; offset < 8; offset++) {
    const d = (day + offset) % 7;
    const starts = happyHour.periods
      .filter((p) => p.days.includes(d))
      .map((p) => p.start)
      .filter((s) => offset > 0 || s > minutes)
      .sort((a, b) => a - b);
    if (starts.length) return { on: false, until: offset * 1440 + starts[0] - minutes, dayOffset: offset, start: starts[0] };
  }
  return { on: false, until: 0, dayOffset: 0, start: 0 };
}

export function HappyHourSection({ t, lang }: { t: Copy; lang: Lang }) {
  const h = t.happy;
  // The live line depends on the visitor's clock, so it appears only in the browser.
  const [now, setNow] = useState<ReturnType<typeof reykjavikNow> | null>(null);
  useEffect(() => {
    setNow(reykjavikNow());
    const id = window.setInterval(() => setNow(reykjavikNow()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const duration = (m: number) => {
    const hrs = Math.floor(m / 60);
    const mins = m % 60;
    return hrs ? `${hrs} ${h.h} ${mins} ${h.min}` : `${mins} ${h.min}`;
  };

  let live: string | null = null;
  let on = false;
  if (now) {
    const s = happyHourStatus(now.day, now.minutes);
    on = s.on;
    if (s.on) live = h.on(duration(s.left));
    else {
      const time = hhmm(s.start);
      const when =
        s.dayOffset === 0 ? h.today(time) : s.dayOffset === 1 ? h.tomorrow(time) : h.onDay(h.days[(now.day + s.dayOffset) % 7], time);
      live = h.next(when, duration(s.until));
    }
  }

  return (
    <section id="happy-hour" className="relative scroll-mt-20 overflow-hidden bg-navy px-4 py-24 sm:px-6 sm:py-32">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[120%] -translate-x-1/2 rounded-full bg-copper/15 blur-3xl"
      />
      <div className="relative mx-auto max-w-6xl">
        <Reveal className="text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-copper">{h.eyebrow}</p>
          <h2 className="mx-auto mt-4 max-w-4xl font-display text-4xl font-semibold uppercase leading-[1.05] tracking-wide sm:text-6xl">
            {h.title}
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-foreground/80">{h.lead}</p>
          <p className="mt-8 flex min-h-10 justify-center" aria-live="polite">
            {live ? (
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold",
                  on ? "bg-copper text-charcoal shadow-[0_0_40px_rgba(224,141,109,0.55)]" : "bg-foreground/10 text-foreground/85",
                )}
              >
                <span aria-hidden="true" className={cn("text-base", on && "animate-bounce motion-reduce:animate-none")}>
                  {on ? "🍹" : "⏳"}
                </span>
                {live}
              </span>
            ) : null}
          </p>
        </Reveal>

        <Reveal delay={80} className="mt-8 flex flex-wrap justify-center gap-3">
          {[
            { label: h.daily, time: "15:00–18:00" },
            { label: h.late, time: "22:00–00:00" },
          ].map((row) => (
            <span
              key={row.label}
              className="inline-flex items-center gap-3 rounded-full border border-foreground/20 px-5 py-2 text-sm"
            >
              <span className="text-foreground/75">{row.label}</span>
              <span className="font-semibold tabular-nums">{row.time}</span>
            </span>
          ))}
        </Reveal>

        <h3 className="sr-only">{h.lineup}</h3>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {happyHourMenu.map((g, gi) => (
            <Reveal
              key={g.title.en}
              delay={gi * 90}
              className={cn(gi === 0 && "sm:col-span-2 lg:col-span-1 lg:row-span-2")}
            >
              <div className="group h-full rounded-3xl border border-foreground/15 bg-background/30 p-6 transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-1 hover:border-copper/60 motion-reduce:transform-none">
                <div className="flex items-baseline justify-between gap-3 border-b border-copper/40 pb-3">
                  <h4 className="text-sm font-bold uppercase tracking-[0.22em] text-copper">{g.title[lang]}</h4>
                  <span className="rounded-full bg-copper px-3 py-1 font-display text-lg font-bold tabular-nums text-charcoal transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-110 group-hover:-rotate-3 motion-reduce:transform-none">
                    {formatIsk(g.price, lang)}
                  </span>
                </div>
                <ul className="mt-3">
                  {g.items.map((i) => (
                    <li key={i.name.en} className="py-1.5">
                      <span className="font-display text-lg font-semibold">{i.name[lang]}</span>
                      {i.desc ? <span className="block text-sm text-foreground/65">{i.desc[lang]}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-8 text-center text-xs uppercase tracking-[0.15em] text-foreground/60">{h.finePrint}</p>
      </div>
    </section>
  );
}
