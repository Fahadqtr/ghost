# Commerce AI OS

A dashboard for **Malika's Universe Trading** to manage its catalog across
multiple channels (Snoonu · Talabat · Shopify · Rafeeq · Pure Seoul) from one
place, backed by Supabase, with an AI store manager (**Malak**).

> **⚠️ Historical note:** this file described the original *Phase 1* MVP (UI +
> schema + placeholders, no AI, no real exports). The project has since grown far
> beyond that — Malak AI, real per-channel exports, staff app, compliance gate,
> etc. For the **current** picture see **`docs/PROJECT_OVERVIEW_AR.md`** (full
> narrative) and **`UPDATES.md`** (latest changes). The setup/auth/data-model
> notes below are still accurate.

Location: `ghost/commerce-ai-os/` (the `package.json` is in this folder).

---

## Tech stack
- **Next.js 16** (App Router) + **React 19** + **TypeScript 6**
- **Tailwind CSS 4** (CSS-first config)
- **Supabase** (Postgres + Auth + Storage) via `@supabase/ssr`
- **Anthropic Claude** (Opus 4.8) — the Malak assistant brain
- **ElevenLabs** (TTS) · **Three.js** (procedural 3D lab)
- **xlsx** (SheetJS) for in-browser Excel parsing

## Run it locally
```bash
cd commerce-ai-os
cp .env.local.example .env.local     # paste your Supabase URL + anon key
pnpm install
pnpm dev                             # http://localhost:3000
```
`pnpm build` for a production build, `pnpm start` to serve it.

### Environment (`.env.local`, never commit)
| var | where to find it |
|-----|------------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon/public key |

## Project structure
```
commerce-ai-os/
├─ app/
│  ├─ layout.tsx              # root (html/body)
│  ├─ page.tsx                # redirect → /dashboard
│  ├─ globals.css             # Tailwind + shared UI primitives
│  ├─ (auth)/login/           # sign-in page (outside the shell)
│  └─ (app)/                  # authenticated shell (sidebar + topbar)
│     ├─ layout.tsx           # auth guard + shell
│     ├─ actions.ts           # signOut
│     ├─ dashboard/           # CEO KPIs
│     ├─ products/            # Product Hub (list, new, [id] edit) + actions
│     ├─ inventory/           # stock table + actions
│     ├─ channels/            # product × channel matrix + actions
│     ├─ agents/              # 13 agent cards + command panel + actions
│     └─ import-export/       # Excel import, image upload, exports + actions
├─ components/                # Sidebar, Topbar, forms, tables, panels
├─ lib/
│  ├─ constants.ts            # 11 categories, channels, 13 agents, nav
│  ├─ types.ts                # row types mirroring the live schema
│  ├─ dashboard.ts            # defensive KPI data layer
│  └─ supabase/               # client.ts, server.ts, middleware.ts
├─ agents/                    # Phase-2 stubs (no logic)
├─ supabase/                  # seed_sample_data.sql, delete_sample_data.sql
├─ docs/                      # README.md, MILESTONES.md
└─ middleware.ts              # session refresh + route protection
```

## Auth (sign-in only)
There is no public sign-up. Create users in **Supabase → Authentication → Users →
Add user** (email + password), then sign in at `/login`. All `(app)` routes are
protected by `middleware.ts`; unauthenticated requests redirect to `/login`.

## Data model
The app connects to the **existing** Supabase schema (15 tables) — it does not
create or modify it. `products` mirrors the 28-column master sheet; categories are
locked to the 11; `product_variants.parent_product_id` holds the parent–child link
that drives the Talabat splitter in a later phase. RLS restricts reads/writes to
authenticated users, so all data access happens through a signed-in session.

## Sample data (test only)
Load demo rows to click around — all clearly marked test data:
1. Run `supabase/seed_sample_data.sql` in the Supabase SQL Editor
   (8 products across both brands, incl. **Rhode Peptide Lip Tint** with 3 variants;
   one low-stock and two missing-image rows to exercise the dashboard).
2. Remove it all later with `supabase/delete_sample_data.sql`
   (or `DELETE FROM products WHERE sku LIKE 'TEST-%';` + child cleanups).

Every sample SKU starts with `TEST-` and every `notes` says
`TEST/SAMPLE — delete before real data`.

## Image upload (optional)
To use the image uploader, create a **public** Storage bucket named
`product-images` in Supabase (Storage → New bucket) and allow authenticated
uploads. Without it, the rest of the app works; the uploader shows a clear
"bucket missing" message.

## Built since Phase 1 (not in this file's original scope)
Malak AI (Claude Opus 4.8, voice via ElevenLabs, 3D lab), real per-channel export
builders (Shopify/Snoonu/Talabat/Rafeeq), Pure Seoul + Snoonu sync, a staff PWA
(PIN login, stock in/out, add-product-from-photo, tasks), per-employee
permissions, a compliance publish-gate, notifications, and a loop-state agent
layer. Still NOT here: live marketplace-API pushes for every channel (exports are
still file-based for most), payments/order ingestion, WhatsApp/Telegram.

See `docs/MILESTONES.md` for the original M0–M6 Phase-1 build log, and
`docs/PROJECT_OVERVIEW_AR.md` + `UPDATES.md` for everything after.
