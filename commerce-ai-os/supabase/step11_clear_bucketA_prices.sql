-- ============================================================================
-- STEP 11 — BUCKET A fix: clear the 0-price channel overrides so the 5 affected
-- products inherit their base products.price. Run on production yourself.
-- (channel_price = 0 was a bad import; null = inherit base = shared pricing.)
-- ============================================================================

update channel_products
set channel_price = null,
    updated_at    = now()
where channel_price = 0
  and product_id in (
    select id from products where sku in ('mk995','mk1122','mk1161','mk1121','mk1597')
  );

-- verify: no remaining channel overrides for these (all inherit base now)
select p.sku, p.price as base_price,
       count(*) filter (where cp.channel_price is not null) as remaining_overrides
from products p
join channel_products cp on cp.product_id = p.id
where p.sku in ('mk995','mk1122','mk1161','mk1121','mk1597')
group by p.sku, p.price
order by p.sku;
