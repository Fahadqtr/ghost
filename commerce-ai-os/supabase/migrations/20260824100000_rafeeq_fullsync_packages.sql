-- ============================================================================
-- RAFEEQ.FULLSYNC.1 — DURABLE RAFEEQ PACKAGE / SENT-STATE MODEL (additive,
-- idempotent).
--
-- Introduces the smallest durable model that lets "NEW for Rafeeq" mean
-- "not yet included in a Rafeeq package the owner explicitly marked SENT" —
-- instead of the identity-based proxy (ECL rafeeq id == null). Two tables:
--
--   • rafeeq_packages       — one row per generated package (FULL or NEW),
--                             with the EXPLICIT sent state (sent_at/sent_by,
--                             null until the owner marks it sent);
--   • rafeeq_package_items  — one row per canonical product included in a
--                             package, with the SKU and the canonical row
--                             fingerprint AT GENERATION TIME.
--
-- PENDING NEW PRODUCT (derived, never stored) =
--   the product is currently exportable for Rafeeq
--   AND it is not contained in any package with sent_at IS NOT NULL.
--
-- STRICT SCOPE:
--   • purely ADDITIVE — two new tables + indexes/policies only;
--   • NO existing table/column is altered or dropped;
--   • NO data backfill here;
--   • sent state is set ONLY by the explicit owner action ("Mark as sent to
--     Rafeeq") — generation/download never writes sent_at;
--   • NOT auto-applied — this migration ships in the PR and awaits explicit
--     production approval.
-- ============================================================================

-- ── 1) packages ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rafeeq_packages (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  mode                 text NOT NULL,                  -- FULL | NEW
  output_filename      text NOT NULL DEFAULT '',       -- e.g. rafeeq-full-2026-08-24.zip
  manifest_fingerprint text,                           -- deterministic package fingerprint
  product_count        integer NOT NULL DEFAULT 0,
  image_count          integer NOT NULL DEFAULT 0,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  generated_by         text,                           -- actor email
  sent_at              timestamptz,                    -- NULL = Generated, not sent
  sent_by              text,                           -- owner email who confirmed the send
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rafeeq_packages_pkey PRIMARY KEY (id)
);

-- ── 2) package items (products captured at generation time) ──────────────────
CREATE TABLE IF NOT EXISTS public.rafeeq_package_items (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  package_id      uuid NOT NULL,
  product_id      uuid NOT NULL,                       -- internal canonical product
  sku             text NOT NULL DEFAULT '',
  row_fingerprint text,                                -- canonical row fingerprint at generation
  rafeeq_id_sent  text,                                -- the RAFEEQ ID column value in the file
                                                       -- (an existing id, or the "new product" marker)
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rafeeq_package_items_pkey PRIMARY KEY (id)
);

-- ── 3) CHECK constraints (guarded) ───────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rafeeq_packages_mode_check') THEN
    ALTER TABLE public.rafeeq_packages
      ADD CONSTRAINT rafeeq_packages_mode_check
      CHECK (mode = ANY (ARRAY['FULL','NEW']));
  END IF;
END $$;

-- ── 4) foreign keys (guarded on referenced tables existing) ───────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rafeeq_package_items_package_fkey') THEN
    ALTER TABLE public.rafeeq_package_items
      ADD CONSTRAINT rafeeq_package_items_package_fkey
      FOREIGN KEY (package_id) REFERENCES public.rafeeq_packages(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rafeeq_package_items_product_fkey') THEN
    ALTER TABLE public.rafeeq_package_items
      ADD CONSTRAINT rafeeq_package_items_product_fkey
      FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── 5) uniqueness + lookup indexes ────────────────────────────────────────────
--   One item per product per package (a package never lists a product twice).
CREATE UNIQUE INDEX IF NOT EXISTS rafeeq_package_items_uk
  ON public.rafeeq_package_items USING btree (package_id, product_id);

CREATE INDEX IF NOT EXISTS rafeeq_package_items_product_idx
  ON public.rafeeq_package_items USING btree (product_id);
CREATE INDEX IF NOT EXISTS rafeeq_packages_generated_idx
  ON public.rafeeq_packages USING btree (generated_at DESC);
--   The sent-baseline query ("products in any SENT package") filters on sent_at.
CREATE INDEX IF NOT EXISTS rafeeq_packages_sent_idx
  ON public.rafeeq_packages USING btree (sent_at) WHERE (sent_at IS NOT NULL);

-- ── 6) RLS + least-privilege policy (mirror external_channel_listings) ────────
ALTER TABLE public.rafeeq_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rafeeq_package_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rafeeq_packages' AND policyname='rafeeq_packages_select') THEN
    CREATE POLICY rafeeq_packages_select ON public.rafeeq_packages FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='rafeeq_package_items' AND policyname='rafeeq_package_items_select') THEN
    CREATE POLICY rafeeq_package_items_select ON public.rafeeq_package_items FOR SELECT TO authenticated USING (true);
  END IF;
  -- No INSERT/UPDATE/DELETE policy: writes (package recording, mark-as-sent) go
  -- through the service role behind the gated server boundary. Signed-in users
  -- get read-only.
END $$;

-- ── 7) self-documenting comments ──────────────────────────────────────────────
COMMENT ON TABLE public.rafeeq_packages IS
  'RAFEEQ.FULLSYNC.1 durable Rafeeq package history + explicit sent state. sent_at/sent_by are set ONLY by the owner action "Mark as sent to Rafeeq" — generating or downloading a package never sets them. The pending-NEW queue is DERIVED: exportable products not contained in any sent package.';
COMMENT ON TABLE public.rafeeq_package_items IS
  'One row per canonical product included in a Rafeeq package at generation time (SKU + canonical row fingerprint + the RAFEEQ ID value written to the file). Identity stays in external_channel_listings — this table never stores or resolves identity.';
COMMENT ON COLUMN public.rafeeq_packages.sent_at IS
  'NULL = Generated, not sent. Set only by the explicit owner "Mark as sent to Rafeeq" action; establishes the baseline that clears products from the pending-NEW queue.';

-- ============================================================================
-- NOT APPLIED AUTOMATICALLY. Rollout (awaiting approval):
--   A. apply this additive migration
--   B. deploy the RAFEEQ.FULLSYNC.1 feature (degrades gracefully while the
--      tables are absent — history shows UNAVAILABLE, nothing is fabricated)
--   C. owner generates the FULL catalog package and marks it sent to establish
--      the baseline; the pending-NEW queue derives from that point onward
-- ============================================================================
