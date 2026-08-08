// Malikas V2 — PureSoul platform types (Phase UI.9.1). TYPES ONLY (no runtime
// code) so the pure mapper can `import type` from here and stay node-loadable.
//
// PureSoul has NO official API. Its reliable, persisted, READ-ONLY source of
// truth in this system is the shared `platform_status` overlay (platform =
// 'pure_seoul'), populated from the owner's periodic PureSoul export uploads.
// This phase reads that overlay only — it never publishes, writes, or syncs.

/**
 * One PureSoul overlay row as read from `platform_status` (platform =
 * 'pure_seoul'). A row exists BECAUSE the product was seen/processed for
 * PureSoul, so its presence is trusted; a product with NO row is "unknown"
 * (never "missing"). `availability` is 'InStock' | 'OutOfStock' | null;
 * `approval` is 'Approved' | 'Rejected' | 'SentAI' | '' | null.
 */
export interface PureSoulOverlayRow {
  productId: string;
  approval: string | null;
  availability: string | null;
}

/** Result of reading the PureSoul overlay. `degraded` distinguishes a read
 *  FAILURE (show "تعذر قراءة PureSoul" — treat all as unknown, never missing)
 *  from a healthy-but-empty overlay (not synced yet → not connected). */
export interface PureSoulReadResult {
  /** true only when the read succeeded AND at least one overlay row exists */
  available: boolean;
  /** true when the read itself failed (degraded) — never implies "missing" */
  degraded: boolean;
  /** productId → trusted PureSoul presence (only for products with a row) */
  byProductId: Map<string, import("../../operations/shared/models").PlatformPresence>;
}
