import "server-only";
// CH.6D — Snoonu barcode completion orchestrator (SERVER).
//
// Two operations:
//   • scanBarcodeCompletion  — READ-ONLY. Resolves internal products/variants to
//     Snoonu listings through the ECL identity layer ONLY (external_channel_listings,
//     ACTIVE mappings, never legacy id columns), gathers deterministic barcode
//     evidence per storefront (persisted ECL exported_barcode, plus a live merchant
//     session when injected), and classifies each MISSING-barcode candidate. NO writes.
//   • applyBarcodeCompletion — WRITER-GATED (CH.3b requireMalakWriter). Re-scans
//     fresh, re-reads internal state at apply time (idempotency / stale-preview),
//     then writes ONLY selected AUTO_COMPLETABLE rows through the narrow Catalog
//     barcode boundary (writeProductBarcode / writeVariantBarcode), grain-exact.
//     Never touches quantity / availability / images / any other field. Records an
//     audit row per applied change. Partial failures continue; every selected item
//     resolves to UPDATED / UNCHANGED / SKIPPED / FAILED / NEEDS_REVIEW.

import { requireMalakWriter } from "@/lib/malak/authz";
import { isSignedIn } from "@/lib/auth/requireUser";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { safeError } from "@/lib/security/safe-error";
import {
  writeProductBarcode,
  writeVariantBarcode,
  type BarcodeWriteClient,
} from "@/lib/products/barcode-write";
import {
  SNOONU_STOREFRONT_KEYS,
  type SnoonuStorefrontKey,
  type MerchantSessionState,
} from "../merchant/merchant-contract.ts";
import {
  createSnoonuBarcodeSource,
  type SnoonuBarcodeSource,
} from "./barcode-source.server.ts";
import { normalizeBarcode } from "./snoonu-barcode-normalize.ts";
import {
  classifyBarcode,
  summarizeBarcode,
  type BarcodeCandidate,
  type BarcodeDiffRow,
  type BarcodeDiffSummary,
  type BarcodeEvidence,
} from "./snoonu-barcode-diff.ts";
import { planBarcodeApply, targetKey } from "./snoonu-barcode-plan.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const APPLY_FAILED = "تعذّر إكمال الباركود.";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

// ── read PORT (select/eq/in only — provably cannot write) ─────────────────────
interface QueryResult { data: unknown[] | null; error: unknown | null }
interface Filter extends PromiseLike<QueryResult> {
  eq(c: string, v: string): Filter;
  in(c: string, v: string[]): Filter;
  range(a: number, b: number): Filter;
}
interface Select { select(cols: string): Filter }
interface ReadClient { from(table: string): Select }

interface EclRow { productId: string; variantId: string | null; spi: string | null; exportedBarcode: string | null; storefront: SnoonuStorefrontKey }

/** Active Snoonu ECL rows for a storefront (identity + persisted barcode evidence). */
async function loadEclRows(client: ReadClient, storefront: SnoonuStorefrontKey): Promise<EclRow[]> {
  const out: EclRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from("external_channel_listings")
      .select("product_id, variant_id, external_product_id, exported_barcode")
      .eq("storefront_key", storefront)
      .eq("mapping_status", "active")
      .range(from, from + 999);
    if (error || !Array.isArray(data)) break;
    for (const r of data as Record<string, unknown>[]) {
      const productId = str(r.product_id);
      if (!productId) continue;
      out.push({ productId, variantId: str(r.variant_id), spi: str(r.external_product_id), exportedBarcode: str(r.exported_barcode), storefront });
    }
    if (data.length < 1000) break;
  }
  return out;
}

interface ProductInfo { sku: string | null; name: string | null; barcode: string | null }
async function loadProducts(client: ReadClient, ids: string[]): Promise<Map<string, ProductInfo>> {
  const out = new Map<string, ProductInfo>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 300) {
    const chunk = unique.slice(i, i + 300);
    const { data, error } = await client.from("products").select("id, sku, name_ar, name_en, barcode").in("id", chunk);
    if (error || !Array.isArray(data)) continue;
    for (const r of data as Record<string, unknown>[]) {
      const id = str(r.id);
      if (id) out.set(id, { sku: str(r.sku), name: str(r.name_ar) ?? str(r.name_en), barcode: str(r.barcode) });
    }
  }
  return out;
}

interface VariantInfo { sku: string | null; name: string | null; barcode: string | null }
async function loadVariants(client: ReadClient, ids: string[]): Promise<Map<string, VariantInfo>> {
  const out = new Map<string, VariantInfo>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 300) {
    const chunk = unique.slice(i, i + 300);
    const { data, error } = await client.from("product_variants").select("id, sku, variant_name, barcode").in("id", chunk);
    if (error || !Array.isArray(data)) continue;
    for (const r of data as Record<string, unknown>[]) {
      const id = str(r.id);
      if (id) out.set(id, { sku: str(r.sku), name: str(r.variant_name), barcode: str(r.barcode) });
    }
  }
  return out;
}

/** barcode → owner target keys (products + variants) across the whole catalog. */
async function loadBarcodeOwners(client: ReadClient): Promise<Map<string, Set<string>>> {
  const owners = new Map<string, Set<string>>();
  const add = (bc: string | null, key: string) => {
    const v = normalizeBarcode(bc);
    if (!v) return;
    const set = owners.get(v) ?? new Set<string>();
    set.add(key);
    owners.set(v, set);
  };
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from("products").select("id, barcode").range(from, from + 999);
    if (error || !Array.isArray(data)) break;
    for (const r of data as Record<string, unknown>[]) { const id = str(r.id); if (id) add(str(r.barcode), `product:${id}`); }
    if (data.length < 1000) break;
  }
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from("product_variants").select("id, barcode").range(from, from + 999);
    if (error || !Array.isArray(data)) break;
    for (const r of data as Record<string, unknown>[]) { const id = str(r.id); if (id) add(str(r.barcode), `variant:${id}`); }
    if (data.length < 1000) break;
  }
  return owners;
}

// ── SCAN (read-only preview) ─────────────────────────────────────────────────
export interface BarcodeScanResult {
  rows: BarcodeDiffRow[];
  summary: BarcodeDiffSummary;
  /** mapped targets that already carry a barcode (reported, not returned as rows). */
  alreadyComplete: number;
  liveSourceStates: Record<SnoonuStorefrontKey, MerchantSessionState>;
}

export interface ScanOptions {
  /** Injected live barcode sources per storefront (default: session_required/empty). */
  sources?: Partial<Record<SnoonuStorefrontKey, SnoonuBarcodeSource>>;
}

interface ScanInternals {
  rows: BarcodeDiffRow[];
  candidates: Map<string, BarcodeCandidate>;
  evidenceByKey: Map<string, BarcodeEvidence[]>;
}

async function buildScan(sb: ReadClient, opts: ScanOptions): Promise<{ scan: ScanInternals; alreadyComplete: number; liveSourceStates: Record<SnoonuStorefrontKey, MerchantSessionState> }> {
  // 1) Gather ECL rows + live evidence per storefront.
  const evidenceByKey = new Map<string, BarcodeEvidence[]>();
  const targetMeta = new Map<string, { targetKind: "product" | "variant"; productId: string; variantId: string | null }>();
  const liveSourceStates = {} as Record<SnoonuStorefrontKey, MerchantSessionState>;

  for (const storefront of SNOONU_STOREFRONT_KEYS) {
    const source = opts.sources?.[storefront] ?? createSnoonuBarcodeSource(storefront);
    const state = await source.state();
    liveSourceStates[storefront] = state;
    const live = state === "authenticated" ? await source.barcodeBySpi() : new Map<string, string>();

    const eclRows = await loadEclRows(sb, storefront);
    for (const row of eclRows) {
      const isVariant = !!row.variantId;
      const key = isVariant ? `variant:${row.variantId}` : `product:${row.productId}`;
      targetMeta.set(key, { targetKind: isVariant ? "variant" : "product", productId: row.productId, variantId: row.variantId });
      const rawBarcode = (row.spi && live.get(row.spi)) || row.exportedBarcode;
      const list = evidenceByKey.get(key) ?? [];
      list.push({ storefront, spi: row.spi, rawBarcode });
      evidenceByKey.set(key, list);
    }
  }

  // 2) Load internal info for the resolved targets.
  const productIds: string[] = [];
  const variantIds: string[] = [];
  for (const meta of targetMeta.values()) {
    if (meta.targetKind === "variant" && meta.variantId) variantIds.push(meta.variantId);
    else productIds.push(meta.productId);
  }
  const [products, variants, owners] = await Promise.all([
    loadProducts(sb, productIds),
    loadVariants(sb, variantIds),
    loadBarcodeOwners(sb),
  ]);

  // 3) Classify. Completion mode: only MISSING-barcode targets become rows.
  const rows: BarcodeDiffRow[] = [];
  const candidates = new Map<string, BarcodeCandidate>();
  let alreadyComplete = 0;

  for (const [key, meta] of targetMeta) {
    const info = meta.targetKind === "variant" && meta.variantId ? variants.get(meta.variantId) : products.get(meta.productId);
    const currentBarcode = info?.barcode ?? null;
    if (normalizeBarcode(currentBarcode) !== null) { alreadyComplete++; continue; }

    const candidate: BarcodeCandidate = {
      targetKind: meta.targetKind,
      productId: meta.productId,
      variantId: meta.variantId,
      sku: info?.sku ?? null,
      name: info?.name ?? null,
      currentBarcode,
      evidence: evidenceByKey.get(key) ?? [],
    };
    candidates.set(key, candidate);
    const isOwnedByOther = (barcode: string) => {
      const set = owners.get(barcode);
      if (!set) return false;
      return [...set].some((owner) => owner !== key);
    };
    rows.push(classifyBarcode(candidate, isOwnedByOther));
  }

  rows.sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    return (a.sku ?? "").localeCompare(b.sku ?? "");
  });

  return { scan: { rows, candidates, evidenceByKey }, alreadyComplete, liveSourceStates };
}

/** READ-ONLY scan across BOTH storefronts. No writes. */
export async function scanBarcodeCompletion(opts: ScanOptions = {}): Promise<BarcodeScanResult | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };
  const sb = createClient() as unknown as ReadClient;
  const { scan, alreadyComplete, liveSourceStates } = await buildScan(sb, opts);
  return { rows: scan.rows, summary: summarizeBarcode(scan.rows), alreadyComplete, liveSourceStates };
}

// ── APPLY (writer-gated, through the Catalog barcode boundary only) ───────────
export type ApplyStatus = "UPDATED" | "UNCHANGED" | "SKIPPED" | "FAILED" | "NEEDS_REVIEW";

export interface BarcodeApplyItem {
  targetKind: "product" | "variant";
  productId: string;
  variantId: string | null;
  sku: string | null;
  status: ApplyStatus;
  old: string | null;
  new: string | null;
  reason: string;
}

export interface BarcodeApplySummary { total: number; updated: number; unchanged: number; skipped: number; failed: number; needsReview: number }

function summarizeApply(items: BarcodeApplyItem[]): BarcodeApplySummary {
  return {
    total: items.length,
    updated: items.filter((i) => i.status === "UPDATED").length,
    unchanged: items.filter((i) => i.status === "UNCHANGED").length,
    skipped: items.filter((i) => i.status === "SKIPPED").length,
    failed: items.filter((i) => i.status === "FAILED").length,
    needsReview: items.filter((i) => i.status === "NEEDS_REVIEW").length,
  };
}

/**
 * WRITER-GATED apply. Re-scans fresh, plans with idempotency/stale-preview
 * protection, and writes ONLY selected AUTO_COMPLETABLE rows through the Catalog
 * barcode boundary — grain-exact. Audits each applied change. Partial failures
 * continue; every selected target gets a per-item result.
 */
export async function applyBarcodeCompletion(
  selectedKeys: string[],
  opts: ScanOptions = {},
): Promise<{ results: BarcodeApplyItem[]; summary: BarcodeApplySummary } | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };

  const selected = new Set((selectedKeys ?? []).filter(Boolean));
  if (selected.size === 0) return { results: [], summary: summarizeApply([]) };

  const sb = createClient() as unknown as ReadClient;
  const { scan } = await buildScan(sb, opts);
  const rowByKey = new Map(scan.rows.map((r) => [targetKey(r), r]));

  // Fresh internal barcode + ownership are already reflected in the fresh scan;
  // build currentNow/isOwnedByOther from it for the pure planner.
  const currentNow = new Map<string, string | null>();
  for (const r of scan.rows) currentNow.set(targetKey(r), r.currentBarcode);
  const owners = await loadBarcodeOwners(sb);
  const isOwnedByOther = (barcode: string, key: string) => {
    const set = owners.get(barcode);
    return set ? [...set].some((o) => o !== key) : false;
  };

  const results: BarcodeApplyItem[] = [];
  // Selected keys that fell out of the completion scan (barcode filled, mapping
  // removed, …) → SKIPPED, never blindly written.
  for (const key of selected) {
    if (!rowByKey.has(key)) {
      const meta = key.startsWith("variant:")
        ? { targetKind: "variant" as const, productId: "", variantId: key.slice("variant:".length) }
        : { targetKind: "product" as const, productId: key.slice("product:".length), variantId: null };
      results.push({ ...meta, sku: null, status: "SKIPPED", old: null, new: null, reason: "no longer a completion candidate (barcode filled or mapping changed)" });
    }
  }

  const plan = planBarcodeApply({ rows: scan.rows, selected, currentNow, isOwnedByOther });
  const admin = createAdminClient();
  const writeClient = admin as unknown as BarcodeWriteClient;
  const at = new Date().toISOString();

  for (const item of plan) {
    const key = targetKey(item);
    const row = rowByKey.get(key);
    const sku = row?.sku ?? null;
    const oldBarcode = row?.currentBarcode ?? null;
    const base = { targetKind: item.targetKind, productId: item.productId, variantId: item.variantId, sku };

    if (item.action === "skip") { results.push({ ...base, status: "SKIPPED", old: oldBarcode, new: null, reason: item.reason }); continue; }
    if (item.action === "unchanged") { results.push({ ...base, status: "UNCHANGED", old: oldBarcode, new: null, reason: item.reason }); continue; }
    if (item.action === "needs_review") { results.push({ ...base, status: "NEEDS_REVIEW", old: oldBarcode, new: null, reason: item.reason }); continue; }

    // action === "apply" — grain-exact write through the Catalog barcode boundary.
    const incoming = item.incoming as string;
    try {
      const res = item.targetKind === "variant" && item.variantId
        ? await writeVariantBarcode(writeClient, item.variantId, incoming)
        : await writeProductBarcode(writeClient, item.productId, incoming);
      if (!res.ok) { results.push({ ...base, status: "FAILED", old: oldBarcode, new: null, reason: safeError("ch6d.write", res.error, APPLY_FAILED) }); continue; }

      const evidence = scan.candidates.get(key)?.evidence ?? [];
      const src = evidence.filter((e) => normalizeBarcode(e.rawBarcode) === incoming);
      await insertAuditRow(admin, {
        agent: "snoonu_barcode_completion",
        action: "barcode_complete",
        action_type: "barcode_complete",
        actor: writer.email,
        sku,
        product_id: item.productId,
        field: item.targetKind === "variant" ? "variant_barcode" : "barcode",
        old_value: oldBarcode ?? "(empty)",
        new_value: incoming,
        status: "done",
        details: {
          source: "snoonu",
          storefronts: src.map((e) => e.storefront),
          spis: src.map((e) => e.spi),
          targetKind: item.targetKind,
          variantId: item.variantId,
          reason: item.reason,
          at,
        },
      }).catch(() => {});
      results.push({ ...base, status: "UPDATED", old: oldBarcode, new: incoming, reason: item.reason });
    } catch (e) {
      results.push({ ...base, status: "FAILED", old: oldBarcode, new: null, reason: safeError("ch6d.apply", e, APPLY_FAILED) });
    }
  }

  return { results, summary: summarizeApply(results) };
}
