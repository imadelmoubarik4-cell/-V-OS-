import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { photos, type Copy, type Lang } from "@/content";
import { Eyebrow, Reveal, reducedMotion } from "./helpers";

const FLY_MS = 420;
const SWIPE_PX = 80;
// Resting tilt and offset for the cards under the top one, so the deck looks hand-dealt.
const STACK = [
  { r: 0, x: 0, y: 0 },
  { r: 5, x: 14, y: 8 },
  { r: -6, x: -14, y: 14 },
  { r: 3, x: 6, y: 20 },
  { r: -3, x: -6, y: 24 },
];

/** "Behind the bar": a stack of photos you tap, swipe or arrow through. */
export function BarSection({ t, lang }: { t: Copy; lang: Lang }) {
  const [order, setOrder] = useState(() => photos.map((_, i) => i));
  const [fly, setFly] = useState<0 | 1 | -1>(0); // direction the top card is leaving in
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; moved: boolean } | null>(null);
  const busy = useRef(false);

  const top = order[0];
  const current = photos[top];

  const next = (dir: 1 | -1 = 1) => {
    if (busy.current) return;
    const rotate = () => setOrder((o) => [...o.slice(1), o[0]]);
    if (reducedMotion()) {
      rotate();
      return;
    }
    busy.current = true;
    setFly(dir);
    window.setTimeout(() => {
      rotate();
      setFly(0);
      setDrag(0);
      busy.current = false;
    }, FLY_MS);
  };

  const prev = () => {
    if (busy.current) return;
    setOrder((o) => [o[o.length - 1], ...o.slice(0, -1)]);
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    start.current = { x: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!start.current || reducedMotion()) return;
    const dx = e.clientX - start.current.x;
    if (Math.abs(dx) > 6) start.current.moved = true;
    setDrag(dx);
  };
  const onPointerUp = () => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (!s.moved) {
      next(1); // a tap deals the next photo
      return;
    }
    if (Math.abs(drag) > SWIPE_PX) next(drag > 0 ? 1 : -1);
    else setDrag(0);
  };

  const onPointerCancel = () => {
    start.current = null;
    setDrag(0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      next(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prev();
    }
  };

  const position = photos.indexOf(current) + 1;

  return (
    <section id="bar" className="relative scroll-mt-20 overflow-hidden px-4 py-24 sm:px-6 sm:py-32">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-40 top-1/4 size-[520px] rounded-full bg-ocean/30 blur-3xl"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 md:grid-cols-[1fr_auto]">
        <Reveal>
          <Eyebrow>{t.bar.eyebrow}</Eyebrow>
          <h2 className="max-w-xl font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.bar.title}</h2>
          <p className="mt-5 max-w-md text-lg text-muted-foreground">{t.bar.lead}</p>

          <div className="mt-10 flex items-center gap-4">
            <button
              type="button"
              onClick={prev}
              aria-label={t.bar.prev}
              className="grid size-12 place-items-center rounded-full border border-foreground/25 transition-all duration-300 hover:-translate-x-0.5 hover:border-copper hover:text-copper active:scale-90 motion-reduce:transform-none"
            >
              <ArrowLeft className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => next(1)}
              aria-label={t.bar.next}
              className="grid size-12 place-items-center rounded-full bg-copper text-charcoal shadow-[0_10px_30px_-10px_rgba(224,141,109,0.8)] transition-all duration-300 hover:translate-x-0.5 hover:scale-105 active:scale-90 motion-reduce:transform-none"
            >
              <ArrowRight className="size-5" />
            </button>
            <p className="ml-2 min-w-0" aria-live="polite">
              <span className="block font-display text-xl font-semibold">{current.caption[lang]}</span>
              <span className="text-sm tabular-nums text-foreground/60">
                {String(position).padStart(2, "0")} {t.bar.of} {String(photos.length).padStart(2, "0")}
              </span>
            </p>
          </div>
        </Reveal>

        <Reveal delay={150} className="justify-self-center">
          <div
            role="region"
            aria-roledescription="carousel"
            aria-label={t.bar.deck}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="relative aspect-[9/16] w-[min(70vw,340px)] rounded-[28px] focus-visible:outline-2 focus-visible:outline-offset-8"
          >
            {order
              .map((photoIndex, depth) => ({ photo: photos[photoIndex], depth }))
              .reverse()
              .map(({ photo, depth }) => {
                const isTop = depth === 0;
                const pose = STACK[Math.min(depth, STACK.length - 1)];
                const flying = isTop && fly !== 0;
                const transform = flying
                  ? `translateX(${fly * 130}%) rotate(${fly * 22}deg)`
                  : isTop && drag
                    ? `translateX(${drag}px) rotate(${drag / 18}deg)`
                    : `translate(${pose.x}px, ${pose.y}px) rotate(${pose.r}deg)`;
                return (
                  <button
                    key={photo.id}
                    type="button"
                    tabIndex={-1}
                    aria-hidden={!isTop}
                    disabled={!isTop}
                    onPointerDown={isTop ? onPointerDown : undefined}
                    onPointerMove={isTop ? onPointerMove : undefined}
                    onPointerUp={isTop ? onPointerUp : undefined}
                    onPointerCancel={isTop ? onPointerCancel : undefined}
                    className={cn(
                      "absolute inset-0 touch-pan-y select-none overflow-hidden rounded-[28px] border-[6px] border-[#f5f1ec] bg-charcoal shadow-[0_30px_60px_-20px_rgba(0,0,0,0.7)]",
                      isTop ? "cursor-grab active:cursor-grabbing" : "cursor-default",
                      // no transition while following the finger, so the card sticks to it
                      !(isTop && drag && !flying) && "transition-transform duration-[420ms] ease-[cubic-bezier(0.34,1.4,0.64,1)]",
                      "motion-reduce:transition-none",
                    )}
                    style={{ transform, zIndex: photos.length - depth, opacity: flying ? 0 : 1, transitionProperty: "transform, opacity" }}
                  >
                    <img
                      src={photo.src}
                      alt={isTop ? photo.alt[lang] : ""}
                      width={720}
                      height={1280}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      className="size-full object-cover"
                      style={{ objectPosition: photo.position ?? "50% 50%" }}
                    />
                  </button>
                );
              })}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
