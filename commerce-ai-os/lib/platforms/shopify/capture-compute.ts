// Malikas V2 — Shopify snapshot capture logic (Phase UI.9.5). PURE: no DB, no
// network, no clock, no secrets, no Shopify client. This is the DURABLE, testable
// source of truth for what a Shopify snapshot records per product.
//
// It consumes ONLY the output of the EXISTING trusted Shopify read model
// (ShopifyCatalogRow from lib/catalog-v2/shopify-catalog-view) — the same rows the
// UI.7 operations presence bridge already reads. It NEVER calls Shopify, invents
// an external id, or fuzzy-matches: matching is whatever the read model already
// decided (unique SKU → unique barcode → unmatched/ambiguous). One snapshot per
// Malika product, rolled up across its sellable rows EXACTLY as loadShopifyPresence
// rolls up presence, so a snapshot reconstructs the same PlatformPresence the live
// reader would — the platform-status engine stays untouched.
//
// Confidence-only: a row whose presence/match is "unknown" (Shopify read was
// unavailable) is NEVER snapshotted — an unknown must never be recorded as a
// verdict. Only rows from a trusted, available read produce inputs.

import type { PlatformPresence } from "../../operations/shared/models";
import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

export const SHOPIFY_PLATFORM = "shopify";

/** How long a Shopify snapshot stays "fresh" (adopted threshold, unit-tested). */
export const SHOPIFY_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/** Hard upper bound on snapshot inputs built in one capture — a safety cap so a
 *  huge catalog can never produce an unbounded write set (the reader is already
 *  page/cap bounded; this bounds the capture side too). */
export const MAX_SHOPIFY_SNAPSHOT_INPUTS = 5000;

/** The dashboard-facing Shopify state derived from a stored snapshot. Kept for
 *  parity with PureSoul; the dashboard itself flows through PlatformPresence +
 *  the unchanged platform-status engine, so this is a convenience projection. */
export type ShopifyState = "published" | "ready" | "review" | "missing" | "unknown";

/** The subset of a trusted ShopifyCatalogRow this adapter reads. Declared
 *  structurally so this pure module never imports the server-only read layer;
 *  ShopifyCatalogRow is assignable to it. */
export interface ShopifyRowInput {
  masterProductId: string;
  sku: string | null;
  barcode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  shopifyProductId: string | null;
  shopifyStatus: string; // active | draft | archived | unknown
  presenceStatus: string; // present | missing | unknown
  matchStatus: string; // matched_sku | matched_barcode | ambiguous | unmatched | unknown
}

/** The rolled-up, whitelisted Shopify facts we persist in metadata so a snapshot
 *  reconstructs the same PlatformPresence the live reader produces. NO secrets,
 *  no token, no domain, no raw Shopify JSON — booleans + fixed enums only. */
interface ShopifyMeta {
  presence?: "present" | "missing";
  linked?: boolean;
  live?: boolean;
  reviewRequired?: boolean;
}

const S = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

const isLinkedMatch = (m: string): boolean => m === "matched_sku" || m === "matched_barcode";

interface Rollup {
  productId: string;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  externalId: string | null;
  status: string | null; // representative shopifyStatus (active | draft | archived)
  presence: "present" | "missing";
  linked: boolean;
  live: boolean;
  reviewRequired: boolean;
}

/**
 * Roll every trusted Shopify catalog row up to ONE record per Malika product,
 * mirroring loadShopifyPresence: once ANY sellable entity is linked/live the
 * product counts as linked/live, and ambiguity anywhere → reviewRequired. Rows
 * with an "unknown" presence/match (Shopify unavailable) are DROPPED — never
 * recorded as a verdict. The first uniquely-matched row supplies the Shopify
 * external id + status; ambiguous-only products keep a null external id.
 */
export function rollupShopifyRows(rows: readonly ShopifyRowInput[]): Rollup[] {
  const byProduct = new Map<string, Rollup>();
  for (const row of rows ?? []) {
    const id = S(row?.masterProductId);
    if (id === null) continue;
    const match = String(row?.matchStatus ?? "");
    const presence = String(row?.presenceStatus ?? "");
    // Confidence-only: skip rows we cannot trust (Shopify read unavailable).
    if (match === "unknown" || presence === "unknown") continue;

    const linked = isLinkedMatch(match);
    const ambiguous = match === "ambiguous";
    const live = linked && row.shopifyStatus === "active";
    const isPresent = presence === "present";

    const prev = byProduct.get(id);
    if (!prev) {
      byProduct.set(id, {
        productId: id,
        sku: S(row.sku),
        barcode: S(row.barcode),
        title: S(row.nameEn) ?? S(row.nameAr),
        externalId: linked ? S(row.shopifyProductId) : null,
        status: linked ? S(row.shopifyStatus) : null,
        presence: isPresent ? "present" : "missing",
        linked,
        live,
        reviewRequired: ambiguous,
      });
      continue;
    }
    prev.linked = prev.linked || linked;
    prev.live = prev.live || live;
    prev.reviewRequired = prev.reviewRequired || ambiguous;
    if (isPresent) prev.presence = "present";
    // First uniquely-matched row wins the external id + status (never guessed).
    if (prev.externalId === null && linked) {
      prev.externalId = S(row.shopifyProductId);
      prev.status = S(row.shopifyStatus);
    }
    if (prev.sku === null) prev.sku = S(row.sku);
    if (prev.barcode === null) prev.barcode = S(row.barcode);
    if (prev.title === null) prev.title = S(row.nameEn) ?? S(row.nameAr);
  }
  return [...byProduct.values()];
}

/**
 * Build snapshot inputs from the trusted Shopify read model. `capturedAt` is
 * supplied by the caller (no clock here). A snapshot records ONLY confident,
 * whitelisted facts:
 *  - price is NEVER recorded — the read model exposes Malika's price, not
 *    Shopify's, so recording it would misattribute a Malika price change to
 *    Shopify. availability is NEVER recorded — the read model never reads stock.
 *  - the reconstructable presence facts live in metadata.shopify (booleans +
 *    fixed enums only; no token, domain, or raw Shopify JSON).
 * Bounded by MAX_SHOPIFY_SNAPSHOT_INPUTS.
 */
export function rowsToSnapshotInputs(
  rows: readonly ShopifyRowInput[],
  capturedAt: string,
): SnapshotInput[] {
  const rollups = rollupShopifyRows(rows).slice(0, MAX_SHOPIFY_SNAPSHOT_INPUTS);
  return rollups.map((r) => {
    const meta: ShopifyMeta = {
      presence: r.presence,
      linked: r.linked,
      live: r.live,
      reviewRequired: r.reviewRequired,
    };
    return {
      platform: SHOPIFY_PLATFORM,
      productId: r.productId,
      externalId: r.externalId,
      sku: r.sku,
      barcode: r.barcode,
      status: r.status,
      price: null, // read model exposes Malika's price, not Shopify's — never record it
      availability: null, // read model never reads Shopify stock
      title: r.title,
      capturedAt,
      metadata: { shopify: meta },
    };
  });
}

function readMeta(snapshot: PlatformSnapshot): ShopifyMeta {
  const m = (snapshot.metadata as Record<string, unknown>)?.shopify;
  return m && typeof m === "object" ? (m as ShopifyMeta) : {};
}

/**
 * Reconstruct the PlatformPresence a snapshot represents — the SAME shape
 * loadShopifyPresence produces — so the dashboard can interpret a persisted
 * snapshot through the UNCHANGED platform-status engine. Prefers the persisted
 * rolled-up flags; falls back to deriving them from status/external id for any
 * snapshot written without metadata. `drift` is always false (the read model has
 * no field-level drift yet — never invented).
 */
export function snapshotToShopifyPresence(snapshot: PlatformSnapshot): PlatformPresence {
  const m = readMeta(snapshot);
  if (typeof m.linked === "boolean" || typeof m.live === "boolean" || typeof m.reviewRequired === "boolean") {
    return {
      linked: m.linked === true,
      live: m.live === true,
      drift: false,
      reviewRequired: m.reviewRequired === true,
    };
  }
  // Fallback: a matched snapshot carries an external id; live iff status active.
  const linked = S(snapshot.externalId) !== null;
  return {
    linked,
    live: linked && snapshot.status === "active",
    drift: false,
    reviewRequired: false,
  };
}

/** Convenience projection of a stored snapshot into a dashboard state (parity
 *  with PureSoul). The dashboard proper uses snapshotToShopifyPresence + the
 *  platform-status engine; this is used by tests and any direct display. */
export function classifyShopifySnapshot(snapshot: PlatformSnapshot): ShopifyState {
  const p = snapshotToShopifyPresence(snapshot);
  if (p.reviewRequired) return "review";
  if (p.linked && p.live) return "published";
  if (p.linked) return "ready"; // staged (draft/archived), not live yet
  return readMeta(snapshot).presence === "missing" ? "missing" : "unknown";
}

/** True when a snapshot's capture time is older than the adopted stale window. */
export function isSnapshotStale(capturedAt: string | null, now: number): boolean {
  if (!capturedAt) return true;
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > SHOPIFY_SNAPSHOT_STALE_MS;
}
