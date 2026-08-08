// Malikas V2 — Platform Snapshot Engine (Phase UI.9.2): snapshot construction.
//
// Turns loose per-platform input into a normalized, hashed, versioned
// PlatformSnapshot; derives the comparable payload; and computes the IDENTITY
// key used to line up "the same product on the same platform" across captures.
// Pure and platform-agnostic.

import type { PlatformSnapshot, SnapshotInput, SnapshotPayload } from "./types.ts";
import { SNAPSHOT_VERSION } from "./types.ts";
import { hashPayload } from "./hash.ts";

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The comparable payload of a snapshot (or input) — the fields that decide
 *  equality. `metadata` is frozen so a snapshot cannot be mutated after build. */
export function snapshotPayload(input: SnapshotInput | PlatformSnapshot): SnapshotPayload {
  return {
    externalId: str(input.externalId),
    sku: str(input.sku),
    barcode: str(input.barcode),
    status: str(input.status),
    price: num(input.price),
    availability: str(input.availability),
    title: str(input.title),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  };
}

/** Build a normalized, hashed, versioned snapshot. `capturedAt` is taken from
 *  the caller verbatim (the engine never reads a clock). */
export function createSnapshot(input: SnapshotInput): PlatformSnapshot {
  const payload = snapshotPayload(input);
  return {
    platform: input.platform,
    productId: str(input.productId),
    ...payload,
    payloadHash: hashPayload(payload as unknown as Record<string, unknown>),
    snapshotVersion: SNAPSHOT_VERSION,
    capturedAt: input.capturedAt,
  };
}

/**
 * Identity key for lining snapshots up across captures: platform + the first
 * stable identifier available (productId → externalId → sku → barcode). Two
 * snapshots with the same key describe the same product on the same platform.
 * A snapshot with none of these identifiers gets a platform-scoped "anon" key
 * (it can never match another row, so it always reads as created/deleted).
 */
export function snapshotKey(s: Pick<PlatformSnapshot, "platform" | "productId" | "externalId" | "sku" | "barcode">): string {
  const id = str(s.productId) ?? str(s.externalId) ?? str(s.sku) ?? str(s.barcode);
  return `${s.platform}::${id ?? "anon"}`;
}

/** True when two snapshots carry identical comparable content (by hash). */
export function snapshotsEqual(a: PlatformSnapshot, b: PlatformSnapshot): boolean {
  return a.payloadHash === b.payloadHash;
}
