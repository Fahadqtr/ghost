// SHOPIFY.VARIANT.REPAIR — plan + verify + orchestration core (PURE).
//
// 62 mapped Shopify products carry only the standalone "Default Title" variant
// while the internal catalog holds their real child variants. This module plans
// the repair for ONE product, verifies the post-mutation state, and runs the
// whole flow through INJECTED ports — no I/O of its own, node:test loads it
// directly. The single Shopify write is `productVariantsBulkCreate` with
// strategy REMOVE_STANDALONE_VARIANT (atomic: creates the real variants AND
// removes the standalone default in one mutation; product images/status/title/
// description untouched; NO inventory quantity is ever written).
//
// STRICT FAIL-CLOSED: ambiguous mapping, missing identity/price, duplicate
// SKU/barcode, unexpected or partial live state, or a partial mutation result
// all stop the product — nothing is guessed and ECL is only written from a
// VERIFIED re-read.

// ── inputs ───────────────────────────────────────────────────────────────────

export interface RepairInternalVariant {
  id: string;
  name: string | null;
  sku: string | null;
  barcode: string | null;
  /** explicit variant price; null/0 ⇒ inherit the parent effective price */
  price: number | null;
}

export interface RepairInternalProduct {
  id: string;
  sku: string | null;
  price: number | null;
  discountPrice: number | null;
  variants: RepairInternalVariant[];
}

export interface RepairLiveVariant {
  id: string; // gid://shopify/ProductVariant/…
  sku: string;
  barcode: string;
  title: string;
}

export interface RepairLiveProduct {
  id: string; // gid://shopify/Product/…
  /** Shopify's own flag — the standalone-default gate never trusts the title alone */
  hasOnlyDefaultVariant: boolean;
  variants: RepairLiveVariant[];
}

// ── plan ─────────────────────────────────────────────────────────────────────

export const DEFAULT_TITLE = "Default Title";

export type RepairReason =
  | "no_product_gid"
  | "ambiguous_mapping"
  | "no_internal_variants"
  | "missing_name"
  | "missing_sku"
  | "missing_barcode"
  | "missing_price"
  | "duplicate_sku"
  | "duplicate_barcode"
  /** two internal variants share one option-value name — a single Shopify
   *  "Title" option cannot represent both; the catalog must be fixed first */
  | "duplicate_name"
  | "partial_live_state"
  | "unexpected_live_state"
  /** the live product is not verifiably a standalone-default product: the
   *  title says "Default Title" but Shopify's hasOnlyDefaultVariant flag
   *  disagrees (or vice versa) — never mutate on contradictory evidence */
  | "not_standalone_default"
  /** live SKUs match the plan but a barcode differs — NOT the same variants */
  | "live_barcode_mismatch"
  /** live SKUs match the plan but a variant name/title differs */
  | "live_name_mismatch";

export interface PlannedCreate {
  internalVariantId: string;
  name: string;
  sku: string;
  barcode: string;
  /** money string, 2 decimals — exactly what the mutation sends */
  price: string;
}

export interface EclWrite {
  internalVariantId: string;
  variantGid: string;
  sku: string;
  barcode: string;
}

export interface VariantRepairPlan {
  internalProductId: string;
  productGid: string | null;
  status: "READY" | "ALREADY_DONE" | "BLOCKED";
  reasons: RepairReason[];
  /** the ONLY supported Shopify strategy for this repair */
  strategy: "REMOVE_STANDALONE_VARIANT";
  /** the standalone default variant that the mutation removes (READY only) */
  standaloneVariantGid: string | null;
  creates: PlannedCreate[];
  /** ALREADY_DONE: identity writes derivable from live WITHOUT any mutation */
  eclWrites: EclWrite[];
}

const positive = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

const text = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

/** Effective sell price — the SAME certified semantics as the channel previews:
 *  variant.price ?? parent.discountPrice ?? parent.price (positive only). */
export function effectiveVariantPrice(v: RepairInternalVariant, p: RepairInternalProduct): number | null {
  return positive(v.price) ?? positive(p.discountPrice) ?? positive(p.price);
}

function money(n: number): string {
  return n.toFixed(2);
}

/** Plan the repair for one mapped product. Pure and deterministic. */
export function planVariantRepair(
  internal: RepairInternalProduct,
  productGid: string | null,
  live: RepairLiveProduct,
): VariantRepairPlan {
  const reasons: RepairReason[] = [];
  const base: Omit<VariantRepairPlan, "status" | "reasons"> = {
    internalProductId: internal.id,
    productGid,
    strategy: "REMOVE_STANDALONE_VARIANT",
    standaloneVariantGid: null,
    creates: [],
    eclWrites: [],
  };
  const blocked = (): VariantRepairPlan => ({ ...base, status: "BLOCKED", reasons });

  if (!text(productGid)) {
    reasons.push("no_product_gid");
    return blocked();
  }
  if (internal.variants.length === 0) {
    reasons.push("no_internal_variants");
    return blocked();
  }

  // Internal identity + price validation — every variant must be complete.
  const creates: PlannedCreate[] = [];
  for (const v of internal.variants) {
    const name = text(v.name);
    const sku = text(v.sku);
    const barcode = text(v.barcode);
    const price = effectiveVariantPrice(v, internal);
    if (name === "" && !reasons.includes("missing_name")) reasons.push("missing_name");
    if (sku === "" && !reasons.includes("missing_sku")) reasons.push("missing_sku");
    if (barcode === "" && !reasons.includes("missing_barcode")) reasons.push("missing_barcode");
    if (price === null && !reasons.includes("missing_price")) reasons.push("missing_price");
    if (name && sku && barcode && price !== null) {
      creates.push({ internalVariantId: v.id, name, sku, barcode, price: money(price) });
    }
  }
  // Duplicates INSIDE the product are ambiguous identity — hard stop.
  const skuSeen = new Set<string>();
  const barcodeSeen = new Set<string>();
  const nameSeen = new Set<string>();
  for (const c of creates) {
    const s = c.sku.toLowerCase();
    if (skuSeen.has(s) && !reasons.includes("duplicate_sku")) reasons.push("duplicate_sku");
    skuSeen.add(s);
    if (barcodeSeen.has(c.barcode) && !reasons.includes("duplicate_barcode")) reasons.push("duplicate_barcode");
    barcodeSeen.add(c.barcode);
    // Shopify option values must be unique — two internal variants with the
    // same name (trim + case-insensitive) cannot share one "Title" option.
    const nm = c.name.toLowerCase();
    if (nameSeen.has(nm) && !reasons.includes("duplicate_name")) reasons.push("duplicate_name");
    nameSeen.add(nm);
  }
  if (reasons.length > 0) return blocked();

  // Live state gate. The ONLY repairable shape is the standalone default —
  // and the destructive REMOVE_STANDALONE_VARIANT strategy requires BOTH
  // pieces of evidence: Shopify's own hasOnlyDefaultVariant flag AND exactly
  // one live variant titled "Default Title". If the two disagree in either
  // direction the state is contradictory and we never mutate.
  const liveVariants = live.variants;
  const plannedSkus = new Set(creates.map((c) => c.sku.toLowerCase()));
  const titleSaysDefaultOnly = liveVariants.length === 1 && text(liveVariants[0]!.title) === DEFAULT_TITLE;

  if (live.hasOnlyDefaultVariant && titleSaysDefaultOnly) {
    return {
      ...base,
      status: "READY",
      reasons: [],
      standaloneVariantGid: liveVariants[0]!.id,
      creates,
    };
  }
  if (live.hasOnlyDefaultVariant !== titleSaysDefaultOnly) {
    reasons.push("not_standalone_default");
    return blocked();
  }

  // Idempotency: EXACTLY the planned set already live ⇒ nothing to mutate;
  // identity may still be persisted. A live variant counts as a match ONLY
  // when ALL identity fields equal the planned internal variant — normalized
  // SKU (unique hit), exact barcode, exact name/title. A SKU-only match with
  // a differing barcode or name is NOT done — it is a different variant.
  const liveBySku = new Map<string, RepairLiveVariant[]>();
  for (const lv of liveVariants) {
    const s = text(lv.sku).toLowerCase();
    liveBySku.set(s, [...(liveBySku.get(s) ?? []), lv]);
  }
  const hasDefault = liveVariants.some((lv) => text(lv.title) === DEFAULT_TITLE);
  const skuExact =
    !hasDefault &&
    liveVariants.length === creates.length &&
    creates.every((c) => (liveBySku.get(c.sku.toLowerCase()) ?? []).length === 1);
  if (skuExact) {
    for (const c of creates) {
      const lv = liveBySku.get(c.sku.toLowerCase())![0]!;
      if (text(lv.barcode) !== c.barcode && !reasons.includes("live_barcode_mismatch")) reasons.push("live_barcode_mismatch");
      if (text(lv.title) !== c.name && !reasons.includes("live_name_mismatch")) reasons.push("live_name_mismatch");
    }
    if (reasons.length > 0) return blocked();
    return {
      ...base,
      status: "ALREADY_DONE",
      reasons: [],
      creates: [],
      eclWrites: creates.map((c) => ({
        internalVariantId: c.internalVariantId,
        variantGid: liveBySku.get(c.sku.toLowerCase())![0]!.id,
        sku: c.sku,
        barcode: c.barcode,
      })),
    };
  }

  // Anything else is either a partial earlier run or a state we do not own.
  const anyPlannedLive = liveVariants.some((lv) => plannedSkus.has(text(lv.sku).toLowerCase()));
  reasons.push(anyPlannedLive ? "partial_live_state" : "unexpected_live_state");
  return blocked();
}

// ── verify (post-mutation re-read) ───────────────────────────────────────────

export type VerifyResult =
  | { status: "VERIFIED"; eclWrites: EclWrite[] }
  | { status: "NEEDS_RECONCILIATION"; reasons: string[] };

/**
 * Verify the re-read against the plan. Every planned variant must be matched
 * by EXACTLY ONE live variant on ALL identity fields — normalized SKU, exact
 * barcode, exact name/title — with no standalone default left and no extra
 * variants. Any deviation ⇒ NEEDS_RECONCILIATION and ZERO ECL writes
 * (identity is NEVER persisted from an ambiguous or mismatched state).
 */
export function verifyRepairResult(plan: VariantRepairPlan, reread: readonly RepairLiveVariant[]): VerifyResult {
  const reasons: string[] = [];
  const bySku = new Map<string, RepairLiveVariant[]>();
  for (const lv of reread) {
    const s = text(lv.sku).toLowerCase();
    bySku.set(s, [...(bySku.get(s) ?? []), lv]);
  }
  if (reread.some((lv) => text(lv.title) === DEFAULT_TITLE)) reasons.push("default_title_still_present");
  const eclWrites: EclWrite[] = [];
  for (const c of plan.creates) {
    const hits = bySku.get(c.sku.toLowerCase()) ?? [];
    if (hits.length === 0) {
      reasons.push(`missing:${c.sku}`);
      continue;
    }
    if (hits.length > 1) {
      reasons.push(`ambiguous:${c.sku}`);
      continue;
    }
    const lv = hits[0]!;
    let mismatched = false;
    if (text(lv.barcode) !== c.barcode) {
      reasons.push(`barcode_mismatch:${c.sku}`);
      mismatched = true;
    }
    if (text(lv.title) !== c.name) {
      reasons.push(`name_mismatch:${c.sku}`);
      mismatched = true;
    }
    if (!mismatched) {
      eclWrites.push({ internalVariantId: c.internalVariantId, variantGid: lv.id, sku: c.sku, barcode: c.barcode });
    }
  }
  if (reread.length !== plan.creates.length) reasons.push("unexpected_variant_count");
  if (reasons.length > 0) return { status: "NEEDS_RECONCILIATION", reasons };
  return { status: "VERIFIED", eclWrites };
}

// ── orchestration core (injected ports — the server file only binds them) ────

export interface VariantRepairPorts {
  loadInternal(productId: string): Promise<RepairInternalProduct | null>;
  /** the product's Shopify GID from ECL; ambiguous ⇒ hard stop */
  loadProductGid(productId: string): Promise<{ gid: string | null; ambiguous: boolean }>;
  readLive(productGid: string): Promise<RepairLiveProduct | null>;
  /** the ONE Shopify write: bulk-create with REMOVE_STANDALONE_VARIANT */
  createVariants(productGid: string, creates: readonly PlannedCreate[]): Promise<{ ok: boolean; error?: string }>;
  rereadLive(productGid: string): Promise<RepairLiveVariant[] | null>;
  /** durable identity write-back through the certified ECL boundary */
  persistEcl(productId: string, productGid: string, write: EclWrite): Promise<{ ok: boolean }>;
}

export type RepairOutcome =
  | "REPAIRED"
  | "ALREADY_DONE"
  | "BLOCKED"
  | "FAILED"
  | "NEEDS_RECONCILIATION";

export interface VariantRepairItemResult {
  productId: string;
  outcome: RepairOutcome;
  reasons: string[];
  createdCount: number;
  eclPersisted: number;
  eclFailed: number;
}

/** Run the full repair for ONE product through the injected ports. */
export async function runVariantRepair(ports: VariantRepairPorts, productId: string): Promise<VariantRepairItemResult> {
  const out = (outcome: RepairOutcome, reasons: string[] = [], createdCount = 0, eclPersisted = 0, eclFailed = 0): VariantRepairItemResult =>
    ({ productId, outcome, reasons, createdCount, eclPersisted, eclFailed });

  const internal = await ports.loadInternal(productId);
  if (!internal) return out("FAILED", ["internal_read_failed"]);

  const mapping = await ports.loadProductGid(productId);
  if (mapping.ambiguous) return out("BLOCKED", ["ambiguous_mapping"]);
  if (!mapping.gid) return out("BLOCKED", ["no_product_gid"]);

  const live = await ports.readLive(mapping.gid);
  if (!live) return out("FAILED", ["live_read_failed"]);

  const plan = planVariantRepair(internal, mapping.gid, live);
  if (plan.status === "BLOCKED") return out("BLOCKED", plan.reasons);

  if (plan.status === "ALREADY_DONE") {
    // Idempotent identity persistence only — NO mutation on a converged product.
    let ok = 0, failed = 0;
    for (const w of plan.eclWrites) {
      const r = await ports.persistEcl(productId, mapping.gid, w);
      if (r.ok) ok++; else failed++;
    }
    return failed > 0 ? out("NEEDS_RECONCILIATION", ["ecl_persist_failed"], 0, ok, failed) : out("ALREADY_DONE", [], 0, ok, 0);
  }

  // READY → the single atomic mutation. Any error ⇒ FAILED, identity untouched.
  const created = await ports.createVariants(mapping.gid, plan.creates);
  if (!created.ok) return out("FAILED", ["mutation_failed"]);

  // Re-read Shopify and verify BEFORE persisting any identity.
  const reread = await ports.rereadLive(mapping.gid);
  if (!reread) return out("NEEDS_RECONCILIATION", ["reread_failed"], plan.creates.length);

  const verdict = verifyRepairResult(plan, reread);
  if (verdict.status === "NEEDS_RECONCILIATION") {
    return out("NEEDS_RECONCILIATION", verdict.reasons, plan.creates.length);
  }

  let ok = 0, failed = 0;
  for (const w of verdict.eclWrites) {
    const r = await ports.persistEcl(productId, mapping.gid, w);
    if (r.ok) ok++; else failed++;
  }
  if (failed > 0) return out("NEEDS_RECONCILIATION", ["ecl_persist_failed"], plan.creates.length, ok, failed);
  return out("REPAIRED", [], plan.creates.length, ok, 0);
}
