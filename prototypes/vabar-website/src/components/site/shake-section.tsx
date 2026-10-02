import { useEffect, useRef, useState } from "react";
import { FlowButton } from "@/components/ui/flow-button";
import { cn } from "@/lib/utils";
import { drinks, moodLabels, site, type Copy, type Drink, type Lang, type Mood } from "@/content";
import { Eyebrow, Reveal, reducedMotion, useBurst } from "./helpers";

const MOODS = Object.keys(moodLabels) as Mood[];
const SHAKE_MS = 1400;

function pickDrink(moods: Mood[], previous: Drink | null): Drink {
  // Best matches first: drinks that share the most chosen moods.
  const scored = drinks.map((d) => ({ d, score: moods.filter((m) => d.moods.includes(m)).length }));
  const best = Math.max(...scored.map((s) => s.score));
  let pool = scored.filter((s) => s.score === best).map((s) => s.d);
  if (pool.length > 1 && previous) pool = pool.filter((d) => d.id !== previous.id);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function ShakeSection({ t, lang }: { t: Copy; lang: Lang }) {
  const [moods, setMoods] = useState<Mood[]>([]);
  const [shaking, setShaking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [drink, setDrink] = useState<Drink | null>(null);
  const timer = useRef<number | null>(null);
  const { burst, node: bits } = useBurst(["🫧", "✨", "🍋", "🧊", "🌿", "🍒"]);

  useEffect(() => () => {
    if (timer.current) cancelAnimationFrame(timer.current);
  }, []);

  const toggleMood = (m: Mood) => setMoods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));

  const shake = () => {
    if (shaking) return;
    const finish = () => {
      setShaking(false);
      setProgress(1);
      setDrink((prev) => pickDrink(moods, prev));
      burst(16);
    };
    if (reducedMotion()) return finish();

    setShaking(true);
    setDrink(null);
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / SHAKE_MS, 1);
      setProgress(p);
      if (p < 1) timer.current = requestAnimationFrame(tick);
      else finish();
    };
    timer.current = requestAnimationFrame(tick);
  };

  return (
    <section id="shake" className="relative scroll-mt-20 overflow-hidden px-4 py-24 sm:px-6 sm:py-32">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-40 top-10 size-[480px] rounded-full bg-copper/10 blur-3xl"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-2">
        <Reveal>
          <Eyebrow>{t.shake.eyebrow}</Eyebrow>
          <h2 className="font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.shake.title}</h2>
          <p className="mt-5 max-w-md text-lg text-muted-foreground">{t.shake.lead}</p>

          <fieldset className="mt-8">
            <legend className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-foreground/60">
              {t.shake.moodsLabel}
            </legend>
            <div className="flex flex-wrap gap-2">
              {MOODS.map((m) => {
                const on = moods.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleMood(m)}
                    className={cn(
                      "rounded-full border px-4 py-2 text-sm font-medium transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none",
                      on
                        ? "border-copper bg-copper text-accent-foreground shadow-[0_0_24px_rgba(224,141,109,0.35)]"
                        : "border-foreground/20 text-foreground/80 hover:border-foreground/50",
                    )}
                  >
                    {moodLabels[m][lang]}
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={moods.length === 0}
                onClick={() => setMoods([])}
                className={cn(
                  "rounded-full border border-dashed px-4 py-2 text-sm font-medium transition-all duration-300 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none",
                  moods.length === 0 ? "border-copper text-copper" : "border-foreground/20 text-foreground/60",
                )}
              >
                🎲 {t.shake.any}
              </button>
            </div>
          </fieldset>
        </Reveal>

        <Reveal delay={150} className="flex flex-col items-center">
          {/* The shaker itself is the main button */}
          <div className="relative">
            <button
              type="button"
              onClick={shake}
              disabled={shaking}
              className={cn(
                "group relative grid size-56 place-items-center rounded-full border border-foreground/15 bg-gradient-to-b from-card to-background shadow-[0_30px_80px_-20px_rgba(224,141,109,0.35)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-105 active:scale-95 disabled:cursor-wait motion-reduce:transform-none sm:size-64",
              )}
            >
              <span className="sr-only">{shaking ? t.shake.shaking : drink ? t.shake.again : t.shake.button}</span>
              {/* progress ring */}
              <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
                <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(237,232,224,0.08)" strokeWidth="2" />
                <circle
                  cx="50"
                  cy="50"
                  r="47"
                  fill="none"
                  stroke="url(#shake-grad)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={295.3}
                  strokeDashoffset={295.3 * (1 - progress)}
                />
                <defs>
                  <linearGradient id="shake-grad" x1="0" x2="1">
                    <stop offset="0" stopColor="#e08d6d" />
                    <stop offset="1" stopColor="#a15c3f" />
                  </linearGradient>
                </defs>
              </svg>
              <span aria-hidden="true" className="flex flex-col items-center gap-3">
                <Shaker className={cn("h-24 w-auto drop-shadow-[0_10px_20px_rgba(0,0,0,0.5)]", shaking && "animate-shake")} />
                <span className="font-display text-xl font-semibold transition-colors group-hover:text-copper">
                  {shaking ? t.shake.shaking : drink ? t.shake.again : t.shake.button}
                </span>
              </span>
            </button>
            {bits}
          </div>

          <div className="mt-8 min-h-48 w-full max-w-md" aria-live="polite">
            {drink ? (
              <div
                key={drink.id + progress}
                className="animate-flip-in rounded-3xl border border-foreground/10 bg-card/80 p-6 shadow-2xl backdrop-blur"
              >
                <p className="text-xs uppercase tracking-[0.2em] text-copper">{t.shake.result}</p>
                <p className="mt-2 flex items-center gap-3 font-display text-4xl font-semibold">
                  <span aria-hidden="true" className="text-3xl">
                    {drink.emoji}
                  </span>
                  {drink.name}
                </p>
                <p className="mt-3 text-muted-foreground">{drink.notes[lang]}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {drink.moods.map((m) => (
                    <span key={m} className="rounded-full bg-foreground/5 px-2.5 py-1 text-xs text-foreground/70">
                      {moodLabels[m][lang]}
                    </span>
                  ))}
                </div>
                <div className="mt-6">
                  <FlowButton href={site.menuUrl} text={t.shake.menu} tone="light" />
                </div>
              </div>
            ) : null}
          </div>
          <p className="mt-2 max-w-md text-center text-xs text-foreground/50">{t.shake.footnote}</p>
        </Reveal>
      </div>
    </section>
  );
}

function Shaker({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 60 110" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="steel" x1="0" x2="1">
          <stop offset="0" stopColor="#8f9a96" />
          <stop offset="0.35" stopColor="#eef2ef" />
          <stop offset="0.6" stopColor="#b9c3bf" />
          <stop offset="1" stopColor="#6c7672" />
        </linearGradient>
      </defs>
      <rect x="22" y="2" width="16" height="8" rx="3" fill="#a15c3f" />
      <path d="M17 10h26l-3 18H20z" fill="url(#steel)" />
      <rect x="14" y="27" width="32" height="5" rx="2" fill="#a15c3f" />
      <path d="M14 32h32l-5 74a4 4 0 0 1-4 4H23a4 4 0 0 1-4-4z" fill="url(#steel)" />
      <path d="M22 45h3l-2 50h-3z" fill="#fff" opacity="0.5" />
    </svg>
  );
}
