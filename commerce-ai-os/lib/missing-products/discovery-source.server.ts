import "server-only";
// CH.6F — discovery SOURCE ports (SERVER-ONLY, READ-ONLY).
//
// Three deterministic, persisted read layers per storefront, plus an injectable
// external-listing source. Every loader degrades gracefully (returns rows +
// a `degraded` flag) and NEVER writes — the client surfaces below expose only
// select/eq/in/order/range, so a mutation is structurally impossible here.
//
//   • loadInternalUnits    — internal Catalog (products + product_variants),
//                            grain-aware. The internal side of every comparison.
//   • loadEclRows          — active + needs_review external_channel_listings for
//                            the storefront (the CH.5 durable identity). Never
//                            reads legacy products.{snoonu_id,pure_seoul_id,
//                            rafeeq_product_id}.
//   • loadSnapshotEvidence — platform_snapshots (immutable, provenance =
//                            captured_at) → external identity evidence per
//                            internal product. Shopify/PureSoul/Talabat/Rafeeq.
//   • ExternalListingSource — injectable port for RAW external listings not tied
//                            to an internal product (export files / live merchant
//                            session). Defaults to session_required + EMPTY, so
//                            discovery is safe on day one (mirrors CH.6B/6C/6D).

import { SupabaseSnapshotStore } from "@/lib/platforms/core/supabase-store";
import {
  type StorefrontKey,
  type Grain,
  grainOf,
} from "./discovery-model.ts";
import {
  type InternalUnitInput,
  type EclRowInput,
  type ExternalEvidenceInput,
} from "./discovery-plan.ts";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

// ── read-only client surface (provably cannot write) ─────────────────────────
interface QueryResult {
  data: unknown[] | null;
  error: unknown | null;
}
interface Filter extends PromiseLike<QueryResult> {
  eq(c: string, v: string): Filter;
  in(c: string, v: string[]): Filter;
  range(a: number, b: number): Filter;
}
interface OrderedSelect extends PromiseLike<QueryResult> {
  eq(c: string, v: string): Filter;
  range(a: number, b: number): Filter;
}
interface Select {
  select(cols: string): OrderedSelect & { order(c: string, o: { ascending: boolean }): OrderedSelect };
}
export interface DiscoveryReadClient {
  from(table: string): Select;
}

const PAGE = 1000;
const PRODUCT_CAP = 30000;
const VARIANT_CAP = 60000;

// ── internal catalog ─────────────────────────────────────────────────────────
export interface InternalLoad {
  units: InternalUnitInput[];
  degraded: boolean;
}

/** Internal products (+ variants for variant-grain storefronts). Read-only. */
export async function loadInternalUnits(
  client: DiscoveryReadClient,
  storefront: StorefrontKey,
): Promise<InternalLoad> {
  const grain: Grain = grainOf(storefront);
  const units: InternalUnitInput[] = [];
  let degraded = false;

  // products
  const parentHasImage = new Map<string, boolean>();
  const parentHasDescription = new Map<string, boolean>();
  const parentBrand = new Map<string, string | null>();
  for (let from = 0; from < PRODUCT_CAP; from += PAGE) {
    const { data, error } = await client
      .from("products")
      .select("id, sku, barcode, name_en, name_ar, brand_id, image_url, description_en, description_ar")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      degraded = true;
      break;
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      const id = str(r.id);
      if (!id) continue;
      const hasImage = str(r.image_url) != null;
      const hasDescription = str(r.description_en) != null || str(r.description_ar) != null;
      parentHasImage.set(id, hasImage);
      parentHasDescription.set(id, hasDescription);
      parentBrand.set(id, str(r.brand_id));
      if (grain === "product") {
        units.push({
          productId: id,
          variantId: null,
          grain: "product",
          sku: str(r.sku),
          barcode: str(r.barcode),
          nameEn: str(r.name_en),
          nameAr: str(r.name_ar),
          brandId: str(r.brand_id),
          archived: false,
          sellable: true,
          hasImage,
          hasDescription,
        });
      }
    }
    if (rows.length < PAGE) break;
  }

  // variants (only needed at variant grain — Talabat sellable listings §8)
  if (grain === "variant") {
    for (let from = 0; from < VARIANT_CAP; from += PAGE) {
      const { data, error } = await client
        .from("product_variants")
        .select("id, parent_product_id, sku, barcode, variant_name, variant_name_en")
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        degraded = true;
        break;
      }
      const rows = (data ?? []) as Record<string, unknown>[];
      for (const r of rows) {
        const id = str(r.id);
        const parent = str(r.parent_product_id);
        if (!id || !parent) continue;
        units.push({
          productId: parent,
          variantId: id,
          grain: "variant",
          sku: str(r.sku),
          barcode: str(r.barcode),
          nameEn: str(r.variant_name_en),
          nameAr: str(r.variant_name),
          brandId: parentBrand.get(parent) ?? null,
          archived: false,
          sellable: true,
          hasImage: parentHasImage.get(parent) ?? false,
          hasDescription: parentHasDescription.get(parent) ?? false,
        });
      }
      if (rows.length < PAGE) break;
    }
  }

  return { units, degraded };
}

// ── ECL rows (durable identity) ──────────────────────────────────────────────
export interface EclLoad {
  rows: EclRowInput[];
  degraded: boolean;
}

/** Active + needs_review ECL rows for the storefront. Read-only, storefront-scoped. */
export async function loadEclRows(client: DiscoveryReadClient, storefront: StorefrontKey): Promise<EclLoad> {
  const rows: EclRowInput[] = [];
  let degraded = false;
  for (let from = 0; from < 200000; from += PAGE) {
    const { data, error } = await client
      .from("external_channel_listings")
      .select("product_id, variant_id, external_product_id, exported_sku, exported_barcode, mapping_status, metadata")
      .eq("storefront_key", storefront)
      .range(from, from + PAGE - 1);
    if (error) {
      degraded = true;
      break;
    }
    const page = (data ?? []) as Record<string, unknown>[];
    for (const r of page) {
      const productId = str(r.product_id);
      if (!productId) continue;
      const status = str(r.mapping_status) ?? "active";
      if (status === "archived") continue; // ignore retired mappings
      const meta = (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>;
      rows.push({
        productId,
        variantId: str(r.variant_id),
        externalProductId: str(r.external_product_id),
        exportedSku: str(r.exported_sku),
        exportedBarcode: str(r.exported_barcode),
        mappingStatus: status,
        claimedExternalId: str(meta.claimed_external_product_id),
      });
    }
    if (page.length < PAGE) break;
  }
  return { rows, degraded };
}

// ── snapshot evidence (external identity per internal product) ───────────────
export const SNAPSHOT_PLATFORM: Record<StorefrontKey, string | null> = {
  "shopify:malikas": "shopify",
  "snoonu:malikas": null, // no snapshot capture wired; ECL + injected export only
  "snoonu:pure_seoul": "pure_seoul",
  "talabat:malikas": "talabat",
  "rafeeq:malikas": "rafeeq",
};

export interface SnapshotLoad {
  evidence: ExternalEvidenceInput[];
  degraded: boolean;
  lastCapturedAt: string | null;
}

/**
 * platform_snapshots for the storefront's platform → external evidence. Every
 * row carries an internal product_id (captured joined to catalog). availability
 * is read for display only — NEVER used to infer stock (§2/§11).
 */
export async function loadSnapshotEvidence(
  client: DiscoveryReadClient,
  storefront: StorefrontKey,
): Promise<SnapshotLoad> {
  const platform = SNAPSHOT_PLATFORM[storefront];
  if (!platform) return { evidence: [], degraded: false, lastCapturedAt: null };
  const grain = grainOf(storefront);
  try {
    const store = new SupabaseSnapshotStore(client as never);
    const snaps = await store.listLatestByPlatform(platform);
    let lastCapturedAt: string | null = null;
    const evidence: ExternalEvidenceInput[] = [];
    for (const s of snaps) {
      if (s.capturedAt && (!lastCapturedAt || s.capturedAt > lastCapturedAt)) lastCapturedAt = s.capturedAt;
      evidence.push({
        productId: s.productId ?? null,
        externalId: s.externalId ?? null,
        sku: s.sku ?? null,
        barcode: s.barcode ?? null,
        title: s.title ?? null,
        grain,
        sourceType: `snapshot:${platform}`,
        capturedAt: s.capturedAt ?? null,
      });
    }
    return { evidence, degraded: false, lastCapturedAt };
  } catch {
    return { evidence: [], degraded: true, lastCapturedAt: null };
  }
}

// ── injectable external-listing source (raw listings / live session) ─────────
export type ExternalSourceState = "session_required" | "export" | "session" | "empty";

/**
 * A source of RAW external listings not tied to an internal product (export
 * files, a live merchant session). CH.6F is safe by default: the built-in source
 * reports `session_required` and yields NOTHING, so EXTERNAL_ONLY discovery is a
 * no-op until a real export/session is injected at live-activation time.
 */
export interface ExternalListingSource {
  readonly storefront: StorefrontKey;
  state(): Promise<ExternalSourceState>;
  listListings(): Promise<ExternalEvidenceInput[]>;
}

export function createEmptyExternalListingSource(storefront: StorefrontKey): ExternalListingSource {
  return {
    storefront,
    async state() {
      return "session_required";
    },
    async listListings() {
      return [];
    },
  };
}
