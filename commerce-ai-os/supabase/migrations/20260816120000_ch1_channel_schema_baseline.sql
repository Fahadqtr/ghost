-- ============================================================================
-- CH.1 — CHANNEL SCHEMA BASELINE (parity-only, additive, fully idempotent).
--
-- Purpose: make the repo migration history REPRODUCE the live production
-- channel-domain schema. Every object below already exists in production
-- (project vqstcmattiarhblqshvb), created historically via loose "run once"
-- scripts under supabase/*.sql that were never tracked as migrations. This
-- migration captures them EXACTLY as introspected from production on
-- 2026-08-16, using only IF NOT EXISTS / guarded ADDs.
--
-- STRICT SCOPE — this migration:
--   • creates NOTHING that production does not already have (no new schema),
--   • changes NO runtime behavior, performs NO data backfill / repair,
--   • does NOT rename the two distinct "platform_status" concepts (documented
--     below; renaming is deferred to a later CH migration),
--   • does NOT add the platform_snapshots uniqueness constraint that CH.0
--     proposed — see the DEFERRED note at the bottom (842 legitimate
--     append-only history recurrences already violate every narrow key, and
--     the INSERT-only write path is not upsert-compatible).
--
-- Base-table dependency note: the FKs below reference public.products and
-- public.brands, which are themselves not yet tracked in repo migrations. This
-- file is idempotent parity for the EXISTING production DB (where those tables
-- exist); a true from-zero rebuild additionally requires a base-table baseline
-- (products/brands/inventory/product_variants/shelf_stock), out of CH.1 scope.
-- Every FK add below is therefore guarded on the referenced table existing.
-- ============================================================================

-- ── 1) enum used by channel_products.channel_status ─────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_status_enum') THEN
    CREATE TYPE public.channel_status_enum AS ENUM ('Active', 'Draft', 'Not Listed');
  END IF;
END $$;

-- ── 2) channels — channel registry ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.channels (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  brand_id          uuid,
  supports_variants boolean NOT NULL DEFAULT true,
  created_at        timestamptz DEFAULT now(),
  CONSTRAINT channels_pkey PRIMARY KEY (id)
);

-- ── 3) channel_products — per-channel publish/price overlay ─────────────────
--    channel_stock is CHECK-forced NULL: inventory is a single shared pool
--    (enforce_shared_inventory policy). Do NOT relax this.
CREATE TABLE IF NOT EXISTS public.channel_products (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_id     uuid NOT NULL,
  product_id     uuid NOT NULL,
  channel_status public.channel_status_enum DEFAULT 'Not Listed'::public.channel_status_enum,
  channel_price  numeric,
  channel_stock  integer,
  updated_at     timestamptz DEFAULT now(),
  CONSTRAINT channel_products_pkey PRIMARY KEY (id)
);

-- ── 4) channel_variant_mappings — Talabat flattened-variant export map ───────
--    DURABLE IDENTITY = (channel_id, master_product_id, coalesce(master_variant_sku,'')).
--    Deliberately keyed on the variant SKU, NOT product_variants.id (variant
--    ids are not stable across edits). channel_product_id is the external id,
--    NULL until the channel assigns it. Do NOT change this contract in CH.1.
CREATE TABLE IF NOT EXISTS public.channel_variant_mappings (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_id         uuid NOT NULL,
  master_product_id  uuid NOT NULL,
  master_variant_sku text,
  exported_sku       text NOT NULL,
  exported_barcode   text,
  channel_product_id text,
  mapping_status     text NOT NULL DEFAULT 'active'::text,
  export_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_exported_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_variant_mappings_pkey PRIMARY KEY (id)
);

-- ── 5) platform_status (TABLE) — per-(product,platform) approval + availability
--    NOTE — NAME COLLISION: this TABLE is distinct from the products.platform_status
--    COLUMN (an enum: Active/Draft/Archived) which is the product LIFECYCLE state.
--    This table is a derived projection/overlay (approval + availability per
--    channel), NOT an authority. The two are intentionally left un-renamed in CH.1.
CREATE TABLE IF NOT EXISTS public.platform_status (
  product_id       uuid NOT NULL,
  platform         text NOT NULL,
  approval         text,
  rejection_reason text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  availability     text,
  CONSTRAINT platform_status_pkey PRIMARY KEY (product_id, platform)
);

-- ── 6) platform_snapshots — append-only external-state capture log ──────────
CREATE TABLE IF NOT EXISTS public.platform_snapshots (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  platform         text NOT NULL,
  product_id       uuid,
  external_id      text,
  sku              text,
  barcode          text,
  status           text,
  price            numeric,
  availability     text,
  title            text,
  payload_hash     text NOT NULL,
  snapshot_version integer NOT NULL DEFAULT 1,
  captured_at      timestamptz NOT NULL DEFAULT now(),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT platform_snapshots_snapshot_version_check CHECK (snapshot_version >= 1)
);

-- ── 7) product channel external-id columns (denormalized reconcile keys) ────
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS snoonu_id         text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS rafeeq_product_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS pure_seoul_id     text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS pure_seoul_status text;

-- ── 8) foreign keys (guarded: added only if referenced table exists & FK absent)
DO $$ BEGIN
  IF to_regclass('public.brands') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channels_brand_id_fkey') THEN
    ALTER TABLE public.channels
      ADD CONSTRAINT channels_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_products_channel_id_fkey') THEN
    ALTER TABLE public.channel_products
      ADD CONSTRAINT channel_products_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_products_product_id_fkey') THEN
    ALTER TABLE public.channel_products
      ADD CONSTRAINT channel_products_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_variant_mappings_channel_id_fkey') THEN
    ALTER TABLE public.channel_variant_mappings
      ADD CONSTRAINT channel_variant_mappings_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_variant_mappings_master_product_id_fkey') THEN
    ALTER TABLE public.channel_variant_mappings
      ADD CONSTRAINT channel_variant_mappings_master_product_id_fkey FOREIGN KEY (master_product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_status_product_id_fkey') THEN
    ALTER TABLE public.platform_status
      ADD CONSTRAINT platform_status_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='platform_snapshots_product_id_fkey') THEN
    ALTER TABLE public.platform_snapshots
      ADD CONSTRAINT platform_snapshots_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── 9) UNIQUE + CHECK constraints (guarded) ─────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channels_name_brand_id_key') THEN
    ALTER TABLE public.channels ADD CONSTRAINT channels_name_brand_id_key UNIQUE (name, brand_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_products_channel_id_product_id_key') THEN
    ALTER TABLE public.channel_products ADD CONSTRAINT channel_products_channel_id_product_id_key UNIQUE (channel_id, product_id);
  END IF;
  -- Single shared inventory pool: channel_stock must always be NULL.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_products_no_per_channel_stock') THEN
    ALTER TABLE public.channel_products ADD CONSTRAINT channel_products_no_per_channel_stock CHECK (channel_stock IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='channel_variant_mappings_mapping_status_check') THEN
    ALTER TABLE public.channel_variant_mappings
      ADD CONSTRAINT channel_variant_mappings_mapping_status_check
      CHECK (mapping_status = ANY (ARRAY['active'::text, 'needs_review'::text, 'archived'::text]));
  END IF;
END $$;

-- ── 10) indexes (idempotent) ────────────────────────────────────────────────
-- channel_variant_mappings durable identity + uniqueness set
CREATE UNIQUE INDEX IF NOT EXISTS channel_variant_mappings_identity_uk
  ON public.channel_variant_mappings USING btree (channel_id, master_product_id, COALESCE(master_variant_sku, ''::text));
CREATE UNIQUE INDEX IF NOT EXISTS channel_variant_mappings_channel_sku_uk
  ON public.channel_variant_mappings USING btree (channel_id, exported_sku);
CREATE UNIQUE INDEX IF NOT EXISTS channel_variant_mappings_channel_cpid_uk
  ON public.channel_variant_mappings USING btree (channel_id, channel_product_id) WHERE (channel_product_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS channel_variant_mappings_product_idx
  ON public.channel_variant_mappings USING btree (master_product_id);
CREATE INDEX IF NOT EXISTS channel_variant_mappings_exported_sku_idx
  ON public.channel_variant_mappings USING btree (exported_sku);
CREATE INDEX IF NOT EXISTS channel_variant_mappings_variant_sku_idx
  ON public.channel_variant_mappings USING btree (master_variant_sku) WHERE (master_variant_sku IS NOT NULL);
CREATE INDEX IF NOT EXISTS channel_variant_mappings_barcode_idx
  ON public.channel_variant_mappings USING btree (exported_barcode) WHERE (exported_barcode IS NOT NULL);
CREATE INDEX IF NOT EXISTS channel_variant_mappings_cpid_idx
  ON public.channel_variant_mappings USING btree (channel_product_id) WHERE (channel_product_id IS NOT NULL);
-- platform_snapshots lookup indexes
CREATE INDEX IF NOT EXISTS platform_snapshots_latest_idx
  ON public.platform_snapshots USING btree (platform, product_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS platform_snapshots_platform_captured_idx
  ON public.platform_snapshots USING btree (platform, captured_at DESC);

-- ── 11) RLS enable (idempotent) + least-privilege policies (guarded) ────────
-- Channel tables are RLS-gated (broad table grants are the Supabase project
-- default; RLS is the real boundary). Policies captured verbatim from prod.
ALTER TABLE public.channels                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_variant_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_status          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_snapshots       ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channels' AND policyname='authenticated_all_channels') THEN
    CREATE POLICY authenticated_all_channels ON public.channels FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_products' AND policyname='authenticated_all_channel_products') THEN
    CREATE POLICY authenticated_all_channel_products ON public.channel_products FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='channel_variant_mappings' AND policyname='channel_variant_mappings_select') THEN
    CREATE POLICY channel_variant_mappings_select ON public.channel_variant_mappings FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='platform_status' AND policyname='platform_status_all') THEN
    CREATE POLICY platform_status_all ON public.platform_status FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='platform_snapshots' AND policyname='platform_snapshots_select') THEN
    CREATE POLICY platform_snapshots_select ON public.platform_snapshots FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='platform_snapshots' AND policyname='platform_snapshots_insert') THEN
    CREATE POLICY platform_snapshots_insert ON public.platform_snapshots FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
END $$;

-- ── 12) self-documenting comments (parity, no behavior) ─────────────────────
COMMENT ON TABLE  public.platform_status IS
  'Per-(product,platform) approval + availability OVERLAY (derived projection, not authority). DISTINCT from the products.platform_status COLUMN, which is the product lifecycle enum (Active/Draft/Archived). Rename deferred to a later CH migration.';
COMMENT ON CONSTRAINT channel_products_no_per_channel_stock ON public.channel_products IS
  'Single shared inventory pool: per-channel stock is forbidden. Inventory authority is the inventory table only.';
COMMENT ON INDEX public.channel_variant_mappings_identity_uk IS
  'Durable channel mapping identity = (channel_id, master_product_id, coalesce(master_variant_sku,'''')). Keyed on variant SKU, never product_variants.id.';

-- ============================================================================
-- DEFERRED (NOT applied here) — platform_snapshots uniqueness hardening.
--   CH.0 proposed a UNIQUE key to stop concurrent duplicate captures. Read-only
--   analysis of production (2026-08-16) found 842 groups sharing
--   (platform, identity, payload_hash) across DIFFERENT captured_at values —
--   these are LEGITIMATE append-only history recurrences (a value changing back
--   to a prior state re-emits the same payload_hash). Any narrow unique key over
--   identity+hash therefore (a) cannot be created against current data and
--   (b) would corrupt append-only history semantics. The write path
--   (SupabaseSnapshotStore.saveSnapshot) is INSERT-only, not an upsert, so a
--   unique key would also turn concurrent captures into thrown errors — a
--   runtime behavior change out of CH.1 scope. Deferred to a later PR that pairs
--   a correctly-scoped key (or capture-time advisory lock) with an
--   onConflict-compatible write path.
-- ============================================================================
