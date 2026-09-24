// Operations, briefing and shift tools. Dates are the venue business date
// from the venue clock; opening hours are never invented.

import { applyStockTrustToWorkspace, buildRecipeReport } from "../stock-provenance.mjs";
import { S } from "./schema.mjs";
import { buildProposal } from "./actions.mjs";
import { fact, calculation, interpretation, missing, ok, record, source, ToolError } from "./result.mjs";
import { OPEN_ORDER_STATUSES, PURCHASING_TOOLS } from "./tools-purchasing.mjs";
import { addDays, isManagerActor, matchByName, mondayOf, resolveDay, text, venueDates, weekdayName } from "./helpers.mjs";

const ALL = ["admin", "manager", "bartender", "viewer"];
const MANAGERS = ["admin", "manager"];
const TIME_PATTERN = "^(?:[01]\\d|2[0-3]):[0-5]\\d$";

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function routineView(routine) {
  return {
    id: routine.id,
    name: routine.name,
    type: routine.routine_type ?? null,
    status: routine.status,
    due_time: routine.due_time ?? null,
    assigned_role: routine.assigned_role ?? null,
    progress_percent: routine.progress?.percent ?? null,
    completed_items: routine.progress?.completed ?? null,
    required_items: routine.progress?.required ?? null,
    completed_by: routine.completed_by_label ?? null,
  };
}

async function operationsState(ctx, date = null) {
  const dates = await venueDates(ctx, ctx.services);
  const localDate = date || dates.businessDate;
  const [operations, checklists] = await Promise.all([
    ctx.services.operationsToday(localDate),
    ctx.services.dailyChecklists(date ? localDate : null).catch(() => null),
  ]);
  return { dates, localDate, operations: operations || {}, checklists };
}

function checklistView(routine) {
  if (!routine) return null;
  return { id: routine.id, name: routine.name, status: routine.status, completed: routine.progress?.completed ?? null, required: routine.progress?.required ?? null };
}

const status = {
  name: "operations.status",
  level: "read",
  roles: ALL,
  specialist: "operations",
  progress: "Checking today's routines",
  description: "Today's operational status for the venue business date (or a given date): routines with progress and overdue flags, the shared opening/closing checklists, and the temperature log. Data is from the shared server checklists, not any device.",
  parameters: S.object({ date: S.nullable(S.date("Business date YYYY-MM-DD (default: current business date)")) }),
  async execute(args, ctx) {
    const state = await operationsState(ctx, args.date);
    const routines = (state.operations.routines || []).map(routineView);
    const opening = checklistView(state.checklists?.opening);
    const closing = checklistView(state.checklists?.closing);
    const temperature = state.operations.temperature?.summary || null;
    const overdue = routines.filter((routine) => routine.status === "overdue");
    const done = routines.filter((routine) => routine.status === "completed");
    const evidence = routines.map((routine) => fact(`${routine.name}`, `${routine.status.replace(/_/g, " ")}${routine.required_items ? ` (${routine.completed_items}/${routine.required_items})` : ""}${routine.due_time ? `, due ${String(routine.due_time).slice(0, 5)}` : ""}`, source("routine", routine.id, routine.name)));
    if (state.checklists && state.checklists.configured === false) evidence.push(missing("Daily checklists", "not set up on the server", source("operations", null, "Operations")));
    if (temperature) evidence.push(fact("Temperature log", `${temperature.logged_points ?? 0} of ${temperature.required_points ?? 0} points logged${Number(temperature.outside_range_points) > 0 ? `, ${temperature.outside_range_points} out of range` : ""}`, source("operations", null, "Temperature log")));
    return ok({
      summary: `${state.localDate}: ${done.length} of ${routines.length} routines completed, ${overdue.length} overdue.${opening ? ` Opening checklist ${opening.status}.` : ""}${closing ? ` Closing checklist ${closing.status}.` : ""}`,
      data: {
        business_date: state.localDate,
        timezone: state.dates.timezone,
        routines,
        checklists: state.checklists ? { configured: state.checklists.configured !== false, opening, closing } : null,
        temperature,
        alerts: state.operations.alerts || [],
      },
      evidence,
      records: routines.map((routine) => record("routine", routine.id, routine.name)),
      unknown: state.checklists && state.checklists.configured === false ? { count: 1, reason: "Daily checklists are not set up on the server" } : null,
    });
  },
};

function flattenIngredients(recipes) {
  return recipes.flatMap((recipe) => (recipe.recipe_ingredients || []).map((ingredient) => ({ ...ingredient, recipe_id: ingredient.recipe_id ?? recipe.id })));
}

// The trusted alert list: stock/recipe alerts from verified evidence only
// (stock-provenance applyStockTrustToWorkspace), routine and temperature
// alerts from the server checklists, and overdue orders for managers.
async function collectAlerts(ctx) {
  const manager = isManagerActor(ctx.actor);
  const [stockReport, recipes, inventory, ops] = await Promise.all([
    ctx.services.stockReport(),
    ctx.services.recipes(),
    ctx.services.inventory(),
    operationsState(ctx),
  ]);
  const recipeReport = buildRecipeReport(recipes, flattenIngredients(recipes), inventory, stockReport);
  const trusted = applyStockTrustToWorkspace({ attention: [] }, stockReport, recipeReport).attention;
  const alerts = trusted.map((alert) => ({ key: alert.key, severity: alert.tone === "danger" ? "high" : "medium", title: alert.title, detail: alert.detail, area: alert.section, route: alert.section === "recipes" ? "#recipes" : "#inventory" }));
  for (const alert of ops.operations.alerts || []) {
    alerts.push({ key: alert.key, severity: alert.severity || "medium", title: alert.title, detail: alert.detail, area: "operations", route: alert.routine_id ? `#dashboard?routine=${alert.routine_id}` : "#dashboard" });
  }
  if (manager) {
    const orders = await ctx.services.purchaseOrders().catch(() => []);
    const overdue = orders.filter((order) => ["ordered", "partially_received"].includes(order.status) && order.expected_delivery_date && order.expected_delivery_date < ops.dates.businessDate);
    if (overdue.length) alerts.push({ key: "purchasing-overdue", severity: "medium", title: `${overdue.length} deliveries are overdue`, detail: "Placed orders past their expected delivery date.", area: "purchasing", route: "#suppliers?section=purchase-orders" });
  }
  const order = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  return { alerts, stockReport, recipeReport, ops };
}

const alertsTool = {
  name: "operations.alerts",
  level: "read",
  roles: ALL,
  specialist: "operations",
  progress: "Checking what needs attention",
  description: "What needs attention now: out-of-stock and below-par items and unavailable/incomplete recipes (from current verified counts only), overdue routines and missing temperature logs, and overdue deliveries for managers. States how many items have no current count, so stock alerts are not complete.",
  parameters: S.object({}),
  async execute(args, ctx) {
    const { alerts, stockReport, recipeReport, ops } = await collectAlerts(ctx);
    const unknownStock = stockReport.summary.needs_current_count;
    const evidence = alerts.map((alert) => fact(alert.title, alert.detail, source(alert.area === "recipes" ? "recipes" : alert.area === "operations" ? "operations" : alert.area === "purchasing" ? "purchase_order" : "inventory", null, alert.area)));
    evidence.push(missing("Stock alerts coverage", `${unknownStock} of ${stockReport.summary.active_items} items have no current verified count and cannot raise stock alerts`, source("stock_count", null, "Stock count")));
    evidence.push(calculation("Recipe readiness", `${recipeReport.summary.ready} ready, ${recipeReport.summary.needs_attention} low, ${recipeReport.summary.unavailable} unavailable, ${recipeReport.summary.incomplete_setup} incomplete`, source("recipes", null, "Recipes")));
    return ok({
      summary: alerts.length
        ? `${alerts.length} things need attention (${alerts.filter((alert) => alert.severity === "high").length} high). Stock alerts cover only the ${stockReport.summary.current_items} items with a current count.`
        : `Nothing flagged. Note: ${unknownStock} items have no current count, so they cannot raise stock alerts.`,
      data: { business_date: ops.dates.businessDate, alerts, recipe_summary: recipeReport.summary, stock_summary: { active_items: stockReport.summary.active_items, current_items: stockReport.summary.current_items, below_par: stockReport.summary.below_par, out_of_stock: stockReport.summary.out_of_stock, missing_par: stockReport.summary.missing_par } },
      evidence,
      records: [],
      unknown: unknownStock ? { count: unknownStock, reason: "Items without a current verified count cannot raise stock alerts" } : null,
    });
  },
};

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

function shiftLine(shift) {
  return {
    id: shift.id ?? null,
    person_id: shift.person_id ?? null,
    name: shift.person_name || "Team member",
    role: shift.role_name ?? null,
    starts_local: shift.starts_local,
    ends_local: shift.ends_local,
    start: String(shift.starts_local || "").slice(11, 16),
    end: String(shift.ends_local || "").slice(11, 16),
    unpublished_change: shift.last_published_revision === null || shift.last_published_revision === undefined ? true : false,
  };
}

async function shiftWeek(ctx, date) {
  const weekStart = mondayOf(date);
  const snapshot = await ctx.services.shiftsSnapshot(weekStart);
  const week = snapshot?.week || {};
  const published = week.status === "published";
  const shifts = (snapshot?.shifts || []).filter((shift) => shift.active !== false);
  return { weekStart, snapshot, week, published, shifts };
}

const schedule = {
  name: "shifts.schedule",
  level: "read",
  roles: ALL,
  specialist: "shifts",
  progress: "Looking at the rota",
  description: "The rota for a week (Monday start; default: the week of the current business date): who works each day and when, and whether the week is published. Staff see only the published rota; managers also see unpublished changes, which are flagged.",
  parameters: S.object({
    week_start: S.nullable(S.date("Any date in the wanted week")),
  }),
  async execute(args, ctx) {
    const dates = await venueDates(ctx, ctx.services);
    const manager = isManagerActor(ctx.actor);
    const { weekStart, week, published, shifts } = await shiftWeek(ctx, args.week_start || dates.businessDate);
    const days = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(weekStart, offset);
      const entries = shifts.filter((shift) => String(shift.starts_local || "").slice(0, 10) === day).map(shiftLine)
        .map((line) => (manager ? line : { ...line, unpublished_change: false }));
      days.push({ date: day, weekday: weekdayName(day), shifts: entries });
    }
    const total = days.reduce((sum, day) => sum + day.shifts.length, 0);
    const unpublished = manager ? days.flatMap((day) => day.shifts).filter((line) => line.unpublished_change).length : 0;
    const weekSource = source("shift_week", weekStart, `Week of ${weekStart}`);
    // Staffing gaps: open days (from Settings opening hours) from today on
    // with nobody scheduled. Without opening hours a gap cannot be judged.
    const hoursConfigured = dates.clock?.hours_configured === true;
    const gaps = hoursConfigured
      ? days.filter((day) => day.date >= dates.businessDate && day.shifts.length === 0
        && todaysHours(dates.clock, day.date)?.is_open === true)
        .map((day) => ({ key: "staffing-gap", subject_key: day.date, title: `Nobody is scheduled on ${day.weekday} ${day.date}`, detail: "The venue is open that day according to Settings.", severity: "medium" }))
      : [];
    const evidence = [fact("Week status", published ? "published" : week.status ? `${week.status} (not published)` : "not published", weekSource)];
    if (!hoursConfigured) evidence.push(missing("Staffing gaps", "opening hours are not set, so days without staff cannot be judged", source("venue_clock", null, "Opening hours")));
    for (const gap of gaps) evidence.push(fact("Staffing gap", gap.title, weekSource));
    if (!published) evidence.push(interpretation("Rota may change", "This week is not published yet", weekSource));
    if (manager && unpublished) evidence.push(fact("Unpublished changes", `${unpublished} shifts changed since the last publication`, weekSource));
    for (const day of days) evidence.push(fact(`${day.weekday} ${day.date}`, day.shifts.length ? day.shifts.map((line) => `${line.name} ${line.start}–${line.end}`).join(", ") : "nobody scheduled", weekSource));
    return ok({
      summary: `Week of ${weekStart}: ${total} shifts; ${published ? "published" : "not published yet, so it may still change"}${unpublished ? `; ${unpublished} unpublished changes` : ""}${gaps.length ? `; ${gaps.length} open days with nobody scheduled` : ""}.`,
      data: { week_start: weekStart, status: week.status ?? null, published, days, unpublished_changes: unpublished, gaps, hours_configured: hoursConfigured },
      evidence,
      records: [record("shift_week", weekStart, `Week of ${weekStart}`)],
    });
  },
};

const whoIsWorking = {
  name: "shifts.who_is_working",
  level: "read",
  roles: ALL,
  specialist: "shifts",
  progress: "Checking who is working",
  description: "Who is scheduled on a day: today/tomorrow/yesterday relative to the venue business date, or an explicit date. Flags when the week is not published (the rota may still change). Staff only see published shifts.",
  parameters: S.object({
    day: S.nullable(S.enum(["today", "tomorrow", "yesterday"], "Relative day")),
    date: S.nullable(S.date("Explicit date YYYY-MM-DD (overrides day)")),
  }),
  async execute(args, ctx) {
    const dates = await venueDates(ctx, ctx.services);
    const date = args.date || resolveDay(args.day || "today", dates.businessDate);
    const manager = isManagerActor(ctx.actor);
    const { weekStart, week, published, shifts } = await shiftWeek(ctx, date);
    const entries = shifts.filter((shift) => String(shift.starts_local || "").slice(0, 10) === date)
      .sort((a, b) => text(a.starts_local).localeCompare(text(b.starts_local)))
      .map(shiftLine)
      .map((line) => (manager ? line : { ...line, unpublished_change: false }));
    const label = date === dates.businessDate ? "today" : date === addDays(dates.businessDate, 1) ? "tomorrow" : date;
    const weekSource = source("shift_week", weekStart, `Week of ${weekStart}`);
    const staffHidden = !manager && !published;
    const evidence = entries.map((line) => fact(line.name, `${line.start}–${line.end}${line.role ? ` · ${line.role}` : ""}`, weekSource));
    evidence.push(fact("Business date", `${dates.businessDate} (${dates.timezone})`, source("venue_clock", null, "Venue clock")));
    if (!published) evidence.push(interpretation("Rota status", staffHidden ? "This week is not published yet, so staff cannot see it" : "Not published yet — may still change", weekSource));
    return ok({
      summary: staffHidden
        ? `The rota for ${label} is not published yet, so Atlas cannot say who is working.`
        : entries.length
          ? `${entries.length} ${entries.length === 1 ? "person is" : "people are"} working ${label}: ${entries.map((line) => `${line.name} ${line.start}–${line.end}`).join(", ")}.${published ? "" : " The week is not published yet, so this may change."}`
          : `Nobody is scheduled ${label}.${published ? "" : " The week is not published yet."}`,
      data: { date, business_date: dates.businessDate, week_start: weekStart, published, week_status: week.status ?? null, shifts: entries },
      evidence,
      records: [record("shift_week", weekStart, `Week of ${weekStart}`)],
      unknown: staffHidden ? { count: 1, reason: "The week is not published" } : null,
    });
  },
};

function minutes(time) {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}

const prepareShift = {
  name: "shifts.prepare_draft",
  level: "draft",
  roles: MANAGERS,
  specialist: "shifts",
  progress: "Preparing a draft shift",
  description: "Manager only. Prepare (not save) one shift for a team member on a date with start and end time (an end before the start ends the next day). Warns about overlaps, marked unavailability and already-published weeks. Approval saves it as an unpublished change; Atlas never publishes a rota or notifies staff.",
  parameters: S.object({
    person_id: S.nullable(S.uuid("Shift person id (from shifts.schedule)")),
    person_query: S.nullable(S.string("Team member name", { maxLength: 120 })),
    date: S.date("Shift date YYYY-MM-DD"),
    start_time: S.string("Start HH:MM (24h)", { minLength: 5, maxLength: 5, pattern: TIME_PATTERN }),
    end_time: S.string("End HH:MM (24h)", { minLength: 5, maxLength: 5, pattern: TIME_PATTERN }),
    role_name: S.nullable(S.string("Role on this shift, e.g. Bar", { maxLength: 120 })),
    break_minutes: S.nullable(S.integer("Break minutes (default 0)", { minimum: 0, maximum: 720 })),
    note: S.nullable(S.string("Shift note", { maxLength: 500 })),
  }),
  async execute(args, ctx) {
    const { weekStart, snapshot, week, published, shifts } = await shiftWeek(ctx, args.date);
    const people = (snapshot?.people || []).filter((person) => person.active !== false);
    let person = null;
    if (args.person_id) {
      person = people.find((candidate) => String(candidate.id) === args.person_id) || null;
      if (!person) throw new ToolError("not_found", "That team member is not on the rota.");
    } else if (args.person_query) {
      const match = matchByName(people, args.person_query, { nameOf: (candidate) => candidate.display_name });
      if (match.status === "none") throw new ToolError("not_found", `No active team member on the rota matches "${args.person_query}".`);
      if (match.status === "ambiguous") {
        return ok({
          summary: `"${args.person_query}" matches ${match.candidates.length} people: ${match.candidates.map((candidate) => candidate.display_name).join(", ")}. Ask which one.`,
          data: { needs_clarification: [{ query: args.person_query, status: "ambiguous", candidates: match.candidates.map((candidate) => ({ id: candidate.id, name: candidate.display_name })) }] },
          evidence: [interpretation("Ambiguous name", match.candidates.map((candidate) => candidate.display_name).join(" / "), null)],
          records: [],
        });
      }
      person = match.match;
    } else throw new ToolError("invalid_arguments", "Give person_id or person_query.");

    const endDate = minutes(args.end_time) <= minutes(args.start_time) ? addDays(args.date, 1) : args.date;
    const startsLocal = `${args.date}T${args.start_time}`;
    const endsLocal = `${endDate}T${args.end_time}`;
    const warnings = [];
    const overlaps = shifts.filter((shift) => String(shift.person_id) === String(person.id)
      && `${shift.starts_local}` < `${endsLocal}:00` && `${shift.ends_local}` > `${startsLocal}:00`);
    if (overlaps.length) warnings.push(`${person.display_name} already has ${overlaps.length} overlapping shift(s) that day.`);
    const weekday = new Date(`${args.date}T12:00:00Z`).getUTCDay();
    const availability = (snapshot?.availability || []).find((entry) => String(entry.person_id) === String(person.id) && Number(entry.weekday) === weekday);
    if (availability?.unavailable) warnings.push(`${person.display_name} is marked unavailable on ${weekdayName(args.date)}s.`);
    if (published) warnings.push("This week is already published: the new shift stays an unpublished change until you republish in Shifts.");
    const command = {
      week_start: weekStart,
      person_id: String(person.id),
      person_name: String(person.display_name || "Team member"),
      role_name: args.role_name ?? person.default_role ?? null,
      starts_local: startsLocal,
      ends_local: endsLocal,
      break_minutes: args.break_minutes ?? 0,
      note: args.note ?? null,
    };
    const weekSource = source("shift_week", weekStart, `Week of ${weekStart}`);
    const evidence = [
      fact("Week status", published ? "published" : week.status || "draft", weekSource),
      ...warnings.map((warning) => interpretation("Check", warning, weekSource)),
    ];
    const proposal = buildProposal("shift.draft", command, {
      title: `Draft shift: ${command.person_name} ${args.date} ${args.start_time}–${args.end_time}`,
      subjectKey: weekStart,
      evidence,
      extras: { warnings },
    });
    return ok({
      summary: `Prepared a shift for ${command.person_name} on ${args.date} ${args.start_time}–${args.end_time}. Nothing is saved until you approve, and the rota is not published.${warnings.length ? ` Check: ${warnings.join(" ")}` : ""}`,
      data: { shift: command, warnings },
      evidence,
      records: [record("shift_week", weekStart, `Week of ${weekStart}`)],
      proposal,
    });
  },
};

// ---------------------------------------------------------------------------
// Briefing (composite, role-shaped)
// ---------------------------------------------------------------------------

function todaysHours(clock, businessDate) {
  if (!clock || clock.hours_configured !== true) return null;
  const weekday = new Date(`${businessDate}T12:00:00Z`).getUTCDay();
  return (clock.business_hours || []).find((entry) => Number(entry.weekday) === weekday) || null;
}

const briefing = {
  name: "briefing.today",
  level: "read",
  roles: ALL,
  specialist: "operations",
  progress: "Preparing today's briefing",
  description: "What needs attention today, in one call: opening hours (only if set in Settings), today's routines and checklists, alerts, who is working, and for managers also order suggestions, open deliveries and the top data-quality issues. Role-shaped: staff get the operational parts only.",
  parameters: S.object({}),
  async execute(args, ctx) {
    const manager = isManagerActor(ctx.actor);
    const dates = await venueDates(ctx, ctx.services);
    const [opsResult, alertResult, rotaResult] = await Promise.all([
      status.execute({ date: null }, ctx),
      alertsTool.execute({}, ctx),
      whoIsWorking.execute({ day: "today", date: null }, ctx),
    ]);
    const hours = todaysHours(dates.clock, dates.businessDate);
    const sections = {
      business_date: dates.businessDate,
      hours: hours ? { is_open: hours.is_open, open_time: hours.open_time, close_time: hours.close_time, close_next_day: hours.close_next_day, last_order_time: hours.last_order_time } : null,
      operations: { routines: opsResult.data.routines.length, overdue: opsResult.data.routines.filter((routine) => routine.status === "overdue").map((routine) => routine.name), checklists: opsResult.data.checklists },
      alerts: alertResult.data.alerts,
      working_today: { published: rotaResult.data.published, shifts: rotaResult.data.shifts },
    };
    const evidence = [
      hours ? fact("Opening hours today", hours.is_open ? `${String(hours.open_time).slice(0, 5)}–${String(hours.close_time).slice(0, 5)}` : "closed", source("venue_clock", null, "Opening hours"))
        : missing("Opening hours", "not set in Settings", source("venue_clock", null, "Opening hours")),
      ...opsResult.evidence.slice(0, 6),
      ...alertResult.evidence.slice(0, 8),
      ...rotaResult.evidence.slice(0, 6),
    ];
    const records = [...opsResult.records, ...rotaResult.records];
    let unknownCount = alertResult.unknown?.count || 0;
    if (manager) {
      const suggest = PURCHASING_TOOLS.find((tool) => tool.name === "purchasing.suggest");
      const [suggestResult, orders, review] = await Promise.all([
        suggest.execute({ supplier_id: null, include_ordered: false }, ctx),
        ctx.services.purchaseOrders().catch(() => []),
        ctx.services.dataReviewSummary().catch(() => null),
      ]);
      const due = orders.filter((order) => ["ordered", "partially_received"].includes(order.status) && order.expected_delivery_date === dates.businessDate);
      sections.purchasing = {
        suggested_items: suggestResult.data.counts.suggested,
        estimated_total: suggestResult.data.estimated_total,
        open_orders: orders.filter((order) => OPEN_ORDER_STATUSES.includes(order.status)).length,
        deliveries_due_today: due.map((order) => order.id),
      };
      const issues = Array.isArray(review?.issues) ? review.issues.filter((issue) => Number(issue.count) > 0).sort((a, b) => Number(b.count) - Number(a.count)).slice(0, 3) : [];
      sections.data_quality = issues.map((issue) => ({ code: issue.code, label: issue.label, count: Number(issue.count) }));
      evidence.push(...suggestResult.evidence.slice(0, 4));
      if (due.length) evidence.push(fact("Deliveries due today", String(due.length), source("purchase_order", null, "Purchase orders")));
      for (const issue of sections.data_quality) evidence.push(fact(`Data to fix: ${issue.label}`, `${issue.count}`, source("data_review", issue.code, issue.label)));
      records.push(...due.map((order) => record("purchase_order", order.id, "Delivery due today")));
    }
    const highAlerts = alertResult.data.alerts.filter((alert) => alert.severity === "high").length;
    return ok({
      summary: `Business date ${dates.businessDate}. ${hours ? (hours.is_open ? `Open ${String(hours.open_time).slice(0, 5)}–${String(hours.close_time).slice(0, 5)}.` : "Closed today.") : "Opening hours are not set."} ${alertResult.data.alerts.length} alerts (${highAlerts} high). ${rotaResult.summary}${manager && sections.purchasing ? ` ${sections.purchasing.suggested_items} items to order.` : ""}`,
      data: sections,
      evidence: evidence.slice(0, 30),
      records,
      unknown: unknownCount ? { count: unknownCount, reason: alertResult.unknown.reason } : null,
    });
  },
};

export const OPERATIONS_TOOLS = [status, alertsTool, briefing];
export const SHIFT_TOOLS = [schedule, whoIsWorking, prepareShift];
