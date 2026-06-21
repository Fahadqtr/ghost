-- ============================================================================
-- STEP 12 — BUCKET B (safe 67): clear the STALE channel_price overrides so the
-- products inherit the current products.price (the confirmed source of truth).
-- Self-targeting: selects products whose channels all agree, differ from base,
-- are > 0, with gap <= 50%, discount NULL — and EXCLUDES the 3 outliers
-- (mk1134, mk1993, mk1987) by gap AND by name. Run on production yourself.
--
-- Order: (1) PREVIEW — confirm it returns 67 rows. (2) UPDATE. (3) VERIFY.
-- ============================================================================

-- ---- (1) PREVIEW: the exact set that will be cleared (expect 67 rows) -------
with eff as (
  select cp.product_id, p.sku, p.price as base, p.discount_price,
         min(coalesce(cp.channel_price, p.price)) as mn,
         max(coalesce(cp.channel_price, p.price)) as mx
  from channel_products cp
  join products p on p.id = cp.product_id
  group by cp.product_id, p.sku, p.price, p.discount_price
)
select sku, base as products_price, mn as stale_channel_price
from eff
where discount_price is null
  and base > 0
  and mn = mx and mn <> base and mn > 0
  and abs(mn - base)::numeric / base <= 0.5
  and sku not in ('mk1134','mk1993','mk1987')
order by sku;

-- ---- (2) UPDATE: clear the overrides for that set ---------------------------
with eff as (
  select cp.product_id, p.sku, p.price as base, p.discount_price,
         min(coalesce(cp.channel_price, p.price)) as mn,
         max(coalesce(cp.channel_price, p.price)) as mx
  from channel_products cp
  join products p on p.id = cp.product_id
  group by cp.product_id, p.sku, p.price, p.discount_price
),
targets as (
  select product_id from eff
  where discount_price is null
    and base > 0
    and mn = mx and mn <> base and mn > 0
    and abs(mn - base)::numeric / base <= 0.5
    and sku not in ('mk1134','mk1993','mk1987')
)
update channel_products cp
set channel_price = null,
    updated_at    = now()
from targets t
where cp.product_id = t.product_id
  and cp.channel_price is not null;

-- ---- (3) VERIFY: remaining safe-B mismatches should now be 0 ----------------
with eff as (
  select cp.product_id, p.sku, p.price as base, p.discount_price,
         min(coalesce(cp.channel_price, p.price)) as mn,
         max(coalesce(cp.channel_price, p.price)) as mx
  from channel_products cp
  join products p on p.id = cp.product_id
  group by cp.product_id, p.sku, p.price, p.discount_price
)
select count(*) as remaining_safe_B_mismatches
from eff
where discount_price is null
  and base > 0
  and mn = mx and mn <> base and mn > 0
  and abs(mn - base)::numeric / base <= 0.5
  and sku not in ('mk1134','mk1993','mk1987');
-- expect 0
