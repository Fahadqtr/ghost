-- ACC-02B batch 2 — remove direct `authenticated` write privileges from the five
-- tables that batch 1 deliberately held back.
--
-- WHY THEY WERE HELD BACK, AND WHAT CHANGED
-- Batch 1 excluded these because each still had a REAL direct
-- authenticated-client writer; revoking then would have broken working features.
-- The companion commit migrates every one of those writers to the service role,
-- behind the authorization gate that was already there (or, in one case, behind
-- the gate that should always have been there). Only after that is this safe:
--
--   products            setProductApproval, setProductsApproval, setProductStatus,
--                       deleteProduct, deleteProductById, enrichProduct,
--                       setPlatformApproval, and the shared create/update cores
--                       reached from V2 create / V2 import / V2 edit / wave2 /
--                       missing-product import
--   product_images      the V2 AI-create gallery row
--   channel_products    setChannelStatus, applyReconciledToShopify
--   platform_status     applyReconciledAvailability, setPureSeoulApproval,
--                       applyPureSeoulAvailability, setPlatformApproval
--   agent_logs          logAgentCommand
--
-- ONE GATE WAS RAISED, NOT JUST RE-CLIENTED
-- platforms.setPlatformApproval wrote products.approval and platform_status
-- behind an inline "is anybody signed in" check. Approval is named in the writer
-- boundary's own definition (lib/malak/authz.ts: "price/stock/approval/add/
-- image/sync"), and it was the last approval path still on a session check, so
-- it now takes requireMalakWriter() like every sibling.
--
-- ONE WRITER KEPT ITS GATE ON PURPOSE
-- agents.logAgentCommand records a command typed on an owner-facing admin page.
-- The row is bookkeeping for an action the caller was already permitted to take,
-- so only the CLIENT moved; who may call it is unchanged. Whether that gate
-- should be tightened is an owner decision, not a side effect of this migration.
--
-- AN INVARIANT WAS DELIBERATELY INVERTED
-- Five existing tests required product metadata to be written with the SESSION
-- client "so RLS applies". The policy they relied on was
--   FOR ALL TO authenticated USING (true) WITH CHECK (true)
-- which constrained nothing at all; the per-action writer gate was always the
-- real boundary. Those tests now pin the admin client instead.
--
-- WHAT THIS DOES
--   authenticated -> SELECT only. INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
--                    TRIGGER revoked, and each permissive ALL policy replaced
--                    with a SELECT-only policy so a future re-grant cannot
--                    silently restore write access.
--   anon          -> UNTOUCHED (ACC-05's subject).
--   service_role  -> UNTOUCHED.
--
-- SELECT is retained for `authenticated` on all five: the app reads these tables
-- constantly (catalog lists, media, channel and platform views).
--
-- SCOPE: the five tables below ONLY. No schema, column, index, constraint or
-- trigger change; no row touched; no anon grant; no auth setting; no function.
--
-- Down migration: 20260915100001_acc02b_batch2_authenticated_readonly_down.sql

-- ── products ────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.products from authenticated;
drop policy if exists "authenticated_all_products" on public.products;
drop policy if exists "products_authenticated_all" on public.products;
create policy "products_select_authenticated"
  on public.products for select to authenticated using (true);

-- ── product_images ──────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.product_images from authenticated;
drop policy if exists "authenticated_all_product_images" on public.product_images;
create policy "product_images_select_authenticated"
  on public.product_images for select to authenticated using (true);

-- ── channel_products ────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.channel_products from authenticated;
drop policy if exists "authenticated_all_channel_products" on public.channel_products;
create policy "channel_products_select_authenticated"
  on public.channel_products for select to authenticated using (true);

-- ── platform_status ─────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.platform_status from authenticated;
drop policy if exists "platform_status_all" on public.platform_status;
create policy "platform_status_select_authenticated"
  on public.platform_status for select to authenticated using (true);

-- ── agent_logs ──────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate, references, trigger
  on public.agent_logs from authenticated;
drop policy if exists "authenticated_all_agent_logs" on public.agent_logs;
create policy "agent_logs_select_authenticated"
  on public.agent_logs for select to authenticated using (true);
