-- ============================================================================
-- STEP 4 (1/2) — extract 5 REAL products as checker-ready drafts (JSON).
-- Read-only. Pulls one product per category (a mix), mapped to the Draft shape
-- the Compliance Checker expects. Run on production, then paste the single JSON
-- result back so the deterministic checker can score them.
--
-- Mapping notes:
--   * title_en/title_ar are mapped from name_en/name_ar (products has no
--     separate title column) so the format check has titles to validate.
--   * platform_prices is omitted here (prices live in channel_products); the
--     price-consistency check will therefore pass trivially for this run. Say
--     the word and I'll add the channel_products join to test cross-platform
--     price parity for real.
-- ============================================================================

select json_agg(d) as drafts
from (
  select distinct on (main_category)
    sku,
    name_en,
    name_ar,
    name_en  as title_en,
    name_ar  as title_ar,
    main_category,
    description_en as desc_en,
    description_ar as desc_ar,
    keywords_en,
    keywords_ar,
    size,
    price,
    discount_price,
    image_url
  from products
  where sku is not null
    and name_en is not null
  order by main_category, sku
  limit 5
) d;
