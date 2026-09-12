# Rafeeq mapping rebind — 2026-09-12 (STEP RAFEEQ 09)

Pre-write snapshot and planned-change artifacts for the owner-authorized rebind of
`external_channel_listings` rows on `storefront_key = 'rafeeq:malikas'`, after Rafeeq
reloaded its catalogue and issued a new generation of `product_id` values
(`698933171 .. 698934509`). Every previously stored Rafeeq id is absent from the new
catalogue, so all existing bindings were stale.

## Files

| file | rows | sha256 |
|---|---|---|
| `SNAPSHOT_rafeeq_malikas_pre_step09.csv` | 1357 | `72f74ca7a9f0e961da09e3c55815d96ad121abef81818a78ce4f1979d94b1c33` |
| `PLANNED_CHANGES_step09.csv` | 1339 | `4bcac7227cd101218bb67d3c88b8020bd3bb49b858933829238f32dfd9bb993c` |

`CHECKSUMS.sha256` carries the same digests in `sha256sum -c` format.

`SNAPSHOT_…` is the complete state of the storefront's listings immediately before the
write: `ecl_id, product_id, sku, external_product_id, mapping_status, identity_type,
channel_key, variant_id, variant_sku, created_at, updated_at`.

`PLANNED_CHANGES_…` is the change set: `sku, old_external_product_id,
new_external_product_id, classification, ecl_id, old_mapping_status`.

## Scope

* 1228 `A_UPDATE_REPLACE_OLD_ID` — resolved row repointed to the new id
* 3 `B_RESOLVE_NULL_NEEDS_REVIEW` — `mk1285`, `mk1286`, `mk898`
* 108 `C_INSERT_NO_EXISTING_ROW` — first binding, product grain, `variant_id` NULL

Matching key is `products.sku`. `product_variants.barcode` is never read or written.

## Deliberately untouched

* `mk1516`, `mk1106`, `mk1335`, `mk900` — active for us, absent from the new Rafeeq
  catalogue; held for separate review.
* 122 listing rows whose SKU is outside the active Snoonu master.
* 6 `archived` rows.

## Rollback

`SNAPSHOT_rafeeq_malikas_pre_step09.csv` restores the exact prior state: for each
`ecl_id` present in it, write back its `external_product_id` (empty means NULL) and
`mapping_status`; delete any `rafeeq:malikas` row whose `ecl_id` is not in the snapshot
(those are the 108 inserts). Do not run a rollback without owner authorization.
