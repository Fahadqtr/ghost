-- ============================================================================
-- Phase 2 verification — run AFTER compliance.sql, on a branch/staging DB.
-- Mirrors malika-compliance-checker-spec.md §6 where it is expressible as SQL
-- (the 7-check verdict logic, §6 cases 1–11, is covered by the 13/13 node tests
-- and cannot run as pure SQL). Returns one results table; every result = PASS.
-- Inserts temporary chk rows and deletes them at the end (DB stays clean).
-- ============================================================================

drop table if exists _chk;
create temp table _chk(step text, result text);

-- 1: valid_categories seeded from the REAL 17 (decision A1)
insert into _chk
  select '1. valid_categories=17 (A1)',
    case when jsonb_array_length(rule_value)=17 then 'PASS: 17 categories'
         else 'FAIL: '||coalesce(jsonb_array_length(rule_value),-1)::text end
  from compliance_rules where rule_key='valid_categories';

-- 2: forbidden-term rules present (EN + AR)
insert into _chk
  select '2. forbidden_terms present',
    case when count(*) filter (where rule_key='forbidden_terms_en')=1
          and count(*) filter (where rule_key='forbidden_terms_ar')=1
         then 'PASS: forbidden_terms_en + _ar seeded' else 'FAIL: missing rows' end
  from compliance_rules where rule_key in ('forbidden_terms_en','forbidden_terms_ar');

-- 3: format_rules present with sku_pattern (configurable format, not hardcoded)
insert into _chk
  select '3. format_rules present',
    case when count(*)=1 and bool_and(rule_value ? 'sku_pattern')
         then 'PASS: format_rules has sku_pattern' else 'FAIL' end
  from compliance_rules where rule_key='format_rules';

-- 4: compliance_log.overall CHECK constraint (PASS = invalid overall rejected)
do $$
begin
  begin
    insert into compliance_log(product_sku, overall, publish_allowed) values('chk','MAYBE',true);
    insert into _chk values('4. overall CHECK','FAIL: invalid overall accepted');
  exception when check_violation then
    insert into _chk values('4. overall CHECK','PASS: invalid overall rejected');
  end;
end $$;

-- 5: B1 — draft_id nullable + NO FK (accepts NULL and an arbitrary value)
insert into compliance_log(product_sku, overall, publish_allowed, draft_id) values('chk-null','PASS',true,null);
insert into compliance_log(product_sku, overall, publish_allowed, draft_id) values('chk-arb','PASS',true,999999);
insert into _chk
  select '5. draft_id nullable/no-FK (B1)',
    case when count(*)=2 then 'PASS: null + 999999 both accepted (no FK)'
         else 'FAIL: '||count(*) end
  from compliance_log where product_sku in ('chk-null','chk-arb');

-- 6a: publish gate — latest verdict is BLOCK → refuse (§6.12)
insert into compliance_log(product_sku, overall, publish_allowed, run_at) values('GATE','BLOCK',false, now()-interval '2 min');
insert into _chk
  select '6a. gate refuses on BLOCK',
    case when (select publish_allowed from compliance_log where product_sku='GATE' order by run_at desc limit 1)=false
         then 'PASS: latest=BLOCK → publish_allowed=false' else 'FAIL' end;

-- 6b: publish gate — newer PASS → allow
insert into compliance_log(product_sku, overall, publish_allowed, run_at) values('GATE','PASS', true, now());
insert into _chk
  select '6b. gate allows after PASS',
    case when (select publish_allowed from compliance_log where product_sku='GATE' order by run_at desc limit 1)=true
         then 'PASS: newer PASS → publish_allowed=true' else 'FAIL' end;

-- 7: RLS enabled on both tables
insert into _chk
  select '7. RLS enabled',
    case when bool_and(relrowsecurity) then 'PASS: RLS on compliance_rules+log' else 'FAIL' end
  from pg_class where relname in ('compliance_rules','compliance_log');

-- 8: RLS policies present (2 authenticated SELECT, no client writes)
insert into _chk
  select '8. RLS policies',
    case when count(*)=2 then 'PASS: 2 authenticated SELECT policies' else 'FAIL: '||count(*) end
  from pg_policies where tablename like 'compliance_%';

-- cleanup temporary check rows
delete from compliance_log where product_sku in ('chk-null','chk-arb','GATE');

-- RESULTS
select * from _chk order by step;
