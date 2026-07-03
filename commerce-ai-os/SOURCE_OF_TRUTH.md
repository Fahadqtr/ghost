# Source of Truth — Malak Commerce OS

> **✅ CONFIRMED (2026-07-02).** Production is **`vqstcmattiarhblqshvb`** —
> verified from Vercel's deployed `NEXT_PUBLIC_SUPABASE_URL`
> (`https://vqstcmattiarhblqshvb.supabase.co`, Production + Preview). This file
> was correct; the IDs below stand.
>
> **⚠️ Supabase MCP caveat:** the MCP connector is currently logged into an
> account/org that lists ONLY the **frozen v2** `awlevukqqsaxvifrfteb`, and CANNOT
> see production `vqstcmattiarhblqshvb`. A "Supabase security check" run on
> 2026-07-02 therefore hit the frozen v2 by mistake — **production RLS/advisors
> were NOT verified via MCP.** To audit production, either reconnect the MCP to
> the account that owns `vqstcmattiarhblqshvb`, or run the checks in that
> project's own SQL editor. (Note: `.env.local` here on disk is only placeholder
> build values — the real production URL lives in Vercel + the owner's machine.)
>
> **✅ Production RLS verified directly (2026-07-02).** In the `vqstcmattiarhblqshvb`
> SQL editor, `select tablename from pg_tables where schemaname='public' and
> rowsecurity=false` returned **no rows** — every production `public` table has RLS
> enabled, so the public anon key cannot reach them. Fingerprint confirmed it was
> production: 1142 products, SKU format `mk####` (e.g. `mk1000`). Supabase
> `get_advisors` on production is still pending (MCP can't see this project).

## Canonical database (THE ONLY ONE)
- Supabase project: **vqstcmattiarhblqshvb**  (production, live store)
- Supabase account that owns it: **fahadshiping@gmail.com**
- Connection: set ONLY via `commerce-ai-os/.env.local` → `NEXT_PUBLIC_SUPABASE_URL`
- Vercel env `NEXT_PUBLIC_SUPABASE_URL` must equal this project.

## Canonical schema (old/production schema)
- `products`: id (uuid), sku (e.g. `mk942`), barcode, name_en, name_ar, brand_id,
  main_category, sub_category, price, discount_price, cost, stock_quantity,
  stock_status, platform_status, image_url, snoonu_id, approval (text:
  Approved/Rejected/null), rafeeq_product_id, ...
- Per-platform prices live in `channel_products` (channel_id, product_id,
  channel_price, channel_status), linked by `product_id`.
- Audit log: `malak_audit`. Its `product_id` was a legacy bigint (from the old
  `audit_log` table) while products.id is uuid. ✅ **FIXED (2026-07-02):**
  `supabase/malak_audit_product_id_uuid.sql` was run in production — the column
  is now uuid (old values kept as `product_id_legacy`), 48 rows backfilled from
  `details->>'productId'`, 539 total rows at migration time. App code
  (`lib/audit.ts`) writes `product_id` directly (its legacy fallback remains
  harmless).

## Frozen / DO NOT USE
- Supabase project **awlevukqqsaxvifrfteb** ("v2", SKU format `MK-SKIN-0001`,
  schema products(master_sku)+platform_products) is an abandoned v2 experiment.
  It is FROZEN. Do not connect the app, scripts, or the Supabase MCP connector to it.
  It has no representation in this repo.

## Operational infrastructure (as of 2026-07-03)
- **CI (`.github/workflows/ci.yml`):** jobs `typecheck` / `test` / `build` /
  `lint` / `audit` on every PR. The `protect-master` ruleset REQUIRES
  typecheck, test, build, and lint (audit is advisory). Names must match the
  job names exactly — a required check that never reports blocks ALL merges.
- **Lint:** ESLint 9 flat config (`eslint.config.mjs`), gated by
  `pnpm lint` = `eslint . --max-warnings 74` — the warning ratchet only goes
  down; new warnings fail the required check.
- **Tests:** `pnpm test` (Node runner, `--conditions=react-server`). Pattern:
  pure logic lives in `*-compute.ts` modules with NO `@/` or server-only
  imports (so the runner can load them); DB wrappers stay thin.
- **Scheduled availability sync:** `vercel.json` cron → GET
  `/api/cron/availability-sync` daily 03:00 UTC, auth =
  `Authorization: Bearer $CRON_SECRET` (set in Vercel ✅). The path must stay in
  `PUBLIC_PATHS` (`lib/supabase/middleware.ts`) or the proxy 307s it to /login.
- **Staff PIN rate limiter:** env-gated via `UPSTASH_REDIS_REST_URL/TOKEN`
  (inactive until set; fail-open), defaults 10 attempts / 5 min per IP.
- **Dependabot:** weekly npm + github-actions PRs land on Mondays.

## For any AI/automation session
1. Verify `.env.local` URL = `vqstcmattiarhblqshvb` before any DB work.
2. If using the Supabase MCP connector, it MUST be logged into fahadshiping@gmail.com
   (the production account). The other account holds only the frozen v2 DB.
3. SKU format is lowercase `mk` + digits (e.g. `mk942`), NOT `MK-SKIN-0001`.
4. Read `UPDATES.md` for the per-session change log (newest first).

_Last reconciled: 2026-07-03 (infrastructure); 2026-06-19 for prices (73 product
prices synced to channel-agreed values)._
