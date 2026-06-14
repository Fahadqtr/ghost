-- ============================================================================
-- STEP 5 — set SKU pattern to Option C (config change only, no code/redeploy).
-- Real SKUs are 'mk####' (e.g. mk1003); Option C accepts those AND hyphenated
-- BRAND-PRODUCT-VARIANT SKUs. Updates ONLY format_rules.sku_pattern; preserves
-- require_ar / require_en / keywords_min / keywords_max.
-- Run on production yourself.
-- ============================================================================

update compliance_rules
set rule_value = jsonb_set(
      rule_value,
      '{sku_pattern}',
      '"^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$"'::jsonb,
      true
    ),
    updated_at = now()
where rule_key = 'format_rules';

-- verify (expect sku_pattern = ^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$ ; other keys intact)
select rule_value from compliance_rules where rule_key = 'format_rules';
