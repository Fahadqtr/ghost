import "server-only";
// INT.2E.2 — Shopify publish orchestrator (SERVER-ONLY, writer-gated).
//
// The first live write workflow in the Export Center. It NEVER invents a diff:
// it re-reads internal + live Shopify through the SAME single read path and the
// SAME buildShopifyPreview planner (loadShopifyPreviewContext), then, per selected
// row, it:
//   1. recomputes the deterministic fingerprint and rejects a STALE confirmation,
//   2. hard-stops CONFLICT / BLOCKED / UNKNOWN and reports MATCH as UNCHANGED,
//   3. executes ONLY the conservative supported ops (create / content / price /
//      add-missing-media) via the EXISTING certified Admin helpers,
//   4. writes durable identity for created products through the approved ECL
//      boundary (writeEclMapping), failing closed to NEEDS_RECONCILIATION,
//   5. records a durable export_runs row (+ malak_audit floor),
//   6. reconciles created GIDs against a fresh live read.
//
// It writes NO inventory (creates with locationId:null so no quantity is set),
// NO availability, NO lifecycle; it never deletes/reorders media; it creates as
// DRAFT (never auto-activates/publishes). Credentials stay server-side.

import { requireMalakWriter } from "@/lib/malak/authz";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  shopifyConfigured,
  fetchAllShopifyProducts,
  createShopifyProduct,
  updateVariantPrice,
  updateVariantIdentity,
  updateShopifyProductContent,
  addProductImage,
} from "@/lib/shopify/admin";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";
import { writeEclMapping } from "@/lib/missing-products/ecl-repair-write.server";
import { storefrontByKey } from "@/lib/channels/storefronts";
import { loadShopifyPreviewContext, type ShopifyPreviewContext } from "./preview.server";
import {
  SHOPIFY_STOREFRONT_KEY,
  type ShopifyInternalProduct,
  type ShopifyPreviewRow,
  type ShopifyPreviewStatus,
} from "./preview.ts";
import { canonicalUnitPricing, normalizeCompareAt } from "./pricing.ts";
import {
  evaluateRow,
  isStale,
  rowFingerprint,
  variantIdentityFields,
  dedupeSelections,
  emptyCounts,
  tallyResult,
  runStatusFromCounts,
  type PublishTarget,
  type PublishItemResult,
  type PublishRunCounts,
  type PublishRunStatus,
} from "./publish-plan.ts";
import { recordExportRun, type ExportRunItem } from "./run-store.server.ts";

const CHANNEL_KEY = "shopify";
const IDENTITY_TYPE = storefrontByKey(SHOPIFY_STOREFRONT_KEY)?.identityType ?? "shopify_gid";
const MAX_SELECTIONS = 200;

const clean = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

/** Minimal, safe plain-text → HTML for a product description write. */
function htmlFromPlain(text: string): string {
  const t = clean(text);
  if (t === "") return "";
  const esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p>${esc.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

/** Derive the exact target values a row would write (also feeds the fingerprint). */
export function deriveTarget(internal: ShopifyInternalProduct, row: ShopifyPreviewRow, ctx: ShopifyPreviewContext): PublishTarget {
  const gidByVariant = ctx.mappingByProductId[internal.id]?.variantGidByVariantId ?? {};
  const realVariants = Array.isArray(internal.variants) ? internal.variants : [];
  const variants = realVariants.length > 0
    ? realVariants.map((v) => {
        // SHOPIFY.PRICE.1 — the SAME canonical rule as the preview planner:
        // sell = variant ?? parent discount ?? parent price; compare-at only
        // when it is a real sale (compareAt > sell).
        const pricing = canonicalUnitPricing(v.price, internal.discountPrice, internal.price);
        return {
          variantId: v.id,
          variantGid: gidByVariant[v.id] ?? null,
          sku: v.sku,
          barcode: v.barcode,
          price: pricing.sellPrice,
          compareAtPrice: pricing.compareAtPrice,
        };
      })
    // mk2237 fix: a SIMPLE product's plan targets the preview's SYNTHETIC unit
    // (unit id = the PRODUCT id, identity from the product row). Without this
    // entry the executor's target lookup missed, the planned UPDATE_VARIANT
    // silently no-opped, and the run reported UNCHANGED while the barcode diff
    // survived every re-read.
    : [{
        variantId: internal.id,
        variantGid: gidByVariant[internal.id] ?? null,
        sku: row.sku || null,
        barcode: row.barcode ?? null,
        price: row.price,
        compareAtPrice: row.compareAtPrice,
      }];
  return {
    title: row.title,
    descriptionText: clean(internal.descriptionEn),
    price: row.price,
    compareAtPrice: row.compareAtPrice,
    hasImage: row.hasImage,
    imageUrl: internal.imageUrl,
    variants,
  };
}

export interface PublishRowView {
  internalProductId: string;
  sku: string;
  title: string;
  status: ShopifyPreviewStatus;
  fingerprint: string;
  eligible: boolean;
  executableOpTypes: string[];
  unsupportedOpTypes: string[];
}

/** Per-row publish view (fingerprint + eligibility) for the UI/confirm layer. */
export function buildPublishRows(ctx: ShopifyPreviewContext): PublishRowView[] {
  const internalById = new Map(ctx.internalProducts.map((p) => [p.id, p]));
  return ctx.result.rows.map((row) => {
    const internal = internalById.get(row.internalProductId);
    const target = internal ? deriveTarget(internal, row, ctx) : fallbackTarget(row);
    const evalr = evaluateRow(row, target);
    return {
      internalProductId: row.internalProductId,
      sku: row.sku,
      title: row.title,
      status: row.status,
      fingerprint: evalr.fingerprint,
      eligible: evalr.eligible,
      executableOpTypes: evalr.executableOps.map((o) => o.type),
      unsupportedOpTypes: evalr.unsupportedOps.map((o) => o.type),
    };
  });
}

function fallbackTarget(row: ShopifyPreviewRow): PublishTarget {
  return { title: row.title, descriptionText: "", price: row.price, compareAtPrice: row.compareAtPrice, hasImage: row.hasImage, imageUrl: null, variants: [] };
}

export interface PublishSelection {
  internalProductId: string;
  expectedFingerprint: string;
}

export interface PublishInput {
  selections: readonly PublishSelection[];
  /** explicit operator confirmation of the batch (§15). */
  confirm: boolean;
  /** explicit confirmation that CREATE (new products) is intended (§2). */
  confirmCreate?: boolean;
}

export interface PublishItemOutcome {
  internalProductId: string;
  sku: string | null;
  status: ShopifyPreviewStatus;
  result: PublishItemResult;
  externalProductGid: string | null;
  ops: string[];
  error: string | null; // fixed/safe text only
}

export interface PublishRunResult {
  ok: boolean;
  error?: string;
  runStatus: PublishRunStatus;
  counts: PublishRunCounts;
  items: PublishItemOutcome[];
  runId: string | null;
  durablePersisted: boolean;
}

function fail(error: string): PublishRunResult {
  return { ok: false, error, runStatus: "FAILED", counts: emptyCounts(), items: [], runId: null, durablePersisted: false };
}

/** A systemic (auth/config) failure aborts the whole batch safely (§17). */
function looksSystemic(error: string | undefined | null): boolean {
  return /غير مهيأ|غير مربوط|unauthorized|forbidden|401|403|invalid.*token|access.*denied/i.test(String(error ?? ""));
}

export async function executeShopifyPublish(input: PublishInput): Promise<PublishRunResult> {
  // §4 — writer-gated (matches the existing Shopify create/update policy; never weaker).
  const writer = await requireMalakWriter();
  if (!writer.ok) return fail(writer.error);
  if (!input?.confirm) return fail("لم يتم تأكيد النشر."); // §15 explicit confirmation
  if (!shopifyConfigured()) return fail("شوبي فاي غير مربوط.");

  // §6 — SERVER-SIDE dedupe by internalProductId (never trust the client to be
  // unique). First occurrence wins (deterministic order + fingerprint); a request
  // that repeats a product executes it AT MOST ONCE. Dedupe runs before the cap,
  // so MAX_SELECTIONS counts distinct products.
  const selections = dedupeSelections(input.selections ?? []).slice(0, MAX_SELECTIONS);
  if (selections.length === 0) return fail("ما في عناصر محددة.");

  // §1/§5 — FRESH re-read + re-plan through the SAME context (never stale client state).
  const ctx = await loadShopifyPreviewContext();
  if (!ctx || !ctx.result.shopifyAvailable) return fail("تعذّرت قراءة شوبي فاي — لا يمكن النشر الآن.");

  const rowById = new Map(ctx.result.rows.map((r) => [r.internalProductId, r]));
  const internalById = new Map(ctx.internalProducts.map((p) => [p.id, p]));

  const startedAt = new Date().toISOString();
  const admin = createAdminClient();

  let counts = emptyCounts();
  let systemicAbort = false;
  let imageCount = 0;
  let warningCount = 0;
  const items: PublishItemOutcome[] = [];
  const externalRefs: { internalProductId: string; gid: string; kind: "created" | "updated" }[] = [];
  const createdToConfirm: { internalProductId: string; gid: string }[] = [];

  for (const sel of selections) {
    if (systemicAbort) break;
    const row = rowById.get(sel.internalProductId);
    const internal = internalById.get(sel.internalProductId);
    if (!row || !internal) {
      items.push({ internalProductId: sel.internalProductId, sku: null, status: "UNKNOWN", result: "FAILED", externalProductGid: null, ops: [], error: "العنصر غير موجود في الخطة الحالية." });
      counts = tallyResult(counts, "FAILED");
      continue;
    }

    const target = deriveTarget(internal, row, ctx);
    const fresh = rowFingerprint(row, target);
    if (isStale(fresh, sel.expectedFingerprint)) {
      items.push({ internalProductId: row.internalProductId, sku: row.sku || null, status: row.status, result: "STALE", externalProductGid: row.shopifyProductGid, ops: [], error: "تغيّرت البيانات منذ المعاينة — أعد المعاينة." });
      counts = tallyResult(counts, "STALE");
      continue;
    }

    const evalr = evaluateRow(row, target);
    if (!evalr.eligible) {
      const result = evalr.ineligibleResult ?? "BLOCKED";
      if (result === "SKIPPED_UNSUPPORTED") warningCount++;
      items.push({ internalProductId: row.internalProductId, sku: row.sku || null, status: row.status, result, externalProductGid: row.shopifyProductGid, ops: evalr.unsupportedOps.map((o) => o.type), error: null });
      counts = tallyResult(counts, result);
      continue;
    }

    // NEW requires explicit create confirmation (§2).
    if (row.status === "NEW" && input.confirmCreate !== true) {
      items.push({ internalProductId: row.internalProductId, sku: row.sku || null, status: row.status, result: "SKIPPED_UNSUPPORTED", externalProductGid: null, ops: ["CREATE_PRODUCT"], error: "الإنشاء يحتاج تأكيداً صريحاً." });
      counts = tallyResult(counts, "SKIPPED_UNSUPPORTED");
      warningCount++;
      continue;
    }

    const outcome = await executeRow(admin, row, internal, target, evalr.executableOps, writer.email);
    if (outcome.imageAdded) imageCount++;
    if (outcome.gid && outcome.result === "CREATED") createdToConfirm.push({ internalProductId: row.internalProductId, gid: outcome.gid });
    if (outcome.gid) externalRefs.push({ internalProductId: row.internalProductId, gid: outcome.gid, kind: row.status === "NEW" ? "created" : "updated" });
    items.push({ internalProductId: row.internalProductId, sku: row.sku || null, status: row.status, result: outcome.result, externalProductGid: outcome.gid, ops: outcome.ops, error: outcome.error });
    counts = tallyResult(counts, outcome.result);
    if (outcome.systemic) { systemicAbort = true; }
  }

  // §18 — reconcile created GIDs against a fresh live read (best-effort).
  if (createdToConfirm.length > 0) {
    try {
      const relive = await fetchAllShopifyProducts();
      if (!relive.error && Array.isArray(relive.products)) {
        const liveGids = new Set(relive.products.map((p) => p.id));
        for (const c of createdToConfirm) {
          if (!liveGids.has(c.gid)) {
            const it = items.find((i) => i.internalProductId === c.internalProductId);
            if (it && it.result === "CREATED") {
              it.result = "NEEDS_RECONCILIATION";
              it.error = "تعذّر تأكيد المنتج المُنشأ في المتجر — يحتاج مطابقة.";
              counts = { ...counts, created: counts.created - 1, needsReconciliation: counts.needsReconciliation + 1 };
            }
          }
        }
      }
    } catch { /* reconcile is best-effort; leave results as recorded */ }
  }

  const finishedAt = new Date().toISOString();
  const runStatus = runStatusFromCounts(counts, { systemicAbort });

  const runItems: ExportRunItem[] = items.map((i) => ({
    internalProductId: i.internalProductId,
    sku: i.sku,
    externalProductGid: i.externalProductGid,
    operation: i.ops.join("+") || "NONE",
    result: i.result,
    error: i.error,
  }));

  const rec = await recordExportRun(admin as never, {
    destination: SHOPIFY_STOREFRONT_KEY,
    operation: "publish",
    status: runStatus,
    actor: writer.email,
    startedAt,
    finishedAt,
    counts,
    variantCount: 0,
    imageCount,
    warningCount,
    previewFingerprint: batchFingerprint(selections),
    externalRefs,
    errorSummary: systemicAbort ? "أُوقفت الدفعة بسبب فشل عام (مصادقة/تهيئة)." : null,
    items: runItems,
  });

  return {
    ok: !systemicAbort,
    ...(systemicAbort ? { error: "فشل عام أثناء النشر — أُوقفت الدفعة بأمان." } : {}),
    runStatus,
    counts,
    items,
    runId: rec.runId,
    durablePersisted: rec.persisted,
  };
}

interface RowExecOutcome { result: PublishItemResult; gid: string | null; ops: string[]; error: string | null; imageAdded: boolean; systemic: boolean }

async function executeRow(
  admin: ReturnType<typeof createAdminClient>,
  row: ShopifyPreviewRow,
  internal: ShopifyInternalProduct,
  target: PublishTarget,
  ops: { type: string; fields: readonly string[]; variantId?: string | null; variantGid?: string | null }[],
  actor: string,
): Promise<RowExecOutcome> {
  const applied: string[] = [];
  let imageAdded = false;

  // ── CREATE (NEW) ──────────────────────────────────────────────────────────────
  if (row.status === "NEW") {
    // Idempotency backstop: the fresh plan already re-read live; a product that
    // now exists by SKU would be CONFLICT (not NEW), so we never reach here for it.
    const created = await createShopifyProduct({
      title: target.title,
      descriptionHtml: htmlFromPlain(target.descriptionText),
      status: "DRAFT", // never auto-activate/publish (§3, §11)
      price: target.price !== null ? String(target.price) : "0.00",
      compareAtPrice: target.compareAtPrice !== null ? String(target.compareAtPrice) : null,
      sku: row.sku || null,
      // mk2237 fix: write the catalog barcode at CREATE time so the very next
      // preview re-read matches instead of diffing barcodeChanged.
      barcode: row.barcode || null,
      quantity: 0, // §12 — no inventory write from the publisher
      locationId: null, // §12 — skip the stock step entirely
      imageUrl: target.hasImage ? safeImageUrlOrNull(target.imageUrl) : null,
    });
    if (!created.ok) {
      return { result: "FAILED", gid: created.shopifyId ?? null, ops: ["CREATE_PRODUCT"], error: safeErr(created.error), imageAdded: false, systemic: looksSystemic(created.error) };
    }
    const gid = created.shopifyId ?? null;
    if (!gid) return { result: "NEEDS_RECONCILIATION", gid: null, ops: ["CREATE_PRODUCT"], error: "أُنشئ المنتج لكن لم يُرجع مُعرّفاً.", imageAdded: false, systemic: false };
    applied.push("CREATE_PRODUCT");

    // §7 — durable ECL identity write-back through the approved boundary. If this
    // fails, return NEEDS_RECONCILIATION with the observed GID; NEVER re-create.
    const ecl = await writeEclMapping(
      admin as never,
      {
        productId: internal.id,
        variantId: null,
        channelKey: CHANNEL_KEY,
        storefrontKey: SHOPIFY_STOREFRONT_KEY,
        identityType: IDENTITY_TYPE,
        externalProductId: gid,
        externalVariantId: null,
        exportedSku: row.sku || null,
        exportedBarcode: row.barcode,
        variantSku: row.sku || null,
      },
      actor,
    );
    if (!ecl.ok && !ecl.duplicate) {
      return { result: "NEEDS_RECONCILIATION", gid, ops: applied, error: "أُنشئ في شوبي فاي لكن فشل حفظ الهوية — يحتاج مطابقة.", imageAdded: false, systemic: false };
    }
    return { result: "CREATED", gid, ops: applied, error: null, imageAdded: false, systemic: false };
  }

  // ── UPDATE (UPDATE_REQUIRED) ────────────────────────────────────────────────────
  const gid = row.shopifyProductGid;
  if (!gid) {
    return { result: "CONFLICT", gid: null, ops: [], error: "لا يوجد مُعرّف شوبي فاي للتحديث.", imageAdded: false, systemic: false };
  }

  // Product content (title / description).
  const content = ops.find((o) => o.type === "UPDATE_PRODUCT");
  if (content) {
    const fields: { title?: string } = {};
    if (content.fields.includes("title") && target.title) fields.title = target.title;
    // description update uses the same content mutation; title-only is the common case.
    if (Object.keys(fields).length > 0) {
      const r = await updateShopifyProductContent(gid, fields); // status intentionally never sent (§6)
      if (!r.ok) return { result: "FAILED", gid, ops: applied, error: safeErr(r.error), imageAdded, systemic: looksSystemic(r.error) };
      applied.push("UPDATE_PRODUCT");
    }
  }

  // Price ops (per variant, by GID).
  for (const op of ops.filter((o) => o.type === "UPDATE_PRICE")) {
    const vGid = op.variantGid ?? null;
    if (!vGid) { return { result: "CONFLICT", gid, ops: applied, error: "هوية المتغيّر غير محددة للسعر.", imageAdded, systemic: false }; } // §10 ambiguous → stop
    const tv = target.variants.find((v) => v.variantId === op.variantId);
    const price = tv?.price ?? target.price;
    if (price === null) continue;
    // SHOPIFY.PRICE.1 — per-unit compare-at, re-normalized against the exact
    // price being sent: only a REAL sale (compareAt > price) is ever written.
    const compareAt = normalizeCompareAt(price, tv ? tv.compareAtPrice : target.compareAtPrice);
    const r = await updateVariantPrice(gid, vGid, String(price), compareAt !== null ? String(compareAt) : null);
    if (!r.ok) return { result: "FAILED", gid, ops: applied, error: safeErr(r.error), imageAdded, systemic: looksSystemic(r.error) };
    applied.push("UPDATE_PRICE");
  }

  // Variant identity ops (sku/barcode) — GID-matched variants only; the catalog
  // is the identity source of truth. Only the PLANNED fields are sent, and only
  // when the target value is a real non-empty string (never blank out Shopify).
  for (const op of ops.filter((o) => o.type === "UPDATE_VARIANT")) {
    const vGid = op.variantGid ?? null;
    if (!vGid) { return { result: "CONFLICT", gid, ops: applied, error: "هوية المتغيّر غير محددة للتحديث.", imageAdded, systemic: false }; } // ambiguous → stop
    // Pure, unit-tested resolution (mk2237 regression): the target now always
    // carries the plan's unit — real variants AND the simple-product synthetic.
    const fields = variantIdentityFields({ fields: op.fields, variantId: op.variantId ?? null }, target);
    if (!fields.sku && !fields.barcode) continue;
    const r = await updateVariantIdentity(gid, vGid, fields);
    if (!r.ok) return { result: "FAILED", gid, ops: applied, error: safeErr(r.error), imageAdded, systemic: looksSystemic(r.error) };
    applied.push("UPDATE_VARIANT");
  }

  // Media — ADD a proven-missing image only (§11). Never delete/reorder.
  if (ops.some((o) => o.type === "UPDATE_MEDIA") && target.hasImage) {
    const url = safeImageUrlOrNull(target.imageUrl);
    if (url) {
      const okImg = await probeImage(url);
      if (okImg) {
        const r = await addProductImage(gid, target.imageUrl as string);
        if (!r.ok) return { result: "FAILED", gid, ops: applied, error: safeErr(r.error), imageAdded, systemic: looksSystemic(r.error) };
        applied.push("UPDATE_MEDIA");
        imageAdded = true;
      }
    }
  }

  if (applied.length === 0) return { result: "UNCHANGED", gid, ops: [], error: null, imageAdded: false, systemic: false };
  return { result: "UPDATED", gid, ops: applied, error: null, imageAdded, systemic: false };
}

async function probeImage(url: string): Promise<boolean> {
  try {
    const res = await safeFetchImage(url, { headers: { Range: "bytes=0-2047" }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const ct = String(res.headers.get("content-type") ?? "").toLowerCase();
    if ((!res.ok && res.status !== 206) || (ct && !ct.startsWith("image/") && !ct.includes("octet-stream"))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Never surface a raw Shopify/DB error to the operator. */
function safeErr(_e: string | undefined): string {
  return "فشلت العملية على شوبي فاي — حاول لاحقاً.";
}

function batchFingerprint(selections: readonly PublishSelection[]): string {
  const joined = [...selections].map((s) => `${s.internalProductId}:${s.expectedFingerprint}`).sort().join("|");
  // reuse the same FNV via a tiny inline (kept here to avoid importing the pure hash for one call)
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) { h ^= joined.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
