-- ============================================================================
-- STEP 9 — reword 2 products to clear genuine/negation medical flags.
-- Run on production yourself. NOTE: the medical flags are in desc_EN, so the
-- two EN updates below are what clear the BLOCKs. The AR updates are for
-- consistency — I don't have the current AR text to target a safe REPLACE, so
-- run the SELECT first and either paste me the AR (I'll give exact REPLACEs) or
-- edit AR directly. Targeted REPLACE = no-op if the text doesn't match exactly.
-- ============================================================================

-- mk1462 — negation disclaimer ("...is not a medical treatment") -> cosmetic-only
update products
set description_en = replace(
      description_en,
      'This Device Is Intended For Cosmetic Care Only And Is Not A Medical Treatment.',
      'Designed for cosmetic and personal care use only.'
    )
where sku = 'mk1462';

-- mk1342 — mild claim ("heals dry skin") -> nourishes
update products
set description_en = replace(
      description_en,
      'Deeply Hydrates And Heals Dry Skin',
      'Deeply hydrates and nourishes dry skin for a smoother, replenished feel'
    )
where sku = 'mk1342';

-- ---- AR (consistency; inspect first, then craft exact REPLACEs) -------------
select sku, description_ar from products where sku in ('mk1462','mk1342');

-- Template once you have the current AR phrase to replace:
-- update products set description_ar = replace(description_ar,
--   '«current AR phrase»', 'مصمّم للاستخدام التجميلي والعناية الشخصية فقط')
--   where sku = 'mk1462';
-- update products set description_ar = replace(description_ar,
--   '«current AR phrase»', 'يرطّب البشرة الجافة بعمق ويغذّيها لملمس أنعم وأكثر امتلاءً')
--   where sku = 'mk1342';

-- verify the EN rewording took effect (offending terms should be gone)
select sku,
       (description_en ilike '%medical treatment%') as has_medical_treatment,
       (description_en ilike '%heals%')             as has_heals
from products where sku in ('mk1462','mk1342');
