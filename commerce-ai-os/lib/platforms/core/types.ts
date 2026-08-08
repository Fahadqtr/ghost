// Malikas V2 — Platform Snapshot Engine (Phase UI.9.2). TYPES ONLY.
//
// A PLATFORM-AGNOSTIC contract for capturing "what a platform currently says
// about a product" as an immutable snapshot, so any two snapshots can be
// diffed. This layer is ARCHITECTURE ONLY — it is not wired to any platform,
// dashboard, timeline, or store yet. It knows nothing about PureSoul / Shopify /
// Talabat / Rafeeq specifically; `platform` is an opaque id so future platforms
// need no change here.
//
// Purity: no clock, no I/O, no secrets. `capturedAt` is always supplied by the
// caller (the engine never reads the wall clock), which keeps every function
// deterministic and testable.

/** Opaque platform identifier, e.g. "shopify" | "puresoul" | "talabat" | any
 *  future platform. Kept as a string so the core never couples to one set. */
export type PlatformId = string;

/** The comparable fields of a snapshot (everything EXCEPT identity/versioning/
 *  timestamps). Exactly the set folded into `payloadHash` — so equal hash ⇔ all
 *  of these are equal. `platform` is part of identity, not payload. */
export interface SnapshotPayload {
  externalId: string | null;
  sku: string | null;
  barcode: string | null;
  status: string | null;
  price: number | null;
  availability: string | null;
  title: string | null;
  metadata: Readonly<Record<string, unknown>>;
}

/** An immutable capture of one product's state on one platform. */
export interface PlatformSnapshot extends SnapshotPayload {
  /** which platform this snapshot came from */
  platform: PlatformId;
  /** Malikas product id when linked; null when the platform row is unmatched */
  productId: string | null;
  /** stable hash of the SnapshotPayload — identical content ⇒ identical hash */
  payloadHash: string;
  /** contract version, so stored snapshots can be migrated forward safely */
  snapshotVersion: number;
  /** ISO-8601 capture time, ALWAYS supplied by the caller (never a clock read) */
  capturedAt: string;
}

/** Input to `createSnapshot` — the engine normalizes nullables, stamps the
 *  version and computes the hash. Only `platform` and `capturedAt` are required. */
export interface SnapshotInput {
  platform: PlatformId;
  capturedAt: string;
  productId?: string | null;
  externalId?: string | null;
  sku?: string | null;
  barcode?: string | null;
  status?: string | null;
  price?: number | null;
  availability?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Current snapshot contract version. Bump when the payload shape changes. */
export const SNAPSHOT_VERSION = 1 as const;

/** The comparable payload field names, in a FIXED order (drives deterministic
 *  hashing and field-change reporting). */
export const SNAPSHOT_PAYLOAD_FIELDS = [
  "externalId",
  "sku",
  "barcode",
  "status",
  "price",
  "availability",
  "title",
  "metadata",
] as const satisfies readonly (keyof SnapshotPayload)[];
