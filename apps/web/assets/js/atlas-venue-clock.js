// Atlas venue clock: the one browser source for operational time.
//
// Every operational date, time and "is the venue open" answer in the browser
// comes from here, in the VENUE time zone (Settings -> venue.timezone, served
// by atlas-settings GET ?action=venue-clock). The browser's own zone is never
// used for an operational date: an owner travelling abroad or a phone set to
// another zone sees the same business day, times and countdowns as the bar.
//
// Loaded as a classic script after atlas-shell.js and config.js.
//
//   state      load() · refresh() · state() · apply(clockPayload) · onChange(fn)
//              state().status: 'loading' | 'ready' | 'not_set' | 'unavailable'
//   zone       timeZone() · timezoneIsDefault() · parts(at)
//   dates      today() · tomorrow() · businessDate(at) · venueDate(at) · weekday(date)
//              addDays(dateKey, n) · startOfWeek(date) · monthKey(date) · monthRange(date)
//              compareRange(period) · zonedToInstant(dateKey, 'HH:MM')
//   format     formatTime · formatDate · formatDateTime · formatRelative · formatKr
//   inputs     localInputValue(date, type) · fromLocalInput(value)
//   hours      dayWindow(dateKey) · isOpenAt(at) · nextEvent(at, {types}) · timeline(dateKey, at)
//
// Rules (docs/design/Atlas_Time_Migration.md):
// - Date-only values are 'YYYY-MM-DD' strings. Arithmetic on them is done at
//   UTC noon, which is independent of every zone and of DST.
// - Instants are Date objects or ISO strings; they are displayed and split into
//   dates only through Intl with timeZone = the venue zone.
// - Hours come only from the saved business hours. With no saved hours (the
//   production state until a manager saves them) status is 'not_set' and every
//   hours helper returns null / [] — nothing is invented.
// - The fallback zone Atlantic/Reykjavik is used only when the venue setting is
//   missing or the clock is unavailable, and state().timezoneIsDefault says so.
(function (root) {
  'use strict';

  if (root.AtlasVenueClock) return;

  const DEFAULT_TIME_ZONE = 'Atlantic/Reykjavik';
  const REQUEST_TIMEOUT_MS = 15000;
  const DAY_MS = 86400000;
  const MAX_TIMER_MS = 6 * 3600000;
  const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME_OF_DAY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  const LOCAL_INPUT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)$/;
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const EVENT_LABELS =Object.freeze({ opens: 'Opens', last_orders: 'Last orders', kitchen_closes: 'Kitchen closes', closes: 'Closes' });
  const SETTINGS_ACTIONS_THAT_MOVE_TIME = new Set(['save-hours', 'save-offer']);

  const clock = {
    status: 'loading',
    payload: null,
    staff: null,
    error: null,
    loadedAt: 0,
    inflight: null,
    rolloverTimer: null
  };
  const listeners = new Set();
  const formatters = new Map();

  // ---------- zone primitives ----------

  function timeZone() {
    const zone = clock.payload?.timezone;
    return typeof zone === 'string' && zone && validZone(zone) ? zone : DEFAULT_TIME_ZONE;
  }

  function timezoneIsDefault() {
    return !clock.payload || clock.payload.timezone_source !== 'settings' || timeZone() !== clock.payload.timezone;
  }

  function validZone(zone) {
    try {
      formatter(zone);
      return true;
    } catch {
      return false;
    }
  }

  function formatter(zone) {
    let entry = formatters.get(zone);
    if (!entry) {
      entry = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      formatters.set(zone, entry);
    }
    return entry;
  }

  function toDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value === 'number') return new Date(value);
    if (typeof value === 'string' && value) {
      if (DATE_KEY.test(value)) return zonedToInstant(value, '00:00');
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? new Date(parsed) : null;
    }
    if (value === undefined) return new Date();
    return null;
  }

  function validDate(date) {
    return date instanceof Date && Number.isFinite(date.getTime());
  }

  /** Wall-clock parts of an instant in the venue zone (or `zone`). */
  function parts(at, zone = timeZone()) {
    const date = at === undefined ? new Date() : toDate(at);
    if (!validDate(date)) return null;
    const out = {};
    formatter(zone).formatToParts(date).forEach((part) => { out[part.type] = part.value; });
    const hour = Number(out.hour) % 24;
    return {
      year: Number(out.year), month: Number(out.month), day: Number(out.day),
      hour, minute: Number(out.minute), second: Number(out.second),
      weekday: WEEKDAY_INDEX[out.weekday],
      dateKey: `${out.year}-${out.month}-${out.day}`,
      time: `${String(hour).padStart(2, '0')}:${out.minute}`
    };
  }

  function offsetMs(instantMs, zone) {
    const p = parts(new Date(instantMs), zone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - Math.floor(instantMs / 1000) * 1000;
  }

  /** Venue wall time ('YYYY-MM-DD', 'HH:MM[:SS]') → Date. The offset is solved twice so DST days are right. */
  function zonedToInstant(dateKey, time = '00:00', zone = timeZone()) {
    const d = DATE_KEY.exec(String(dateKey || ''));
    const t = TIME_OF_DAY.exec(String(time || ''));
    if (!d || !t || !keyToNoon(d[0])) return null;
    const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), Number(t[3] || 0));
    let result = guess - offsetMs(guess, zone);
    const second = guess - offsetMs(result, zone);
    if (second !== result) result = second;
    return new Date(result);
  }

  // ---------- date keys (UTC-noon arithmetic, zone independent) ----------

  function keyToNoon(dateKey) {
    const d = DATE_KEY.exec(String(dateKey || ''));
    if (!d) return null;
    const noon = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 12));
    // Reject impossible dates such as 2026-02-30 instead of rolling them over.
    return noonToKey(noon) === d[0] ? noon : null;
  }

  function noonToKey(date) {
    return date.toISOString().slice(0, 10);
  }

  function dateKeyOf(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'string' && DATE_KEY.test(value)) return keyToNoon(value) ? value : null;
    const p = parts(value);
    return p ? p.dateKey : null;
  }

  function addDays(date, n) {
    const noon = keyToNoon(dateKeyOf(date));
    if (!noon) return null;
    noon.setUTCDate(noon.getUTCDate() + Number(n || 0));
    return noonToKey(noon);
  }

  /** 0 = Sunday … 6 = Saturday, like settings_business_hours.weekday. */
  function weekday(date) {
    const noon = keyToNoon(dateKeyOf(date));
    return noon ? noon.getUTCDay() : null;
  }

  function daysBetween(fromKey, toKey) {
    const a = keyToNoon(fromKey);
    const b = keyToNoon(toKey);
    return a && b ? Math.round((b - a) / DAY_MS) : null;
  }

  function venueDate(at) {
    return dateKeyOf(at === undefined ? new Date() : at);
  }

  function hourRows() {
    return Array.isArray(clock.payload?.business_hours) ? clock.payload.business_hours : [];
  }

  function rowFor(dateKey) {
    const day = weekday(dateKey);
    return hourRows().find((row) => Number(row.weekday) === day) || null;
  }

  function hhmm(value) {
    const t = TIME_OF_DAY.exec(String(value || ''));
    return t ? `${t[1].padStart(2, '0')}:${t[2]}` : null;
  }

  function minutesOf(value) {
    const t = TIME_OF_DAY.exec(String(value || ''));
    return t ? Number(t[1]) * 60 + Number(t[2]) : null;
  }

  /**
   * Operational (business) date of an instant. Same rule as
   * atlas_private.venue_business_date: while the venue is still inside the
   * previous day's after-midnight close (close_next_day), it is still the
   * previous business day. Without saved hours it is the venue calendar date.
   */
  function businessDate(at) {
    const p = parts(at === undefined ? new Date() : at);
    if (!p) return null;
    const previous = addDays(p.dateKey, -1);
    const row = rowFor(previous);
    if (row && row.is_open && row.close_next_day && row.close_time) {
      const close = minutesOf(row.close_time);
      if (close !== null && p.hour * 60 + p.minute < close) return previous;
    }
    return p.dateKey;
  }

  /** The operational day now (the business date). Use venueDate() for the calendar date. */
  function today() {
    return businessDate(new Date());
  }

  function tomorrow() {
    return addDays(today(), 1);
  }

  /** Monday of the week containing `date`, in the venue zone. */
  function startOfWeek(date) {
    const key = dateKeyOf(date === undefined ? today() : date);
    const day = weekday(key);
    return day === null ? null : addDays(key, -((day + 6) % 7));
  }

  function monthKey(date) {
    if (typeof date === 'string' && /^\d{4}-\d{2}$/.test(date)) return date;
    const key = dateKeyOf(date === undefined ? today() : date);
    return key ? key.slice(0, 7) : null;
  }

  /** { month:'YYYY-MM', start:'YYYY-MM-01', end:'YYYY-MM-<last>', days } for the month of `date`. */
  function monthRange(date) {
    const month = monthKey(date);
    if (!month) return null;
    const [year, mon] = month.split('-').map(Number);
    const last = new Date(Date.UTC(year, mon, 0, 12)).getUTCDate();
    return { month, start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`, days: last };
  }

  /**
   * The comparison period for a report period { start, end } (inclusive date keys).
   * Rule:
   *  1. A period that is exactly one full calendar month compares with the full
   *     previous calendar month (September 1–30 → August 1–31).
   *  2. Any other period compares with the period of the same number of days
   *     that ends the day before it starts (2026-08-25..2026-09-23, 30 days →
   *     2026-07-26..2026-08-24).
   * Date keys only, so month lengths and DST never shift the result.
   */
  function compareRange(period) {
    const start = dateKeyOf(period?.start);
    const end = dateKeyOf(period?.end);
    if (!start || !end) return null;
    const span = daysBetween(start, end);
    if (span === null || span < 0) return null;
    const days = span + 1;
    const month = monthRange(start);
    if (month && start === month.start && end === month.end) {
      const previous = monthRange(addDays(start, -1));
      return { start: previous.start, end: previous.end, days: previous.days, rule: 'previous_month' };
    }
    const previousEnd = addDays(start, -1);
    return { start: addDays(previousEnd, 1 - days), end: previousEnd, days, rule: 'previous_period' };
  }

  // ---------- formatting (venue zone, 24 h, en-GB wording) ----------

  function intl(date, options) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), ...options }).format(date);
  }

  /** '17:00'. Accepts a Date, an ISO instant, or a plain time of day ('17:00:00'). */
  function formatTime(value, fallback = '') {
    if (typeof value === 'string' && TIME_OF_DAY.test(value)) return hhmm(value);
    const date = toDate(value);
    if (!validDate(date)) return fallback;
    return intl(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }

  /**
   * 'Thu 24 Sep' (default) or 'Thursday 24 September' ({ long: true }); add the
   * year with { year: true }. A 'YYYY-MM-DD' key is formatted as that calendar
   * date; an instant as its venue date.
   */
  function formatDate(value, options = {}, fallback = '') {
    const key = typeof value === 'string' && DATE_KEY.test(value) ? value : dateKeyOf(value === undefined ? new Date() : value);
    const noon = keyToNoon(key);
    if (!noon) return fallback;
    // Spelled out rather than Intl so every browser prints 'Sep' (ICU en-GB says 'Sept').
    const weekdayName = WEEKDAY_NAMES[noon.getUTCDay()];
    const monthName = MONTH_NAMES[noon.getUTCMonth()];
    const text = options.long
      ? `${weekdayName} ${noon.getUTCDate()} ${monthName}`
      : `${weekdayName.slice(0, 3)} ${noon.getUTCDate()} ${monthName.slice(0, 3)}`;
    return options.year ? `${text} ${noon.getUTCFullYear()}` : text;
  }

  /** 'Thu 24 Sep, 17:00' in the venue zone. */
  function formatDateTime(value, options = {}, fallback = '') {
    if (typeof value === 'string' && DATE_KEY.test(value)) return formatDate(value, options, fallback);
    const date = toDate(value);
    if (!validDate(date)) return fallback;
    return `${formatDate(date, options)}, ${formatTime(date)}`;
  }

  /** Relative only under 24 h ('just now', '12 min ago', 'in 3 h'); otherwise formatDateTime. */
  function formatRelative(value, at, fallback = '') {
    const date = toDate(value);
    const now = at === undefined ? new Date() : toDate(at);
    if (!validDate(date) || !validDate(now)) return fallback;
    const diff = date.getTime() - now.getTime();
    const abs = Math.abs(diff);
    if (abs < 60000) return 'just now';
    if (abs < 3600000) {
      const minutes = Math.round(abs / 60000);
      return diff < 0 ? `${minutes} min ago` : `in ${minutes} min`;
    }
    if (abs < DAY_MS) {
      const hours = Math.floor(abs / 3600000);
      return diff < 0 ? `${hours} h ago` : `in ${hours} h`;
    }
    return formatDateTime(date);
  }

  /** '3.900 kr' (is-IS grouping, whole krónur; spec §11 decision 5). */
  function formatKr(value, fallback = '—') {
    const amount = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
    if (value === null || value === undefined || !Number.isFinite(amount)) return fallback;
    const rounded = Math.round(amount);
    const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${rounded < 0 ? '-' : ''}${grouped} kr`;
  }

  // ---------- form inputs in the venue zone ----------

  /**
   * Value for <input type="datetime-local"> ('YYYY-MM-DDTHH:MM', venue wall
   * time) or, with type 'date', for <input type="date"> ('YYYY-MM-DD').
   */
  function localInputValue(value, type = 'datetime-local') {
    if (value === null || value === '') return '';
    if (typeof value === 'string' && DATE_KEY.test(value)) return type === 'date' ? value : `${value}T00:00`;
    const p = parts(value === undefined ? new Date() : value);
    if (!p) return '';
    return type === 'date' ? p.dateKey : `${p.dateKey}T${p.time}`;
  }

  /**
   * Inverse of localInputValue. A datetime-local value is read as VENUE wall
   * time and returned as an ISO instant ('…Z'); a date value stays a date key.
   * Invalid input → null.
   */
  function fromLocalInput(value) {
    const text = String(value || '').trim();
    if (DATE_KEY.test(text)) return keyToNoon(text) ? text : null;
    const match = LOCAL_INPUT.exec(text);
    if (!match || !keyToNoon(match[1])) return null;
    const instant = zonedToInstant(match[1], match[2]);
    return validDate(instant) ? instant.toISOString() : null;
  }

  // ---------- hours ----------

  function hoursUsable() {
    return clock.status === 'ready';
  }

  function atDay(dateKey, time, nextDay) {
    return time ? zonedToInstant(nextDay ? addDays(dateKey, 1) : dateKey, time) : null;
  }

  /**
   * The saved service window of a business date:
   * { state: 'loading'|'unavailable'|'not_set'|'closed'|'open', dateKey, open, close, lastOrder, kitchenClose }.
   * 'open' means the day has opening hours, not that the venue is open now.
   */
  function dayWindow(dateKey) {
    const key = dateKeyOf(dateKey === undefined ? today() : dateKey);
    if (clock.status !== 'ready') return { state: clock.status, dateKey: key };
    const row = rowFor(key);
    if (!row || !row.is_open || !row.open_time || !row.close_time) return { state: 'closed', dateKey: key, row };
    const open = atDay(key, row.open_time, false);
    const closeNextDay = Boolean(row.close_next_day) || minutesOf(row.close_time) <= minutesOf(row.open_time);
    return {
      state: 'open',
      dateKey: key,
      row,
      open,
      close: atDay(key, row.close_time, closeNextDay),
      closeNextDay,
      lastOrder: atDay(key, row.last_order_time, Boolean(row.last_order_next_day) || (closeNextDay && minutesOf(row.last_order_time) < minutesOf(row.open_time))),
      kitchenClose: atDay(key, row.kitchen_close_time, Boolean(row.kitchen_close_next_day) || (closeNextDay && minutesOf(row.kitchen_close_time) < minutesOf(row.open_time)))
    };
  }

  /** true/false from saved hours; null when hours are not set or not loaded. */
  function isOpenAt(at) {
    if (!hoursUsable()) return null;
    const date = at === undefined ? new Date() : toDate(at);
    if (!validDate(date)) return null;
    const keys = [...new Set([businessDate(date), addDays(venueDate(date), -1), venueDate(date)])];
    return keys.some((key) => {
      const win = dayWindow(key);
      return win.state === 'open' && date >= win.open && date < win.close;
    });
  }

  /**
   * The next service event after `at`: { type: 'opens'|'last_orders'|'kitchen_closes'|'closes',
   * label, at: Date, time: 'HH:MM', businessDate }, or null when hours are not
   * set / not loaded / the venue is closed all week. `types` limits the kinds.
   */
  function nextEvent(at, options = {}) {
    if (!hoursUsable()) return null;
    const date = at === undefined ? new Date() : toDate(at);
    if (!validDate(date)) return null;
    const types = Array.isArray(options.types) && options.types.length ? new Set(options.types) : null;
    const start = addDays(businessDate(date), -1);
    const events = [];
    for (let offset = 0; offset <= 8; offset += 1) {
      const win = dayWindow(addDays(start, offset));
      if (win.state !== 'open') continue;
      [['opens', win.open], ['last_orders', win.lastOrder], ['kitchen_closes', win.kitchenClose], ['closes', win.close]]
        .forEach(([type, instant]) => {
          if (!validDate(instant) || instant <= date || (types && !types.has(type))) return;
          events.push({ type, label: EVENT_LABELS[type], at: instant, time: formatTime(instant), businessDate: win.dateKey });
        });
    }
    events.sort((a, b) => a.at - b.at);
    return events[0] || null;
  }

  function offersOn(dateKey) {
    const day = weekday(dateKey);
    const offers = Array.isArray(clock.payload?.offers) ? clock.payload.offers : [];
    return offers.filter((offer) => Array.isArray(offer.days) && offer.days.map(Number).includes(day) && offer.start_time);
  }

  /**
   * Today's timeline for a business date, built ONLY from saved hours and
   * active offers: [{ time, at, title, detail, kind, status: 'past'|'current'|'future' }].
   * [] when hours are not set, not loaded, or the day is closed.
   */
  function timeline(dateKey, at) {
    const key = dateKeyOf(dateKey === undefined ? today() : dateKey);
    const win = dayWindow(key);
    if (win.state !== 'open') return [];
    const now = at === undefined ? new Date() : toDate(at);
    const entries = [{ kind: 'opens', at: win.open, title: 'Open', detail: 'Service starts.' }];
    offersOn(key).forEach((offer) => {
      const startNextDay = minutesOf(offer.start_time) < minutesOf(win.row.open_time) && win.closeNextDay;
      const begins = atDay(key, offer.start_time, startNextDay);
      const endTime = hhmm(offer.end_time);
      entries.push({ kind: 'offer', at: begins, title: String(offer.name || 'Offer'), detail: endTime ? `Until ${endTime}.` : 'Offer begins.' });
    });
    if (win.lastOrder) entries.push({ kind: 'last_orders', at: win.lastOrder, title: 'Last orders', detail: 'Final orders for the day.' });
    if (win.kitchenClose) entries.push({ kind: 'kitchen_closes', at: win.kitchenClose, title: 'Kitchen closes', detail: 'Kitchen service ends.' });
    entries.push({ kind: 'closes', at: win.close, title: 'Close', detail: 'Complete closing checks and handover.' });
    const valid = entries.filter((entry) => validDate(entry.at)).sort((a, b) => a.at - b.at);
    let currentAssigned = false;
    return valid.map((entry) => {
      let status = 'past';
      if (!validDate(now) || entry.at >= now) {
        status = currentAssigned ? 'future' : 'current';
        currentAssigned = true;
      }
      return { ...entry, time: formatTime(entry.at), status };
    });
  }

  // ---------- state ----------

  function todaySummary() {
    if (clock.status !== 'ready') return null;
    const win = dayWindow(today());
    if (win.state !== 'open') return { isOpen: false, open: null, close: null, closeNextDay: false, lastOrder: null, kitchenClose: null };
    return {
      isOpen: true,
      open: hhmm(win.row.open_time),
      close: hhmm(win.row.close_time),
      closeNextDay: win.closeNextDay,
      lastOrder: hhmm(win.row.last_order_time),
      kitchenClose: hhmm(win.row.kitchen_close_time)
    };
  }

  function canManageHours() {
    if (typeof clock.staff?.can_manage_hours === 'boolean') return clock.staff.can_manage_hours;
    const role = root.AtlasShell?.profile?.()?.role;
    return role === 'admin' || role === 'manager';
  }

  function state() {
    const offers = Array.isArray(clock.payload?.offers) ? clock.payload.offers.map((offer) => ({ ...offer, days: Array.isArray(offer.days) ? [...offer.days] : [] })) : [];
    return {
      status: clock.status,
      timezone: timeZone(),
      timezoneSource: clock.payload?.timezone_source === 'settings' && !timezoneIsDefault() ? 'settings' : 'default',
      timezoneIsDefault: timezoneIsDefault(),
      businessDate: today(),
      venueDate: venueDate(),
      hoursConfigured: clock.status === 'ready',
      today: todaySummary(),
      offers: clock.status === 'ready' ? offers : [],
      canManageHours: canManageHours(),
      generatedAt: clock.payload?.generated_at || null,
      error: clock.error
    };
  }

  function notify(reason) {
    const detail = { reason, status: clock.status };
    listeners.forEach((fn) => { try { fn(detail); } catch (error) { setTimeout(() => { throw error; }, 0); } });
    root.AtlasShell?.emit?.('venue-clock:changed', detail);
    if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
      root.dispatchEvent(new root.CustomEvent('atlas:venue-clock', { detail }));
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Apply a venue-clock payload ({ clock, staff } or the clock itself) without a request. */
  function apply(payload, reason = 'apply') {
    const next = payload && typeof payload === 'object' && payload.clock && typeof payload.clock === 'object' ? payload.clock : payload;
    if (!next || typeof next !== 'object' || !('hours_configured' in next || 'timezone' in next)) {
      clock.payload = null;
      clock.status = 'unavailable';
      clock.error = 'The venue clock did not return opening hours.';
    } else {
      clock.payload = next;
      clock.status = next.hours_configured === true && hourRows().length === 7 ? 'ready' : 'not_set';
      clock.error = null;
    }
    if (payload?.staff) clock.staff = payload.staff;
    clock.loadedAt = Date.now();
    scheduleRollover();
    notify(reason);
    return state();
  }

  function fail(message, reason = 'error') {
    clock.payload = null;
    clock.status = 'unavailable';
    clock.error = message;
    clock.loadedAt = Date.now();
    notify(reason);
    return state();
  }

  async function sessionToken() {
    const client = root.atlasSupabase;
    if (!client?.auth?.getSession) return null;
    const result = await client.auth.getSession();
    return result?.data?.session?.access_token || null;
  }

  async function request() {
    const endpoint = String(root.VABAR_CONFIG?.SETTINGS_API || '').trim();
    if (!endpoint || typeof root.fetch !== 'function') return fail('Opening hours are not available in this environment.');
    const token = await sessionToken();
    if (!token) return fail('Sign in to Atlas to read opening hours.', 'signed_out');
    const url = new URL(endpoint);
    url.searchParams.set('action', 'venue-clock');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await root.fetch(url.toString(), {
        method: 'GET',
        cache: 'no-store',
        signal: controller?.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return fail(response.status === 404 ? 'Opening hours are unavailable.' : (payload?.error || `Opening hours could not be loaded (${response.status}).`));
      }
      return apply(payload, 'loaded');
    } catch (error) {
      return fail(error?.name === 'AbortError' ? 'Opening hours took too long to load.' : 'Opening hours could not be loaded.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One request per sign-in; later calls return the cached state. */
  function load(options = {}) {
    if (clock.inflight) return clock.inflight;
    if (!options.force && clock.loadedAt && clock.status !== 'loading') return Promise.resolve(state());
    clock.inflight = request().finally(() => { clock.inflight = null; });
    return clock.inflight;
  }

  function refresh() {
    if (clock.inflight) return clock.inflight.then(() => load({ force: true }));
    return load({ force: true });
  }

  // Re-fetch when the business date rolls over (the server's venue_date /
  // business_date and the day's hours change then).
  function nextRollover(now = new Date()) {
    const key = businessDate(now);
    const calendar = venueDate(now);
    if (key !== calendar) {
      const row = rowFor(key);
      return zonedToInstant(calendar, hhmm(row?.close_time) || '00:00');
    }
    const row = rowFor(key);
    const midnight = zonedToInstant(addDays(key, 1), '00:00');
    if (row && row.is_open && row.close_next_day && minutesOf(row.close_time) > 0) {
      return zonedToInstant(addDays(key, 1), hhmm(row.close_time));
    }
    return midnight;
  }

  function scheduleRollover() {
    if (clock.rolloverTimer) clearTimeout(clock.rolloverTimer);
    clock.rolloverTimer = null;
    if (!clock.payload || typeof root.document === 'undefined') return;
    const next = nextRollover();
    if (!validDate(next)) return;
    const loadedDate = today();
    const wait = Math.max(1000, Math.min(MAX_TIMER_MS, next.getTime() - Date.now() + 1000));
    clock.rolloverTimer = setTimeout(() => {
      clock.rolloverTimer = null;
      if (today() !== loadedDate) refresh();
      else scheduleRollover();
    }, wait);
  }

  function checkRolloverOnReturn() {
    if (!clock.payload || clock.inflight) return;
    const serverDate = clock.payload.business_date;
    if (serverDate && today() !== serverDate) refresh();
  }

  function bind() {
    const shell = root.AtlasShell;
    if (shell?.on) {
      shell.on('profile:ready', (profile) => { if (profile) load(); });
      shell.on('settings:saved', (detail = {}) => {
        const action = String(detail.action || '');
        if (SETTINGS_ACTIONS_THAT_MOVE_TIME.has(action) || (action === 'save-section' && detail.section_key === 'venue')) refresh();
      });
      if (shell.profile?.()) load();
    }
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('focus', checkRolloverOnReturn);
      root.document?.addEventListener?.('visibilitychange', () => { if (root.document.visibilityState === 'visible') checkRolloverOnReturn(); });
    }
  }

  root.AtlasVenueClock = Object.freeze({
    DEFAULT_TIME_ZONE,
    // state
    load,
    refresh,
    state,
    apply,
    onChange,
    status: () => clock.status,
    // zone
    timeZone,
    timezoneIsDefault,
    parts,
    zonedToInstant,
    // dates
    today,
    tomorrow,
    businessDate,
    venueDate,
    weekday,
    addDays,
    startOfWeek,
    monthKey,
    monthRange,
    compareRange,
    // formatting
    formatTime,
    formatDate,
    formatDateTime,
    formatRelative,
    formatKr,
    // inputs
    localInputValue,
    fromLocalInput,
    // hours
    dayWindow,
    isOpenAt,
    nextEvent,
    offersOn,
    timeline
  });

  // Spec §5.3 names one money helper, AtlasFormat.money(); none existed before.
  if (!root.AtlasFormat) root.AtlasFormat = Object.freeze({ money: formatKr });

  bind();
})(typeof window === 'undefined' ? globalThis : window);
