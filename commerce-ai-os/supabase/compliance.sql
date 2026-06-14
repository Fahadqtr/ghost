-- ============================================================================
-- Compliance Checker (Agent #9) — compliance_rules / compliance_log
-- Implements malika-compliance-checker-spec.md §4, with two owner decisions:
--   A1: valid_categories seeded from the REAL 17 product_categories
--       (live products.main_category source of truth) — NOT the spec's 11.
--   B1: compliance_log.draft_id is a plain nullable column with NO FK
--       (ai_drafts / Maker pipeline does not exist yet).
--
-- All rules live in compliance_rules (configurable — edit without redeploying
-- the agent). SKU/title format is in format_rules (default BRAND-PRODUCT-VARIANT
-- via sku_pattern). Safe & idempotent. No changes to existing tables.
-- ============================================================================

-- 4.1 compliance_rules — config -------------------------------------------------
create table if not exists compliance_rules (
  id          bigint generated always as identity primary key,
  rule_key    text not null unique,   -- 'valid_categories','forbidden_terms_en','format_rules', ...
  rule_value  jsonb not null,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- Seed (idempotent). A1: the real 17 categories from product_categories.
insert into compliance_rules (rule_key, rule_value) values
('valid_categories', '["Face Care","Body Care","Hair Care","Makeup","Lashes & Nails","Beauty Accessories","Beauty Bundle","Masks","Sun Protection","Dental Care","Women’s Essentials","Rhode Products Section","Thailand Products","Summer And Camping Supplies","Electronics","✨Toys","Uncategorized"]'),
('forbidden_terms_en', '["cure","cures","heal","heals","treat","treats","treatment","medical","clinically guaranteed","eliminates acne","removes wrinkles permanently","fda","prescription","diagnose","allergy-free"]'),
('forbidden_terms_ar', '["يعالج","علاج","يشفي","يشفى","يداوي","طبي","يقضي على حب الشباب نهائياً","يزيل التجاعيد نهائياً","مضمون طبياً","آمن لجميع أنواع الحساسية","يعالج الإكزيما","تشخيص"]'),
('format_rules', '{"sku_pattern":"^[A-Z]{2,4}(-[A-Z0-9]+)+$","require_ar":true,"require_en":true,"keywords_min":5,"keywords_max":10}'),
-- Deterministic "fabricated data" heuristics (delivery time / stock claims a
-- Maker should never invent). Configurable — extend as needed.
('fabrication_patterns', '["\\bships? in \\d","\\bdelivery in \\d","\\bwithin \\d+ ?(hours|hrs|days|day)\\b","\\b\\d+ ?(hours|hrs) delivery\\b","\\bin stock\\b *: *\\d","\\b\\d+ in stock\\b","\\bsame[- ]day delivery\\b"]'),
-- Where to route a product whose category is not one of the 17 (A1 has no
-- "Trending Products" bucket — "Uncategorized" is the real fallback).
('category_fallback', '"Uncategorized"'),
-- "clinically proven" style phrases allowed ONLY if confirmed on packaging.
('on_label_claims', '[]'),
-- Image policy. White-bg classifier is not wired, so it is not enforced
-- (would otherwise WARN-and-queue, per spec §2.2). HTTPS is still required.
('image_rules', '{"require_white_bg_check":false}')
on conflict (rule_key) do nothing;

-- 4.2 compliance_log — audit trail of every check run --------------------------
create table if not exists compliance_log (
  id              bigint generated always as identity primary key,
  product_sku     text not null,
  draft_id        bigint,                              -- B1: nullable, NO FK (ai_drafts not created yet)
  checker_version text not null default 'v1',
  run_at          timestamptz not null default now(),
  overall         text not null check (overall in ('PASS','WARN','BLOCK')),
  publish_allowed boolean not null,
  needs_human     boolean not null default false,
  failed_checks   jsonb not null default '[]',         -- array of {name, severity, detail, evidence}
  reviewed_by     text,
  reviewed_at     timestamptz,
  published_after boolean not null default false,
  notes           text
);

create index if not exists idx_compliance_log_sku on compliance_log (product_sku);
create index if not exists idx_compliance_log_blocked on compliance_log (overall) where overall = 'BLOCK';
-- Supports the publish gate's "latest verdict for this SKU" lookup.
create index if not exists idx_compliance_log_sku_time on compliance_log (product_sku, run_at desc);

-- Row-Level Security (same pattern as the Live Memory Layer) --------------------
-- Server (service-role) writes; signed-in dashboard users may READ; no client
-- writes. Idempotent drop-then-create.
alter table compliance_rules enable row level security;
alter table compliance_log  enable row level security;

drop policy if exists compliance_rules_read_authenticated on compliance_rules;
create policy compliance_rules_read_authenticated on compliance_rules
  for select to authenticated using (true);

drop policy if exists compliance_log_read_authenticated on compliance_log;
create policy compliance_log_read_authenticated on compliance_log
  for select to authenticated using (true);
