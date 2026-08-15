# Durable Multi-Store External Listing Identity (CH.5)

One durable, **storefront-scoped** identity model behind the existing
`ExternalIdentityResolver` — without changing adapter contracts or current
runtime behavior. Purely additive; legacy id columns stay intact.

## Domain model

```
Internal Product / Variant
        ↓
Channel
        ↓
Storefront          ← first-class, may be many per channel
        ↓
External Listing    ← one row in external_channel_listings
```

A single internal product may have **many** external listings:

| Storefront | identity | grain |
| --- | --- | --- |
| `shopify:malikas` | product GID (+ variant GID) | product |
| `snoonu:malikas` | SPI-A | product |
| `snoonu:pure_seoul` | SPI-B *(independent from Malikas)* | product |
| `talabat:malikas` | SKU/barcode per flattened variant | **variant** |
| `rafeeq:malikas` | platform product id | product |

**Pure Seoul is a second Snoonu storefront, not a separate channel** — the core
CH.5 correction to the CH.2 model.

## Identity semantics (normalize storage, not meaning)

`identity_type ∈ { shopify_gid, snoonu_spi, rafeeq_product_id, talabat_sku }`.
The table stores all of them uniformly; each channel keeps its own meaning. Snoonu
SPI is **per storefront** — the same product has different SPIs in Malikas vs Pure
Seoul, and the storefront-scoped uniqueness keys keep them from colliding.

## Schema (additive, not applied)

`supabase/migrations/20260816130000_ch5_external_channel_listings.sql` creates
`external_channel_listings`. There is deliberately **no stock/quantity column** —
external listings never own inventory (§11); all storefronts share the Inventory
Engine pool.

### Uniqueness (partial indexes)
- `ecl_internal_uk` — `(storefront_key, product_id, variant_id, variant_sku)`: one
  listing per internal target per storefront (Shopify product + variant rows;
  Talabat one row per flattened variant).
- `ecl_external_uk` — `(storefront_key, external_product_id, external_variant_id)`
  where `external_product_id` not null: **storefront-scoped**, so Snoonu Malikas
  SPI-A and Pure Seoul SPI-B never collide.
- `ecl_sku_uk` — `(storefront_key, lower(exported_sku))` where not null: Talabat's
  practical listing key.

None of these break the four scenarios (two Snoonu stores, Shopify variants,
Talabat flattened variants).

## Migration from current sources (§6)

| Source | → storefront | identity |
| --- | --- | --- |
| `products.snoonu_id` | `snoonu:malikas` | `snoonu_spi` |
| `products.pure_seoul_id` | `snoonu:pure_seoul` | `snoonu_spi` (independent) |
| `products.rafeeq_product_id` | `rafeeq:malikas` | `rafeeq_product_id` |
| `channel_variant_mappings` | `talabat:malikas` | `talabat_sku` (variant grain) |

`channel_products` (publish/price) and `platform_status` (approval/availability)
are **overlays, not identity** — excluded. Shopify has no authoritative legacy id
(live-match); its rows are captured going forward by the adapter.

Rollout: **A** additive table → **B** read-only backfill report
(`scripts/ch5_backfill_report.mjs`) → **C** backfill (service role; conflicts left
`needs_review`) → **D** dual-read verify, then switch the resolver → **E** legacy
columns retired in a later CH. Nothing is auto-applied.

## Resolver (§8)

`createDurableIdentityResolver(port)` implements the CH.4
`ExternalIdentityResolver.resolve()` (adapters unchanged) **plus**:
- `resolveExternalListing({ productId, variantId?, channel, storefront })`
- `resolveInternalListing({ channel, storefront, externalProductId?, externalVariantId?, sku?, barcode? })`

Both return **provenance** and **mapping health**. No fuzzy / name fallback.

## Mapping health (§9)

`HEALTHY | UNMAPPED | STALE | AMBIGUOUS | ORPHANED | NEEDS_REVIEW`, store-aware:
being mapped in `snoonu:malikas` says nothing about `snoonu:pure_seoul`.

## Talabat flattening (§10)

```
Internal:  Product ├ Variant A ├ Variant B └ Variant C
Talabat:   Listing A   Listing B   Listing C
```
Each Talabat listing is a variant-grain row (`variant_sku` + `exported_sku`) that
maps back to the exact internal variant — never collapsed to product level. CH.5
only *represents* this; Talabat export behavior is not implemented.

## Shared inventory boundary (§11)

No per-channel / per-store / per-listing quantity. `channel_products.channel_stock`
stays CHECK-NULL; `external_channel_listings` has no stock column. Guard-enforced.
