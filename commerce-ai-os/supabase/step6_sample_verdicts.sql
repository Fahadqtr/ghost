-- ============================================================================
-- STEP 4 (2/2) — write the 5-product sample verdicts into compliance_log.
-- Produced by the deterministic Compliance Checker (sku_pattern = Option C).
-- Logging only — NO publish/export. Run on production yourself.
-- All 5 = WARN (data completeness), publish_allowed = true, needs_human = false.
-- ============================================================================

insert into compliance_log (product_sku,overall,publish_allowed,needs_human,failed_checks,checker_version,notes) values ('mk1003','WARN',true,false,'[{"name":"required_fields","severity":"WARN","detail":"Missing/invalid required fields","evidence":"size, keywords_en(15), keywords_ar(15)"}]'::jsonb,'v1','STEP4 5-product sample');
insert into compliance_log (product_sku,overall,publish_allowed,needs_human,failed_checks,checker_version,notes) values ('mk1191','WARN',true,false,'[{"name":"required_fields","severity":"WARN","detail":"Missing/invalid required fields","evidence":"size, keywords_en(0), keywords_ar(0)"}]'::jsonb,'v1','STEP4 5-product sample');
insert into compliance_log (product_sku,overall,publish_allowed,needs_human,failed_checks,checker_version,notes) values ('mk1001','WARN',true,false,'[{"name":"required_fields","severity":"WARN","detail":"Missing/invalid required fields","evidence":"size, keywords_en(15), keywords_ar(15)"}]'::jsonb,'v1','STEP4 5-product sample');
insert into compliance_log (product_sku,overall,publish_allowed,needs_human,failed_checks,checker_version,notes) values ('mk1011','WARN',true,false,'[{"name":"required_fields","severity":"WARN","detail":"Missing/invalid required fields","evidence":"size, keywords_en(15), keywords_ar(0)"}]'::jsonb,'v1','STEP4 5-product sample');
insert into compliance_log (product_sku,overall,publish_allowed,needs_human,failed_checks,checker_version,notes) values ('mk1525','WARN',true,false,'[{"name":"required_fields","severity":"WARN","detail":"Missing/invalid required fields","evidence":"size, keywords_en(1), keywords_ar(0)"}]'::jsonb,'v1','STEP4 5-product sample');

-- verify
select product_sku, overall, publish_allowed, failed_checks
from compliance_log where notes = 'STEP4 5-product sample' order by product_sku;
