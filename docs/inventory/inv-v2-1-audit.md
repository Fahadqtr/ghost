# INV.V2.1 Inventory Audit

## Current map

| Capability | Current route | Classification | Current authority |
|---|---|---|---|
| Overview, quantities and availability mode | `/inventory` | REUSE / NEEDS_MIGRATION | `inventory`, `product_variants`, availability engine |
| Shelves and locations | `/inventory/shelves` | REUSE / NEEDS_MIGRATION | `shelf_slots`, `shelf_stock`, `variant_shelf_stock`, Inventory Engine |
| Stocktake | `/inventory/stocktake` | REUSE / NEEDS_MIGRATION | Inventory Engine absolute-count and shelf placement operations |
| Movements | `/inventory/movements` | REUSE / NEEDS_MIGRATION | Inventory Engine movement operations plus `malak_audit` ledger |
| Out of stock | `/inventory/out-of-stock` | REUSE / NEEDS_MIGRATION | explicit availability state, products, channels and channel listings |
| Reports | `/inventory/reports` | REUSE / NEEDS_MIGRATION | inventory analytics plus movement ledger; read-only calculations |
| Product barcode labels and scanner | `/inventory/labels` and embedded scanner | REUSE / NEEDS_MIGRATION | `products.barcode`, `product_variants.barcode`; existing barcode components |
| Shelf labels | `/inventory/shelves/labels` | REUSE / NEEDS_MIGRATION | existing shelf placement tables |
| Staff movement approvals | `/inventory/approvals` | REUSE / NEEDS_MIGRATION | authenticated approval actions over `malak_audit` |
| Unified V2 entry point | `/v2/inventory` | MOVE (navigation only) | static links to current authorities; no reader or writer |

No requested capability is MISSING. No legacy page is classified KEEP as the final V2 UX; all remain operational and NEEDS_MIGRATION until UI/action parity is proven individually.

## Data and action authorities

- Product-level quantity: `inventory`; variant quantity: `product_variants`.
- Shelf topology and distribution: `shelf_slots`, `shelf_stock`, `variant_shelf_stock`.
- Quantity, movement and shelf mutations: existing `lib/inventory/engine.ts` RPC boundary and `app/(app)/inventory/actions.ts` adapters.
- Availability is explicit and remains owned by `lib/availability/*`; it is not inferred from quantity.
- Movement/audit history and staff review state: `malak_audit` through existing movement and approval actions.
- Reports reuse existing sales, analytics and shrinkage readers; no second calculation model is introduced.
- Authentication remains the V2/legacy authenticated layouts plus `requireUser()` in server actions. Service-role fallback behavior is unchanged.

## Foundation decision

The V2 Hub is navigation-only. It does not import a Supabase client or any inventory action, and it introduces no redirect from `/inventory/**`. Therefore legacy tools remain the sole operational UI and no parity claim is made. A route may move later only after its V2 replacement is proven equivalent.

