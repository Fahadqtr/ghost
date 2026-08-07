// Malikas V2 Operations Engine — shared models (Phase UI.7.1).
//
// TYPES ONLY. This module deliberately contains no runtime code at all, so
// every engine can `import type` from it and stay loadable by node:test
// directly (the same constraint that shaped lib/products/excel-import).
// Malikas is the Single Source of Truth: every model here describes Malikas
// data or values DERIVED from it — never platform truth.
//
// The engines are pure functions over these models: no database, no fetch,
// no storage, no API, no clock, no randomness. Screens (the UI.7.2 dashboard,
// TickTick/Shopify/PureSoul/Talabat/Rafeeq surfaces) read rows with their own
// readers, project them into OperationsProduct, and call lib/operations/* —
// they never re-implement business logic.

// ── input snapshot ───────────────────────────────────────────────────────────

/** The platforms the operations center tracks (Phase UI.7 scope). */
export type PlatformType = "shopify" | "puresoul" | "talabat" | "rafeeq";

/**
 * What the caller already knows about one product on one platform, read
 * through the EXISTING read models (e.g. the UI.3 Shopify read model). This
 * engine never talks to a platform — it only interprets a snapshot.
 *
 * A PlatformPresence value is a TRUSTED snapshot: providing one with
 * linked=false means the reader really looked and the product is confirmed
 * absent. When there is NO trusted reader (or the reader is currently
 * unavailable), the caller must OMIT the platform key entirely — the engine
 * then reports "unknown" (غير مربوط), never "missing".
 */
export interface PlatformPresence {
  /** the product is identity-matched on the platform (UI.3-style SKU/barcode match) */
  linked: boolean;
  /** the platform listing is live/visible to customers */
  live: boolean;
  /** the platform copy is known to differ from Malikas (price/name drift) */
  drift: boolean;
  /** a human explicitly has to look at this pairing (e.g. ambiguous identity) */
  reviewRequired: boolean;
}

/**
 * A catalog-safe snapshot of one Malikas product — the ONLY input the engines
 * read. Structural on purpose (like ShopifyProductInput in catalog-v2): the
 * caller builds it from whatever reader it already has. No stock quantities,
 * no platform ids, no PII.
 */
export interface OperationsProduct {
  id: string;
  sku: string | null;
  barcode: string | null;
  nameAr: string | null;
  nameEn: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  brandId: string | null;
  category: string | null;
  price: number | null;
  imageUrl: string | null;
  /** raw approval text: "Approved" | "Rejected" | "SentAI" | "" (house values) */
  approval: string | null;
  /** raw platform_status text; "" = never pushed anywhere */
  platformStatus: string | null;
  /** number of variant rows the product currently has */
  variantCount: number;
  /**
   * TRUSTED knowledge that this product is supposed to have variants (e.g.
   * shades). Only set true when the reading layer really knows it; omit
   * (undefined) when unknown — the absence of variant rows alone NEVER means
   * the product is single-variant, and undefined never fails readiness.
   */
  expectsVariants?: boolean;
  /** per-platform TRUSTED snapshots; an omitted key = no data = "unknown" */
  platforms?: Partial<Record<PlatformType, PlatformPresence>>;
}

// ── readiness ────────────────────────────────────────────────────────────────

export type ReadinessCheckCode =
  | "name"
  | "image"
  | "sku"
  | "barcode"
  | "price"
  | "category"
  | "variants"
  | "description"
  | "brand";

export interface ReadinessCheck {
  code: ReadinessCheckCode;
  /** required checks gate the status; optional ones only affect the percent */
  required: boolean;
  passed: boolean;
}

export type ReadinessReasonCode =
  | "missing_name"
  | "missing_image"
  | "missing_sku"
  | "invalid_sku"
  | "missing_barcode"
  | "invalid_barcode"
  | "missing_price"
  | "missing_category"
  | "missing_variants"
  | "missing_description"
  | "missing_brand"
  | "pending_review"
  | "rejected"
  | "not_approved";

export interface ReadinessReason {
  code: ReadinessReasonCode;
  /** fixed Arabic text — never raw data */
  message: string;
}

export type ReadinessStatus = "ready" | "almost_ready" | "incomplete" | "needs_review";

export interface ProductReadiness {
  productId: string;
  /** 0..100 over all applicable checks */
  percent: number;
  status: ReadinessStatus;
  reasons: ReadinessReason[];
  checks: ReadinessCheck[];
  /** never approved AND never pushed to any platform */
  isNew: boolean;
  /** all required data present + approved — safe to publish anywhere */
  readyToPublish: boolean;
}

// ── tasks ────────────────────────────────────────────────────────────────────

export type TaskType =
  | "needs_image"
  | "needs_data"
  | "needs_review"
  | "new_product"
  | "publish_platform"
  | "platform_review";

export type TaskPriority = "high" | "medium" | "low";

/**
 * A COMPUTED task — never stored. The id is deterministic over
 * (type, platform, productId), so recomputing yields the same ids and any
 * future surface (dashboard, TickTick export) can de-duplicate safely.
 */
export interface OperationTask {
  id: string;
  productId: string;
  type: TaskType;
  priority: TaskPriority;
  /** fixed Arabic title */
  title: string;
  /** fixed Arabic description */
  description: string;
  platform?: PlatformType;
  /** fixed Arabic reason the task exists */
  reason: string;
}

// ── platform status ──────────────────────────────────────────────────────────

export type PlatformStatusValue =
  | "unknown" // no trusted snapshot for this platform (not connected / reader unavailable)
  | "missing" // a trusted snapshot CONFIRMS the product is absent (and it is not yet publishable)
  | "ready"
  | "published"
  | "different"
  | "review_required";

export interface PlatformStatus {
  platform: PlatformType;
  status: PlatformStatusValue;
  /** fixed Arabic label for the status */
  label: string;
}

// ── new-product buckets ──────────────────────────────────────────────────────

/**
 * Independent views over the same catalog (a product may appear in more than
 * one bucket — e.g. new AND missing its image). Each bucket carries product
 * ids; callers join back to their own rows.
 */
export interface NewProductBuckets {
  newProducts: string[];
  readyProducts: string[];
  needsImage: string[];
  needsReview: string[];
}

// ── health ───────────────────────────────────────────────────────────────────

export interface HealthSummary {
  totalProducts: number;
  readyProducts: number;
  needsImage: number;
  newProducts: number;
  generatedTasks: number;
  /** rounded average of readiness percent over all products; 0 when empty */
  readinessAverage: number;
}
