// Malikas V2 — Platform Snapshot Engine (Phase UI.9.2): the diff engine.
//
// Compares two snapshots of the SAME identity and reports created / deleted /
// changed / unchanged plus the exact fields that moved. Platform-agnostic: it
// only reads the generic payload, never any platform-specific meaning. Field
// coverage is derived from SNAPSHOT_PAYLOAD_FIELDS, so it stays in lock-step
// with the hash — equal hash ⇒ "unchanged" with zero deltas.

import type { PlatformId, PlatformSnapshot } from "./types.ts";
import { SNAPSHOT_PAYLOAD_FIELDS } from "./types.ts";
import { stableStringify } from "./hash.ts";
import { snapshotKey } from "./snapshot.ts";

export type SnapshotChangeKind = "created" | "deleted" | "changed" | "unchanged";

export type SnapshotFieldChange =
  | "external_id_changed"
  | "sku_changed"
  | "barcode_changed"
  | "status_changed"
  | "price_changed"
  | "availability_changed"
  | "title_changed"
  | "metadata_changed";

/** payload field name → its change flag, in the fixed field order. */
const FIELD_TO_CHANGE: Record<(typeof SNAPSHOT_PAYLOAD_FIELDS)[number], SnapshotFieldChange> = {
  externalId: "external_id_changed",
  sku: "sku_changed",
  barcode: "barcode_changed",
  status: "status_changed",
  price: "price_changed",
  availability: "availability_changed",
  title: "title_changed",
  metadata: "metadata_changed",
};

export interface FieldDelta {
  field: SnapshotFieldChange;
  before: unknown;
  after: unknown;
}

export interface SnapshotDiff {
  kind: SnapshotChangeKind;
  /** identity key (platform::id) this diff is about */
  key: string;
  platform: PlatformId;
  /** productId of the present side (after, else before) */
  productId: string | null;
  /** ordered field-change flags (empty unless kind === "changed") */
  changes: SnapshotFieldChange[];
  /** before/after for each changed field (empty unless kind === "changed") */
  deltas: FieldDelta[];
  before: PlatformSnapshot | null;
  after: PlatformSnapshot | null;
}

function fieldEqual(field: (typeof SNAPSHOT_PAYLOAD_FIELDS)[number], a: PlatformSnapshot, b: PlatformSnapshot): boolean {
  if (field === "metadata") return stableStringify(a.metadata) === stableStringify(b.metadata);
  return a[field] === b[field];
}

/** Field-level deltas between two present snapshots, in fixed field order. */
function fieldDeltas(before: PlatformSnapshot, after: PlatformSnapshot): FieldDelta[] {
  const deltas: FieldDelta[] = [];
  for (const field of SNAPSHOT_PAYLOAD_FIELDS) {
    if (!fieldEqual(field, before, after)) {
      deltas.push({ field: FIELD_TO_CHANGE[field], before: before[field], after: after[field] });
    }
  }
  return deltas;
}

/**
 * Diff two snapshots of the same identity. Pass `null` for a missing side:
 *   (null, after)  → created
 *   (before, null) → deleted
 *   (before, after) equal hash → unchanged; else → changed (with deltas).
 * Throws if BOTH sides are null (nothing to diff).
 */
export function diffSnapshot(before: PlatformSnapshot | null, after: PlatformSnapshot | null): SnapshotDiff {
  if (!before && !after) throw new Error("diffSnapshot requires at least one snapshot");

  const present = (after ?? before)!;
  const base = {
    key: snapshotKey(present),
    platform: present.platform,
    productId: (after ?? before)?.productId ?? null,
    before,
    after,
  };

  if (!before) return { ...base, kind: "created", changes: [], deltas: [] };
  if (!after) return { ...base, kind: "deleted", changes: [], deltas: [] };
  if (before.payloadHash === after.payloadHash) return { ...base, kind: "unchanged", changes: [], deltas: [] };

  const deltas = fieldDeltas(before, after);
  return { ...base, kind: "changed", changes: deltas.map((d) => d.field), deltas };
}
