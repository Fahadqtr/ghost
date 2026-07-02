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
