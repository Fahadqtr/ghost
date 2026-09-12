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

---

## Outcome (write executed 2026-09-12)

`POSTSTATE_rafeeq_malikas_after_step09.csv` — 1465 rows, sha256
`261d19006973e52ee152b7d9d66e21593296132b4e5598da164502c4fa0f4ced` — is the state
immediately after the commit, read back independently.

Applied in one transaction: 1231 rows updated (1228 repointed + 3 needs_review resolved)
and 108 rows inserted. Pre-existing `ecl_id` and `created_at` values are unchanged, so
every update happened in place — nothing was deleted and re-created.

Verified against the export: 1339 bound, 1339 matching, 0 mismatched, 0 null, 0 duplicate
ids, 0 duplicate SKUs. The four held-back SKUs and all 122 out-of-master rows are
byte-identical to the snapshot, `updated_at` included.

### Follow-up: closed by STEP 11 (2026-09-12)

The three rows that this rebind resolved out of `needs_review` still carried the
backfill's conflict markers afterwards. STEP 11 removed them under separate owner
authorisation, touching nothing else:

| SKU | external_product_id | mapping_status |
|---|---|---|
| `mk898` | `698933521` | active |
| `mk1285` | `698934306` | active |
| `mk1286` | `698934295` | active |

Only the two stale keys were dropped — `conflict` (value `duplicate_external_id`) and
`claimed_external_product_id`, whose claimed ids `691712302` and `695342530` were first
confirmed to be referenced by no listing on any storefront. `backfill_source` is
preserved, leaving these rows in the same metadata shape as every other row on the
storefront. No id, status, identity type or grain column changed.

`mk900` was deliberately left alone and remains `needs_review` with a NULL
`external_product_id` and its markers intact, pending the duplicate review in STEP 10.

The reconciler, re-run against the same workbook and the live mappings after the
cleanup, still reports 1339 matched (`already_mapped`), 0 conflicts, 0 applicable.

Note for anyone running the rollback below: it restores `external_product_id` and
`mapping_status` only, so it would not put these three rows' conflict markers back.
That is harmless — the markers describe a conflict that no longer exists.

## Rollback procedure

Not authorized; do not run without the owner saying so. Given
`SNAPSHOT_rafeeq_malikas_pre_step09.csv` (1357 rows) as `snap(ecl_id, external_product_id,
mapping_status)`, in one transaction:

```sql
-- 1. restore the 1231 rows that existed before
update external_channel_listings l
   set external_product_id = nullif(s.external_product_id, ''),
       mapping_status      = s.mapping_status,
       updated_at          = now()
  from snap s
 where l.id = s.ecl_id;                                  -- expect 1357 rows

-- 2. remove the 108 rows this write created
delete from external_channel_listings l
 where l.storefront_key = 'rafeeq:malikas'
   and l.id not in (select ecl_id from snap);            -- expect 108 rows
```

Assert before commit: 1357 rows remain on `rafeeq:malikas`, 1353 carry a non-null
`external_product_id`, 4 are `needs_review` with NULL, and no id falls in
`698933171 .. 698934509`.
