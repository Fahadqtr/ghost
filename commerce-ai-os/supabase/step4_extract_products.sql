-- ============================================================================
-- STEP 4 (1/2) — extract 5 REAL products as checker-ready drafts (JSON).
-- Read-only. Pulls one product per category (a mix), mapped to the Draft shape
-- the Compliance Checker expects. Run on production, then paste the single JSON
-- result back so the deterministic checker can score them.
--
-- Mapping notes:
--   * title_en/title_ar are mapped from name_en/name_ar (products has no
--     separate title column) so the format check has titles to validate.
--   * platform_prices is built from channel_products joined to channels: the
--     effective price per channel is channel_price, or the base price when
--     channel_price is NULL (shared pricing). This drives price-consistency.
-- ============================================================================

select json_agg(d) as drafts
from (
  select distinct on (p.main_category)
    p.sku,
    p.name_en,
    p.name_ar,
    p.name_en  as title_en,
    p.name_ar  as title_ar,
    p.main_category,
    p.description_en as desc_en,
    p.description_ar as desc_ar,
    p.keywords_en,
    p.keywords_ar,
    p.size,
    p.price,
    p.discount_price,
    p.image_url,
    (select jsonb_object_agg(c.name, coalesce(cp.channel_price, p.price))
       from channel_products cp
       join channels c on c.id = cp.channel_id
      where cp.product_id = p.id) as platform_prices
  from products p
  where p.sku is not null
    and p.name_en is not null
  order by p.main_category, p.sku
  limit 5
) d;
