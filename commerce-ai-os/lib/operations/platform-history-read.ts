import "server-only";
// Malikas V2 Operations — Platform history reader (Phase UI.9.4).
//
// The generic, server-only reader behind the product page's "سجل المنصات"
// section. It reads ONE product's snapshots (bounded, newest-first) via the
// SESSION client (RLS) through the #533 SupabaseSnapshotStore — READ-only, no
// service role, no admin client, no write, no RPC — then:
//   - builds the platform history (created/changed, unchanged dropped)   [core]
//   - computes the latest-vs-previous comparison per platform            [core]
//   - projects the history into the existing Timeline engine             [engine]
// NO business logic here: derivation lives in lib/platforms/core, ordering in the
// Timeline engine. Any read failure degrades to a single constant "error" status
// (never a raw DB error), an unknown/blank id or a product with no snapshots to
// an empty "ok" — so the section can never break the product page.

import type { PlatformSnapshot } from "../platforms/core/types";
import {
  buildPlatformHistory,
  latestPreviousByPlatform,
  type PlatformComparison,
  type PlatformHistoryEntry,
} from "../platforms/core/history.ts";
import type { TimelineEvent } from "./shared/models";
import type { TimelineProvider } from "./timeline/providers/timeline-provider";

const PRODUCT_ID_MAX = 200;
const DEFAULT_LIMIT = 500;

/** Minimal store surface this reader needs (structurally SupabaseSnapshotStore). */
export interface PlatformHistoryStore {
  listByProduct(
    productId: string,
    opts?: { platform?: string; limit?: number },
  ): Promise<PlatformSnapshot[]>;
}

/** The pure engine layer (injected in tests; lazily bound in production). */
export interface PlatformHistoryEngines {
  createPlatformTimelineProviders(entries: readonly PlatformHistoryEntry[]): TimelineProvider[];
  buildTimeline(providers: readonly TimelineProvider[]): TimelineEvent[];
}

export interface ProductPlatformHistory {
  status: "ok" | "error";
  productId: string;
  /** newest-first history entries (created/changed only) */
  entries: PlatformHistoryEntry[];
  /** latest-vs-previous per platform */
  comparisons: PlatformComparison[];
  /** the same history projected into the unified Timeline (engine-ordered) */
  events: TimelineEvent[];
}

function empty(productId: string, status: "ok" | "error"): ProductPlatformHistory {
  return { status, productId, entries: [], comparisons: [], events: [] };
}

async function defaultStore(client: unknown): Promise<PlatformHistoryStore> {
  const { SupabaseSnapshotStore } = await import("@/lib/platforms/core/supabase-store");
  return new SupabaseSnapshotStore(client as never);
}

async function defaultEngines(): Promise<PlatformHistoryEngines> {
  const [platform, engine] = await Promise.all([
    import("@/lib/operations/timeline/providers/platform-provider"),
    import("@/lib/operations/timeline/timeline-engine"),
  ]);
  return {
    createPlatformTimelineProviders: platform.createPlatformTimelineProviders,
    buildTimeline: engine.buildTimeline,
  };
}

/**
 * Load and derive the platform snapshot history for ONE product. Bounded read,
 * session client, RLS-only. Returns "ok" with empty collections for an unknown/
 * blank id or a product that simply has no snapshots yet; "error" (empty) on any
 * read failure. Never throws, never surfaces a raw error, never writes.
 */
export async function loadProductPlatformHistory(
  client: unknown,
  productId: unknown,
  opts?: {
    platform?: string;
    limit?: number;
    deps?: { store?: PlatformHistoryStore; engines?: PlatformHistoryEngines };
  },
): Promise<ProductPlatformHistory> {
  if (
    typeof productId !== "string" ||
    productId.trim() === "" ||
    productId.length > PRODUCT_ID_MAX
  ) {
    return empty(typeof productId === "string" ? productId : "", "ok");
  }

  try {
    const store = opts?.deps?.store ?? (await defaultStore(client));
    let snapshots: PlatformSnapshot[];
    try {
      snapshots = await store.listByProduct(productId, {
        platform: opts?.platform,
        limit: opts?.limit ?? DEFAULT_LIMIT,
      });
    } catch {
      return empty(productId, "error"); // degraded read — never a raw DB error
    }

    const entries = buildPlatformHistory(snapshots);
    const comparisons = latestPreviousByPlatform(snapshots);

    const engines = opts?.deps?.engines ?? (await defaultEngines());
    const events = engines.buildTimeline(engines.createPlatformTimelineProviders(entries));

    return { status: "ok", productId, entries, comparisons, events };
  } catch {
    return empty(productId, "error");
  }
}
