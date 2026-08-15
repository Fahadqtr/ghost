-- ============================================================================
-- CH.5 — DURABLE MULTI-STORE EXTERNAL LISTING IDENTITY (additive, idempotent).
--
-- Introduces ONE durable, store-aware identity table behind the existing
-- ExternalIdentityResolver. It generalizes the four current identity sources
-- (products.snoonu_id / pure_seoul_id / rafeeq_product_id, and the Talabat
-- channel_variant_mappings) into a single normalized model that is STOREFRONT-
-- scoped — so a product may carry a different external identity in Snoonu
-- Malikas vs Snoonu Pure Seoul, and Talabat's flattened variants each get their
-- own listing.
--
-- STRICT SCOPE:
--   • purely ADDITIVE — creates one new table + its indexes/policies only;
--   • NO legacy column is dropped (products.*_id stay intact — retired later);
--   • NO data backfill here (backfill is a separate, approved apply step);
--   • external listings NEVER own inventory — there is deliberately NO stock /
--     quantity column (single shared Inventory Engine pool, §11);
--   • NOT auto-applied — this migration ships in the PR and awaits explicit
--     production approval.
-- ============================================================================

-- ── 1) table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.external_channel_listings (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL,                 -- internal master product (authoritative)
  variant_id          uuid,                          -- internal variant id (nullable; not stable across edits)
  variant_sku         text,                          -- durable variant grain key (variant SKU)
  channel_key         text NOT NULL,                 -- shopify | snoonu | talabat | rafeeq
  storefront_key      text NOT NULL,                 -- e.g. snoonu:malikas | snoonu:pure_seoul | talabat:malikas
  external_product_id text,                          -- Shopify product GID / Snoonu SPI / Rafeeq id
  external_variant_id text,                          -- Shopify variant GID (else NULL)
  exported_sku        text,                          -- SKU as exported (Talabat's practical listing key)
  exported_barcode    text,
  identity_type       text NOT NULL,                 -- shopify_gid | snoonu_spi | rafeeq_product_id | talabat_sku
  mapping_status      text NOT NULL DEFAULT 'active',-- active | needs_review | archived
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_channel_listings_pkey PRIMARY KEY (id)
);

-- ── 2) CHECK constraints (guarded) ──────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ecl_identity_type_check') THEN
    ALTER TABLE public.external_channel_listings
      ADD CONSTRAINT ecl_identity_type_check
      CHECK (identity_type = ANY (ARRAY['shopify_gid','snoonu_spi','rafeeq_product_id','talabat_sku']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ecl_mapping_status_check') THEN
    ALTER TABLE public.external_channel_listings
      ADD CONSTRAINT ecl_mapping_status_check
      CHECK (mapping_status = ANY (ARRAY['active','needs_review','archived']));
  END IF;
END $$;

-- ── 3) foreign keys (guarded on referenced tables existing) ──────────────────
DO $$ BEGIN
  IF to_regclass('public.products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ecl_product_id_fkey') THEN
    ALTER TABLE public.external_channel_listings
      ADD CONSTRAINT ecl_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.product_variants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ecl_variant_id_fkey') THEN
    ALTER TABLE public.external_channel_listings
      ADD CONSTRAINT ecl_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 4) uniqueness (partial indexes — see §5 reasoning) ──────────────────────
--   Internal grain: one listing per (storefront, product, variant grain). Lets
--   Shopify keep a product row PLUS variant rows, and Talabat keep one row per
--   flattened variant; NULLs coalesced so product-grain rows are unique too.
CREATE UNIQUE INDEX IF NOT EXISTS ecl_internal_uk
  ON public.external_channel_listings
  USING btree (storefront_key, product_id, COALESCE(variant_id::text, ''), COALESCE(variant_sku, ''));

--   External handle: one internal target per (storefront, external id[, variant])
--   Storefront-scoped ⇒ Snoonu Malikas SPI-A and Pure Seoul SPI-B never collide.
CREATE UNIQUE INDEX IF NOT EXISTS ecl_external_uk
  ON public.external_channel_listings
  USING btree (storefront_key, external_product_id, COALESCE(external_variant_id, ''))
  WHERE (external_product_id IS NOT NULL);

--   SKU grain: one listing per (storefront, exported SKU) — Talabat's real key.
CREATE UNIQUE INDEX IF NOT EXISTS ecl_sku_uk
  ON public.external_channel_listings
  USING btree (storefront_key, lower(exported_sku))
  WHERE (exported_sku IS NOT NULL);

-- ── 5) lookup indexes ───────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ecl_product_idx     ON public.external_channel_listings USING btree (product_id);
CREATE INDEX IF NOT EXISTS ecl_storefront_idx  ON public.external_channel_listings USING btree (storefront_key);
CREATE INDEX IF NOT EXISTS ecl_channel_idx     ON public.external_channel_listings USING btree (channel_key);
CREATE INDEX IF NOT EXISTS ecl_ext_lookup_idx  ON public.external_channel_listings USING btree (storefront_key, external_product_id) WHERE (external_product_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS ecl_sku_lookup_idx  ON public.external_channel_listings USING btree (storefront_key, lower(exported_sku)) WHERE (exported_sku IS NOT NULL);
CREATE INDEX IF NOT EXISTS ecl_needs_review_idx ON public.external_channel_listings USING btree (mapping_status) WHERE (mapping_status = 'needs_review');

-- ── 6) RLS + least-privilege policy (mirror channel_variant_mappings) ────────
ALTER TABLE public.external_channel_listings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='external_channel_listings' AND policyname='ecl_select') THEN
    CREATE POLICY ecl_select ON public.external_channel_listings FOR SELECT TO authenticated USING (true);
  END IF;
  -- No INSERT/UPDATE/DELETE policy: writes (backfill / adapter persistence) go
  -- through the service role, which bypasses RLS. Signed-in users get read-only.
END $$;

-- ── 7) self-documenting comments ────────────────────────────────────────────
COMMENT ON TABLE public.external_channel_listings IS
  'CH.5 durable, storefront-scoped external listing identity. One row per (internal product/variant to storefront to external listing). Generalizes products.*_id + channel_variant_mappings. Owns identity only — never any per-listing count column; the single shared Inventory Engine pool is the sole source of counts.';
COMMENT ON COLUMN public.external_channel_listings.storefront_key IS
  'Canonical storefront key (channel + business unit), e.g. snoonu:malikas / snoonu:pure_seoul. Storefront-scoped identity: the same product may carry different external ids per storefront.';
COMMENT ON INDEX public.ecl_external_uk IS
  'External handle uniqueness is STOREFRONT-scoped so the two Snoonu storefronts (independent SPIs) never collide.';

-- ============================================================================
-- NOT APPLIED AUTOMATICALLY. Rollout (awaiting approval):
--   A. apply this additive migration
--   B. run the read-only backfill report (scripts/ch5_backfill_report.mjs)
--   C. backfill rows (service role), leaving conflicts as needs_review
--   D. dual-read verification, then switch ExternalIdentityResolver
--   E. legacy products.*_id columns stay intact until a later retirement CH
-- ============================================================================
