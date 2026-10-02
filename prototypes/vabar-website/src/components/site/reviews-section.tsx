import { reviews, type Copy } from "@/content";
import { Eyebrow, Reveal } from "./helpers";

// Each bubble sits at its own slight angle and straightens up on hover.
const TILTS = ["-rotate-1", "rotate-1", "-rotate-[0.5deg]"];
const OFFSETS = ["md:mr-24", "md:ml-16 md:mr-8", "md:ml-32"];

export function ReviewsSection({ t }: { t: Copy }) {
  return (
    <section id="reviews" className="relative scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <Reveal className="text-center">
          <Eyebrow>{t.reviews.eyebrow}</Eyebrow>
          <h2 className="font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.reviews.title}</h2>
        </Reveal>
        <ul className="mt-12 flex flex-col gap-6">
          {reviews.map((r, i) => (
            <Reveal as="li" key={r.author} delay={i * 120}>
              <div
                className={`group relative rounded-[2.5rem] rounded-bl-md border border-copper/40 bg-card/60 p-7 transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:rotate-0 hover:border-copper hover:bg-card sm:p-9 motion-reduce:transform-none ${TILTS[i % 3]} ${OFFSETS[i % 3]}`}
              >
                <span
                  aria-hidden="true"
                  className="absolute -top-6 left-8 font-display text-7xl leading-none text-copper transition-transform duration-500 group-hover:-translate-y-1 group-hover:rotate-6"
                >
                  “
                </span>
                <blockquote className="text-lg leading-relaxed text-foreground/90">{r.quote}</blockquote>
                <p className="mt-4 text-sm">
                  <span className="font-semibold">{r.author}</span>
                  <span className="text-foreground/60"> · {t.reviews.review(r.source)}</span>
                </p>
              </div>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
