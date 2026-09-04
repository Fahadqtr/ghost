// Malikas V2 — Talabat snapshot capture logic (Phase UI.9.6). PURE: no DB, no
// network, no clock, no secrets, no Talabat/API code. This is the DURABLE,
// testable source of truth for what a Talabat snapshot records per product.
//
// Talabat has NO catalog API for us. Presence is UPLOAD-DRIVEN: the owner uploads
// Talabat's own catalog export and the EXISTING pure diff (diffTalabat, lib/
// talabat-diff.ts) answers "which of our Approved products are missing there".
// This adapter consumes ONLY that diff's verdicts (present / missing) — it adds
// NO matching of its own (no fuzzy, no name-only): it reuses whatever diffTalabat
// already decided. A separate, weaker signal — a confirmed channel_variant_mappings
// row (channel_product_id != null) — yields "linked" (ready) ONLY, never
// present/published (we cannot confirm the live listing without an upload).
//
// Confidence-only + honesty:
//   - present / missing  ← trusted upload diff (Approved products only)
//   - linked (ready)     ← confirmed mapping row (baseline, read-side only)
//   - price  = null  (Talabat price is never read back — only pushed in export)
//   - availability = null  (Talabat stock is never read; our stock ≠ theirs)
//   - absence / stale / read failure is NEVER "missing".

import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

export const TALABAT_PLATFORM = "talabat";

/** How long a Talabat snapshot stays "fresh" (adopted threshold, unit-tested). */
export const TALABAT_SNAPSHOT_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7d — uploads are periodic, not live

/** Hard upper bound on snapshot inputs built in one capture (safety cap). */
export const MAX_TALABAT_SNAPSHOT_INPUTS = 5000;

/** The dashboard-facing Talabat state. `linked` = a confirmed mapping exists but
 *  no upload has confirmed the live listing (ready, NOT published). */
export type TalabatState = "present" | "missing" | "review" | "linked" | "unknown";

/** Structural subset of a TalabatOurRow (lib/talabat-diff) this adapter reads. */
export interface TalabatCatalogRow {
  id: string;
  sku: string | null;
  barcode?: string | null;
  name_en: string | null;
  name_ar: string | null;
  /** STEP 62 — master membership, not approval. Supplied by the caller. */
  eligible: boolean;
}

/** Structural subset of a TalabatDiff (lib/talabat-diff) this adapter reads. */
export interface TalabatDiffResult {
  ok: boolean;
  missing: { product_id: string }[];
}

/** Structural subset of a channel_variant_mappings row (baseline linkage). */
export interface TalabatMappingRow {
  master_product_id: string;
  channel_product_id: string | null;
  mapping_status?: string | null;
}

type TalabatVerdict = "present" | "missing" | "review";

interface TalabatMeta {
  verdict?: TalabatVerdict;
  source?: "upload";
}

const S = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Exact "talabat" channel resolution (mirrors resolveExactTalabatChannel in the
 * order pipeline — same semantics, kept here so the adapter stays pure and never
 * imports the order pipeline). Exact, case-insensitive name match; ambiguous or
 * missing → null (never guessed).
 */
export function resolveTalabatChannelId(channels: readonly { id: string; name: string | null }[]): string | null {
  const matches = (channels ?? []).filter((c) => String(c?.name ?? "").trim().toLowerCase() === "talabat");
  return matches.length === 1 ? S(matches[0]!.id) : null;
}

/**
 * Build snapshot inputs from the trusted upload diff. Only ELIGIBLE (Approved)
 * products get a verdict — exactly the set diffTalabat itself considers sellable.
 * A product in `diff.missing` is `missing`; every other eligible product is
 * `present`. `capturedAt` is supplied by the caller (no clock). externalId is
 * NOT taken from the sheet (the upload does not carry a trusted Talabat id);
 * price/availability are always null. Bounded by MAX_TALABAT_SNAPSHOT_INPUTS.
 */
export function diffToSnapshotInputs(
  ours: readonly TalabatCatalogRow[],
  diff: TalabatDiffResult,
  capturedAt: string,
): SnapshotInput[] {
  if (!diff?.ok) return [];
  const missing = new Set<string>();
  for (const m of diff.missing ?? []) {
    const id = S(m?.product_id);
    if (id) missing.add(id);
  }
  const out: SnapshotInput[] = [];
  for (const o of ours ?? []) {
    const id = S(o?.id);
    if (id === null) continue;
    if (o.eligible !== true) continue; // eligibility mirrors the diff (master membership)
    const verdict: TalabatVerdict = missing.has(id) ? "missing" : "present";
    const meta: TalabatMeta = { verdict, source: "upload" };
    out.push({
      platform: TALABAT_PLATFORM,
      productId: id,
      externalId: null, // the upload sheet carries no trusted Talabat id
      sku: S(o.sku),
      barcode: S(o.barcode),
      status: verdict,
      price: null, // Talabat price is never read back — only pushed in export
      availability: null, // Talabat stock is never read
      title: S(o.name_en) ?? S(o.name_ar),
      capturedAt,
      metadata: { talabat: meta },
    });
    if (out.length >= MAX_TALABAT_SNAPSHOT_INPUTS) break;
  }
  return out;
}

function readMeta(snapshot: PlatformSnapshot): TalabatMeta {
  const m = (snapshot.metadata as Record<string, unknown>)?.talabat;
  return m && typeof m === "object" ? (m as TalabatMeta) : {};
}

/** Classify a stored Talabat snapshot into its dashboard state. Reads only the
 *  confident verdict recorded at capture time — a snapshot's ABSENCE is handled
 *  by the caller as "unknown"/"linked", NEVER "missing". */
export function classifyTalabatSnapshot(snapshot: PlatformSnapshot): TalabatState {
  const v = readMeta(snapshot).verdict;
  if (v === "missing") return "missing";
  if (v === "review") return "review";
  if (v === "present") return "present";
  return "unknown";
}

/**
 * Baseline linkage from confirmed mappings: a row with a non-null
 * channel_product_id and a non-archived status ⇒ the product is `linked` (ready)
 * on Talabat. This is weaker than an upload verdict — it proves we mapped it, not
 * that the listing is live — so it NEVER yields present/published. Returns one
 * entry per product id (first confirmed row wins).
 */
export function mappingsToLinkedProductIds(rows: readonly TalabatMappingRow[]): Set<string> {
  const linked = new Set<string>();
  for (const r of rows ?? []) {
    const id = S(r?.master_product_id);
    if (id === null) continue;
    if (S(r.channel_product_id) === null) continue; // no external id yet → not confirmed
    if (String(r.mapping_status ?? "") === "archived") continue;
    linked.add(id);
  }
  return linked;
}

/** True when a snapshot's capture time is older than the adopted stale window. */
export function isSnapshotStale(capturedAt: string | null, now: number): boolean {
  if (!capturedAt) return true;
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > TALABAT_SNAPSHOT_STALE_MS;
}
