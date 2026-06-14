-- ============================================================================
-- STEP 7 — extract 5 REAL products that are listed on 2+ channels, as
-- checker-ready drafts (JSON), for the price-consistency sample. Read-only.
--
-- Targets products with >= 2 channel_products rows and surfaces price VARIANCE
-- first (then discounted ones), so the price check isn't trivial — we want to
-- see a real BLOCK on a mismatch and a PASS where discount_price explains it.
--
-- platform_prices = effective price per channel = channel_price, or the base
-- price when channel_price is NULL (shared pricing). Paste the JSON result back.
-- ============================================================================

select json_agg(to_jsonb(d) - 'nchannels' - 'has_variance') as drafts
from (
  select
    p.sku,
    p.name_en,
    p.name_ar,
    p.name_en as title_en,
    p.name_ar as title_ar,
    p.main_category,
    p.description_en as desc_en,
    p.description_ar as desc_ar,
    p.keywords_en,
    p.keywords_ar,
    p.size,
    p.price,
    p.discount_price,
    p.image_url,
    pp.platform_prices,
    pp.nchannels,
    pp.has_variance
  from products p
  join lateral (
    select
      jsonb_object_agg(c.name, coalesce(cp.channel_price, p.price)) as platform_prices,
      count(*) as nchannels,
      (min(coalesce(cp.channel_price, p.price)) <> max(coalesce(cp.channel_price, p.price))) as has_variance
    from channel_products cp
    join channels c on c.id = cp.channel_id
    where cp.product_id = p.id
  ) pp on true
  where p.sku is not null
    and p.name_en is not null
    and pp.nchannels >= 2
  order by pp.has_variance desc nulls last, p.discount_price desc nulls last, p.sku
  limit 5
) d;
