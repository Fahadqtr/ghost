-- ============================================================================
-- STEP 10 — add the nail-jargon medical exception to compliance_rules.
-- Run on production yourself. The checker reads this rule and skips
-- "cure"/"cures" only when every occurrence sits within `window` words of a
-- context word (nail-curing jargon). Genuine claims still BLOCK.
-- Idempotent (upsert).
-- ============================================================================

insert into compliance_rules (rule_key, rule_value, active)
values (
  'medical_jargon_exceptions',
  '{"terms":["cure","cures"],"context":["gel","uv","led","nail","nails","polish","lamp","manicure"],"window":4}'::jsonb,
  true
)
on conflict (rule_key) do update
  set rule_value = excluded.rule_value,
      active     = true,
      updated_at = now();

-- verify the rule is present + active
select rule_key, active, rule_value
from compliance_rules
where rule_key = 'medical_jargon_exceptions';
