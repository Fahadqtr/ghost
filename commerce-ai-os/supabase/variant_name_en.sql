-- Bilingual product options: add an English name alongside the existing
-- variant_name (which now holds the Arabic/primary option name). Nullable and
-- additive, so existing rows and readers keep working unchanged.
alter table product_variants add column if not exists variant_name_en text;
