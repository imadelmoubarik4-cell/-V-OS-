import { useEffect, useRef, useState } from "react";
import type { Copy } from "@/content";
import { Eyebrow, Reveal, reducedMotion } from "./helpers";

/** A number that counts up once when it scrolls into view (static with reduced motion). */
function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        // Years count up from 2000 so "2024" doesn't spin through every number.
        const from = value > 1900 ? 2000 : 0;
        const t0 = performance.now();
        const tick = (t: number) => {
          const p = Math.min((t - t0) / 1400, 1);
          setShown(Math.round(from + (value - from) * (1 - Math.pow(1 - p, 3))));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        setShown(from);
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);

  return (
    <span ref={ref} className="tabular-nums">
      {shown}
    </span>
  );
}

export function AboutSection({ t }: { t: Copy }) {
  const a = t.about;
  return (
    <section id="story" className="relative scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto grid max-w-6xl gap-14 md:grid-cols-[1.3fr_1fr] md:items-end">
        <Reveal>
          <Eyebrow>{a.eyebrow}</Eyebrow>
          <h2 className="font-display text-4xl font-semibold uppercase leading-[1.05] tracking-wide text-copper sm:text-6xl">
            {a.title}
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-foreground/85">{a.body}</p>
        </Reveal>
        <Reveal delay={150}>
          <dl className="grid grid-cols-3 gap-4 md:grid-cols-1 md:gap-8">
            {a.stats.map((s) => (
              <div key={s.label} className="group border-l-2 border-copper/40 pl-4 transition-colors hover:border-copper">
                <dt className="sr-only">{s.label}</dt>
                <dd className="font-display text-4xl font-semibold text-copper transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:scale-105 sm:text-6xl motion-reduce:transform-none">
                  <CountUp value={s.value} />
                </dd>
                <dd aria-hidden="true" className="mt-1 text-xs font-semibold uppercase tracking-[0.18em] text-foreground/65 sm:text-sm">
                  {s.label}
                </dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}
