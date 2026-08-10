// Malikas V2 — Rafeeq snapshot capture logic (Phase UI.9.7). PURE: no DB, no
// network, no clock, no secrets, no Rafeeq/API code. This is the DURABLE,
// testable source of truth for what a Rafeeq snapshot records per product.
//
// Rafeeq has NO API/client/webhook — it is an export-only channel. Its per-product
// state lives in DB overlays WE maintain: channel_products.channel_status for the
// Rafeeq channel + products.rafeeq_product_id (Rafeeq's external id). This adapter
// consumes ONLY those already-read overlays — it never reads Rafeeq, never adds a
// client, and never invents identity (no fuzzy/name matching).
//
// Confidence-only + honesty:
//   channel_status = Active     → present
//   channel_status = Not Listed → missing (a recorded, confident "not listed")
//   channel_status = Draft      → linked (ready, NOT published/live)
//   rafeeq_product_id present, no Active status → linked (ready)
//   no channel row AND no id     → unknown (NOT snapshotted; absence is never missing)
//   price = null (channel_price is OUR push-side override, not Rafeeq's)
//   availability = null (the shared availability overlay is a CROSS-PLATFORM
//     reconcile, never a pure Rafeeq read)

import type { PlatformSnapshot, SnapshotInput } from "../core/types.ts";

export const RAFEEQ_PLATFORM = "rafeeq";

/** How long a Rafeeq snapshot stays "fresh". The channel record is maintained
 *  periodically (export / sync / manual), not live — 7 days like Talabat. */
export const RAFEEQ_SNAPSHOT_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/** Hard upper bound on snapshot inputs built in one capture (safety cap). */
export const MAX_RAFEEQ_SNAPSHOT_INPUTS = 5000;

/** The dashboard-facing Rafeeq state. `linked` = we have an id / Draft listing
 *  but no confirmed live listing (ready, NOT published). No `review` — there is
 *  no trusted source for an ambiguity verdict on Rafeeq. */
export type RafeeqState = "present" | "missing" | "linked" | "unknown";

/** Structural subset of a `products` row this adapter reads. */
export interface RafeeqProductRow {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  rafeeq_product_id?: string | null;
}

type RafeeqVerdict = "present" | "missing" | "linked";

interface RafeeqMeta {
  verdict?: RafeeqVerdict;
  /** the raw internal channel status this verdict came from (fixed enum text) */
  channelStatus?: string | null;
}

const S = (v: unknown): string | null => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Exact "rafeeq" channel resolution — case-insensitive exact name equality only
 * (never a prefix/substring/pattern match). Zero matches or more than one
 * (ambiguity) → null; the caller treats null as "channel unavailable", never guesses.
 */
export function resolveRafeeqChannelId(channels: readonly { id: string; name: string | null }[]): string | null {
  const matches = (channels ?? []).filter((c) => String(c?.name ?? "").trim().toLowerCase() === "rafeeq");
  return matches.length === 1 ? S(matches[0]!.id) : null;
}

/**
 * Classify one product's Rafeeq verdict from the trusted overlays. Returns null
 * when there is NO confident signal (no channel status + no external id) — such a
 * product is never snapshotted (absence ⇒ unknown, never missing).
 */
export function rafeeqVerdictFor(channelStatus: string | null, rafeeqProductId: string | null): RafeeqVerdict | null {
  const norm = String(channelStatus ?? "").trim().toLowerCase();
  if (norm === "active") return "present";
  if (norm === "not listed") return "missing";
  if (norm === "draft") return "linked";
  // Unrecognized/empty status: an external id alone means "linked" (ready); else
  // there is no confident signal → null (unknown, not snapshotted).
  return S(rafeeqProductId) !== null ? "linked" : null;
}

/**
 * Build snapshot inputs from the trusted DB overlays. `statusByProductId` is the
 * channel_products.channel_status for the Rafeeq channel (already read by the
 * caller). `capturedAt` is supplied by the caller (no clock). price/availability
 * are ALWAYS null. Bounded by MAX_RAFEEQ_SNAPSHOT_INPUTS.
 */
export function buildRafeeqSnapshotInputs(
  products: readonly RafeeqProductRow[],
  statusByProductId: ReadonlyMap<string, string | null>,
  capturedAt: string,
): SnapshotInput[] {
  const out: SnapshotInput[] = [];
  for (const p of products ?? []) {
    const id = S(p?.id);
    if (id === null) continue;
    const channelStatus = statusByProductId.get(id) ?? null;
    const rafeeqId = S(p.rafeeq_product_id);
    const verdict = rafeeqVerdictFor(channelStatus, rafeeqId);
    if (verdict === null) continue; // no confident signal → unknown, never snapshotted
    const meta: RafeeqMeta = { verdict, channelStatus: S(channelStatus) };
    out.push({
      platform: RAFEEQ_PLATFORM,
      productId: id,
      externalId: rafeeqId, // Rafeeq's own id when known (null otherwise)
      sku: S(p.sku),
      barcode: S(p.barcode),
      status: S(channelStatus), // trusted internal Rafeeq channel status (never a verdict alias)
      price: null, // channel_price is our push-side override — never Rafeeq's price
      availability: null, // the shared availability overlay is a cross-platform reconcile
      title: S(p.name_en) ?? S(p.name_ar),
      capturedAt,
      metadata: { rafeeq: meta },
    });
    if (out.length >= MAX_RAFEEQ_SNAPSHOT_INPUTS) break;
  }
  return out;
}

function readMeta(snapshot: PlatformSnapshot): RafeeqMeta {
  const m = (snapshot.metadata as Record<string, unknown>)?.rafeeq;
  return m && typeof m === "object" ? (m as RafeeqMeta) : {};
}

/** Classify a stored Rafeeq snapshot into its dashboard state. Reads only the
 *  confident verdict recorded at capture time; absence is the caller's "unknown",
 *  NEVER "missing". */
export function classifyRafeeqSnapshot(snapshot: PlatformSnapshot): RafeeqState {
  const v = readMeta(snapshot).verdict;
  if (v === "present") return "present";
  if (v === "missing") return "missing";
  if (v === "linked") return "linked";
  return "unknown";
}

/** True when a snapshot's capture time is older than the adopted stale window. */
export function isSnapshotStale(capturedAt: string | null, now: number): boolean {
  if (!capturedAt) return true;
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > RAFEEQ_SNAPSHOT_STALE_MS;
}
