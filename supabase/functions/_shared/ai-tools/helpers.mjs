// Shared helpers for Atlas AI tools: venue dates, name matching and role
// checks. No business rules live here (those are in ../atlas-domain.mjs and
// ../stock-provenance.mjs).

import { MANAGER_ROLES } from "../auth.mjs";
import { ToolError } from "./result.mjs";

export const DEFAULT_TIME_ZONE = "Atlantic/Reykjavik";

export function isManagerActor(actor) {
  return Boolean(actor && actor.active === true && MANAGER_ROLES.includes(actor.role));
}

export function text(value) {
  return String(value ?? "").trim();
}

export function lower(value) {
  return text(value).toLowerCase();
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Dates. The venue business date comes from the venue clock (a closing
// checklist at 01:30 still belongs to the previous day); the calendar date in
// the venue time zone is the fallback.
// ---------------------------------------------------------------------------

export function calendarDate(nowMillis, timeZone = DEFAULT_TIME_ZONE) {
  let zone = timeZone || DEFAULT_TIME_ZONE;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(nowMillis));
  } catch {
    zone = DEFAULT_TIME_ZONE;
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(nowMillis));
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function mondayOf(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(isoDate, -weekday);
}

export function weekdayName(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}

// { businessDate, calendarDate, timezone, source, clock } for the venue.
export async function venueDates(ctx, services) {
  const nowMillis = Number(ctx.now) || Date.now();
  if (ctx.venue?.businessDate) {
    const timezone = ctx.venue.timezone || DEFAULT_TIME_ZONE;
    return { businessDate: ctx.venue.businessDate, calendarDate: calendarDate(nowMillis, timezone), timezone, source: "context", clock: null };
  }
  try {
    const clock = await services.venueClock();
    if (clock && /^\d{4}-\d{2}-\d{2}$/.test(String(clock.business_date || ""))) {
      return {
        businessDate: clock.business_date,
        calendarDate: clock.venue_date || calendarDate(nowMillis, clock.timezone),
        timezone: clock.timezone || DEFAULT_TIME_ZONE,
        source: "venue_clock",
        clock,
      };
    }
  } catch {
    // Fall back to the venue calendar date below.
  }
  const timezone = ctx.venue?.timezone || DEFAULT_TIME_ZONE;
  const date = calendarDate(nowMillis, timezone);
  return { businessDate: date, calendarDate: date, timezone, source: "calendar_fallback", clock: null };
}

// "today" | "tomorrow" | "yesterday" | ISO date → ISO date against the venue business date.
export function resolveDay(day, businessDate) {
  const value = lower(day);
  if (!value || value === "today") return businessDate;
  if (value === "tomorrow") return addDays(businessDate, 1);
  if (value === "yesterday") return addDays(businessDate, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw new ToolError("invalid_arguments", "Use today, tomorrow, yesterday or a YYYY-MM-DD date.");
}

// ---------------------------------------------------------------------------
// Name matching (record resolution). Exact name first, then every word of the
// query contained in the name. Never guesses between several candidates.
// ---------------------------------------------------------------------------

function words(value) {
  return lower(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9ðþæö]+/i).filter(Boolean);
}

export function matchByName(rows, query, { nameOf = (row) => row?.name, limit = 5 } = {}) {
  const needle = lower(query);
  if (!needle) return { status: "none", match: null, candidates: [] };
  const list = Array.isArray(rows) ? rows : [];
  const exact = list.filter((row) => lower(nameOf(row)) === needle);
  if (exact.length === 1) return { status: "unique", match: exact[0], candidates: exact };
  if (exact.length > 1) return { status: "ambiguous", match: null, candidates: exact.slice(0, limit) };
  const queryWords = words(needle);
  const partial = list.filter((row) => {
    const nameWords = words(nameOf(row)).join(" ");
    return queryWords.every((word) => nameWords.includes(word));
  });
  if (partial.length === 1) return { status: "unique", match: partial[0], candidates: partial };
  if (partial.length > 1) {
    partial.sort((a, b) => text(nameOf(a)).length - text(nameOf(b)).length);
    return { status: "ambiguous", match: null, candidates: partial.slice(0, limit) };
  }
  return { status: "none", match: null, candidates: [] };
}

export function clampLimit(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function withinDays(isoTimestamp, days, nowMillis) {
  const at = Date.parse(String(isoTimestamp || ""));
  if (!Number.isFinite(at)) return false;
  return at >= nowMillis - days * 24 * 60 * 60 * 1000 && at <= nowMillis;
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new ToolError("unavailable", "A secure identifier could not be generated.");
}
