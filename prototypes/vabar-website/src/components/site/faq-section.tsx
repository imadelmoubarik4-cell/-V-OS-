import type { Copy } from "@/content";
import { Eyebrow, Reveal } from "./helpers";

/** FAQ as native <details> (works without JavaScript and keeps every answer in the HTML for search). */
export function FaqSection({ t }: { t: Copy }) {
  return (
    <section id="faq" className="relative scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-4xl">
        <Reveal className="text-center">
          <Eyebrow>{t.faq.eyebrow}</Eyebrow>
          <h2 className="font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.faq.title}</h2>
        </Reveal>
        <Reveal delay={120} className="mt-12">
          <div className="divide-y divide-foreground/15 overflow-hidden rounded-3xl border border-foreground/15 bg-card/50">
            {t.faq.items.map((item) => (
              <details key={item.q} className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 px-6 py-5 text-lg font-medium transition-colors hover:bg-foreground/5 hover:text-copper sm:px-8 [&::-webkit-details-marker]:hidden">
                  <span>{item.q}</span>
                  <span
                    aria-hidden="true"
                    className="grid size-9 shrink-0 place-items-center rounded-full border border-foreground/25 text-xl leading-none transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-open:rotate-[135deg] group-open:border-copper group-open:bg-copper group-open:text-charcoal motion-reduce:transition-none"
                  >
                    +
                  </span>
                </summary>
                <p className="px-6 pb-6 text-base leading-relaxed text-foreground/85 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 sm:px-8">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
