# Channel Adapter Framework (CH.4)

One interface every sales channel implements, so catalog / image / availability /
price / publish / order flows are driven the **same way** regardless of channel.
Shopify is the first (reference) implementation. Talabat, Snoonu, and Rafeeq plug
into the **same contracts** later — they are **not** implemented in CH.4.

## The four-level model

```
Channel  →  Store  →  External Listing  →  Internal Product
```

- **Channel** — `shopify | talabat | snoonu | pure_seoul | rafeeq` (the CH.2 keys).
- **Store** — a distinct storefront *within* a channel. **A channel may have many.**
  The framework never assumes one store per channel.
  - Shopify: one store today (`shopify:main`).
  - Snoonu (later): `snoonu:malikas` + `snoonu:pure_seoul`.
  - Rafeeq (later): its own store.
  - Talabat (later): flattens variants into standalone listings
    (`listingGrain: "variant"`).
- **External Listing** — the channel's own product/variant handle for a store.
- **Internal Product** — a master-catalog product (+ optional variant).

## Files

| File | Purpose | Purity |
| --- | --- | --- |
| `types.ts` | The `ChannelAdapter` contract, `StoreRef`, listing/product refs, uniform outcome shapes, capability list, `ExternalIdentityResolver`. | pure |
| `registry.ts` | `AdapterRegistry` — dispatch by channel or by globally-unique `storeKey`; fan-out across all stores. | pure |
| `identity.ts` | `createProjectionIdentityResolver(loader)` — internal→external id via the **CH.2 read-model** (abstracts access only; no new tables). | pure |
| `shopify/store.ts` | Shopify's `StoreRef` list (one store today). | pure |
| `shopify/shopify-adapter.ts` | `createShopifyAdapter(deps)` — the reference adapter; normalizes Shopify's native result shapes into the uniform contract. Dependency-injected (unit-testable). | pure |
| `app/(app)/import-export/shopify-adapter.server.ts` | Concrete server wiring: binds the factory to the existing, tested Shopify functions + the CH.2 reader. **Uncalled** (no behavior change). | server |

## Capabilities

Every adapter declares support for nine capabilities (`ADAPTER_CAPABILITIES`):

`identity`, `listings`, `catalogSync`, `imageSync`, `availabilitySync`,
`priceSync`, `publish`, `unpublish`, `orderIngestion`.

An adapter may report `supports(cap) === false` for one it cannot perform; the
Shopify reference adapter implements all nine.

## External identity — CH.2, not new storage

Adapters translate an internal product to its external listing pointer through
`ExternalIdentityResolver`, backed by the CH.2 mapping read-model
(`loadProductChannelProjection`). CH.4 adds **no** mapping tables and changes
**no** storage. **CH.5.5** will replace the backing store by supplying a
different loader — adapters stay unchanged.

## What CH.4 deliberately does NOT touch

Inventory, Availability Engine, Sales, Shelf, Security/authorization, RPCs, and
the database. Order **ingestion** here only fetches/normalizes/counts orders;
stock **deduction** stays owned by the Inventory Engine / order RPCs.

## Adding a channel later (sketch)

1. Add its `StoreRef`s (one or several) — set `listingGrain` (`"product"` or
   `"variant"`).
2. Write `create<Channel>Adapter(deps)` implementing `ChannelAdapter`, delegating
   to that channel's existing functions (no logic duplication).
3. Bind the real dependencies in a server module and `register()` it.
4. Reads keep flowing through the CH.2 resolver until CH.5.5 swaps storage.
