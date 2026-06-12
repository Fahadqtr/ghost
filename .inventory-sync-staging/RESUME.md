# Inventory Sync — Staging (resume data)

Temporary staging for the Shopify inventory sync (malikasuniverse.com / Doha location
`gid://shopify/Location/81908531438`). Source of truth: Supabase `inventory.stock_quantity`.

## Status
- **Phase 1 (trial 20):** DONE in an earlier session — mk849–mk868 (21 variant items) tracked + set to 50.
- **Phase 2 (rest):** PREPARED, NOT YET WRITTEN. Blocked by an MCP write-approval gate
  ("MCP tool call requires approval") in the session — reads worked, writes were denied.

## What is ready here
- `items.ndjson` — full Shopify catalog map: `sku<TAB>inventoryItemId<TAB>tracked` (1283 rows, all distinct).
- `towrite.json` — `{ set50: [...1262 inventoryItem ids], set0: [] }` (the remaining items to set to 50; excludes the 21 trial items already done).
- `qty.json` / `zeros.json` / `source.json` — Supabase source data + the 63 zero-qty SKUs.
- `track_0..12.graphql` — enable tracking (`inventoryItemUpdate tracked:true`), 100 aliased mutations each.
- `set_0..5.graphql` — `inventorySetQuantities` available=50, 250 items each.
- `gen.mjs` — regenerates the .graphql files from `towrite.json` if needed.

## Key finding
The 63 zero-qty SKUs (mk1995–mk2057 + mk1995/2001/2004/2011) **do not exist in Shopify**
(highest Shopify SKU = mk1994). Nothing to set for them — correctly out-of-stock by absence.

## To resume (once write-approval is granted)
1. Submit each `track_*.graphql` via the Shopify MCP `graphql_mutation` (enables tracking; auto-activates at Doha at qty 0).
2. Submit each `set_*.graphql` via `graphql_mutation` (sets available = 50).
3. Verify with a `productVariants` read, then log to Supabase `malak_audit` (action_type `shopify_stock_sync`).

This folder is throwaway scaffolding — delete after the sync is verified complete.
