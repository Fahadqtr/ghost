# Commerce AI OS — Phase 1 Milestone Tracker

> **Historical record.** This tracks the original Phase-1 MVP (M0–M6). The project
> has since grown well beyond it — see `PROJECT_OVERVIEW_AR.md` and `../UPDATES.md`
> for the current state.

Build order: **M0 → M1 → (M2 skipped, schema already done) → M3 → M4 → M5 → M6**

Scope guardrail: Phase 1 = UI + schema + placeholders ONLY. No real commerce APIs,
no agent AI logic, no paid services.

| Milestone | Description | Status |
|-----------|-------------|--------|
| M0 | Setup — toolchain, subfolder, env template | ✅ Done |
| M1 | Scaffold & clean architecture (Next.js + Tailwind) | ✅ Done |
| M2 | Schema (15 tables, seeds) | ⏭️ **Skipped — already created & seeded in Supabase** |
| M3 | Auth + CEO Dashboard | ✅ Done |
| M4 | Core pages (Product Hub, Inventory, Channels, Agents) | ✅ Done |
| M5 | Import / Export placeholders | ✅ Done |
| M6 | Seed sample data + final QA + README | ✅ Done |

---

## M0 — Setup (Done)

- [x] Supabase project — already created by owner (schema + seeds done outside this build)
- [x] Repo — building inside `fahadqtr/ghost` under `commerce-ai-os/` (Ghost Framework files untouched)
- [x] Node LTS + pnpm confirmed — Node v22.22.2, pnpm 10.33.0
- [x] `.env.local.example` template added; `.env.local` created locally and git-ignored

### Owner action needed before M3 can be verified live
The app needs the existing Supabase project's credentials to connect:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Paste them into `commerce-ai-os/.env.local` (never committed). Until then the app
scaffolds and runs with empty-state UI but cannot read/write real data.

> Keys received and wired into `.env.local` on 2026-06-05.

---

## M1 — Scaffold & clean architecture (Done)

- [x] Next.js 14 (App Router) + TypeScript + Tailwind v3
- [x] Folder structure: `/app`, `/components`, `/lib` (constants, types, supabase client+server), `/agents` (stubs), `/docs`
- [x] Base layout: persistent sidebar + topbar shell via `app/(app)/layout.tsx`
- [x] Supabase helpers: `lib/supabase/client.ts` (browser) + `lib/supabase/server.ts` (server, cookie-bound)
- [x] Locked constants: 11 categories, channel statuses, 13 agents, nav items
- [x] Hand-written DB types mirroring the existing 15-table schema (`lib/types.ts`)
- [x] Placeholder pages for every nav route (replaced in later milestones)
- [x] **Verify:** `pnpm install` + `pnpm build` succeed; server runs; `/` → `/dashboard` (307); sidebar renders

### Folder structure
```
commerce-ai-os/
├─ app/
│  ├─ layout.tsx              # root (html/body)
│  ├─ page.tsx                # redirect → /dashboard
│  ├─ globals.css             # Tailwind + UI primitives
│  └─ (app)/                  # authenticated shell (sidebar+topbar)
│     ├─ layout.tsx
│     ├─ dashboard/page.tsx
│     ├─ products/page.tsx
│     ├─ inventory/page.tsx
│     ├─ channels/page.tsx
│     ├─ agents/page.tsx
│     └─ import-export/page.tsx
├─ components/                # Sidebar, Topbar, MilestonePlaceholder
├─ lib/
│  ├─ constants.ts            # categories, channels, agents, nav
│  ├─ types.ts                # DB row types (mirror schema)
│  └─ supabase/               # client.ts, server.ts
├─ agents/                    # Phase-2 stubs (no logic)
└─ docs/                      # MILESTONES.md, README (M6)
```

---

## M3 — Auth + CEO Dashboard (Done)

Sign-in only (no public sign-up, per owner decision). Accounts are created in the
Supabase dashboard.

- [x] Supabase email/password login page at `/login` (route group `(auth)`, no shell)
- [x] Middleware (`middleware.ts` + `lib/supabase/middleware.ts`): refreshes session and
      redirects unauthenticated users to `/login`; logged-in users away from `/login`
- [x] Belt-and-suspenders guard in `app/(app)/layout.tsx` (also feeds user email to Topbar)
- [x] Working **Sign out** in the Topbar (server action `app/(app)/actions.ts`)
- [x] CEO Dashboard with 6 KPI cards: Sales Today, Orders Today, Low Stock,
      Missing Images, Products, Alerts + Top Products and Alerts detail panels
- [x] Defensive data layer (`lib/dashboard.ts`): every query degrades to a clean
      "No data yet" empty-state on missing table/column/permission

### Verification (live against Supabase)
- [x] REST endpoint reachable (HTTP 200); Auth endpoint reachable (400 on bad creds)
- [x] RLS confirmed: anon reads return empty — data is only visible to an
      authenticated session (the in-app server client runs as the logged-in user)
- [x] `/dashboard` and `/products` redirect to `/login` when logged out (307)
- [x] `/login` renders the sign-in form
- [x] `pnpm build` passes

### Owner action to fully exercise login
Create a user in **Supabase → Authentication → Users → Add user** (email + password),
then sign in at `/login`. The dashboard KPIs will then read live data through RLS.

> Note: a benign build warning ("A Node.js API is used (process.version) … not
> supported in the Edge Runtime") comes from `@supabase/supabase-js` inside the
> Edge middleware. It does not affect functionality and is expected with
> `@supabase/ssr`.

---

## M4 — Core pages (Done)

Schema introspected live before building (PostgREST column probing). 8/9 tables
matched the plan exactly; `agent_logs` real columns are `id, agent_name, command,
result, created_at` (types updated to match).

**Product Hub** (`/products`)
- [x] Searchable/filterable product table (by name/SKU + category), variant count column
- [x] Add (`/products/new`) and Edit (`/products/[id]`) forms with all 28 master-sheet fields
- [x] Category dropdown locked to the 11 categories (also enforced server-side in the action)
- [x] Parent–child variant sub-form (add/remove rows)
- [x] Create seeds an `inventory` row → product shows up on Inventory immediately
- [x] Delete cleans up variants, channel_products, inventory

**Inventory** (`/inventory`)
- [x] Stock table with search, **low-stock filter**, sold-quantity column, Low/OK badge
- [x] Inline edit of stock_quantity + low_stock_threshold (server action `updateInventory`)

**Channels** (`/channels`)
- [x] Product × channel matrix; each cell an independent Active/Draft/Not Listed toggle
- [x] Talabat column flagged "(no variants)" from `channels.supports_variants`
- [x] Toggle upserts `channel_products` (server action `setChannelStatus`)

**Agents** (`/agents`)
- [x] 13 agent cards (Product, Image, Inventory, Channel Sync, Variant Splitter,
      Snoonu, Talabat, Rafeeq, Shopify, Marketing, Customer Service, Finance, CEO)
- [x] Command panel writes a row to `agent_logs` — **no AI, no external API**
- [x] Recent commands table

### Verification
- [x] `pnpm build` passes; all routes dynamic
- [x] All core routes protected (307 → /login when logged out)
- [ ] **Live CRUD** (create product w/ variant → appears in Inventory & Channels):
      requires a signed-in user. Build is complete and written against the verified
      schema; owner needs to log in (or share a confirmed test user) to exercise it.

---

## M5 — Import / Export placeholders (Done)

Added one local dependency: `xlsx` (SheetJS) — runs in the browser, no external API.

**Upload Excel** _(Phase-1 importer — retired in the Catalog Migration; see "Catalog Migration" below)_
- [x] Parses `.xlsx`/`.csv` in-browser; maps headers → the 28 master-sheet columns (alias-aware)
- [x] Preview table + lists ignored/unmapped columns
- [x] Commit behind a confirm → server action inserts products + seeds inventory
- [x] Category not in the 11 is **flagged & skipped** (never force-fit); unknown brand left blank
- [x] **Superseded** by the V2 importer at `/v2/catalog/import` (UX.4E-9B); the Phase-1 component and its import action were deleted.

**Upload Images** (`ImageUpload.tsx`)
- [x] Uploads to Supabase Storage bucket `product-images`; optional link to a product
- [x] Inserts `product_images` row (sets `is_primary` when it's the product's first image)
- [x] Clear error if the bucket is missing

**Export** (`ExportButtons.tsx`)
- [x] Per-channel placeholder CSVs generated client-side and downloaded locally:
      Shopify CSV, Snoonu masterlist, **Talabat split-CSV** (one row per variant), Rafeeq CSV
- [x] Every file carries a "PHASE 1 PLACEHOLDER" banner; nothing is sent anywhere

### Verification
- [x] `pnpm build` passes; `/import-export` protected (307 → /login)

### Owner action for image upload
Create a **public** Storage bucket named `product-images` in Supabase
(Storage → New bucket), and allow authenticated uploads. Until then, image upload
shows a clear "bucket missing" message (import/export of products still works).

---

## M6 — Seed data + final QA + README (Done)

Per owner decision, sample data is delivered as a **SQL file you run yourself**
(option b) — nothing was written to the DB from this build.

**Sample data** (`supabase/seed_sample_data.sql`)
- [x] 8 products across both brands (Malika's Universe + Pure Seoul)
- [x] One product with **3 variants**: Rhode Peptide Lip Tint → Toast / Ribbon / Raspberry Jelly
- [x] Demo coverage: 1 low-stock row, 2 missing-image rows, varied sold-qty (Top Products)
- [x] Brand resolved by name pattern (no UUIDs needed); categories all within the 11
- [x] **All clearly marked test data**: SKU prefix `TEST-` + `notes = 'TEST/SAMPLE — delete before real data'`
- [x] One-shot cleanup: `supabase/delete_sample_data.sql` (`DELETE FROM products WHERE sku LIKE 'TEST-%'` + children)

**Docs**
- [x] `docs/README.md` — stack, run steps, env, structure, auth, data model, seed/teardown, scope

### Verification gate (Section 6)
- [x] App builds clean from a fresh `pnpm install` (`pnpm build` ✓, 12/12 pages)
- [x] Login required on every app route (all 307 → /login; `/login` is 200)
- [~] Create / edit / delete a product — code complete & schema-verified; **exercise after login** (owner)
- [~] Product with variants stores parent–child rows — built; seed file demonstrates it; exercise after login
- [x] Category cannot be set outside the 11 — dropdown + server-side action check + import skip-and-flag
- [x] Channels matrix reflects per-channel status independently (per-cell upsert)
- [x] **No real external API anywhere** — codebase scan: zero `fetch`/axios/marketplace/AI network calls
- [x] Code commented; folder structure documented (README + this file)

[~] = implemented and verified to build/route; final click-through needs a signed-in user.

### Outstanding owner actions (to exercise live, all optional)
1. Create a user in Supabase Auth and sign in at `/login`.
2. (Optional) Run `supabase/seed_sample_data.sql` for demo data.
3. (Optional) Create a public `product-images` Storage bucket for the image uploader.

---

## Phase 1 status: COMPLETE
All milestones M0–M6 done (M2 was pre-done in Supabase). Phase 2 (loading the
cleaned master sheet, real channel exports, agent AI) does not begin until the
product database is confirmed clean.

---

## Catalog Migration (UX.4E): COMPLETE
The product catalog runtime has fully migrated to V2. There is now exactly one
runtime path for each concern, and the Phase-1 originals were deleted:

- **Create** → `/v2/catalog/new` (AI Product Creator).
- **Edit** → `/v2/catalog/[id]/edit` (Product Editor).
- **Import** → `/v2/catalog/import`.
- **Variant editing** → the shared Variant Studio, used by both Create and Edit.

Legacy retired (deleted, with permanent redirects preserved for old URLs):
- the legacy product form and its create/edit server actions (UX.4E-9A/9C);
- the legacy Excel importer and its import server action (UX.4E-9B).

`/products/new` and `/products/[id]/edit` still redirect into their precise V2
replacements (product id/context preserved). Source guards keep the legacy
files absent.
