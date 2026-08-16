# CH.6F — Missing Products Discovery & Repair Wizard

A read-first workflow that detects catalog/listing gaps between the internal
Catalog and external commerce storefronts, explains **why** each gap exists, and
provides controlled, preview-gated repair/import actions. Discovery is
**read-only**; every mutation is `SCAN → CLASSIFY → PREVIEW → SELECT → CONFIRM →
APPLY`, writer-authorized (CH.3b), and audited. It never silently creates
products or mappings.

## Source-of-truth matrix (architecture audit)

| Channel | Storefront | External identity | Available deterministic source | Variant model | Import capability | Safe for CH.6F? |
| --- | --- | --- | --- | --- | --- | --- |
| Shopify | `shopify:malikas` | Shopify product GID (`shopify_gid`) | ECL + `platform_snapshots(platform=shopify)` (`loadShopifySnapshotView`, capture from trusted read model; GID only for unique matches, else `reviewRequired`) | product (variant GID allowed in ECL) | via `createProductCore` only | ✅ (read-only + gated repair) |
| Snoonu | `snoonu:malikas` | Snoonu SPI (`snoonu_spi`) | ECL + `loadSnoonuDiagnostics` / `projectSnoonuListing`; AllExportData upload via `snoonu-diff` (authoritative SPI/name/price/availability) | product | via `createProductCore` only | ✅ |
| Snoonu | `snoonu:pure_seoul` | Snoonu SPI (**independent** from Malikas) | ECL + `platform_snapshots(platform=pure_seoul)` (`loadPureSoulSnapshotView`, upload-derived; carries external SPI) | product | via `createProductCore` only | ✅ (cross-store SPI isolation enforced by `storefront_key`) |
| Talabat | `talabat:malikas` | Talabat SKU (`talabat_sku`) | ECL (one row per flattened variant) + `platform_snapshots(platform=talabat)` (upload; `external_id=null`, sku/barcode present) + `channel_variant_mappings` baseline | **variant** (sellable grain) | via `createProductCore` only | ✅ (compare at sellable grain) |
| Rafeeq | `rafeeq:malikas` | Rafeeq product id (`rafeeq_product_id`) | ECL + `platform_snapshots(platform=rafeeq)` (export/DB-overlay) | product | via `createProductCore` only | ✅ (contested ids stay `NEEDS_REVIEW`) |

### Boundaries reused (no parallel system invented)
- **Durable identity:** `external_channel_listings` (CH.5 ECL) — storefront-scoped,
  no stock column. Read via the select/eq-only surface. **The only** durable
  listing identity CH.6F builds on. Legacy `products.{snoonu_id,pure_seoul_id,
  rafeeq_product_id}` are never read for identity and never written.
- **External evidence (read-only):** `platform_snapshots` via
  `SupabaseSnapshotStore.listLatestByPlatform` (immutable, provenance =
  `captured_at`) + Snoonu diagnostics. External-only enumeration beyond persisted
  evidence comes from an injectable `ExternalListingSource` port that **defaults
  to `session_required` / empty** (mirrors CH.6B/6C/6D — no live connector or
  export is provisioned by default), so discovery is safe on day one.
- **Catalog creation:** `createProductCore` / `createProductsBatchCore`
  (`lib/products/product-create*`) with `makeInventoryInitializer` /
  `makeSimpleProductsInitializer`. Never a direct `products`/`inventory` INSERT.
- **Inventory init:** RPC-protected `inv_initialize_product_state` /
  `inv_initialize_simple_products` behind the initializer adapters. Imported
  products seed at **quantity 0** (Catalog/Inventory policy) — never channel
  quantity. New products are created `approval:""`, `platform_status:""`
  (unapproved, channel-invisible).
- **ECL repair write:** a narrow `writeEclMapping` boundary — INSERT-only into
  `external_channel_listings`, whitelisted columns, storefront-scoped uniqueness
  precheck, never overwrites an active/conflicting mapping.
- **Authz:** `requireMalakWriter` (CH.3b) on every apply. Scan is signed-in only.
- **Audit:** `insertAuditRow` per applied change (actor, channel, storefront,
  external identity, internal target, action, reason, result).
- **Safe errors:** `safeError` at every externally reachable boundary.

## Classification model (§5)
`MAPPED_OK · INTERNAL_ONLY · EXTERNAL_ONLY · MISSING_ECL · IDENTITY_CONFLICT ·
SKU_CONFLICT · BARCODE_CONFLICT · VARIANT_CONFLICT · NEEDS_REVIEW · NOT_SUPPORTED
· ARCHIVED_INTERNAL`. Problems are never collapsed into "missing".

## Matching (§4) — deterministic only
Evidence hierarchy: `ecl_active > external_id > sku > barcode > variant_sku`.
Never fuzzy / name / AI / brand-approx / visual. Confidence is `DETERMINISTIC`
or nothing — no opaque scores. (Fuzzy/name suggestions are out of scope here.)

## Snoonu multi-store (§6)
`snoonu:malikas` and `snoonu:pure_seoul` are independent storefronts; SPIs never
cross. Every read/classification is `storefront_key`-scoped; ECL uniqueness keys
are storefront-prefixed.

## Talabat flattening (§8)
Compared at **sellable variant grain**. A variant product's parent is not a
sufficient match; each sellable variant is checked against Talabat listing
evidence (variant SKU / barcode). No fake parent-level mapping.

## Rafeeq conflicts (§7)
Existing `needs_review` ECL rows are preserved as `NEEDS_REVIEW`; contested
external ids are never auto-assigned to either product.
