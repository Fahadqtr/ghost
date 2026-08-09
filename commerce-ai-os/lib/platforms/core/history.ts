// Malikas V2 — Platform Snapshot Engine (Phase UI.9.4): generic history.
//
// PURE derivation of a product's PLATFORM HISTORY straight from persisted
// snapshots — no new table, no new event store. Given the snapshots for one
// product (any set of platforms), it lines them up per identity, diffs each
// against the one before it (reusing the #532 diff engine), and emits ONE entry
// per real change:
//   - the first snapshot of an identity → a "created" entry
//   - a later snapshot that moved fields  → a "changed" entry (with before→after)
//   - an identical repeat                 → NOTHING (unchanged emits no event)
//
// Platform-agnostic: it reads only the generic snapshot payload and never any
// platform-specific meaning (no "published"/"missing" — that stays in each
// platform's own layer). No clock, no I/O. `metadata` is NEVER surfaced as a
// value — only a boolean flag — so raw payloads can't leak through history.

import type { PlatformId, PlatformSnapshot } from "./types.ts";
import { snapshotKey } from "./snapshot.ts";
import { diffSnapshot, type SnapshotFieldChange } from "./diff.ts";

/** The whitelisted, human-meaningful fields history exposes (metadata excluded
 *  on purpose — it can carry raw platform payload). */
export type PlatformHistoryField =
  | "external_id"
  | "sku"
  | "barcode"
  | "status"
  | "price"
  | "availability"
  | "title";

export interface PlatformFieldDelta {
  field: PlatformHistoryField;
  /** value before the change (null for a "created" entry) */
  before: string | number | null;
  /** value after the change */
  after: string | number | null;
}

export type PlatformChangeType = "created" | "changed";

/**
 * One platform history event, derived from two consecutive snapshots. Carries
 * the full required contract: productId, platform, change type, before→after
 * (per moved field), and capturedAt. `metadataChanged` is a flag only — raw
 * metadata values are never included.
 */
export interface PlatformHistoryEntry {
  productId: string | null;
  platform: PlatformId;
  changeType: PlatformChangeType;
  /** moved fields (changed) or initial non-null values (created); metadata excluded */
  fields: PlatformFieldDelta[];
  /** true when metadata moved — never carries the value */
  metadataChanged: boolean;
  /** the present snapshot's capturedAt (the time the change was observed) */
  capturedAt: string;
  snapshotVersion: number;
}

/** A leak-safe projection of a snapshot: whitelisted fields only (no metadata,
 *  no payloadHash). Used by the latest-vs-previous comparison. */
export interface PlatformSnapshotView {
  capturedAt: string;
  snapshotVersion: number;
  external_id: string | null;
  sku: string | null;
  barcode: string | null;
  status: string | null;
  price: number | null;
  availability: string | null;
  title: string | null;
}

export interface PlatformComparison {
  platform: PlatformId;
  productId: string | null;
  latest: PlatformSnapshotView;
  previous: PlatformSnapshotView | null;
  /** field deltas latest-vs-previous (empty when no previous or unchanged) */
  fields: PlatformFieldDelta[];
  metadataChanged: boolean;
}

/** change-flag → surfaced field name; `metadata_changed` is deliberately absent. */
const CHANGE_TO_FIELD: Partial<Record<SnapshotFieldChange, PlatformHistoryField>> = {
  external_id_changed: "external_id",
  sku_changed: "sku",
  barcode_changed: "barcode",
  status_changed: "status",
  price_changed: "price",
  availability_changed: "availability",
  title_changed: "title",
};

/** Fixed order the created-entry lists initial values in (mirrors the payload). */
const CREATED_FIELDS: readonly {
  field: PlatformHistoryField;
  read: (s: PlatformSnapshot) => string | number | null;
}[] = [
  { field: "external_id", read: (s) => s.externalId },
  { field: "sku", read: (s) => s.sku },
  { field: "barcode", read: (s) => s.barcode },
  { field: "status", read: (s) => s.status },
  { field: "price", read: (s) => s.price },
  { field: "availability", read: (s) => s.availability },
  { field: "title", read: (s) => s.title },
];

function timeMs(s: string): number {
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/** Read one whitelisted field value off a snapshot (typed, never metadata). */
function readField(s: PlatformSnapshot, field: PlatformHistoryField): string | number | null {
  switch (field) {
    case "external_id": return s.externalId;
    case "sku": return s.sku;
    case "barcode": return s.barcode;
    case "status": return s.status;
    case "price": return s.price;
    case "availability": return s.availability;
    case "title": return s.title;
  }
}

function toView(s: PlatformSnapshot): PlatformSnapshotView {
  return {
    capturedAt: s.capturedAt,
    snapshotVersion: s.snapshotVersion,
    external_id: s.externalId,
    sku: s.sku,
    barcode: s.barcode,
    status: s.status,
    price: s.price,
    availability: s.availability,
    title: s.title,
  };
}

/** Group snapshots by identity key, each group ordered oldest→newest (stable). */
function groupByKeyOrdered(snapshots: readonly PlatformSnapshot[]): Map<string, PlatformSnapshot[]> {
  const byKey = new Map<string, { s: PlatformSnapshot; i: number }[]>();
  snapshots.forEach((s, i) => {
    const k = snapshotKey(s);
    const g = byKey.get(k);
    if (g) g.push({ s, i });
    else byKey.set(k, [{ s, i }]);
  });
  const out = new Map<string, PlatformSnapshot[]>();
  for (const [k, g] of byKey) {
    g.sort((a, b) => {
      const t = timeMs(a.s.capturedAt) - timeMs(b.s.capturedAt);
      return t !== 0 ? t : a.i - b.i; // stable on equal timestamps
    });
    out.set(k, g.map((x) => x.s));
  }
  return out;
}

function createdEntry(s: PlatformSnapshot): PlatformHistoryEntry {
  const fields: PlatformFieldDelta[] = [];
  for (const { field, read } of CREATED_FIELDS) {
    const after = read(s);
    if (after !== null && after !== "") fields.push({ field, before: null, after });
  }
  return {
    productId: s.productId,
    platform: s.platform,
    changeType: "created",
    fields,
    metadataChanged: false,
    capturedAt: s.capturedAt,
    snapshotVersion: s.snapshotVersion,
  };
}

/** Field deltas between two snapshots, whitelisted (metadata excluded), fixed order. */
function deltasBetween(before: PlatformSnapshot, after: PlatformSnapshot): PlatformFieldDelta[] {
  const diff = diffSnapshot(before, after);
  const deltas: PlatformFieldDelta[] = [];
  for (const change of diff.changes) {
    const field = CHANGE_TO_FIELD[change];
    if (!field) continue; // drops metadata_changed
    deltas.push({ field, before: readField(before, field), after: readField(after, field) });
  }
  return deltas;
}

/**
 * Build a product's platform history from its snapshots (any platforms). Emits
 * newest-first: one "created" entry per identity's first snapshot, one "changed"
 * entry per later snapshot that actually moved, and nothing for unchanged repeats
 * (so an identical re-capture never produces a duplicate event). PURE.
 */
export function buildPlatformHistory(snapshots: readonly PlatformSnapshot[]): PlatformHistoryEntry[] {
  const entries: PlatformHistoryEntry[] = [];
  for (const group of groupByKeyOrdered(snapshots).values()) {
    let prev: PlatformSnapshot | null = null;
    for (const cur of group) {
      if (prev === null) {
        entries.push(createdEntry(cur));
      } else {
        const diff = diffSnapshot(prev, cur);
        if (diff.kind === "changed") {
          entries.push({
            productId: cur.productId,
            platform: cur.platform,
            changeType: "changed",
            fields: deltasBetween(prev, cur),
            metadataChanged: diff.changes.includes("metadata_changed"),
            capturedAt: cur.capturedAt,
            snapshotVersion: cur.snapshotVersion,
          });
        }
        // unchanged → no entry
      }
      prev = cur;
    }
  }
  return sortEntriesNewestFirst(entries);
}

/** Deterministic newest-first ordering: time desc, then platform, then type. */
export function sortEntriesNewestFirst(entries: readonly PlatformHistoryEntry[]): PlatformHistoryEntry[] {
  return [...entries].sort((a, b) => {
    const t = timeMs(b.capturedAt) - timeMs(a.capturedAt);
    if (t !== 0) return t;
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    if (a.changeType !== b.changeType) return a.changeType < b.changeType ? -1 : 1;
    return 0;
  });
}

/**
 * Latest snapshot vs the one before it, per identity — the product page's
 * "last vs previous" comparison. Newest-first by the latest capturedAt. Only
 * whitelisted field values are exposed (no metadata, no hash).
 */
export function latestPreviousByPlatform(
  snapshots: readonly PlatformSnapshot[],
): PlatformComparison[] {
  const comparisons: PlatformComparison[] = [];
  for (const group of groupByKeyOrdered(snapshots).values()) {
    if (group.length === 0) continue;
    const latest = group[group.length - 1];
    const previous = group.length >= 2 ? group[group.length - 2] : null;
    const diff = previous ? diffSnapshot(previous, latest) : null;
    comparisons.push({
      platform: latest.platform,
      productId: latest.productId,
      latest: toView(latest),
      previous: previous ? toView(previous) : null,
      fields: previous && diff && diff.kind === "changed" ? deltasBetween(previous, latest) : [],
      metadataChanged: diff ? diff.changes.includes("metadata_changed") : false,
    });
  }
  return comparisons.sort((a, b) => {
    const t = timeMs(b.latest.capturedAt) - timeMs(a.latest.capturedAt);
    if (t !== 0) return t;
    return a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0;
  });
}
