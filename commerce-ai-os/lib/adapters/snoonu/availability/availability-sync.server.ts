import "server-only";
// CH.6C — Snoonu availability synchronization orchestrator (SERVER).
//
// Two operations:
//   • scanSnoonuAvailability  — READ-ONLY. Reads the Snoonu listing availability
//     from the merchant source (SPI-keyed), resolves each SPI through the ECL
//     identity layer ONLY (external_channel_listings, ACTIVE mappings, never
//     legacy id columns), and builds the diff/preview. It performs NO writes.
//   • applySnoonuAvailability — WRITER-GATED (CH.3b requireMalakWriter). It
//     re-scans fresh, re-reads internal availability at apply time (idempotency /
//     stale-preview protection), then applies each confirmed change ONLY through
//     the Availability Engine (writeProductAvailability → products.stock_status).
//     It NEVER writes quantity/inventory/shelf/sold columns, NEVER propagates to
//     a channel, and NEVER touches products/product_variants directly. Each
//     applied change is recorded in malak_audit (timestamp, storefront, SPI,
//     product, old, new, reason). Partial failures are allowed: every selected
//     item resolves to UPDATED / UNCHANGED / FAILED / SKIPPED.
//
// Authority split: Availability = products.stock_status (via the Availability
// Engine). Inventory quantity is owned by the Inventory Engine and is out of
// scope — this flow reads it never, writes it never.

import { isSignedIn } from "@/lib/auth/requireUser";
import { requireMalakWriter } from "@/lib/malak/authz";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { insertAuditRow } from "@/lib/audit";
import { safeError } from "@/lib/security/safe-error";
import { writeProductAvailability, type AvailabilityWriteClient } from "@/lib/availability/engine";
import { normalizeAvailability, type AvailabilityState } from "@/lib/availability/read";
import { type SnoonuStorefrontKey, type MerchantSessionState } from "../merchant/merchant-contract.ts";
import {
  createSnoonuAvailabilitySource,
  type SnoonuAvailabilitySource,
} from "./availability-source.server.ts";
import { normalizeSnoonuAvailability, type SnoonuAvailability } from "./snoonu-availability-normalize.ts";
import {
  buildAvailabilityDiff,
  summarizeDiff,
  type AvailabilityDiffRow,
  type AvailabilityDiffSummary,
  type ProductLifecycle,
  type ResolvedProduct,
} from "./snoonu-availability-diff.ts";
import { planAvailabilityApply } from "./snoonu-availability-plan.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const APPLY_FAILED = "تعذّر تحديث التوفّر.";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** products.platform_status is the product lifecycle enum, not a channel state. */
function toLifecycle(raw: unknown): ProductLifecycle {
  const t = str(raw);
  if (t === "Active" || t === "Draft" || t === "Archived") return t;
  return null;
}

// ── read PORT (select/eq/in only — provably cannot write) ─────────────────────
interface QueryResult { data: unknown[] | null; error: unknown | null }
interface Filter extends PromiseLike<QueryResult> {
  eq(c: string, v: string): Filter;
  in(c: string, v: string[]): Filter;
  range(a: number, b: number): Filter;
}
interface Select { select(cols: string): Filter }
interface ReadClient { from(table: string): Select }

/** SPI → ACTIVE ECL mapping (productId + spi) for this storefront. Read-only. */
async function loadActiveMappings(
  client: ReadClient,
  storefront: SnoonuStorefrontKey,
): Promise<Map<string, string>> {
  const bySpi = new Map<string, string>(); // spi → productId
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from("external_channel_listings")
      .select("product_id, external_product_id")
      .eq("storefront_key", storefront)
      .eq("mapping_status", "active")
      .range(from, from + 999);
    if (error || !Array.isArray(data)) break;
    for (const r of data as Record<string, unknown>[]) {
      const pid = str(r.product_id);
      const spi = str(r.external_product_id);
      if (pid && spi) bySpi.set(spi, pid);
    }
    if (data.length < 1000) break;
  }
  return bySpi;
}

/** productId → {sku, current availability, lifecycle}. Read-only. */
async function loadProductInfo(
  client: ReadClient,
  ids: string[],
): Promise<Map<string, { sku: string | null; currentInternal: AvailabilityState | null; lifecycle: ProductLifecycle }>> {
  const out = new Map<string, { sku: string | null; currentInternal: AvailabilityState | null; lifecycle: ProductLifecycle }>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 300) {
    const chunk = unique.slice(i, i + 300);
    const { data, error } = await client
      .from("products")
      .select("id, sku, stock_status, platform_status")
      .in("id", chunk);
    if (error || !Array.isArray(data)) continue;
    for (const r of data as Record<string, unknown>[]) {
      const pid = str(r.id);
      if (!pid) continue;
      out.set(pid, {
        sku: str(r.sku),
        currentInternal: normalizeAvailability(r.stock_status),
        lifecycle: toLifecycle(r.platform_status),
      });
    }
  }
  return out;
}

// ── SCAN (read-only preview) ─────────────────────────────────────────────────
export interface AvailabilityScanResult {
  storefront: SnoonuStorefrontKey;
  sourceState: MerchantSessionState;
  rows: AvailabilityDiffRow[];
  summary: AvailabilityDiffSummary;
  /** whether the source returned any Snoonu availability signal at all. */
  sourceHasData: boolean;
}

export interface ScanOptions {
  /** Injected availability source (live portal / test). Defaults to the
   *  session-required no-op source until live activation. */
  source?: SnoonuAvailabilitySource;
}

/**
 * READ-ONLY per-storefront availability preview. SPI-driven: every SPI the source
 * reports is resolved through the ACTIVE ECL mapping for THIS storefront (no
 * active mapping → NEEDS_REVIEW). No writes. With the default source (no live
 * session) it returns an empty preview and a `session_required` state.
 */
export async function scanSnoonuAvailability(
  storefront: SnoonuStorefrontKey,
  opts: ScanOptions = {},
): Promise<AvailabilityScanResult | { error: string }> {
  if (!(await isSignedIn())) return { error: NOT_SIGNED_IN };

  const source = opts.source ?? createSnoonuAvailabilitySource(storefront);
  const sourceState = await source.state();
  const empty: AvailabilityScanResult = {
    storefront, sourceState, rows: [], summary: summarizeDiff([]), sourceHasData: false,
  };
  if (sourceState !== "authenticated") return empty;

  // Raw SPI → availability from the platform, normalized (never guessed).
  const raw = await source.listAvailability();
  const sourceBySpi = new Map<string, SnoonuAvailability>();
  for (const [spi, token] of raw) {
    const key = str(spi);
    if (key) sourceBySpi.set(key, normalizeSnoonuAvailability(token));
  }
  if (sourceBySpi.size === 0) return empty;

  // Resolve ONLY through ACTIVE ECL mappings for this storefront.
  const sb = createClient() as unknown as ReadClient;
  const productIdBySpi = await loadActiveMappings(sb, storefront);
  const resolvedIds = [...sourceBySpi.keys()].map((spi) => productIdBySpi.get(spi)).filter((v): v is string => !!v);
  const info = await loadProductInfo(sb, resolvedIds);

  const productBySpi = new Map<string, ResolvedProduct>();
  for (const spi of sourceBySpi.keys()) {
    const pid = productIdBySpi.get(spi);
    if (!pid) continue; // no active mapping → left out → buildAvailabilityDiff → NEEDS_REVIEW
    const pi = info.get(pid);
    productBySpi.set(spi, {
      productId: pid,
      sku: pi?.sku ?? null,
      currentInternal: pi?.currentInternal ?? null,
      lifecycle: pi?.lifecycle ?? null,
    });
  }

  const rows = buildAvailabilityDiff({ storefront, sourceBySpi, productBySpi });
  rows.sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    return (a.sku ?? "").localeCompare(b.sku ?? "");
  });

  return { storefront, sourceState, rows, summary: summarizeDiff(rows), sourceHasData: true };
}

// ── APPLY (writer-gated, through the Availability Engine only) ────────────────
export type ApplyStatus = "UPDATED" | "UNCHANGED" | "FAILED" | "SKIPPED";

export interface AvailabilityApplyItem {
  productId: string;
  spi: string | null;
  sku: string | null;
  status: ApplyStatus;
  old: AvailabilityState | null;
  new: AvailabilityState | null;
  reason: string;
}

export interface AvailabilityApplySummary {
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
  skipped: number;
}

function summarizeApply(items: AvailabilityApplyItem[]): AvailabilityApplySummary {
  return {
    total: items.length,
    updated: items.filter((i) => i.status === "UPDATED").length,
    unchanged: items.filter((i) => i.status === "UNCHANGED").length,
    failed: items.filter((i) => i.status === "FAILED").length,
    skipped: items.filter((i) => i.status === "SKIPPED").length,
  };
}

/**
 * WRITER-GATED apply. Re-scans fresh (the client's preview is never trusted),
 * re-reads internal availability at apply time, plans, then writes each confirmed
 * change through the Availability Engine ONLY. Records an audit row per applied
 * change. Partial failures continue; every selected id gets a per-item result.
 */
export async function applySnoonuAvailability(
  storefront: SnoonuStorefrontKey,
  selectedProductIds: string[],
  opts: ScanOptions = {},
): Promise<{ results: AvailabilityApplyItem[]; summary: AvailabilityApplySummary } | { error: string }> {
  const writer = await requireMalakWriter();
  if (!writer.ok) return { error: writer.error };

  const selected = new Set((selectedProductIds ?? []).filter(Boolean));
  if (selected.size === 0) return { results: [], summary: summarizeApply([]) };

  // Fresh re-scan — never trust a stale client preview.
  const scan = await scanSnoonuAvailability(storefront, opts);
  if ("error" in scan) return { error: scan.error };
  const rowByProduct = new Map(scan.rows.filter((r) => r.productId).map((r) => [r.productId, r]));

  // Fresh internal availability at apply time (idempotency / stale-preview).
  const sb = createClient() as unknown as ReadClient;
  const freshInfo = await loadProductInfo(sb, [...selected]);
  const currentNow = new Map<string, AvailabilityState | null>();
  for (const pid of selected) currentNow.set(pid, freshInfo.get(pid)?.currentInternal ?? null);

  const results: AvailabilityApplyItem[] = [];
  // Selected ids absent from the current scan (mapping removed, no longer a
  // Snoonu listing, …) are SKIPPED, never blindly written.
  for (const pid of selected) {
    if (!rowByProduct.has(pid)) {
      results.push({
        productId: pid, spi: null, sku: freshInfo.get(pid)?.sku ?? null,
        status: "SKIPPED", old: currentNow.get(pid) ?? null, new: null,
        reason: "not in the current scan (no active mapping / not a Snoonu listing)",
      });
    }
  }

  const plan = planAvailabilityApply({ rows: scan.rows, selected, currentNow });
  const admin = createAdminClient();
  const engineClient = admin as unknown as AvailabilityWriteClient;
  const at = new Date().toISOString();

  for (const item of plan) {
    const row = rowByProduct.get(item.productId);
    const spi = row?.spi ?? null;
    const sku = row?.sku ?? freshInfo.get(item.productId)?.sku ?? null;
    const oldState = currentNow.get(item.productId) ?? null;

    if (item.action === "skip") {
      results.push({ productId: item.productId, spi, sku, status: "SKIPPED", old: oldState, new: null, reason: item.reason });
      continue;
    }
    if (item.action === "unchanged") {
      results.push({ productId: item.productId, spi, sku, status: "UNCHANGED", old: oldState, new: item.targetState, reason: item.reason });
      continue;
    }

    // action === "apply" — write ONLY through the Availability Engine.
    const target = item.targetState as AvailabilityState;
    try {
      const res = await writeProductAvailability(engineClient, [item.productId], target);
      if (!res.ok) {
        results.push({ productId: item.productId, spi, sku, status: "FAILED", old: oldState, new: null, reason: safeError("ch6c.write", res.error, APPLY_FAILED) });
        continue;
      }
      // Audit each applied change (best-effort; never fails the write).
      await insertAuditRow(admin, {
        agent: "snoonu_availability_sync",
        action: "availability_sync_apply",
        action_type: "availability_sync_apply",
        sku,
        product_id: item.productId,
        field: "stock_status",
        old_value: oldState ?? "(unset)",
        new_value: target,
        status: "done",
        details: { storefront, spi, reason: item.reason, at },
      }).catch(() => {});
      results.push({ productId: item.productId, spi, sku, status: "UPDATED", old: oldState, new: target, reason: item.reason });
    } catch (e) {
      results.push({ productId: item.productId, spi, sku, status: "FAILED", old: oldState, new: null, reason: safeError("ch6c.apply", e, APPLY_FAILED) });
    }
  }

  return { results, summary: summarizeApply(results) };
}
