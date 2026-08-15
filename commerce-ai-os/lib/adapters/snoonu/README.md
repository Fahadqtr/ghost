# Snoonu Multi-Store Adapter — Foundation (CH.6A)

The first real non-Shopify `ChannelAdapter`. Snoonu owns **two storefronts from
day one**, and the storefront is **always explicit** — Malikas vs Pure Seoul is
never inferred.

| Storefront | identity | grain |
| --- | --- | --- |
| `snoonu:malikas` | `snoonu_spi` (SPI = UniqueIdentifier) | product |
| `snoonu:pure_seoul` | `snoonu_spi` — **independent** SPI namespace | product |

**Critical invariant:** the same internal product may carry `SPI=A` in
`snoonu:malikas` and `SPI=B` in `snoonu:pure_seoul`. These are two independent
external listings — **SPI is never deduped across storefronts.**

## What CH.6A contains (foundation only)

| File | Purpose | Purity |
| --- | --- | --- |
| `snoonu-adapter.ts` | `createSnoonuAdapter(deps)` — channel `snoonu`, two stores, explicit storefront, identity live; mutating/connector capabilities declared but `supports()===false` (CH.6B–F). | pure |
| `snoonu-listing.ts` | `projectSnoonuListing` → normalized `SnoonuListing` (SPI from ECL + catalog fields + **explicit** availability + per-storefront health). No quantity. | pure |
| `snoonu-file-contract.ts` | Typed model + pure normalizer for the real Snoonu "AllExportData" export (`SPI(UniqueIdentifier)`, names, `Price Global(Update)`, `Availability <store>`). Mirrors `lib/snoonu-diff.ts`; changes no file behavior. | pure |
| `snoonu-diagnostics.ts` | `computeSnoonuDiagnostics` — per-storefront candidate counts. | pure |
| `snoonu-diagnostics.server.ts` | Read-only reader feeding the compute (select-only). | server |

## Identity — ECL only

All identity flows through the CH.5 `ExternalIdentityResolver` (ECL-primary). The
adapter reads no `products.snoonu_id` / `pure_seoul_id` directly.

## Mapping health (per storefront)

`HEALTHY | UNMAPPED | STALE | AMBIGUOUS | NEEDS_REVIEW` — store-aware. Mapped in
`snoonu:malikas` but not `snoonu:pure_seoul` ⇒ HEALTHY for Malikas, UNMAPPED for
Pure Seoul. One storefront never satisfies another.

## Availability & inventory boundaries

- Availability is an **explicit input** (Availability Engine). Never derived from
  quantity, never written back in CH.6A (projection only — CH.6C adds sync).
- Snoonu owns **no** quantity: no channel/storefront/listing stock. All
  storefronts share the single Inventory Engine pool.

## Read-only diagnostics

`loadSnoonuDiagnostics` reports, per storefront: mapped / unmapped / needs_review
/ stale / orphaned, plus missing-image / missing-barcode / availability-mismatch
**candidate** counts. Counts only — no mutations.

## Future phases (capability hooks, not implemented)

- **CH.6B** — Merchant connector + image sync (`listListings`, `syncImages`)
- **CH.6C** — Availability sync (`syncAvailability`)
- **CH.6D** — Barcode completion
- **CH.6E** — AI enrichment / keywords
- **CH.6F** — Missing-products wizard

## Boundaries (CH.6A)

The adapter is additive and non-mutating; existing Snoonu / Pure Seoul import
workflows are untouched. No browser automation, no writes of any kind.
