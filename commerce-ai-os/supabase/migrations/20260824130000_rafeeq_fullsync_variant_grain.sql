-- ============================================================================
-- RAFEEQ.FULLSYNC.2 — SELLABLE (VARIANT-AWARE) PACKAGE ITEMS + SUPERSEDED
-- SURFACING (additive, idempotent, backward-compatible).
--
-- RAFEEQ.FULLSYNC.1 recorded package items at PRODUCT grain. The Rafeeq export
-- is now flattened to SELLABLE rows (a simple product = one row; a product with
-- variants = one row per variant, no parent row), so the durable sent-state
-- must track sellable identity:
--
--   (product_id, variant_id NULL)     — a simple-product row
--   (product_id, variant_id set)      — one variant row
--
-- This lets a variant added AFTER the baseline become pending on its own while
-- its already-sent siblings stay cleared, and it prevents the old product-grain
-- history from being silently reinterpreted as variant-complete (a legacy item
-- with variant_id NULL clears only the product's SIMPLE row).
--
-- Also adds superseded surfacing on rafeeq_packages: when a NEW authoritative
-- FULL package is recorded, prior UNSENT FULL packages are marked superseded
-- (historical rows are never deleted; a SENT package is never touched).
--
-- STRICT SCOPE:
--   • ADDITIVE columns + indexes only; no data rewrite, no backfill;
--   • the ONLY removal is the old product-grain unique index on
--     rafeeq_package_items, replaced by the sellable-grain unique index —
--     required because a product with N variants now records N item rows;
--   • NOT auto-applied — ships in the PR and awaits explicit production
--     approval.
-- ============================================================================

-- ── 1) sellable grain on package items ───────────────────────────────────────
ALTER TABLE public.rafeeq_package_items
  ADD COLUMN IF NOT EXISTS variant_id uuid;          -- NULL = simple-product row

DO $$ BEGIN
  IF to_regclass('public.product_variants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rafeeq_package_items_variant_fkey') THEN
    ALTER TABLE public.rafeeq_package_items
      ADD CONSTRAINT rafeeq_package_items_variant_fkey
      FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;
  END IF;
END $$;

--   One item per SELLABLE row per package (NULL variant coalesced so simple
--   rows stay unique too). Replaces the FULLSYNC.1 product-grain uniqueness,
--   which would reject a product's second variant row.
CREATE UNIQUE INDEX IF NOT EXISTS rafeeq_package_items_sellable_uk
  ON public.rafeeq_package_items
  USING btree (package_id, product_id, COALESCE(variant_id::text, ''));
DROP INDEX IF EXISTS public.rafeeq_package_items_uk;

CREATE INDEX IF NOT EXISTS rafeeq_package_items_variant_idx
  ON public.rafeeq_package_items USING btree (variant_id) WHERE (variant_id IS NOT NULL);

-- ── 2) superseded surfacing on packages ──────────────────────────────────────
ALTER TABLE public.rafeeq_packages
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;  -- NULL = current
ALTER TABLE public.rafeeq_packages
  ADD COLUMN IF NOT EXISTS superseded_by uuid;         -- the replacing package

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rafeeq_packages_superseded_by_fkey') THEN
    ALTER TABLE public.rafeeq_packages
      ADD CONSTRAINT rafeeq_packages_superseded_by_fkey
      FOREIGN KEY (superseded_by) REFERENCES public.rafeeq_packages(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 3) self-documenting comments ─────────────────────────────────────────────
COMMENT ON COLUMN public.rafeeq_package_items.variant_id IS
  'RAFEEQ.FULLSYNC.2 sellable grain: NULL = the product''s simple row; set = one variant row. A legacy product-grain item (NULL on a product that has variants) clears only the simple row — it is never reinterpreted as covering the product''s variants.';
COMMENT ON COLUMN public.rafeeq_packages.superseded_at IS
  'Set when a later authoritative FULL package replaced this still-UNSENT one (recording a FULL package supersedes prior unsent FULL packages). A SENT package is never superseded; history is never deleted.';

-- ============================================================================
-- NOT APPLIED AUTOMATICALLY. Rollout (awaiting approval):
--   A. apply this additive migration
--   B. deploy RAFEEQ.FULLSYNC.2 (delivery-state reads degrade gracefully on an
--      unmigrated database — variant grain reported unavailable, nothing faked)
--   C. generate the variant-aware FULL replacement package (supersedes the
--      unsent FULLSYNC.1 product-grain package), send it to Rafeeq, mark sent
-- ============================================================================
