import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Fades children up the first time they scroll into view. */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion()) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        "reveal transition-all duration-[900ms] ease-[cubic-bezier(0.19,1,0.22,1)] motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0",
        className,
      )}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

type Bit = { id: number; dx: number; dy: number; rot: number; char: string };

/** A burst of little characters (bubbles, sparkles) from the centre of its parent. */
export function useBurst(chars: string[]) {
  const [bits, setBits] = useState<Bit[]>([]);
  const next = useRef(0);

  const burst = (count = 12) => {
    if (reducedMotion()) return;
    const fresh = Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 90;
      return {
        id: next.current++,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist - 30,
        rot: (Math.random() - 0.5) * 120,
        char: chars[Math.floor(Math.random() * chars.length)],
      };
    });
    setBits((b) => [...b, ...fresh]);
    const ids = new Set(fresh.map((f) => f.id));
    window.setTimeout(() => setBits((b) => b.filter((x) => !ids.has(x.id))), 950);
  };

  const node = (
    <span aria-hidden="true">
      {bits.map((b) => (
        <span
          key={b.id}
          className="pop-bit text-xl"
          style={{ "--dx": `${b.dx}px`, "--dy": `${b.dy}px`, "--rot": `${b.rot}deg` } as React.CSSProperties}
        >
          {b.char}
        </span>
      ))}
    </span>
  );

  return { burst, node };
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-copper/30 bg-copper/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-copper">
      <span className="size-1.5 animate-pulse rounded-full bg-copper motion-reduce:animate-none" />
      {children}
    </p>
  );
}

/** Soft copper glow that follows the pointer (fine pointers only, decorative). */
export function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches || reducedMotion()) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.transform = `translate(${e.clientX - 200}px, ${e.clientY - 200}px)`;
        el.style.opacity = "1";
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-[5] size-[400px] rounded-full opacity-0 mix-blend-screen transition-opacity duration-500"
      style={{ background: "radial-gradient(circle, rgba(224,141,109,0.10), rgba(45,86,104,0.06) 40%, transparent 70%)" }}
    />
  );
}
