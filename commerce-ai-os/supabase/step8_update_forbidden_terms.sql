-- ============================================================================
-- STEP 8 — refine forbidden_terms (config-only) to cut false medical flags.
-- Run on production yourself. Reduces medical flags 138 → 4 (genuine only).
--   EN: drop generic cosmetic verbs (treat/treats/treatment/medical); add the
--       specific "medical treatment"; KEEP allergy-free (safety-first).
--   AR: drop bare علاج ("treatment") and bare طبي ("medical"); keep the verb
--       forms + disease/allergy phrases.
-- ============================================================================

update compliance_rules
set rule_value = '["medical treatment","cure","cures","heal","heals","eliminates acne","removes wrinkles permanently","clinically guaranteed","fda","prescription","diagnose","allergy-free"]'::jsonb,
    updated_at = now()
where rule_key = 'forbidden_terms_en';

update compliance_rules
set rule_value = '["يعالج","يشفي","يشفى","يداوي","يقضي على حب الشباب نهائياً","يزيل التجاعيد نهائياً","مضمون طبياً","آمن لجميع أنواع الحساسية","يعالج الإكزيما","تشخيص"]'::jsonb,
    updated_at = now()
where rule_key = 'forbidden_terms_ar';

-- verify
select rule_key, jsonb_array_length(rule_value) as n_terms, rule_value
from compliance_rules where rule_key in ('forbidden_terms_en','forbidden_terms_ar')
order by rule_key;
