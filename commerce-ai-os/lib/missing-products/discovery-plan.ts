// CH.6F — discovery ASSEMBLY + plan (PURE). No `@/` imports, no server-only.
//
// buildGapItems() takes the three normalized read layers (internal catalog, ECL
// rows, external evidence) for ONE storefront and produces classified GapItems +
// a grain-separated summary. It is the single deterministic brain of the scan;
// the server orchestrator only does IO and hands the rows here. Because it is
// pure, every §23 scenario is unit-testable without a database.
//
// It NEVER performs a mutation and NEVER matches on name/fuzzy/AI.

import {
  type StorefrontKey,
  type ChannelKey,
  type Grain,
  type GapStatus,
  type MatchEvidenceKind,
  type Confidence,
  type RepairAction,
  type ImportEligibility,
  type PublishReadiness,
  channelOf,
  grainOf,
  allowedActionsFor,
} from "./discovery-model.ts";
import {
  buildInternalIndex,
  matchExternalToInternal,
  normalizeSku,
  normalizeBarcode,
  isValidBarcode,
  type InternalTarget,
} from "./discovery-match.ts";
import { importEligibility, publishReadiness, insufficientReasons, type ExternalCandidate } from "./discovery-classify.ts";

// ── normalized read layers ───────────────────────────────────────────────────
export interface InternalUnitInput {
  productId: string;
  variantId: string | null;
  grain: Grain;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  brandId: string | null;
  archived: boolean;
  /** variant-grain only: is this a sellable variant that needs its own listing? */
  sellable: boolean;
  hasImage: boolean;
  hasDescription: boolean;
}

export interface EclRowInput {
  productId: string;
  variantId: string | null;
  externalProductId: string | null;
  exportedSku: string | null;
  exportedBarcode: string | null;
  mappingStatus: string; // active | needs_review | archived
  claimedExternalId: string | null;
}

export interface ExternalEvidenceInput {
  /** set when the evidence is already tied to an internal product (snapshots) */
  productId: string | null;
  externalId: string | null;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  grain: Grain;
  sourceType: string; // "snapshot:shopify" | "export:snoonu" | "session:..." | "ecl"
  capturedAt: string | null;
}

export interface BuildInput {
  storefront: StorefrontKey;
  internals: readonly InternalUnitInput[];
  ecl: readonly EclRowInput[];
  external: readonly ExternalEvidenceInput[];
}

// ── output item ──────────────────────────────────────────────────────────────
export interface GapItem {
  key: string;
  storefront: StorefrontKey;
  channel: ChannelKey;
  grain: Grain;
  status: GapStatus;
  // internal side (null for EXTERNAL_ONLY)
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  barcode: string | null;
  nameEn: string | null;
  nameAr: string | null;
  brandId: string | null;
  archived: boolean;
  // external side
  externalId: string | null;
  externalSku: string | null;
  externalBarcode: string | null;
  externalTitle: string | null;
  // evidence + recommendation
  matchedBy: MatchEvidenceKind;
  confidence: Confidence;
  eclPresent: boolean;
  mappingStatus: string | null;
  recommendedAction: RepairAction;
  allowedActions: readonly RepairAction[];
  importEligibility: ImportEligibility | null;
  publishReadiness: PublishReadiness | null;
  readinessBlockers: string[];
  reasons: string[];
  // deterministic repair identity (consumed by the writer-gated apply)
  repairIdentityType: string | null;
  repairExternalId: string | null;
  repairExportedSku: string | null;
  repairExportedBarcode: string | null;
  repairVariantSku: string | null;
  // provenance (§20)
  sourceType: string | null;
  sourceCapturedAt: string | null;
}

const unitKey = (productId: string, variantId: string | null): string => `${productId}::${variantId ?? ""}`;

function targetOf(u: InternalUnitInput): InternalTarget {
  return { productId: u.productId, variantId: u.variantId, grain: u.grain, sku: u.sku, barcode: u.barcode };
}

// The identity type the ECL row would carry for this storefront.
const IDENTITY_TYPE: Record<StorefrontKey, string> = {
  "shopify:malikas": "shopify_gid",
  "snoonu:malikas": "snoonu_spi",
  "snoonu:pure_seoul": "snoonu_spi",
  "talabat:malikas": "talabat_sku",
  "rafeeq:malikas": "rafeeq_product_id",
};

/** Whether this storefront's durable identity is the exported SKU (Talabat). */
const identityIsSku = (sf: StorefrontKey): boolean => IDENTITY_TYPE[sf] === "talabat_sku";

// ── assembly ─────────────────────────────────────────────────────────────────
export function buildGapItems(input: BuildInput): GapItem[] {
  const { storefront, internals, ecl, external } = input;
  const channel = channelOf(storefront);
  const grain = grainOf(storefront);

  // ECL rows bucketed by internal target key, split by status.
  const eclByUnit = new Map<string, EclRowInput[]>();
  const eclProductLevel = new Map<string, EclRowInput[]>(); // productId → product-level rows (variantId null)
  for (const r of ecl) {
    const k = unitKey(r.productId, r.variantId);
    (eclByUnit.get(k) ?? eclByUnit.set(k, []).get(k)!).push(r);
    if (r.variantId == null) {
      (eclProductLevel.get(r.productId) ?? eclProductLevel.set(r.productId, []).get(r.productId)!).push(r);
    }
  }

  // Internal index for resolving raw external evidence.
  const targets = internals.map(targetOf);
  const externalIdLinks: { externalId: string; target: InternalTarget }[] = [];
  const internalByUnit = new Map<string, InternalUnitInput>();
  for (const u of internals) internalByUnit.set(unitKey(u.productId, u.variantId), u);
  for (const r of ecl) {
    if (r.mappingStatus === "active" && r.externalProductId) {
      const u = internalByUnit.get(unitKey(r.productId, r.variantId));
      if (u) externalIdLinks.push({ externalId: r.externalProductId, target: targetOf(u) });
    }
  }
  for (const e of external) {
    if (e.productId && e.externalId) {
      const u = pickUnitForProduct(internals, e.productId, grain, e);
      if (u) externalIdLinks.push({ externalId: e.externalId, target: targetOf(u) });
    }
  }
  const index = buildInternalIndex(targets, externalIdLinks);

  // Resolve external evidence → internal unit (or unresolved / ambiguous).
  const evidenceByUnit = new Map<string, ExternalEvidenceInput[]>();
  const unresolved: ExternalEvidenceInput[] = [];
  const ambiguous: { e: ExternalEvidenceInput; kind: MatchEvidenceKind }[] = [];

  for (const e of external) {
    if (e.productId) {
      // snapshot rows carry the internal product id directly
      const u = pickUnitForProduct(internals, e.productId, grain, e);
      if (u) {
        (evidenceByUnit.get(unitKey(u.productId, u.variantId)) ?? evidenceByUnit.set(unitKey(u.productId, u.variantId), []).get(unitKey(u.productId, u.variantId))!).push(e);
      } else {
        unresolved.push(e);
      }
      continue;
    }
    const m = matchExternalToInternal({ externalId: e.externalId, sku: e.sku, barcode: e.barcode, grain: e.grain }, index);
    if (m.targets.length === 0) {
      unresolved.push(e);
    } else if (m.ambiguous) {
      ambiguous.push({ e, kind: m.evidence });
    } else {
      const t = m.targets[0];
      const k = unitKey(t.productId, t.variantId);
      (evidenceByUnit.get(k) ?? evidenceByUnit.set(k, []).get(k)!).push(e);
    }
  }

  const items: GapItem[] = [];

  // ── internal pass — one item per internal unit ─────────────────────────────
  for (const u of internals) {
    // variant-grain: only sellable variants are compared as listings (§8)
    if (grain === "variant" && !u.sellable) continue;
    items.push(classifyInternal(u, storefront, channel, grain, eclByUnit, eclProductLevel, evidenceByUnit));
  }

  // ── external pass — unresolved (EXTERNAL_ONLY) + ambiguous (conflicts) ──────
  for (const e of unresolved) {
    items.push(classifyExternalOnly(e, storefront, channel, grain));
  }
  for (const { e, kind } of ambiguous) {
    items.push(classifyAmbiguousExternal(e, kind, storefront, channel, grain));
  }

  // ── ECL-orphan pass — a live mapping whose internal product is gone (§5) ────
  // Archived products are DELETED from `products` (INV.4E), so an ECL row that
  // points to an unknown product means the internal product was archived/removed.
  const knownProducts = new Set(internals.map((u) => u.productId));
  const orphanSeen = new Set<string>();
  for (const r of ecl) {
    if (r.mappingStatus === "archived") continue;
    if (knownProducts.has(r.productId)) continue;
    if (orphanSeen.has(r.productId)) continue;
    orphanSeen.add(r.productId);
    items.push(orphanItem(r, storefront, channel, grain));
  }

  return items;
}

// helper: find the internal unit for a productId at the storefront grain
function pickUnitForProduct(
  internals: readonly InternalUnitInput[],
  productId: string,
  grain: Grain,
  e: ExternalEvidenceInput,
): InternalUnitInput | null {
  if (grain === "product") {
    return internals.find((u) => u.productId === productId && u.variantId == null) ?? internals.find((u) => u.productId === productId) ?? null;
  }
  // variant grain: prefer a variant matched by sku/barcode, else any sellable variant
  const skuKey = normalizeSku(e.sku);
  const bcKey = isValidBarcode(e.barcode) ? normalizeBarcode(e.barcode) : null;
  const kids = internals.filter((u) => u.productId === productId && u.sellable);
  if (skuKey) {
    const bySku = kids.find((u) => normalizeSku(u.sku) === skuKey);
    if (bySku) return bySku;
  }
  if (bcKey) {
    const byBc = kids.find((u) => normalizeBarcode(u.barcode) === bcKey);
    if (byBc) return byBc;
  }
  return null; // cannot pin to a specific sellable variant — leave unresolved
}

function classifyInternal(
  u: InternalUnitInput,
  storefront: StorefrontKey,
  channel: ChannelKey,
  grain: Grain,
  eclByUnit: Map<string, EclRowInput[]>,
  eclProductLevel: Map<string, EclRowInput[]>,
  evidenceByUnit: Map<string, ExternalEvidenceInput[]>,
): GapItem {
  const k = unitKey(u.productId, u.variantId);
  const rows = eclByUnit.get(k) ?? [];
  const active = rows.filter((r) => r.mappingStatus === "active");
  const needsReview = rows.filter((r) => r.mappingStatus === "needs_review");
  const evidence = evidenceByUnit.get(k) ?? [];
  const bestEv = pickBestEvidence(evidence);

  const base = baseItem(u, storefront, channel, grain, rows.length > 0, rows[0]?.mappingStatus ?? null);
  base.sourceType = bestEv?.sourceType ?? (rows.length ? "ecl" : null);
  base.sourceCapturedAt = bestEv?.capturedAt ?? null;
  if (bestEv) {
    base.externalId = bestEv.externalId;
    base.externalSku = bestEv.sku;
    base.externalBarcode = bestEv.barcode;
    base.externalTitle = bestEv.title;
  }

  // 1. archived internal — its own bucket (§5)
  if (u.archived) return finalize(base, "ARCHIVED_INTERNAL", "none", "REVIEW", ["internal_archived"]);

  // 2. Rafeeq / contested — preserve needs_review (§7)
  if (needsReview.length > 0) {
    return finalize(base, "NEEDS_REVIEW", "none", "REVIEW", ["ecl_needs_review"]);
  }

  // 3. ambiguous active mapping
  if (active.length > 1) {
    return finalize(base, "IDENTITY_CONFLICT", "none", "REVIEW", ["multiple_active_ecl"]);
  }

  // 4. exactly one active mapping → mapped
  if (active.length === 1) {
    base.repairIdentityType = null;
    return finalize(base, "MAPPED_OK", "ecl_active", "NONE", ["ecl_active"]);
  }

  // 5. variant-grain: a product-level ECL that would HIDE this missing variant (§8)
  if (grain === "variant") {
    const prodLevelActive = (eclProductLevel.get(u.productId) ?? []).filter((r) => r.mappingStatus === "active");
    if (prodLevelActive.length > 0) {
      return finalize(base, "VARIANT_CONFLICT", "none", "REVIEW", ["parent_level_mapping_hides_variant"]);
    }
  }

  // 6. no active ECL — decide MISSING_ECL vs INTERNAL_ONLY from external evidence
  if (bestEv) {
    const identity = deriveRepairIdentity(storefront, u, bestEv);
    if (identity.usable) {
      base.repairIdentityType = identity.identityType;
      base.repairExternalId = identity.externalId;
      base.repairExportedSku = identity.exportedSku;
      base.repairExportedBarcode = identity.exportedBarcode;
      base.repairVariantSku = identity.variantSku;
      return finalize(base, "MISSING_ECL", identity.matchedBy, "CREATE_ECL", ["external_evidence_present", "no_active_ecl"]);
    }
    // present on channel but no durable identity to write → human review
    return finalize(base, "NEEDS_REVIEW", identity.matchedBy, "REVIEW", ["external_present_no_identity"]);
  }

  // 7. no ECL, no external evidence → internal only (§9)
  const readiness = publishReadiness({
    hasBarcode: isValidBarcode(u.barcode),
    hasImage: u.hasImage,
    hasTitle: (u.nameEn ?? u.nameAr) != null,
    hasDescription: u.hasDescription,
  });
  base.publishReadiness = readiness.readiness;
  base.readinessBlockers = readiness.blockers;
  return finalize(base, "INTERNAL_ONLY", "none", "PREPARE_PUBLISH", ["no_listing_for_storefront"]);
}

interface DerivedIdentity {
  usable: boolean;
  identityType: string | null;
  externalId: string | null;
  exportedSku: string | null;
  exportedBarcode: string | null;
  variantSku: string | null;
  matchedBy: MatchEvidenceKind;
}

function deriveRepairIdentity(sf: StorefrontKey, u: InternalUnitInput, ev: ExternalEvidenceInput): DerivedIdentity {
  const identityType = IDENTITY_TYPE[sf];
  if (identityIsSku(sf)) {
    // Talabat: identity is the exported SKU (variant grain)
    const exportedSku = normalizeSku(ev.sku) ? String(ev.sku) : u.sku;
    if (exportedSku) {
      return {
        usable: true,
        identityType,
        externalId: null,
        exportedSku,
        exportedBarcode: ev.barcode ?? u.barcode,
        variantSku: u.sku,
        matchedBy: normalizeSku(ev.sku) ? "sku" : "variant_sku",
      };
    }
    return notUsable("variant_sku");
  }
  // SPI / GID / rafeeq id
  if (ev.externalId && ev.externalId.trim() !== "") {
    return {
      usable: true,
      identityType,
      externalId: ev.externalId.trim(),
      exportedSku: ev.sku ?? u.sku,
      exportedBarcode: ev.barcode ?? u.barcode,
      variantSku: u.variantId ? u.sku : null,
      matchedBy: "external_id",
    };
  }
  return notUsable("none");
}

function notUsable(matchedBy: MatchEvidenceKind): DerivedIdentity {
  return { usable: false, identityType: null, externalId: null, exportedSku: null, exportedBarcode: null, variantSku: null, matchedBy };
}

function classifyExternalOnly(e: ExternalEvidenceInput, storefront: StorefrontKey, channel: ChannelKey, grain: Grain): GapItem {
  const cand: ExternalCandidate = { title: e.title, sku: e.sku, barcode: e.barcode, externalId: e.externalId, grain: e.grain };
  const eligibility = importEligibility(cand);
  const base: GapItem = {
    key: `${storefront}::EXTERNAL::${e.externalId ?? ""}::${normalizeSku(e.sku) ?? ""}::${normalizeBarcode(e.barcode) ?? ""}`,
    storefront,
    channel,
    grain,
    status: "EXTERNAL_ONLY",
    productId: null,
    variantId: null,
    sku: null,
    barcode: null,
    nameEn: null,
    nameAr: null,
    brandId: null,
    archived: false,
    externalId: e.externalId,
    externalSku: e.sku,
    externalBarcode: e.barcode,
    externalTitle: e.title,
    matchedBy: "none",
    confidence: "NONE",
    eclPresent: false,
    mappingStatus: null,
    recommendedAction: eligibility === "IMPORT_ELIGIBLE" ? "IMPORT_PRODUCT" : "REVIEW",
    allowedActions: allowedActionsFor("EXTERNAL_ONLY"),
    importEligibility: eligibility,
    publishReadiness: null,
    readinessBlockers: [],
    reasons: eligibility === "INSUFFICIENT_DATA" ? ["insufficient_data", ...insufficientReasons(cand).map((r) => `missing_${r}`)] : ["no_internal_match"],
    repairIdentityType: null,
    repairExternalId: null,
    repairExportedSku: null,
    repairExportedBarcode: null,
    repairVariantSku: null,
    sourceType: e.sourceType,
    sourceCapturedAt: e.capturedAt,
  };
  return base;
}

function classifyAmbiguousExternal(e: ExternalEvidenceInput, kind: MatchEvidenceKind, storefront: StorefrontKey, channel: ChannelKey, grain: Grain): GapItem {
  const status: GapStatus = kind === "external_id" ? "IDENTITY_CONFLICT" : kind === "barcode" ? "BARCODE_CONFLICT" : "SKU_CONFLICT";
  return {
    key: `${storefront}::CONFLICT::${e.externalId ?? ""}::${normalizeSku(e.sku) ?? ""}::${normalizeBarcode(e.barcode) ?? ""}`,
    storefront,
    channel,
    grain,
    status,
    productId: null,
    variantId: null,
    sku: null,
    barcode: null,
    nameEn: null,
    nameAr: null,
    brandId: null,
    archived: false,
    externalId: e.externalId,
    externalSku: e.sku,
    externalBarcode: e.barcode,
    externalTitle: e.title,
    matchedBy: kind,
    confidence: "NONE",
    eclPresent: false,
    mappingStatus: null,
    recommendedAction: "REVIEW",
    allowedActions: allowedActionsFor(status),
    importEligibility: null,
    publishReadiness: null,
    readinessBlockers: [],
    reasons: ["ambiguous_external_match"],
    repairIdentityType: null,
    repairExternalId: null,
    repairExportedSku: null,
    repairExportedBarcode: null,
    repairVariantSku: null,
    sourceType: e.sourceType,
    sourceCapturedAt: e.capturedAt,
  };
}

function orphanItem(r: EclRowInput, storefront: StorefrontKey, channel: ChannelKey, grain: Grain): GapItem {
  return {
    key: `${storefront}::ORPHAN::${r.productId}`,
    storefront,
    channel,
    grain,
    status: "ARCHIVED_INTERNAL",
    productId: r.productId,
    variantId: r.variantId,
    sku: r.exportedSku,
    barcode: r.exportedBarcode,
    nameEn: null,
    nameAr: null,
    brandId: null,
    archived: true,
    externalId: r.externalProductId,
    externalSku: r.exportedSku,
    externalBarcode: r.exportedBarcode,
    externalTitle: null,
    matchedBy: "none",
    confidence: "NONE",
    eclPresent: true,
    mappingStatus: r.mappingStatus,
    recommendedAction: "REVIEW",
    allowedActions: allowedActionsFor("ARCHIVED_INTERNAL"),
    importEligibility: null,
    publishReadiness: null,
    readinessBlockers: [],
    reasons: ["ecl_points_to_missing_product"],
    repairIdentityType: null,
    repairExternalId: null,
    repairExportedSku: null,
    repairExportedBarcode: null,
    repairVariantSku: null,
    sourceType: "ecl",
    sourceCapturedAt: null,
  };
}

function baseItem(
  u: InternalUnitInput,
  storefront: StorefrontKey,
  channel: ChannelKey,
  grain: Grain,
  eclPresent: boolean,
  mappingStatus: string | null,
): GapItem {
  return {
    key: `${storefront}::${unitKey(u.productId, u.variantId)}`,
    storefront,
    channel,
    grain,
    status: "INTERNAL_ONLY",
    productId: u.productId,
    variantId: u.variantId,
    sku: u.sku,
    barcode: u.barcode,
    nameEn: u.nameEn,
    nameAr: u.nameAr,
    brandId: u.brandId,
    archived: u.archived,
    externalId: null,
    externalSku: null,
    externalBarcode: null,
    externalTitle: null,
    matchedBy: "none",
    confidence: "NONE",
    eclPresent,
    mappingStatus,
    recommendedAction: "PREPARE_PUBLISH",
    allowedActions: [],
    importEligibility: null,
    publishReadiness: null,
    readinessBlockers: [],
    reasons: [],
    repairIdentityType: null,
    repairExternalId: null,
    repairExportedSku: null,
    repairExportedBarcode: null,
    repairVariantSku: null,
    sourceType: null,
    sourceCapturedAt: null,
  };
}

function finalize(base: GapItem, status: GapStatus, matchedBy: MatchEvidenceKind, action: RepairAction, reasons: string[]): GapItem {
  base.status = status;
  base.matchedBy = matchedBy;
  base.confidence = matchedBy === "none" ? "NONE" : status === "MISSING_ECL" ? "DETERMINISTIC" : matchedBy === "ecl_active" ? "DETERMINISTIC" : "NONE";
  base.recommendedAction = action;
  base.allowedActions = allowedActionsFor(status);
  base.reasons = reasons;
  return base;
}

function pickBestEvidence(evidence: readonly ExternalEvidenceInput[]): ExternalEvidenceInput | null {
  if (evidence.length === 0) return null;
  // prefer evidence with an external id, then the most recent capturedAt
  const withId = evidence.filter((e) => e.externalId && e.externalId.trim() !== "");
  const pool = withId.length ? withId : evidence.slice();
  pool.sort((a, b) => (b.capturedAt ?? "").localeCompare(a.capturedAt ?? ""));
  return pool[0];
}

// ── summary (grain-separated §25) ────────────────────────────────────────────
export interface DiscoverySummary {
  storefront: StorefrontKey;
  grain: Grain;
  total: number;
  byStatus: Record<GapStatus, number>;
  productGrainTotal: number;
  variantGrainTotal: number;
}

const ZERO_STATUS = (): Record<GapStatus, number> => ({
  MAPPED_OK: 0,
  INTERNAL_ONLY: 0,
  EXTERNAL_ONLY: 0,
  MISSING_ECL: 0,
  IDENTITY_CONFLICT: 0,
  SKU_CONFLICT: 0,
  BARCODE_CONFLICT: 0,
  VARIANT_CONFLICT: 0,
  NEEDS_REVIEW: 0,
  NOT_SUPPORTED: 0,
  ARCHIVED_INTERNAL: 0,
});

export function summarize(storefront: StorefrontKey, items: readonly GapItem[]): DiscoverySummary {
  const byStatus = ZERO_STATUS();
  let productGrainTotal = 0;
  let variantGrainTotal = 0;
  for (const it of items) {
    byStatus[it.status] += 1;
    if (it.grain === "variant") variantGrainTotal += 1;
    else productGrainTotal += 1;
  }
  return { storefront, grain: grainOf(storefront), total: items.length, byStatus, productGrainTotal, variantGrainTotal };
}

// ── apply plans ──────────────────────────────────────────────────────────────
/** Selected MISSING_ECL items that are deterministic — the ONLY ECL-repair set. */
export function planEclRepairs(items: readonly GapItem[], selectedKeys: readonly string[]): GapItem[] {
  const sel = new Set(selectedKeys);
  return items.filter((it) => sel.has(it.key) && it.status === "MISSING_ECL" && it.confidence === "DETERMINISTIC" && it.repairIdentityType != null);
}

/** Selected EXTERNAL_ONLY items that are import-eligible — the ONLY import set. */
export function planImports(items: readonly GapItem[], selectedKeys: readonly string[]): GapItem[] {
  const sel = new Set(selectedKeys);
  return items.filter((it) => sel.has(it.key) && it.status === "EXTERNAL_ONLY" && it.importEligibility === "IMPORT_ELIGIBLE");
}
