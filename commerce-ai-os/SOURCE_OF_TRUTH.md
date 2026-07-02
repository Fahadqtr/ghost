# Source of Truth — Malak Commerce OS

> **⚠️ NEEDS VERIFICATION (2026-07-02): the project IDs below may be stale.**
> The connected Supabase account (`fahadshiping@gmail.com`) currently lists ONLY
> the project **`awlevukqqsaxvifrfteb`** (named "malikas-universe"), which this
> file labels as the *frozen v2*. It responds to the live `public` schema
> (`products`, `platform_status`, `channel_products`) and has RLS enabled on all
> tables — i.e. it behaves like production, contradicting the "frozen" label
> below. Meanwhile `vqstcmattiarhblqshvb` was not visible under that account.
> **Before any DB work, confirm the real production project from the deployed
> `NEXT_PUBLIC_SUPABASE_URL` (Vercel → project `ghost` → Environment Variables).**
> The `ref` in that URL is the canonical production project. Update this file once
> confirmed.

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
- Audit log: `malak_audit`. NOTE: its `product_id` column is bigint but products.id
  is uuid — known mismatch; until fixed, write the uuid into `details`.

## Frozen / DO NOT USE
- Supabase project **awlevukqqsaxvifrfteb** ("v2", SKU format `MK-SKIN-0001`,
  schema products(master_sku)+platform_products) is an abandoned v2 experiment.
  It is FROZEN. Do not connect the app, scripts, or the Supabase MCP connector to it.
  It has no representation in this repo.

## For any AI/automation session
1. Verify `.env.local` URL = `vqstcmattiarhblqshvb` before any DB work.
2. If using the Supabase MCP connector, it MUST be logged into fahadshiping@gmail.com
   (the production account). The other account holds only the frozen v2 DB.
3. SKU format is lowercase `mk` + digits (e.g. `mk942`), NOT `MK-SKIN-0001`.

_Last reconciled: 2026-06-19. 73 product prices synced to channel-agreed values._
