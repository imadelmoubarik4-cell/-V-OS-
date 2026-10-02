import { useEffect, useState } from "react";
import { Clock, MapPin } from "lucide-react";
import { FlowButton } from "@/components/ui/flow-button";
import { cn } from "@/lib/utils";
import { site, type Copy, type Hours } from "@/content";
import { Eyebrow, Reveal } from "./helpers";

const TZ = "Atlantic/Reykjavik";

/** Weekday (0 = Sunday) and minutes since midnight in Reykjavík. */
function reykjavikNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** True when open now, counting yesterday's late hours that run past midnight. */
export function isOpen(hours: Hours, now = reykjavikNow()) {
  const today = hours[now.day];
  if (today) {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    if (close > open ? now.minutes >= open && now.minutes < close : now.minutes >= open) return true;
  }
  const yesterday = hours[(now.day + 6) % 7];
  if (yesterday) {
    const open = toMinutes(yesterday.open);
    const close = toMinutes(yesterday.close);
    if (close <= open && now.minutes < close) return true;
  }
  return false;
}

export function VisitSection({ t }: { t: Copy }) {
  const hours = site.hours;
  const [now, setNow] = useState(reykjavikNow);
  // The open/closed badge and today's row depend on the visitor's clock, so they appear only
  // in the browser (not in the prerendered HTML).
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setNow(reykjavikNow());
    const id = window.setInterval(() => setNow(reykjavikNow()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const open = hours && mounted ? isOpen(hours, now) : null;
  // Monday first
  const order = [1, 2, 3, 4, 5, 6, 0];

  return (
    <section id="visit" className="relative scroll-mt-20 px-4 py-24 sm:px-6 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <Eyebrow>{t.visit.eyebrow}</Eyebrow>
          <h2 className="max-w-3xl font-display text-4xl font-semibold leading-[1.05] sm:text-6xl">{t.visit.title}</h2>
          <p className="mt-5 max-w-lg text-lg text-muted-foreground">{t.visit.lead}</p>
        </Reveal>

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <Reveal delay={100}>
            <div className="group h-full rounded-3xl border border-foreground/10 bg-card p-8 transition-all duration-500 hover:-translate-y-1 hover:border-copper/40 hover:shadow-[0_20px_60px_-20px_rgba(224,141,109,0.35)] motion-reduce:transform-none">
              <div className="flex items-center gap-3 text-sm uppercase tracking-[0.2em] text-foreground/60">
                <MapPin className="size-4 text-copper transition-transform duration-500 group-hover:-translate-y-1 group-hover:scale-125" />
                {t.visit.where}
              </div>
              <address className="mt-4 not-italic">
                <p className="font-display text-3xl font-semibold">{site.name}</p>
                <p className="mt-2 text-lg">{site.venue}</p>
                <p className="text-lg text-muted-foreground">
                  {site.street}, {site.postcode} {site.city}
                </p>
              </address>
              <div className="mt-8 flex flex-wrap gap-3">
                <FlowButton href={site.mapsUrl} target="_blank" rel="noopener" text={t.visit.directions} tone="light" />
                <FlowButton href={site.menuUrl} text={t.visit.menu} tone="light" />
              </div>
            </div>
          </Reveal>

          <Reveal delay={200}>
            <div className="group h-full rounded-3xl border border-foreground/10 bg-card p-8 transition-all duration-500 hover:-translate-y-1 hover:border-copper/40 hover:shadow-[0_20px_60px_-20px_rgba(161,92,63,0.35)] motion-reduce:transform-none">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 text-sm uppercase tracking-[0.2em] text-foreground/60">
                  <Clock className="size-4 text-copper transition-transform duration-700 group-hover:rotate-[360deg]" />
                  {t.visit.hours}
                </div>
                {open !== null ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold",
                      open ? "bg-copper/15 text-copper" : "bg-foreground/10 text-foreground/70",
                    )}
                  >
                    <span className={cn("size-2 rounded-full", open ? "animate-pulse bg-copper" : "bg-foreground/40")} />
                    {open ? t.visit.openNow : t.visit.closedNow}
                  </span>
                ) : null}
              </div>

              {hours ? (
                <ul className="mt-6 divide-y divide-foreground/10">
                  {order.map((d) => {
                    const h = hours[d];
                    return (
                      <li
                        key={d}
                        className={cn(
                          "flex justify-between py-2.5 text-sm",
                          mounted && d === now.day && "font-semibold text-copper",
                        )}
                      >
                        <span className="capitalize">{t.visit.days[d]}</span>
                        <span className="tabular-nums">{h ? `${h.open}–${h.close}` : "—"}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-6 text-lg text-muted-foreground">{t.visit.hoursUnset}</p>
              )}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
