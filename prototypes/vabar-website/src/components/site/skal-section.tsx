import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Copy } from "@/content";
import { Eyebrow, Reveal, useBurst } from "./helpers";

const STORAGE_KEY = "va-skal-count";
const LEVEL_STEPS = [0, 5, 15, 30];

const readCount = () => {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
};

export function SkalSection({ t }: { t: Copy }) {
  const [count, setCount] = useState(readCount);
  const [clinking, setClinking] = useState(false);
  const { burst, node: bits } = useBurst(["✨", "🥂", "💚", "⭐", "🎉"]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(count));
    } catch {
      /* storage blocked: the counter still works for this visit */
    }
  }, [count]);

  const level = LEVEL_STEPS.reduce((acc, step, i) => (count >= step ? i : acc), 0);
  const nextStep = LEVEL_STEPS[level + 1];
  const levelProgress = nextStep ? (count - LEVEL_STEPS[level]) / (nextStep - LEVEL_STEPS[level]) : 1;

  const skal = () => {
    setCount((c) => c + 1);
    setClinking(false);
    requestAnimationFrame(() => setClinking(true));
    burst(10 + level * 4);
  };

  return (
    <section id="skal" className="relative scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="relative overflow-hidden rounded-[2rem] border border-foreground/10 bg-gradient-to-br from-[#143a4d] via-card to-[#2d5668] p-8 sm:p-14">
            {/* copper ribbons, brighter with every level */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[140%] -translate-x-1/2 rotate-[-6deg] rounded-full blur-3xl transition-opacity duration-1000"
              style={{
                background: "linear-gradient(90deg, transparent, rgba(224,141,109,0.55), rgba(45,86,104,0.45), transparent)",
                opacity: 0.25 + level * 0.22,
              }}
            />

            <div className="relative grid items-center gap-10 md:grid-cols-[1.2fr_1fr]">
              <div>
                <Eyebrow>{t.skal.eyebrow}</Eyebrow>
                <h2 className="font-display text-5xl font-semibold sm:text-7xl">{t.skal.title}</h2>
                <p className="mt-4 max-w-md text-lg text-muted-foreground">{t.skal.lead}</p>

                <div className="mt-8 max-w-sm">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium text-copper">{t.skal.levels[level]}</span>
                    <span className="tabular-nums text-foreground/60" aria-live="polite">
                      {t.skal.count(count)}
                    </span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-rust via-copper to-[#f3c4ae] transition-[width] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                      style={{ width: `${Math.max(levelProgress * 100, 4)}%` }}
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-foreground/50">
                    <span>{t.skal.note}</span>
                    {count > 0 ? (
                      <button type="button" onClick={() => setCount(0)} className="underline-offset-4 hover:text-foreground hover:underline">
                        {t.skal.reset}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex justify-center">
                <div className="relative">
                  <button
                    type="button"
                    onClick={skal}
                    onAnimationEnd={() => setClinking(false)}
                    className={cn(
                      "group relative grid size-52 place-items-center rounded-full bg-foreground text-background shadow-[0_0_0_10px_rgba(237,232,224,0.06),0_30px_80px_-20px_rgba(45,86,104,0.6)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:-rotate-3 hover:scale-105 active:scale-90 motion-reduce:transform-none sm:size-60",
                      clinking && "clink",
                    )}
                  >
                    <span className="flex flex-col items-center">
                      <span aria-hidden="true" className="flex text-5xl">
                        <span className="glass-left inline-block origin-bottom">🥂</span>
                      </span>
                      <span className="mt-2 font-display text-3xl font-bold">{t.skal.button}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 rounded-full border-2 border-foreground/0 transition-all duration-500 group-hover:scale-110 group-hover:border-copper/60"
                    />
                  </button>
                  {bits}
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
