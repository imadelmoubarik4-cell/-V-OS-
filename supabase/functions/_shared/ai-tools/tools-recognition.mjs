// Visual inventory recognition and catalogue proposal tools (S89 WP7).
//
// inventory.identify_from_image   read   the recognition pipeline in process
// inventory.resolve_name          read   canonical name -> item resolution
// inventory.propose_alias         draft  catalog.alias      (pending request)
// inventory.propose_item          draft  catalog.new_item   (duplicate check first; pending request)
// inventory.report_wrong_match    draft  catalog.wrong_match (pending report)
//
// Recognition never writes stock, items, codes or aliases: its database
// access is the atlas_recognition_* RPCs (guardedRpc), which run as the
// NOLOGIN recognition definer. Proposals only ever create PENDING catalogue
// requests after a person approves the card; a manager decides them in the
// approval queue (atlas-item-master catalog-decide), which also records the
// decision in the Brain.

import { S } from "./schema.mjs";
import { buildProposal } from "./actions.mjs";
import { estimate, fact, interpretation, missing, ok, record, source, ToolError } from "./result.mjs";
import { isManagerActor, newId, text } from "./helpers.mjs";
import { ServiceError } from "./services.mjs";
import { identify, resolveName } from "../recognition/pipeline.mjs";
import { ITEM_CLASSES, PACKAGING_TYPES, RecognitionError } from "../recognition/extract.mjs";
import { localCandidates } from "../recognition/retrieve.mjs";
import { percent } from "../recognition/bands.mjs";
import { normalizeCode } from "../product-identity.mjs";

const ALL = ["admin", "manager", "bartender", "viewer"];
const OPERATIONAL = ["admin", "manager", "bartender"];
const ALIAS_KINDS = ["product_name", "supplier_name", "ocr_variant", "legacy_name"];

function actorFor(ctx) {
  return { userId: ctx.actor.userId, role: ctx.actor.role, label: ctx.actor.label || ctx.actor.displayName || null };
}

function uuid(ctx) {
  return ctx.newId ? ctx.newId() : newId();
}

// ---------------------------------------------------------------------------
// Canonical name resolution, shared with inventory.prepare_count and
// purchasing.compare_delivery. Retrieval is atlas_recognition_candidates
// (aliases, identity/name/match keys, Icelandic and English spellings, pack
// sizes); when that RPC is not deployed yet it falls back to the same scorer
// over the rows the caller already has. `universe` limits the answer to
// those rows (e.g. the lines of a purchase order).
// ---------------------------------------------------------------------------
export async function resolveInventoryName(ctx, query, { universe = null, context = {}, limit = 5 } = {}) {
  const services = ctx.services;
  const fallbackRows = async () => (universe ?? (await services.inventory()).filter((item) => item.active !== false));
  let fellBack = false;
  const provider = async (signals) => {
    if (typeof services.recognitionRpc === "function" && !fellBack) {
      try {
        const result = await services.recognitionRpc("atlas_recognition_candidates", {
          p_signals: signals, p_limit: 25, p_actor_id: ctx.actor.userId, p_actor_role: ctx.actor.role,
        });
        const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        if (candidates.length || !universe) return { method: result?.method ?? "fts", candidates };
      } catch (error) {
        if (!(error instanceof ServiceError) || error.status === 403) throw error;
      }
      fellBack = true;
    }
    return localCandidates(await fallbackRows(), signals, { role: ctx.actor.role, limit: 25 });
  };
  const result = await resolveName(provider, query, { universe, context, limit });
  return { ...result, method: fellBack ? "local" : "rpc" };
}

export function candidateSummary(entry) {
  return {
    item_id: String(entry.item_id),
    name: entry.item?.name ?? null,
    unit: entry.item?.unit ?? null,
    active: entry.active !== false,
    percent: percent(entry.p),
    explanation: entry.explanation,
  };
}

// ---------------------------------------------------------------------------
// inventory.identify_from_image
// ---------------------------------------------------------------------------

// Plain answer when the photo cannot be read at all: what is off and how to
// count or identify instead (owner copy, no settings or key names).
function unreadableSummary(reason, counting) {
  if (reason === "not_configured" || reason === "disabled") {
    return counting
      ? "Photo counting isn't switched on yet, so Atlas can't count from this photo. Count in Inventory › Counts, or tell me the quantities (for example \"six Aperol, two Campari\") and I'll prepare a count for you to approve. Nothing was changed."
      : "Photo recognition isn't switched on yet, so Atlas can't read this photo. Scan the barcode or search Inventory instead. Nothing was changed.";
  }
  return counting
    ? "Atlas can't read this photo (use a JPEG, PNG or WebP photo), so nothing was counted. Count in Inventory › Counts, or tell me the quantities and I'll prepare a count for you to approve. Nothing was changed."
    : "Atlas can't read this photo (use a JPEG, PNG or WebP photo), so nothing was identified. Scan the barcode or search Inventory instead. Nothing was changed.";
}

function unreadableReason(configuredByKey, limits) {
  return !configuredByKey ? "not_configured" : !limits?.vision_enabled ? "disabled" : "unsupported_image";
}

// What the label says, as a short name ("Monin Lavender Syrup").
function readName(read) {
  const words = [];
  for (const field of [read?.brand, read?.product_name, read?.variant]) {
    const value = typeof field?.value === "string" ? field.value.trim() : "";
    if (value && field.confidence >= 50 && !words.some((word) => word.toLowerCase().includes(value.toLowerCase()))) words.push(value);
  }
  return words.join(" ").slice(0, 120);
}

const PACKAGE_WORDS = {
  bottle: ["bottle", "bottles"], can: ["can", "cans"], case: ["case", "cases"], keg: ["keg", "kegs"], box: ["box", "boxes"],
  bag: ["bag", "bags"], carton: ["carton", "cartons"], jar: ["jar", "jars"], pack: ["pack", "packs"],
};

function unitWord(read, count) {
  const words = PACKAGE_WORDS[read?.packaging_type?.value] ?? ["unit", "units"];
  return count === 1 ? words[0] : words[1];
}

// Units of the product visible in the photo (S91), or null when unknown.
function visibleUnits(read) {
  const units = read?.visible_units;
  return units && Number.isInteger(units.value) && units.value > 0 && units.confidence > 0 ? units : null;
}

function readingText(read) {
  const parts = [];
  const add = (label, field) => {
    if (field?.value) parts.push(`${label} ${field.value} (${field.confidence}%)`);
  };
  add("brand", read.brand);
  add("product", read.product_name);
  add("variant", read.variant);
  if (read.unit_size?.quantity || read.unit_size?.text) {
    parts.push(`size ${read.unit_size.text ?? `${read.unit_size.quantity} ${read.unit_size.unit}`} (${read.unit_size.confidence}%${read.unit_size.inferred ? ", guessed from shape" : ""})`);
  }
  add("package", read.packaging_type);
  return parts.join(", ");
}

const identifyFromImage = {
  name: "inventory.identify_from_image",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Reading the photo",
  description: "Identify inventory items in a photo the user attached (media_id from the attachments listed in <atlas_context>): reads the label, then matches it to Atlas inventory with a band (high = exact barcode or code, still needs the user's confirmation; medium = likely options with evidence; low = no confident match, 'not in Atlas'), field-by-field confidence and evidence. Present medium and low results as options, never as fact. Mode 'count' (e.g. 'Count these bottles') also estimates how many units of each product are visible, with a confidence: an estimate from the photo that a person confirms (offer a stock count draft via inventory.prepare_count, or Inventory › Counts); it never changes stock. It never links, creates or changes anything. Mode 'receiving' (managers) compares against a purchase order.",
  parameters: S.object({
    media_id: S.uuid("Id of the photo attachment"),
    mode: S.enum(["identify", "count", "receiving"], "Why the photo was taken"),
    purchase_order_id: S.nullable(S.uuid("Purchase order being received (mode receiving)")),
    count_session_id: S.nullable(S.uuid("Open stock count session (mode count)")),
  }),
  async execute(args, ctx) {
    if (args.mode === "receiving" && !isManagerActor(ctx.actor)) {
      throw new ToolError("forbidden", "Receiving from a delivery photo is available to managers.");
    }
    const services = ctx.services;
    const media = await services.mediaGet(args.media_id);
    if (!media?.path || media.kind !== "image" || media.deleted_at) {
      throw new ToolError("invalid_arguments", "That attachment is not a photo Atlas can read.");
    }
    const limits = await services.recognitionRpc("atlas_recognition_limits", {
      p_actor_id: ctx.actor.userId, p_actor_role: ctx.actor.role, p_vision: true, p_upload_bytes: null,
    });
    const configured = services.visionConfigured() && limits?.vision_enabled === true;
    const mime = String(media.mime ?? "").toLowerCase();
    const readable = ["image/jpeg", "image/png", "image/webp"].includes(mime);
    let imageDataUrl = null;
    if (configured && readable) {
      const bytes = await services.mediaDownload(media.path);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      imageDataUrl = `data:${mime};base64,${btoa(binary)}`;
    }
    const context = {};
    if (args.purchase_order_id) context.purchase_order_id = args.purchase_order_id;
    if (args.count_session_id) context.count_session_id = args.count_session_id;
    if (typeof ctx.conversationId === "string" && /^[0-9a-f-]{36}$/i.test(ctx.conversationId)) context.conversation_id = ctx.conversationId;
    if (args.purchase_order_id && isManagerActor(ctx.actor)) {
      const orders = await services.purchaseOrders();
      const order = orders.find((row) => String(row.id) === args.purchase_order_id);
      if (!order) throw new ToolError("not_found", "That purchase order was not found.");
      if (order.supplier_id) context.supplier_id = String(order.supplier_id);
    }
    let response;
    try {
      response = await identify({
        rpc: services.recognitionRpc,
        actor: actorFor(ctx),
        vision: configured && readable ? (input) => services.visionExtract(input) : null,
        visionReason: !services.visionConfigured() ? "not_configured" : !limits?.vision_enabled ? "disabled" : "unsupported_image",
      }, {
        client_request_id: uuid(ctx),
        mode: args.mode === "identify" ? "ai" : args.mode,
        context,
        client_barcodes: [],
        image: imageDataUrl ? { dataUrl: imageDataUrl } : { dataUrl: null },
        media: { media_id: args.media_id, expires_at: media.expires_at ?? null },
      });
    } catch (error) {
      if (error instanceof RecognitionError && error.code === "invalid_request") {
        // No readable image and no barcode: nothing to identify.
        const reason = unreadableReason(services.visionConfigured(), limits);
        return ok({
          summary: unreadableSummary(reason, args.mode === "count"),
          data: {
            vision: { configured, reason }, detections: [], stock_changed: false,
            ...(args.mode === "count" ? { next_steps: [{ kind: "open", label: "Count in Inventory", route: "#inventory/counts" }] } : {}),
          },
          evidence: [missing("Photo recognition", reason === "not_configured" ? "not switched on yet" : reason === "disabled" ? "switched off in Atlas AI settings" : "this image type cannot be read")],
          records: args.mode === "count" ? [record("stock_count", "", "Stock counts")] : [],
        });
      }
      throw error;
    }
    const counting = args.mode === "count";
    const detections = response.detections.map((detection) => ({
      detection_id: detection.detection_id,
      detection_index: detection.detection_index,
      band: detection.band,
      preselected_item_id: detection.preselected_item_id,
      in_atlas: detection.in_atlas,
      read_name: readName(detection.read) || null,
      visible_units: visibleUnits(detection.read)
        ? { value: detection.read.visible_units.value, confidence: detection.read.visible_units.confidence, unit: unitWord(detection.read, detection.read.visible_units.value), estimate: true }
        : null,
      field_confidence: detection.field_confidence,
      candidates: detection.candidates.slice(0, 3).map((candidate) => ({
        item_id: candidate.item_id, name: candidate.item?.name ?? null, unit: candidate.item?.unit ?? null,
        percent: candidate.percent, explanation: candidate.explanation, exact_identifier: candidate.exact_identifier,
        inactive: candidate.flags.inactive, on_order: candidate.flags.on_order,
      })),
    }));
    const evidence = [];
    const records = [];
    for (const detection of response.detections) {
      const label = response.detections.length > 1 ? `Product ${detection.detection_index + 1}` : "Photo";
      const top = detection.candidates[0];
      const reading = readingText(detection.read ?? {});
      if (reading) evidence.push(interpretation(`${label}: read from the label`, reading, null));
      else evidence.push(missing(`${label}: label`, "nothing readable", null));
      if (detection.read?.unit_size && !detection.read.unit_size.quantity && !detection.read.unit_size.text) {
        evidence.push(missing(`${label}: size`, "not readable on the photo", null));
      }
      if (top?.exact_identifier && detection.band === "high") {
        evidence.push(fact(`${label}: code match`, `${top.item.name} (${top.exact_identifier.kind === "gtin" ? "barcode" : top.exact_identifier.kind.replace("_", " ")})`, source("inventory_item", top.item_id, top.item.name)));
      }
      for (const candidate of detection.candidates.slice(0, detection.band === "high" ? 1 : 3)) {
        evidence.push(interpretation(`${label}: possible match`, candidate.explanation, source("inventory_item", candidate.item_id, candidate.item?.name)));
        records.push(record("inventory_item", candidate.item_id, candidate.item?.name ?? "Item"));
      }
      // S91: a count read from the photo is an estimate for a person to
      // confirm (a stock count draft); it never changes stock.
      const units = visibleUnits(detection.read);
      if (counting && units) {
        evidence.push(estimate(`${label}: visible in the photo`,
          `about ${units.value} ${unitWord(detection.read, units.value)} (estimated from the photo, ${units.confidence}% confidence)`,
          detection.band === "high" && top ? source("inventory_item", top.item_id, top.item.name) : null));
      } else if (counting) {
        evidence.push(missing(`${label}: visible count`, "could not be counted from the photo", null));
      }
    }
    const countText = (detection) => {
      if (!counting) return "";
      const units = visibleUnits(detection.read);
      return units
        ? `about ${units.value} ${unitWord(detection.read, units.value)} visible (estimated from the photo, ${units.confidence}% confidence)`
        : "count not readable from the photo";
    };
    const lines = response.detections.map((detection) => {
      const top = detection.candidates[0];
      const label = response.detections.length > 1 ? `${detection.detection_index + 1}) ` : "";
      const count = countText(detection);
      const suffix = count ? `: ${count}` : "";
      if (detection.band === "high") return `${label}${top.item.name} (${top.percent}%, matched by code; confirm before using it)${suffix}`;
      if (detection.band === "medium") return `${label}possibly ${detection.candidates.slice(0, 3).map((candidate) => `${candidate.item.name} ${candidate.percent}%`).join(" or ")} — ask which${suffix}`;
      const name = counting ? readName(detection.read) : "";
      return name
        ? `${label}${name}, not in Atlas (no confident Atlas inventory match found)${suffix}`
        : `${label}no confident Atlas inventory match found${suffix}`;
    });
    // Counts that could go into a stock count draft: only products that match
    // an Atlas item (Medium matches are confirmed by the person first).
    const countable = counting
      ? response.detections.filter((detection) => detection.band !== "low" && detection.candidates[0] && visibleUnits(detection.read))
      : [];
    const nextSteps = [];
    if (countable.length) {
      nextSteps.push({
        kind: "stock_count_draft",
        label: "Add these counts to a stock count draft for approval",
        tool: "inventory.prepare_count",
        confirm_first: countable.filter((detection) => detection.band !== "high")
          .map((detection) => detection.candidates.slice(0, 3).map((candidate) => candidate.item.name).join(" or ")),
        entries: countable.map((detection) => ({
          item_id: String(detection.candidates[0].item_id),
          item_name: detection.candidates[0].item?.name ?? null,
          quantity: detection.read.visible_units.value,
          confirmed_match: detection.band === "high",
        })),
      });
    }
    if (counting) nextSteps.push({ kind: "open", label: "Count in Inventory", route: "#inventory/counts" });
    const nextText = !counting ? ""
      : countable.length
        ? " Next step: I can add these counts to a stock count draft for you to check and approve (confirm which item each one is first), or you can count in Inventory › Counts."
        : " Next step: count in Inventory › Counts, or tell me the quantities and I'll prepare a count for you to approve.";
    const unreadable = !response.vision.used && !response.detections.length;
    const summary = unreadable
      ? unreadableSummary(["disabled", "not_configured"].includes(response.vision.reason) ? response.vision.reason : "unsupported_image", counting)
      : `${response.detections.length} ${response.detections.length === 1 ? "product" : "products"} in the photo: ${lines.join("; ")}. Nothing was changed.${nextText}`;
    if (counting) records.push(record("stock_count", "", "Stock counts"));
    return ok({
      summary,
      data: {
        request_id: response.request_id,
        mode: args.mode,
        vision: response.vision,
        image_quality: response.image_quality,
        detections,
        rule: "High = exact barcode or code match (pre-selected, still needs confirmation). Medium = options with evidence; the user chooses. Low = no confident match.",
        ...(counting ? {
          count_rule: "Visible counts are estimates from the photo: a suggestion for a stock count draft that a person checks and approves. They never change stock.",
          next_steps: nextSteps,
        } : {}),
        stock_changed: false,
      },
      evidence: evidence.slice(0, 30),
      records: records.slice(0, 20),
      unknown: response.detections.some((detection) => detection.band === "low")
        ? { count: response.detections.filter((detection) => detection.band === "low").length, reason: "No confident Atlas inventory match found" }
        : null,
    });
  },
};

// ---------------------------------------------------------------------------
// inventory.resolve_name
// ---------------------------------------------------------------------------
const resolveNameTool = {
  name: "inventory.resolve_name",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Matching the name",
  description: "Resolve a product name as the user or a document wrote it (any spelling, Icelandic or English, with or without a size such as '70cl') to Atlas inventory items using aliases, name keys and pack sizes. Returns unique (one item), ambiguous (candidates to ask about) or none. Never guesses between several items.",
  parameters: S.object({
    name: S.string("Name as written, e.g. 'Aperol 70cl' or 'Sítrónur'", { maxLength: 160 }),
    limit: S.nullable(S.integer("Maximum candidates (default 5)", { minimum: 1, maximum: 10 })),
  }),
  async execute(args, ctx) {
    const result = await resolveInventoryName(ctx, args.name, { limit: args.limit ?? 5 });
    const candidates = result.candidates.map(candidateSummary);
    const evidence = [];
    if (result.status === "unique") {
      const match = result.match;
      const exact = result.reason === "exact_name" || result.reason === "code";
      evidence.push((exact ? fact : interpretation)(`"${args.name}" is ${match.item.name}`, match.explanation, source("inventory_item", match.item_id, match.item.name)));
    } else if (result.status === "ambiguous") {
      for (const candidate of result.candidates) evidence.push(interpretation(`"${args.name}" could be ${candidate.item.name}`, candidate.explanation, source("inventory_item", candidate.item_id, candidate.item.name)));
    } else {
      evidence.push(missing(`"${args.name}"`, "no Atlas inventory item matches this name", source("inventory", null, "Inventory")));
    }
    return ok({
      summary: result.status === "unique"
        ? `"${args.name}" is ${result.match.item.name}.`
        : result.status === "ambiguous"
          ? `"${args.name}" could be ${candidates.map((candidate) => candidate.name).join(", ")}. Ask which one.`
          : `No Atlas inventory item matches "${args.name}".`,
      data: { query: args.name, status: result.status, reason: result.reason, match: result.match ? candidateSummary(result.match) : null, candidates },
      evidence,
      records: result.candidates.map((entry) => record("inventory_item", entry.item_id, entry.item?.name ?? "Item")),
    });
  },
};

// ---------------------------------------------------------------------------
// inventory.propose_alias
// ---------------------------------------------------------------------------
const proposeAlias = {
  name: "inventory.propose_alias",
  level: "draft",
  roles: OPERATIONAL,
  specialist: "inventory",
  progress: "Preparing a name suggestion",
  description: "Prepare a request to recognise another name for an existing inventory item (e.g. 'Giffard Vanilla' for Giffard Vanille Syrup, a supplier's product name or an Icelandic/English label). Checks first that the name does not already belong to this or another item. Approval sends a pending request; a manager approves it before Atlas uses the name. Nothing changes until then.",
  parameters: S.object({
    item_id: S.uuid("The inventory item the name belongs to"),
    alias: S.string("The other name, exactly as written", { maxLength: 200 }),
    alias_kind: S.nullable(S.enum(ALIAS_KINDS, "product_name (default), supplier_name, ocr_variant or legacy_name")),
    language: S.nullable(S.enum(["is", "en", "fr", "other"], "Language of the name")),
    reason: S.nullable(S.string("Why, e.g. 'label on the new delivery'", { maxLength: 500 })),
    recognition_request_id: S.nullable(S.uuid("Recognition result this came from, if any")),
  }),
  async execute(args, ctx) {
    const items = await ctx.services.inventory();
    const item = items.find((row) => String(row.id) === args.item_id);
    if (!item) throw new ToolError("not_found", "That inventory item was not found.");
    if (item.active === false) throw new ToolError("invalid_arguments", `${item.name} is archived; names are added to active items only.`);
    const alias = text(args.alias);
    if (alias.toLowerCase() === text(item.name).toLowerCase()) {
      return ok({ summary: `"${alias}" is already the name of ${item.name}. Nothing to add.`, data: { status: "already_known", item_id: item.id }, evidence: [fact("Item name", item.name, source("inventory_item", item.id, item.name))], records: [record("inventory_item", item.id, item.name)] });
    }
    const resolved = await resolveInventoryName(ctx, alias);
    if (resolved.status === "unique" && String(resolved.match.item_id) !== args.item_id && ["exact_name", "name_key", "code"].includes(resolved.reason)) {
      return ok({
        summary: `"${alias}" already matches ${resolved.match.item.name}, not ${item.name}. Atlas did not prepare a request; check which item is right.`,
        data: { status: "belongs_to_other_item", item_id: item.id, other: candidateSummary(resolved.match) },
        evidence: [interpretation(`"${alias}" matches ${resolved.match.item.name}`, resolved.match.explanation, source("inventory_item", resolved.match.item_id, resolved.match.item.name))],
        records: [record("inventory_item", resolved.match.item_id, resolved.match.item.name), record("inventory_item", item.id, item.name)],
      });
    }
    // Already resolves to this item (name, spelling, language or alias).
    const known = resolved.status === "unique" && String(resolved.match.item_id) === args.item_id;
    if (known) {
      return ok({ summary: `Atlas already recognises "${alias}" as ${item.name}. Nothing to add.`, data: { status: "already_known", item_id: item.id }, evidence: [interpretation(`"${alias}" is ${item.name}`, resolved.match.explanation, source("inventory_item", item.id, item.name))], records: [record("inventory_item", item.id, item.name)] });
    }
    const command = {
      request_id: uuid(ctx),
      item_id: String(item.id),
      item_name: String(item.name),
      alias,
      alias_kind: args.alias_kind ?? "product_name",
      language: args.language ?? null,
      reason: args.reason ?? null,
      recognition_request_id: args.recognition_request_id ?? null,
    };
    const evidence = [fact("Item", item.name, source("inventory_item", item.id, item.name))];
    if (resolved.status === "unique" && String(resolved.match.item_id) === args.item_id) {
      evidence.push(interpretation(`"${alias}" already resembles ${item.name}`, resolved.match.explanation, source("inventory_item", item.id, item.name)));
    } else if (resolved.status === "ambiguous") {
      evidence.push(interpretation(`"${alias}" could also be`, resolved.candidates.map((entry) => entry.item.name).join(", "), null));
    } else {
      evidence.push(missing(`"${alias}"`, "not recognised by Atlas yet", null));
    }
    const proposal = buildProposal("catalog.alias", command, {
      title: `Add "${alias}" as a name for ${item.name}`,
      subjectKey: String(item.id),
      evidence,
    });
    return ok({
      summary: `Prepared a request to add "${alias}" as another name for ${item.name}. Nothing changes until a manager approves it.`,
      data: { status: "proposed", item_id: item.id, alias, resolution: resolved.status },
      evidence,
      records: [record("inventory_item", item.id, item.name)],
      proposal,
    });
  },
};

// ---------------------------------------------------------------------------
// inventory.propose_item
// ---------------------------------------------------------------------------
const proposeItem = {
  name: "inventory.propose_item",
  level: "draft",
  roles: OPERATIONAL,
  specialist: "inventory",
  progress: "Checking for existing products",
  description: "Prepare a new-product request when a product is not in Atlas. Runs the duplicate check first (barcode, name in any spelling, aliases, size, brand, archived items); if a likely existing product is found it says so and prepares nothing. Otherwise approval sends a pending request that a manager reviews; the item is only created by a manager, with no stock (not counted). Never creates an item itself.",
  parameters: S.object({
    name: S.string("Product name, e.g. 'Demerara Raw Sugar'", { maxLength: 200 }),
    brand: S.nullable(S.string("Brand", { maxLength: 120 })),
    variant: S.nullable(S.string("Flavour or variant", { maxLength: 120 })),
    category: S.nullable(S.string("Inventory category, e.g. 'Bar Ingredients'", { maxLength: 120 })),
    item_class: S.nullable(S.enum(ITEM_CLASSES, "Product type")),
    packaging_type: S.nullable(S.enum(PACKAGING_TYPES, "Package type")),
    unit: S.nullable(S.string("Counting unit, e.g. bottles, kg, packs", { maxLength: 40 })),
    unit_size_quantity: S.nullable(S.number("Unit size amount", { minimum: 0.001, maximum: 1000000 })),
    unit_size_base: S.nullable(S.enum(["ml", "g", "count"], "Unit size base")),
    units_per_case: S.nullable(S.integer("Units per case", { minimum: 1, maximum: 1000 })),
    barcode: S.nullable(S.string("Barcode digits printed on the product", { minLength: 6, maxLength: 20 })),
    notes: S.nullable(S.string("Notes for the manager", { maxLength: 1000 })),
    recognition_request_id: S.nullable(S.uuid("Recognition result this came from, if any")),
  }),
  async execute(args, ctx) {
    if ((args.unit_size_quantity === null) !== (args.unit_size_base === null)) {
      throw new ToolError("invalid_arguments", "Unit size needs both an amount and a base (ml, g or count).");
    }
    const values = { name: text(args.name) };
    for (const key of ["brand", "variant", "category", "item_class", "packaging_type", "unit", "unit_size_quantity", "unit_size_base", "units_per_case"]) {
      if (args[key] !== null && args[key] !== undefined && args[key] !== "") values[key] = args[key];
    }
    const codes = [];
    if (args.barcode) {
      const code = normalizeCode(args.barcode);
      if (!code.valid) throw new ToolError("invalid_arguments", "That barcode is not valid (check digit).");
      codes.push({ kind: code.kind, code: args.barcode });
    }
    const duplicates = await ctx.services.catalogFindDuplicates(values, codes, []);
    const candidates = Array.isArray(duplicates?.candidates) ? duplicates.candidates : [];
    const blocking = (duplicates?.code_conflicts ?? []).length || (duplicates?.alias_conflicts ?? []).length || duplicates?.identity_conflict;
    const strong = candidates.filter((candidate) => candidate.band === "strong");
    const possible = candidates.filter((candidate) => candidate.requires_ack);
    const evidence = candidates.slice(0, 5).map((candidate) => interpretation(
      `Possible existing match: ${candidate.name}`,
      `${Math.round(Number(candidate.score) * 100)}%${candidate.active ? "" : " (archived)"}: ${(candidate.evidence ?? []).map((entry) => entry.text).join(" · ")}`,
      source("inventory_item", candidate.item_id, candidate.name)));
    const records = candidates.slice(0, 5).map((candidate) => record("inventory_item", candidate.item_id, candidate.name));
    if (blocking || strong.length) {
      const first = strong[0] ?? candidates[0];
      return ok({
        summary: `This looks like an existing product${first ? `: ${first.name} (${Math.round(Number(first.score) * 100)}%)` : ""}. Atlas did not prepare a new-product request. Use the existing item, or add this name or barcode to it.`,
        data: { status: "existing_match", duplicates: candidates.slice(0, 5), code_conflicts: duplicates?.code_conflicts ?? [], alias_conflicts: duplicates?.alias_conflicts ?? [], identity_conflict: duplicates?.identity_conflict ?? null },
        evidence: evidence.length ? evidence : [interpretation("Existing product", "the same barcode, name or package is already in Atlas", null)],
        records,
      });
    }
    const command = {
      request_id: uuid(ctx),
      values: Object.fromEntries(["name", "brand", "variant", "category", "item_class", "packaging_type", "unit", "unit_size_quantity", "unit_size_base", "units_per_case"]
        .map((key) => [key, values[key] ?? null])),
      codes,
      notes: args.notes ?? null,
      duplicate_candidates: possible.map((candidate) => String(candidate.item_id)).slice(0, 10),
      recognition_request_id: args.recognition_request_id ?? null,
    };
    if (!evidence.length) evidence.push(missing("Existing products", "no similar product found in Atlas", source("inventory", null, "Inventory")));
    const proposal = buildProposal("catalog.new_item", command, {
      title: `New product request: ${values.name}`,
      subjectKey: command.request_id,
      evidence,
      extras: { duplicates: possible.map((candidate) => `${candidate.name} (${Math.round(Number(candidate.score) * 100)}%)`) },
    });
    return ok({
      summary: `Prepared a new-product request for ${values.name}${possible.length ? `; ${possible.length} possible existing ${possible.length === 1 ? "match" : "matches"} will be shown to the manager` : ""}. Nothing is created until a manager approves it, and it starts with no stock.`,
      data: { status: "proposed", values, codes, possible_matches: possible.slice(0, 5) },
      evidence,
      records,
      proposal,
    });
  },
};

// ---------------------------------------------------------------------------
// inventory.report_wrong_match
// ---------------------------------------------------------------------------
const reportWrongMatch = {
  name: "inventory.report_wrong_match",
  level: "draft",
  roles: OPERATIONAL,
  specialist: "inventory",
  progress: "Preparing a wrong-match report",
  description: "Prepare a report that Atlas matched a product to the wrong inventory item (e.g. a scan or photo showed Giffard Salted Caramel but Atlas said Vanille). Include the wrongly matched item, the right item if known and a short note. Approval sends the report to a manager; nothing else changes.",
  parameters: S.object({
    item_id: S.uuid("The item Atlas matched wrongly"),
    suggested_item_id: S.nullable(S.uuid("The right item, if known")),
    note: S.string("What was wrong", { maxLength: 1000 }),
    recognition_request_id: S.nullable(S.uuid("Recognition result, if known")),
  }),
  async execute(args, ctx) {
    const items = await ctx.services.inventory();
    const item = items.find((row) => String(row.id) === args.item_id);
    if (!item) throw new ToolError("not_found", "That inventory item was not found.");
    const suggested = args.suggested_item_id ? items.find((row) => String(row.id) === args.suggested_item_id) : null;
    if (args.suggested_item_id && !suggested) throw new ToolError("not_found", "The suggested item was not found.");
    const command = {
      request_id: uuid(ctx),
      item_id: String(item.id),
      item_name: String(item.name),
      suggested_item_id: suggested ? String(suggested.id) : null,
      suggested_item_name: suggested ? String(suggested.name) : null,
      note: text(args.note),
      recognition_request_id: args.recognition_request_id ?? null,
    };
    const evidence = [fact("Matched item", item.name, source("inventory_item", item.id, item.name))];
    if (suggested) evidence.push(interpretation("Right item (as reported)", suggested.name, source("inventory_item", suggested.id, suggested.name)));
    const proposal = buildProposal("catalog.wrong_match", command, {
      title: `Report wrong match: ${item.name}`,
      subjectKey: String(item.id),
      evidence,
    });
    return ok({
      summary: `Prepared a wrong-match report for ${item.name}${suggested ? ` (should be ${suggested.name})` : ""}. A manager reviews it; nothing else changes.`,
      data: { status: "proposed", item_id: item.id, suggested_item_id: suggested?.id ?? null },
      evidence,
      records: [record("inventory_item", item.id, item.name), ...(suggested ? [record("inventory_item", suggested.id, suggested.name)] : [])],
      proposal,
    });
  },
};

export const RECOGNITION_TOOLS = [identifyFromImage, resolveNameTool, proposeAlias, proposeItem, reportWrongMatch];
