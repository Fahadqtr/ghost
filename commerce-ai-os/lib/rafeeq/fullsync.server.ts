// RAFEEQ.FULLSYNC.1 — durable Rafeeq sent-state + reconciliation I/O (SERVER-ONLY).
//
// This is the ONE sanctioned write boundary for the Rafeeq file-sync workflow.
// It owns four things, and nothing else writes them:
//   • reading the durable delivery state (rafeeq_packages + rafeeq_package_items)
//     with graceful degradation while the tables are unmigrated (42P01 →
//     UNAVAILABLE, never fabricated);
//   • recording a generated package + its item snapshot (called by the download
//     route AFTER a successful generation — recording never blocks the file);
//   • the explicit owner action "Mark as sent to Rafeeq" (sets sent_at/sent_by
//     once; generating or downloading NEVER sets them);
//   • the returned-file reconciliation: SheetJS parse → the pure reconcile plan
//     (preview = read-only) and the owner-approved apply that updates ONLY the
//     storefront-scoped Rafeeq identity rows in external_channel_listings.
//
// Identity rules are inherited, not re-invented: matching is certified
// SKU/barcode only (pure module), needs_review rows are retired ONLY through an
// exact match the owner approved, ids are never fabricated, and the legacy
// per-store id column on products is never read or written. No Rafeeq API
// publish exists anywhere in this workflow. AUTH is enforced by the callers
// (route/actions) AND the mutating functions take the verified actor email.

import "server-only";

import { createRequire } from "node:module";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { storefrontByKey } from "@/lib/channels/storefronts";
import { RAFEEQ_STOREFRONT_KEY } from "@/lib/export/rafeeq/preview";
import {
  sentSellableKeySet,
  type RafeeqFullSyncMode,
  type RafeeqPackageRecord,
  type RafeeqPackageItemRecord,
} from "@/lib/export/rafeeq/fullsync";
import {
  parseReturnedSheet,
  buildReconcilePlan,
  type ReconcileCatalogProduct,
  type ReconcileMappingEvidence,
  type ReconcilePlan,
} from "@/lib/export/rafeeq/reconcile";

const UNDEFINED_TABLE = "42P01";
const PAGE = 1000;
const MAX_ROWS = 50000;
const ITEM_INSERT_CHUNK = 500;
const MAX_APPLY_ACTIONS = 2000;
const MAX_RETURNED_FILE_BYTES = 10 * 1024 * 1024; // 10 MB spreadsheet cap

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ── delivery state (read-only) ────────────────────────────────────────────────

export interface RafeeqDeliveryState {
  availability: "AVAILABLE" | "UNAVAILABLE";
  /** false while the FULLSYNC.2 variant-grain migration is not applied. */
  variantGrain: boolean;
  packages: RafeeqPackageRecord[];
  items: RafeeqPackageItemRecord[];
  /** sellable keys (product / product::variant) contained in SENT packages. */
  sentSellableKeys: Set<string>;
}

const EMPTY_DELIVERY: RafeeqDeliveryState = {
  availability: "UNAVAILABLE",
  variantGrain: false,
  packages: [],
  items: [],
  sentSellableKeys: new Set(),
};

function toPackageRecord(r: Record<string, unknown>): RafeeqPackageRecord {
  return {
    id: String(r.id ?? ""),
    mode: r.mode === "NEW" ? "NEW" : "FULL",
    outputFilename: s(r.output_filename) ?? "",
    productCount: num(r.product_count),
    imageCount: num(r.image_count),
    generatedAt: s(r.generated_at),
    generatedBy: s(r.generated_by),
    sentAt: s(r.sent_at),
    sentBy: s(r.sent_by),
    supersededAt: "superseded_at" in r ? s(r.superseded_at) : null,
  };
}

/**
 * Read the durable package history + the sent-product baseline. Unmigrated
 * tables (42P01) or any read error degrade to UNAVAILABLE — never a fabricated
 * empty-but-available state that would make everything look "pending & never
 * sent" with false confidence.
 */
export async function loadRafeeqDeliveryState(): Promise<RafeeqDeliveryState> {
  try {
    const client = createClient();
    // Prefer the FULLSYNC.2 columns; fall back to the FULLSYNC.1 shape on an
    // unmigrated database (42703 undefined_column) — variant grain then reads
    // as unavailable, never faked.
    let variantGrain = true;
    const readPackages = (columns: string) =>
      client
        .from("rafeeq_packages")
        .select(columns)
        .order("generated_at", { ascending: false })
        .limit(100) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { code?: string } | null }>;
    let pkgRes = await readPackages("id, mode, output_filename, product_count, image_count, generated_at, generated_by, sent_at, sent_by, superseded_at");
    if (pkgRes.error) {
      variantGrain = false;
      pkgRes = await readPackages("id, mode, output_filename, product_count, image_count, generated_at, generated_by, sent_at, sent_by");
    }
    if (pkgRes.error || !Array.isArray(pkgRes.data)) return EMPTY_DELIVERY;
    const packages = (pkgRes.data as Record<string, unknown>[]).map(toPackageRecord);

    // Items are needed only for SENT packages (the pending-NEW baseline).
    const sentIds = packages.filter((p) => p.sentAt !== null).map((p) => p.id);
    const items: RafeeqPackageItemRecord[] = [];
    if (sentIds.length > 0) {
      const itemColumns = variantGrain ? "package_id, product_id, variant_id, sku" : "package_id, product_id, sku";
      for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const { data, error } = await client
          .from("rafeeq_package_items")
          .select(itemColumns)
          .in("package_id", sentIds)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error || !Array.isArray(data)) return EMPTY_DELIVERY;
        for (const r of data as unknown as Record<string, unknown>[]) {
          items.push({
            packageId: String(r.package_id ?? ""),
            productId: String(r.product_id ?? ""),
            variantId: variantGrain ? s(r.variant_id) : null,
            sku: s(r.sku) ?? "",
          });
        }
        if (data.length < PAGE) break;
      }
    }

    return { availability: "AVAILABLE", variantGrain, packages, items, sentSellableKeys: sentSellableKeySet(packages, items) };
  } catch {
    return EMPTY_DELIVERY;
  }
}

// ── package recording (called by the route AFTER generation succeeds) ─────────

export interface RecordPackageInput {
  mode: RafeeqFullSyncMode;
  outputFilename: string;
  manifestFingerprint: string;
  productCount: number;
  imageCount: number;
  generatedAt: string;
  actor: string | null;
  items: { productId: string; variantId: string | null; sku: string; fingerprint: string; rafeeqIdSent: string }[];
}

export interface RecordPackageResult {
  persisted: boolean;
  packageId: string | null;
  itemsPersisted: number;
  tableMissing: boolean;
  /** true when the FULLSYNC.2 variant-grain migration is missing (items not recorded). */
  schemaOutdated: boolean;
  /** prior UNSENT FULL packages marked superseded by this recording. */
  supersededCount: number;
}

/**
 * Persist the generated package + its SELLABLE item snapshot (sent_at stays
 * NULL — "Generated, not sent"). Recording a FULL package also marks prior
 * UNSENT FULL packages as superseded (history is never deleted; SENT packages
 * are never touched). Best-effort: an unmigrated database degrades to the
 * malak_audit floor; the download itself is never blocked by recording.
 */
export async function recordRafeeqPackage(input: RecordPackageInput): Promise<RecordPackageResult> {
  let persisted = false;
  let packageId: string | null = null;
  let itemsPersisted = 0;
  let tableMissing = false;
  let schemaOutdated = false;
  let supersededCount = 0;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("rafeeq_packages")
      .insert({
        mode: input.mode,
        output_filename: input.outputFilename,
        manifest_fingerprint: input.manifestFingerprint,
        product_count: input.productCount,
        image_count: input.imageCount,
        generated_at: input.generatedAt,
        generated_by: input.actor,
        sent_at: null,
        sent_by: null,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      if (String((error as { code?: string }).code ?? "") === UNDEFINED_TABLE) tableMissing = true;
    } else if (data?.id) {
      persisted = true;
      packageId = String(data.id);
      for (let i = 0; i < input.items.length; i += ITEM_INSERT_CHUNK) {
        const chunk = input.items.slice(i, i + ITEM_INSERT_CHUNK).map((it) => ({
          package_id: packageId,
          product_id: it.productId,
          variant_id: it.variantId,
          sku: it.sku,
          row_fingerprint: it.fingerprint,
          rafeeq_id_sent: it.rafeeqIdSent,
        }));
        const { error: itemError } = await admin.from("rafeeq_package_items").insert(chunk);
        if (itemError) {
          // 42703 = variant_id column absent (FULLSYNC.2 migration not applied).
          // The sellable snapshot CANNOT be represented at product grain without
          // lying (variant siblings would collide) — record nothing and surface it.
          if (String((itemError as { code?: string }).code ?? "") === "42703") schemaOutdated = true;
          break;
        }
        itemsPersisted += chunk.length;
      }

      // Supersede prior UNSENT FULL packages (never a sent one, never delete).
      if (input.mode === "FULL") {
        try {
          const { data: superseded } = await admin
            .from("rafeeq_packages")
            .update({ superseded_at: new Date().toISOString(), superseded_by: packageId })
            .eq("mode", "FULL")
            .is("sent_at", null)
            .is("superseded_at", null)
            .neq("id", packageId)
            .select("id");
          supersededCount = Array.isArray(superseded) ? superseded.length : 0;
        } catch {
          /* superseded columns absent (unmigrated) — surfacing degrades gracefully */
        }
      }
    }
  } catch {
    /* best-effort — fall through to the audit floor */
  }

  // Guaranteed floor: a compact malak_audit row (identifiers + counts only).
  try {
    const admin = createAdminClient() as never;
    await insertAuditRow(admin, {
      action_type: "rafeeq_fullsync_package",
      agent: input.actor ?? "unknown",
      product_id: null,
      new_value: input.outputFilename,
      details: {
        destination: RAFEEQ_STOREFRONT_KEY,
        mode: input.mode,
        actor: input.actor,
        generated_at: input.generatedAt,
        product_count: input.productCount,
        image_count: input.imageCount,
        manifest_fingerprint: input.manifestFingerprint,
        durable_package_persisted: persisted,
        items_persisted: itemsPersisted,
        schema_outdated: schemaOutdated,
        superseded_count: supersededCount,
      },
      status: "done",
    });
  } catch {
    /* never block the package on audit */
  }

  return { persisted, packageId, itemsPersisted, tableMissing, schemaOutdated, supersededCount };
}

// ── explicit owner sent-state ─────────────────────────────────────────────────

export type MarkSentResult =
  | { ok: true; packageId: string; sentAt: string }
  | { ok: false; error: string };

/**
 * "Mark as sent to Rafeeq" — the ONLY operation that establishes the sent
 * baseline. Sets sent_at/sent_by exactly once (a package already marked sent is
 * never re-stamped). Caller MUST have enforced the OWNER boundary; the verified
 * owner email is recorded as sent_by.
 */
export async function markRafeeqPackageSent(packageId: string, ownerEmail: string): Promise<MarkSentResult> {
  const id = s(packageId);
  if (!id) return { ok: false, error: "حزمة غير محددة." };
  try {
    const admin = createAdminClient();
    const sentAt = new Date().toISOString();
    const { data, error } = await admin
      .from("rafeeq_packages")
      .update({ sent_at: sentAt, sent_by: ownerEmail })
      .eq("id", id)
      .is("sent_at", null)
      .select("id")
      .maybeSingle();
    if (error) {
      if (String((error as { code?: string }).code ?? "") === UNDEFINED_TABLE) {
        return { ok: false, error: "سجل الحزم غير مفعّل بعد (الترحيل لم يُطبَّق)." };
      }
      return { ok: false, error: "تعذّر تحديث حالة الإرسال." };
    }
    if (!data?.id) return { ok: false, error: "الحزمة غير موجودة أو سبق تعليمها كمُرسَلة." };

    await insertAuditRow(admin as never, {
      action_type: "rafeeq_package_marked_sent",
      agent: ownerEmail,
      product_id: null,
      new_value: id,
      details: { destination: RAFEEQ_STOREFRONT_KEY, package_id: id, sent_at: sentAt, sent_by: ownerEmail },
      status: "done",
    }).catch(() => {});

    return { ok: true, packageId: id, sentAt };
  } catch {
    return { ok: false, error: "تعذّر تحديث حالة الإرسال." };
  }
}

// ── returned-file reconciliation ──────────────────────────────────────────────

/** SheetJS parse of the returned workbook's FIRST sheet into an AoA. */
function returnedWorkbookToAoa(bytes: Uint8Array): unknown[][] | null {
  try {
    const require = createRequire(import.meta.url);
    const XLSX = require("xlsx");
    const wb = XLSX.read(bytes, { type: "buffer" });
    const first = wb.SheetNames?.[0];
    if (!first) return null;
    const ws = wb.Sheets[first];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
    return Array.isArray(aoa) ? (aoa as unknown[][]) : null;
  } catch {
    return null;
  }
}

async function readAllRows(
  client: ReturnType<typeof createClient>,
  table: string,
  columns: string,
  orderCol: string,
  filter?: (q: any) => any,
): Promise<Record<string, unknown>[] | null> {
  try {
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      let q = client.from(table).select(columns).order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
      if (filter) q = filter(q);
      const { data, error } = await q;
      if (error || !Array.isArray(data)) return null;
      rows.push(...(data as unknown as Record<string, unknown>[]));
      if (data.length < PAGE) break;
    }
    return rows;
  } catch {
    return null;
  }
}

interface ReconcileEvidence {
  catalog: ReconcileCatalogProduct[];
  mappings: ReconcileMappingEvidence[];
}

async function loadReconcileEvidence(): Promise<ReconcileEvidence | null> {
  const client = createClient();
  const [productRows, variantRows, eclRows] = await Promise.all([
    readAllRows(client, "products", "id, sku, barcode", "id"),
    readAllRows(client, "product_variants", "id, parent_product_id, sku, barcode", "parent_product_id"),
    readAllRows(client, "external_channel_listings", "product_id, variant_id, variant_sku, exported_sku, external_product_id, mapping_status", "id",
      (q) => q.eq("storefront_key", RAFEEQ_STOREFRONT_KEY)),
  ]);
  if (!productRows || !variantRows || !eclRows) return null;

  // SELLABLE catalog evidence (mirrors the export flattening): a product with
  // variants contributes ONE entry per variant (its own sku) and NO parent
  // entry; a simple product contributes its product-level entry. Every entry
  // carries the canonical PARENT product sku — the value the exported BARCODE
  // column holds under the owner template rule (corroboration evidence).
  const parentSkuById = new Map<string, string>();
  for (const p of productRows) {
    const id = s(p.id);
    const sku = s(p.sku);
    if (id && sku) parentSkuById.set(id, sku);
  }
  const productsWithVariants = new Set<string>();
  const variantEntries: ReconcileCatalogProduct[] = [];
  for (const v of variantRows) {
    const pid = s(v.parent_product_id);
    const vid = s(v.id);
    const sku = s(v.sku);
    if (!pid || !vid || !sku) continue;
    productsWithVariants.add(pid);
    variantEntries.push({ productId: pid, variantId: vid, sku, parentSku: parentSkuById.get(pid) ?? null, barcode: s(v.barcode) });
  }
  const catalog: ReconcileCatalogProduct[] = [...variantEntries];
  for (const p of productRows) {
    const id = s(p.id);
    const sku = s(p.sku);
    if (!id || !sku || productsWithVariants.has(id)) continue;
    catalog.push({ productId: id, variantId: null, sku, parentSku: sku, barcode: s(p.barcode) });
  }

  const mappings: ReconcileMappingEvidence[] = [];
  for (const e of eclRows) {
    const status = s(e.mapping_status);
    if (status === "archived") continue;
    mappings.push({
      productId: s(e.product_id),
      variantId: s(e.variant_id),
      sku: s(e.exported_sku) ?? s(e.variant_sku) ?? "",
      externalId: s(e.external_product_id),
      status: status === "needs_review" ? "needs_review" : "resolved",
    });
  }

  return { catalog, mappings };
}

export type ReturnedIdsPreview =
  | { ok: true; plan: ReconcilePlan }
  | { ok: false; error: "file_too_large" | "unreadable_file" | "missing_columns" | "empty_file" | "evidence_unavailable" };

/**
 * READ-ONLY preview of a returned Rafeeq file: parse → certified SKU/barcode
 * reconciliation plan. Writes nothing; the owner sees exactly what an apply
 * would do (and every row it would refuse) before anything changes.
 */
export async function previewRafeeqReturnedIds(bytes: Uint8Array): Promise<ReturnedIdsPreview> {
  if (bytes.byteLength === 0) return { ok: false, error: "empty_file" };
  if (bytes.byteLength > MAX_RETURNED_FILE_BYTES) return { ok: false, error: "file_too_large" };
  const aoa = returnedWorkbookToAoa(bytes);
  if (!aoa) return { ok: false, error: "unreadable_file" };
  const parsed = parseReturnedSheet(aoa);
  if (!parsed.ok) return { ok: false, error: parsed.error === "missing_columns" ? "missing_columns" : "empty_file" };
  const evidence = await loadReconcileEvidence();
  if (!evidence) return { ok: false, error: "evidence_unavailable" };
  return { ok: true, plan: buildReconcilePlan({ returned: parsed.rows, catalog: evidence.catalog, mappings: evidence.mappings }) };
}

export type ApplyReturnedIdsResult =
  | { ok: true; applied: number; inserted: number; updated: number; needsReviewResolved: number; failed: number }
  | { ok: false; error: "file_too_large" | "unreadable_file" | "missing_columns" | "empty_file" | "evidence_unavailable" | "nothing_to_apply" | "too_many_actions" };

/**
 * OWNER-APPROVED apply of a returned Rafeeq file. The plan is re-derived FRESH
 * from the uploaded bytes + current production evidence server-side (a client
 * can never send a hand-crafted plan). Only clean matches are applied, at the
 * SELLABLE grain (variant identities are written with variant_id + variant_sku
 * on the certified ECL contract — never collapsed onto the parent):
 *   • insert  → new active rafeeq:malikas ECL identity row
 *   • update / resolve_needs_review → external_product_id + mapping_status
 *     "active" on the EXISTING storefront-scoped row (variant-scoped when the
 *     match is a variant row)
 * Conflict/duplicate/unknown rows are never touched. Caller MUST have enforced
 * the OWNER boundary; the verified owner email is recorded in the audit trail.
 */
export async function applyRafeeqReturnedIds(bytes: Uint8Array, ownerEmail: string): Promise<ApplyReturnedIdsResult> {
  const preview = await previewRafeeqReturnedIds(bytes);
  if (!preview.ok) return { ok: false, error: preview.error };
  const plan = preview.plan;
  if (plan.apply.length === 0) return { ok: false, error: "nothing_to_apply" };
  if (plan.apply.length > MAX_APPLY_ACTIONS) return { ok: false, error: "too_many_actions" };

  const identityType = storefrontByKey(RAFEEQ_STOREFRONT_KEY)?.identityType ?? null;
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  let inserted = 0;
  let updated = 0;
  let needsReviewResolved = 0;
  let failed = 0;

  for (const a of plan.apply) {
    try {
      if (a.action === "insert") {
        const { error } = await admin.from("external_channel_listings").insert({
          product_id: a.productId,
          variant_id: a.variantId,
          variant_sku: a.variantId ? a.sku : null,
          channel_key: "rafeeq",
          storefront_key: RAFEEQ_STOREFRONT_KEY,
          external_product_id: a.externalId,
          external_variant_id: null,
          exported_sku: a.sku,
          exported_barcode: a.barcode,
          identity_type: identityType,
          mapping_status: "active",
          metadata: { source: "rafeeq_fullsync_reconcile", created_by: ownerEmail, applied_at: nowIso },
        });
        if (error) failed++;
        else inserted++;
      } else {
        let q = admin
          .from("external_channel_listings")
          .update({ external_product_id: a.externalId, mapping_status: "active", updated_at: nowIso })
          .eq("storefront_key", RAFEEQ_STOREFRONT_KEY)
          .eq("product_id", a.productId);
        // Sellable scope: a variant identity updates ONLY its variant row; a
        // simple product updates ONLY the product-level (variant_id NULL) row.
        q = a.variantId ? q.eq("variant_id", a.variantId) : q.is("variant_id", null);
        const { data, error } = await q.select("id");
        if (error || !Array.isArray(data) || data.length === 0) failed++;
        else if (a.action === "resolve_needs_review") needsReviewResolved++;
        else updated++;
      }
    } catch {
      failed++;
    }
  }

  await insertAuditRow(admin as never, {
    action_type: "rafeeq_returned_ids_applied",
    agent: ownerEmail,
    product_id: null,
    details: {
      destination: RAFEEQ_STOREFRONT_KEY,
      actor: ownerEmail,
      applied_at: nowIso,
      planned: plan.apply.length,
      inserted,
      updated,
      needs_review_resolved: needsReviewResolved,
      failed,
      counts: plan.counts,
    },
    status: failed > 0 ? "error" : "done",
  }).catch(() => {});

  return { ok: true, applied: inserted + updated + needsReviewResolved, inserted, updated, needsReviewResolved, failed };
}
