# PROJECT_FULL_CONTEXT.md — Malikas AI / Commerce AI OS

> **Handover document for a new developer.** Read-only audit; no code, data, migrations, or deployments were changed to produce this. Every claim is backed by an exact file path (and, where useful, a line number). Paths are relative to `commerce-ai-os/` unless prefixed with `/home/user/ghost/`.
>
> - **Repository:** `Fahadqtr/ghost` · **App location:** `/home/user/ghost/commerce-ai-os/`
> - **Audit date:** 2026-07-25 · **Branch audited:** `claude/new-session-nsf53g` @ `458e41a`
> - **Production DB (confirmed):** Supabase project `vqstcmattiarhblqshvb` (see `SOURCE_OF_TRUTH.md`)
> - **Live host:** `app.malikasuniverse.com` (Vercel project `ghost`)

---

## ⚠️ Read this first — three unrelated projects share one repo

The Git repository root `/home/user/ghost/` is **NOT** the app. It contains **three independent projects**:

| Project | Location | What it is | Backing Supabase |
|---|---|---|---|
| **Ghost Framework** | repo root (`ghost`, `core/`, `bin/`, `data/`, `banner/`, `install.sh`) | An unrelated **Android post-exploitation framework** (Python) by `entynetproject`. Evidence: root `README.md` lines 30-36, `ghost` = `#!/usr/bin/env python3`. Ignore it entirely. | none |
| **Malikas AI / Commerce AI OS** | **`commerce-ai-os/`** | **THE PROJECT this document describes** — a Next.js 16 commerce OS for Malika's Universe Trading (Qatar K-beauty). | `vqstcmattiarhblqshvb` |
| **shift-app** | `shift-app/` + root `supabase/migrations/` + root `scripts/` | A separate static Arabic employee shift/leave-scheduling PWA, deployed to GitHub Pages. | `fibkwudabuwfjqpyeeng` |

A fourth Supabase project, **`awlevukqqsaxvifrfteb` ("v2")**, is a **FROZEN, abandoned experiment — never connect anything to it** (`SOURCE_OF_TRUTH.md` lines 43-49).

---

# 1. Executive Summary

**Malikas AI ("Malak") / Commerce AI OS** is an internal, single-tenant operations dashboard for **Malika's Universe Trading**, a Qatar-based beauty / K-beauty retailer. It manages one product catalog across five sales channels (**Snoonu · Talabat · Shopify · Rafeeq · Pure Seoul**) from one place, backed by Supabase, and layers an Arabic-speaking AI store manager (**"ملاك" / Malak**) on top. `package.json` still self-describes as "Phase 1 local-first MVP dashboard," but the project has grown far past that (`docs/README.md`).

**Primary goal:** let the owner run the whole store — catalog, inventory, pricing, multi-channel publishing prep, staff, loyalty, social content, and customer DMs — from a single Arabic-first, mobile-first PWA, with Malak (Claude Opus 4.8) automating and narrating the work.

**What exists today (working in production):**
- **Catalog & inventory:** products, variants, shared-inventory pool, stocktake, shelves/labels, out-of-stock flows, movements ledger, reports (margins, dead stock, shrinkage).
- **Malak AI assistant** (flagship): Claude tool-loop that reads the catalog/sales and proposes writes; every mutation is HMAC-signed and executed only after human confirmation, then audited.
- **Multi-channel sync/diff:** Shopify (live Admin API + OAuth + order deduction), Snoonu, Talabat (+ order webhook), Rafeeq (export), Pure Seoul.
- **Loyalty ("Beauty Rewards"):** public QR customer flow, prizes, vouchers, WhatsApp.
- **Staff PWA:** PIN login, stock in/out, add-product-from-photo, tasks, sandboxed Malak-lite, per-employee permissions.
- **Tasks + Google Calendar** (one-way push), routines, ICS feed.
- **Social:** real Instagram publishing (posts/reels/stories), scheduling+approval, insights, DM auto-reply bot.
- **AI media:** product-image generation/edit (OpenAI/Gemini), product video (FLORA/Higgsfield), reel composition (Creatomate), Arabic TTS (ElevenLabs).

**Partial / placeholder:**
- **Studio** module pages: only `video`, `voice`, `settings` are live; `reel` partial; 10 others are inert `ModuleScaffold` placeholders (`lib/studio/modules.ts`).
- **`/agents`** page: all agents are Phase-1 stubs that throw (`agents/index.ts`).
- **TikTok** publishing: not wired into the cron; blocked pending TikTok app audit.
- **Professional reels:** AI writes the script, but video is produced externally (Higgsfield Marketing Studio) and pasted back.
- **Dashboard inventory KPIs** show a hard-coded 50-unit placeholder per product until a stocktake runs (`lib/dashboard.ts`).

**Stopped / not started:** live marketplace-API *push* for every channel (most exports remain file-based), payments/order ingestion beyond Shopify+Talabat, WhatsApp/Telegram inbound.

**Latest development stage:** active feature+hardening cadence — each request ships as a PR merged on green CI → Vercel auto-deploys. The most recent merged work (this session): Tasks multi-select bulk approve/reject and a fix to the inventory "الكل نفذ" bulk switch (PR #455, `458e41a`). Preceding milestones: Next 15→16 / Tailwind 3→4 / TS 5→6 upgrades, Shopify Phases 1-4, loyalty rewards, catalog auto-tasks, DM bot. See `UPDATES.md` (Arabic changelog, newest first) and `docs/PROJECT_OVERVIEW_AR.md`.

---

# 2. Technology Stack

Source: `package.json`, `pnpm-lock.yaml`, config files, and `import`/`process.env` scans.

**Runtime & framework**
- **Next.js `16.2.10`** (pinned) — App Router, React Server Components. Next 16 renamed root `middleware.ts` → **`proxy.ts`**.
- **React / React-DOM `^19.2.7`**.
- **TypeScript `^6.0.3`** (`strict`, `moduleResolution: "bundler"`, path alias `@/* → ./*`; `tsconfig.json`). `css.d.ts` added for TS 6's stricter CSS-import typing.
- **Tailwind CSS `^4.3.2`** — **CSS-first** config (no `tailwind.config.js`); `@tailwindcss/postcss` in `postcss.config.mjs`; theme in `app/globals.css` `@theme`.
- **Node 22** (CI), **pnpm 10** (CI). Package manager = **pnpm** (`pnpm-lock.yaml`).

**Production dependencies** (`package.json` 20-33)
| Library | Version | Purpose |
|---|---|---|
| `@anthropic-ai/sdk` | ^0.107.0 | Claude — Malak brain, compliance, DM, social copy |
| `@supabase/ssr` | ^0.12.0 | Supabase auth/cookies for SSR |
| `@supabase/supabase-js` | ^2.110.0 | Supabase client |
| `@react-three/fiber` | ^9.6.1 | React renderer for Three.js (Malak 3D orb) |
| `three` | ^0.169.0 | 3D orb / procedural lab |
| `jsbarcode` | ^3.12.3 | Barcode label generation |
| `qrcode` | ^1.5.4 | Loyalty/rewards QR codes |
| `web-push` | ^3.6.7 | Web Push (VAPID) notifications |
| `xlsx` | SheetJS CDN tarball `xlsx-0.20.3` | Excel parse/export (intentionally NOT the npm package; Dependabot ignores it) |
| `next` / `react` / `react-dom` | as above | — |

**Dev dependencies:** `eslint ^9.39.4` (+ `eslint-config-next 16.2.10` pinned, `@eslint/eslintrc`), `@tailwindcss/postcss ^4.3.2`, `tailwindcss ^4.3.2`, `postcss ^8.5.16`, `typescript ^6.0.3`, `@types/*` (node ^22, react ^19, three, qrcode, web-push), `server-only ^0.0.1`.

**pnpm security overrides** (`package.json` 13-19): `postcss@<8.5.10 → >=8.5.10`, `brace-expansion@<1.1.16 → >=1.1.16 <2` (the `<2` cap is critical — an unbounded bump broke minimatch/eslint), `sharp@<0.35.0 → >=0.35.0`.

**External services (SDK-less, via `fetch`):** Anthropic, OpenAI Images, Google Gemini, ElevenLabs, Meta/Instagram Graph, Shopify Admin, FLORA, Higgsfield, Creatomate, TikTok, Hyperbeam, Browserbase, Browserless, Brave/Tavily search, Upstash Redis, Google Calendar (service-account JWT). Full map in §17.

**Config files:** `next.config.mjs` (`serverActions.bodySizeLimit: "16mb"`; image `remotePatterns` limited to `*.supabase.co/storage/...`; `no-store` cache header on `/malak`), `eslint.config.mjs` (flat config; `no-explicit-any` **off**, hook rules → warnings), `vercel.json` (crons only), `proxy.ts`, `css.d.ts`, `next-env.d.ts`.

---

# 3. Repository Structure

```
/home/user/ghost/
├─ commerce-ai-os/                 ← THE PROJECT (Malikas AI)
│  ├─ app/                         Next.js App Router
│  │  ├─ layout.tsx                Root layout (RTL <html>, PWA manifest, locale)
│  │  ├─ page.tsx                  "/" → redirect("/dashboard")
│  │  ├─ globals.css               Tailwind v4 entry + @theme tokens + @utility primitives
│  │  ├─ (auth)/login/             Owner sign-in (Supabase auth)
│  │  ├─ (app)/                    AUTHENTICATED admin app (see §4)
│  │  ├─ staff/                    Public staff PWA (PIN session, no Supabase account)
│  │  ├─ rewards/                  Public customer Beauty-Rewards (QR)
│  │  └─ api/                      27 route handlers (malak/*, cron/*, webhooks/*, shopify/*, social/*, rewards/*, loyalty/*, push/*, export/*, products/*, calendar/*)
│  ├─ components/                  70 client/UI components (AppShell, Sidebar, Topbar, BottomNav, forms, tables, panels, components/studio/*)
│  ├─ lib/                         205 .ts business-logic files (see subdirs below)
│  ├─ agents/index.ts             Malak agent roster — Phase-1 STUBS that throw
│  ├─ supabase/                    56 ad-hoc .sql files (applied by hand; NO base schema)
│  ├─ scripts/                     16 one-off .mjs/.ts data/test scripts (use prod service-role key)
│  ├─ docs/                        README.md, PROJECT_OVERVIEW_AR.md, MILESTONES.md, MALAK_CONSTITUTION.md, LOYALTY_REWARDS.md
│  ├─ public/                      sw.js, PWA icons, fonts, brand assets, staff.webmanifest
│  ├─ SOURCE_OF_TRUTH.md           ← canonical DB & infra facts (READ THIS)
│  ├─ UPDATES.md                   Arabic per-session changelog (newest first)
│  └─ package.json, tsconfig.json, next.config.mjs, postcss.config.mjs,
│     eslint.config.mjs, vercel.json, proxy.ts, css.d.ts
├─ shift-app/                      Separate static Arabic shift-scheduler PWA
├─ supabase/migrations/            shift-app's VERSIONED migrations (project fibkwudabuwfjqpyeeng)
├─ scripts/                        shift-app auth-repair scripts (npm, not pnpm)
├─ ghost, core/, bin/, data/, banner/, install.sh   ← unrelated Ghost Android framework
└─ MALAK_AUDIT.md, MALAK_BUILD_LOG.md, MALAK_PHASE3_REVIEW.md, *-spec.md
```

**`lib/` subdirectories:** `auth/` (requireUser), `compliance/` (deterministic rule engine + publish gate), `crm/`, `dm/` (Instagram/WhatsApp inbox + AI responder), `integrations/` (Google Calendar), `inventory/` (analytics, lowStock, movements, sales, shrinkage — each split `*.ts` wrapper + `*-compute.ts` pure + `.test.ts`), `loop/` (agent loop-state layer), `loyalty/`, `malak/` (authz, browser, confirm HMAC, intent, live, search, ratelimit, youtube), `net/` (safeImage SSRF guard), `products/` (draft, enrich, copy-text, image-apply, imageStore, imageEdit, price), `shopify/`, `social/` (ad/reel/story compose, higgsfield, instagram, tiktok, voiceover, scene-gemini), `staff/` (pin, session, permissions, stats), `studio/`, `supabase/` (**client / server / admin / middleware / paginate**), `talabat/`, `tasks/` (calendarSync, routines, comments, ics, weekly-report, stock-tasks), `video/` (providers, provider-router, routing, flora, shot-plan, templates), `voice/`.

**Entry points:**
- Root layout → `app/layout.tsx`; app shell → `app/(app)/layout.tsx` → `components/AppShell.tsx`.
- Middleware → `proxy.ts` → `lib/supabase/middleware.ts` (`updateSession`).
- Supabase clients → `lib/supabase/{client,server,admin,middleware}.ts`.
- Landing → `app/page.tsx` → `/dashboard`.

**Key docs:** `SOURCE_OF_TRUTH.md` (canonical DB/infra), `UPDATES.md` (changelog), `docs/PROJECT_OVERVIEW_AR.md` (full narrative), `docs/MALAK_CONSTITUTION.md` (Malak persona/safety rules), root `MALAK_AUDIT.md` / `MALAK_BUILD_LOG.md` / `MALAK_PHASE3_REVIEW.md`.

---

# 4. Routes and Pages

**Auth model (applies to every table below):** `proxy.ts` → `lib/supabase/middleware.ts` gates all non-public paths on a Supabase session. `PUBLIC_PATHS` = `/login, /auth, /staff, /rewards, /api/cron, /api/webhooks, /api/rewards`. No user → 307 → `/login`; fails **closed** in production if Supabase env is missing. `app/(app)/layout.tsx` re-checks `getUser()`. **There are NO admin role tiers inside `(app)`** — every authenticated Supabase user has full owner access. Role granularity exists only on `/staff` (per-employee `StaffPermission`s). Every `(app)` page is `dynamic = "force-dynamic"`.

### Public / auth
| Route | File | Purpose | Auth | Status |
|---|---|---|---|---|
| `/` | `app/page.tsx` | redirect → `/dashboard` | via target | working |
| `/login` | `app/(auth)/login/page.tsx` | Owner email+password sign-in | public | working |
| `/staff` | `app/staff/page.tsx` | PIN-gated employee PWA: stock in/out, products, tasks, add-product-from-photo, Malak-lite | public path + signed `staff_session` cookie; per-employee perms | working |
| `/rewards` | `app/rewards/page.tsx` | Customer Beauty-Rewards card (from printed QR) | fully public (by design) | working |

### `(app)` — Malak (AI)
| Route | File | Purpose | Status |
|---|---|---|---|
| `/malak` | `app/(app)/malak/page.tsx` + `MalakClient.tsx` | Flagship: mission-control HUD + 3D orb + chat/voice | working |
| `/malak/chat`, `/malak/hud` | `.../chat`, `.../hud/page.tsx` | Legacy stubs → **redirect to `/malak`** | dead/redirect |
| `/malak/audit` | `app/(app)/malak/audit/page.tsx` | Read-only log of Malak's writes (`malak_audit`, last 200) | working |

### `(app)` — Studio (statuses from `lib/studio/modules.ts`)
`/studio` (index) working. **Live:** `/studio/video` (`StudioVideoEngine`), `/studio/voice` (`StudioVoiceEngine`), `/studio/settings`. **Partial:** `/studio/reel` (`StudioReelComposer`). **Placeholder (`ModuleScaffold`, no logic):** `/studio/products`, `/script-writer`, `/prompts`, `/templates`, `/queue`. **Planned (experimental):** `/studio/ai-manager`, `/dialect`, `/logo`, `/translate`, `/quality`.

### `(app)` — Catalog / Products / Inventory / Loyalty / Platforms
| Route | File | Purpose | Status |
|---|---|---|---|
| `/dashboard` | `dashboard/page.tsx` | CEO KPIs, low-stock, staff stats, Shopify orders | working (⚠ inventory KPIs placeholder pre-stocktake) |
| `/products` | `products/page.tsx` | Catalog table (`ProductTable`) | working |
| `/products/[id]` · `/[id]/edit` · `/new` · `/archive` | `products/**` | Detail, edit, new (photo→AI draft, `maxDuration=60`), archive | working |
| `/inventory` | `inventory/page.tsx` | KPIs + table; simple/full mode (`SimpleAvailabilityList`, `InventoryTable`) | working |
| `/inventory/{approvals,movements,out-of-stock,labels,reports,shelves,shelves/labels,stocktake}` | `inventory/**` | Approvals, manual movement, OOS, barcode labels, margin/shrinkage reports, shelves, stocktake | working |
| `/loyalty` + `/customers,/prizes,/cards,/qr,/voucher/[id]` | `loyalty/**` | Loyalty admin, customers, prizes, printable cards/QR, voucher redemption | working |
| `/platforms` + `/[platform]` | `platforms/**` | Per-platform approval hub (`PlatformHub`); `notFound()` on bad slug | working |
| `/catalog/enrich` · `/catalog/health` | `catalog/**` | AI enrichment; image/health editor | working |

### `(app)` — Growth / Ops
| Route | File | Purpose | Status |
|---|---|---|---|
| `/tasks` | `tasks/page.tsx` + `TasksClient.tsx` | Task board + routines + weekly report + calendar card; multi-select bulk approve/reject | working |
| `/team` | `team/page.tsx` | Staff members + permission grants | working |
| `/agents` | `agents/page.tsx` | AI agent log panel — **agents are stubs** | experimental |
| `/approvals` | `approvals/page.tsx` | Pending products + staff movements | working |
| `/inbox` | `inbox/page.tsx` | DM conversations + metrics | working/partial |
| `/social` | `social/page.tsx` | Social posts + reel/story publisher (`maxDuration=60`) | working |
| `/content` | `content/page.tsx` | AI content/reel generation + week plan (UI says "image/video coming soon via Higgsfield") | working/partial |
| `/crm` | `crm/page.tsx` | Customers (paged from Shopify, `maxDuration=60`) | working |
| `/channels` | `channels/page.tsx` | Channel availability matrix | working |
| `/shopify-orders` | `shopify-orders/page.tsx` | Recent Shopify orders | working |
| `/import-export` (+ `availability`, `pure-seoul`, `shopify-sync`, `snoonu-sync`, `talabat-sync`, `talabat-orders`) | `import-export/**` | Excel import, image health/upload, exports, per-channel sync | working |

### API routes (27) — see §5B / §8 for auth mechanisms
`malak/*` (route, commit, generate-image, speak, browse, live-check, scan, briefing, upload), `cron/{availability-sync,notify,publish-social}`, `webhooks/{meta,talabat/[token]}`, `calendar/[token]`, `rewards/{state,choose,submit}`, `shopify/{install,callback}`, `social/{ig-test-publish,ig-verify}`, `push/subscribe`, `products/image`, `export/{[channel],images}`, `loyalty/customers/export`.

**Known issues:** `/malak/chat` & `/malak/hud` are dead redirects; `/agents` + 10 studio pages are placeholders; `/api/export/[channel]` depends on a **gitignored local master xlsx** absent on Vercel (falls back to DB descriptions).

---

# 5. Application Architecture

**Frontend:** Next App Router, **RSC by default**. Pages are async server components that fetch server-side and hydrate client "islands" (`components/*Client.tsx`, `*Panel`, `*Form`). `"use client"` in ~89 leaf files. Heavy AI pages raise `maxDuration` to 30-60s. Every `(app)` page is `force-dynamic` (no static caching).

**Backend:** Two backend surfaces — **Server Actions** (`"use server"` co-located `actions.ts`, 20 files) and **Route Handlers** (`app/api/**/route.ts`, 27 files). No separate API server; everything runs on Vercel functions.

**Supabase clients (`lib/supabase/`):**
- `server.ts` — `createServerClient` (anon key, cookies, RLS) for user-scoped reads in RSC/actions. `isSupabaseConfigured()` guards placeholders.
- `client.ts` — `createBrowserClient` (anon, RLS) for client components (login).
- `admin.ts` — `createAdminClient` (**`SUPABASE_SERVICE_ROLE_KEY`, bypasses RLS, server-only**). **The dominant pattern: 144 call sites across 51 files.** Used wherever there's no user session (staff PIN, cron, webhooks, public rewards) or to read across RLS.
- `middleware.ts` — `updateSession()` session refresh + `PUBLIC_PATHS` gate + fail-closed.
- `paginate.ts` — `fetchAll()` pages 1000 rows at a time; degrades to partial on error.

**Auth flow:** Owner logs in via `LoginForm` (browser client) → Supabase cookies → `proxy.ts` revalidates on every request → `(app)/layout.tsx` re-checks. Staff use an entirely separate signed-PIN cookie flow. Rewards customers have no auth.

**Authorization:** Admin app = authenticated-only (no roles). Staff = fine-grained `StaffPermission`s re-read live from DB per action (`lib/staff/permissions.ts`). Malak writes require session **plus** a single-use HMAC action token.

**State / data-fetching:** No global client store. Server fetches → props → client local state → server actions for mutations → `router.refresh()` / `revalidatePath`. External data (Shopify/Instagram) fetched server-side.

**File-upload flow:** client base64 → server action/route → MIME + 10MB validation → admin client uploads to Storage bucket `product-images` → public URL stored on product/gallery.

**Error handling & logging:** pervasive **degrade-to-partial, never-crash** — actions return `{ error }` objects instead of throwing; optional tables/columns probed and fall back on `42P01`/`42703`. Logging is `console.error` for non-fatal failures. Mutations audited into `malak_audit`.

**Data-flow diagram:**
```
Browser (RSC page + client islands)
   │ props / server-action call / fetch
   ▼
proxy.ts → lib/supabase/middleware.ts  (session refresh + PUBLIC_PATHS; owner→/login if none)
   ├─────────────┬────────────────┬─────────────────┐
   ▼             ▼                ▼                 ▼
Server Comp   Server Action    Route Handler     Route Handler
(page.tsx)    actions.ts       app/api/**         (cron / webhook / rewards / malak)
              requireUser()/    getUser()/token
              hasPerm()
   │             │                │                 │
   ▼             ▼                ▼                 ▼
  ┌──────────────────── Supabase ─────────────────────┐
  │ server.ts (anon/RLS) · client.ts (browser/RLS)    │
  │ admin.ts (service-role, bypasses RLS: 144 sites)  │
  │ paginate.ts (1000-row pager)                      │
  └──────────────────────┬─────────────────────────────┘
       Malak writes: HMAC token → /api/malak/commit → malak_audit
                          ▼
External: Anthropic · OpenAI Images · Gemini · ElevenLabs · Shopify · Meta/IG · Talabat ·
          FLORA · Higgsfield · Creatomate · Hyperbeam/Browserbase/Browserless · Brave/Tavily · Upstash · web-push
```

---

# 6. Supabase Configuration

**Runtime DB:** `vqstcmattiarhblqshvb` (via `NEXT_PUBLIC_SUPABASE_URL`). Owner account `fahadshiping@gmail.com` (`SOURCE_OF_TRUTH.md`).

**Clients:** see §5. **Service-role usage = 144 occurrences / 51 files** — access control is therefore enforced in the **middleware + server-action layer, not RLS**, for most tables. Several tables are intentionally "RLS ON, no policies" (service-role-only).

**Storage buckets (only 3):**
| Bucket | Defined | Public | Used for |
|---|---|---|---|
| `product-images` | **NOT in any migration** (created manually in dashboard) — referenced in ~18 files | manually public | product photos, task attachments, AI ad/scene images, reel audio |
| `loyalty-reviews` | `supabase/loyalty_rewards.sql` | yes | review screenshots |
| `loyalty-prizes` | `supabase/loyalty_prizes.sql` | yes | prize images |

**Realtime:** none in app code (only a transitive lockfile dep). **Triggers/functions/views (app):** `loop_board` view (`loop_state_layer.sql`); compliance/loop tables have SELECT-only RLS. Most business triggers live in the *shift-app* migrations, not here.

### Table catalog (project `vqstcmattiarhblqshvb`)
RLS legend: **auth** = RLS on + `authenticated` policy; **none** = RLS on, no policies (service-role only); **manual** = table not created in-repo (schema only in prod).

| Table | Purpose | Key columns | Relationships | RLS | Notable issues |
|---|---|---|---|---|---|
| **products** | Core catalog (28-col master) | `id uuid` PK; `sku`, `barcode`, `name_en/ar`, `description_en/ar`, `main_category`, `price`, `discount_price`, `cost`, `stock_quantity`, `stock_status`, `platform_status`, `image_url`, `image_filename`, `snoonu_id`, `pure_seoul_id`, `rafeeq_product_id`, `approval` | parent of inventory, product_variants, channel_products, product_images | **manual** | **No CREATE TABLE in repo** — biggest gap |
| **inventory** | Single shared stock pool | `id uuid`, `stock_quantity`, `location` | FK product | manual | not in repo |
| **product_variants** | Options/variants | `parent_product_id`, `variant_name`, `variant_name_en`, `barcode`, `sku`, `stock_quantity` | child of products | manual | drives Talabat splitter |
| **channel_products** | Per-channel price/listing overlay | `product_id`, `channel_price`, `channel_stock` (**must be NULL**) | product×channel | manual | `enforce_shared_inventory.sql` adds optional CHECK |
| **product_images** | Image rows | `product_id`, `url`, `filename`, `is_primary`, `sort_order` | child of products | manual | not in repo |
| **brands**, **channels**, **product_categories** | Lookups | — | referenced by products | manual | channels seeded by `scripts/seed_channels.mjs` |
| **platform_status** | Per-platform approval overlay | `(product_id, platform)` PK, `approval`, `rejection_reason` | FK products | **manual — DDL only in a code COMMENT** (`platforms/actions.ts:16-30`) | **No .sql at all** — high risk |
| **malak_audit** | Log of Malak's writes | `id uuid`, `action_type`, `agent`, `sku`, `product_id uuid`, `field`, `old/new_value`, `details jsonb`, `status`; legacy NOT-NULL `action` | product_id→products | (no RLS stmt) | see §10 |
| **loop_state / loop_log / loop_board(view)** | Agent memory layer | status CHECK; append-only log | — | auth (SELECT) | has `_down.sql` |
| **compliance_rules / compliance_log** | Compliance config + verdicts | rules `rule_key` unique; log `overall` CHECK(PASS/WARN/BLOCK) | — | auth (SELECT) | has `compliance_down.sql` |
| **staff_members** | Employee PINs | `id uuid`, `pin` unique, `active`, `permissions jsonb` | parent of staff_tasks | **auth (ALL, using(true))** | over-broad policy — §23 M3 |
| **staff_tasks** | Employee tasks | FK `assigned_to`, `routine_id/date`, `kind/product_id/payload`, `gcal_event_id` | FK staff_members, task_routines | auth (ALL) | schema across 4 files |
| **task_routines** | Recurring templates | FK `assigned_to`; weekday int | parent of generated tasks | auth (ALL) | — |
| **task_comments** | Task threads | FK `task_id` | child of staff_tasks | auth (ALL) | attachments in `product-images` |
| **dm_conversations / dm_messages** | Customer DM inbox | conv `unique(channel,external_id)`; msg `unique(mid)`, `auto_reply`, `needs_human` | conv→messages | none | service-role only |
| **crm_customers** | Notes/tags per customer | `unique(source,source_id)`, `tags text[]` | source_id→shopify/dm | none | — |
| **loyalty_customers / loyalty_submissions** | Beauty Rewards | customer `phone` unique, `stamps`, `chosen_prize_id`; submission `status` CHECK | + loyalty_prizes | none | public IDOR risk — §23 H3 |
| **loyalty_prizes** | Selectable prizes | `id`, `image_path/url`, `active`, `sort_order` | ref by customers | none | defines `loyalty-prizes` bucket |
| **social_posts** | Social/reels queue | `platform`, `status`, `scene_url`, `extras`, `scheduled_at`, `approved`, `format`, `cta_type` | `product_id` (no FK) | none | schema across 3 files |
| **studio_reels** | Finished reel library | `video_url`, jsonb recipe | product_sku (loose) | auth (S/I) | — |
| **reel_requests** | Pro-reel queue | `status`, `script`, `video_url` | product (loose) | auth (S/I/U) | — |
| **generated_content** | AI IG content | `sku`, `hashtags text[]`, `status` | product (loose) | auth (S/I/U) | — |
| **product_archive** | Deleted-product snapshots | `bundle jsonb` | snapshot | auth (ALL) | — |
| **talabat_queue** | New-product email queue | PK `product_id` | FK products | none | — |
| **talabat_orders** | Orders from webhook | `raw jsonb`, `items jsonb` | — | auth (SELECT) | insert via service role |
| **shopify_tokens** | OAuth tokens | PK `shop`, `access_token` | — | none (correct) | secrets, service-role only |
| **shopify_synced_orders** | Dedup ledger | PK `order_id`, `deducted` | — | none | oversell guard |
| **kpi_snapshots** | Daily KPIs | PK `snapshot_date` | — | none | — |
| **app_settings** | Key/value toggles | PK `key`, `value jsonb` | — | none | inventory mode etc. |
| **push_subscriptions** | Web-push subs | `endpoint` unique | — | none | — |
| **shelf_slots / shelf_stock / variant_shelf_stock** | Shelf map + distribution | `code`/`shelf`; `unique(inventory_id,location)`; `unique(variant_id,location)` | ref inventory/variants | auth (ALL) | `shelf_slots` DDL **duplicated** in 2 files |

---

# 7. Database Migrations

### 7A. commerce-ai-os `supabase/*.sql` — ad-hoc, NOT versioned
There is **no migration chain, no `schema_migrations` table, no numbering** (only informal `stepN_` on compliance scripts). Files are pasted by hand into the Supabase SQL editor; most are idempotent `IF NOT EXISTS`. **The base schema is entirely absent** — `products, inventory, product_variants, channel_products, product_images, brands, channels, product_categories` have no CREATE TABLE; `platform_status` DDL exists only as a comment in `app/(app)/platforms/actions.ts`. **A fresh Supabase project cannot be stood up from this repo alone.**

- **Schema-creating/altering (idempotent):** `add_snoonu_columns`, `app_settings`, `catalog_change_tasks`, `compliance`, `crm_customers`, `dm_inbox`, `enforce_shared_inventory`, `generated_content`, `ig_reels_engine`, `kpi_snapshots`, `loop_state_layer`, `loyalty_prizes`, `loyalty_rewards`, `malak_audit`, `product_archive`, `pure_seoul_id`, `push_subscriptions`, `reel_requests`, `shelf_locations`, `seed_shelves_A-G`, `shelf_stock`, `shopify_tokens`, `shopify_synced_orders`, `social_posts`, `social_schedule`, `staff_members`, `staff_permissions`, `staff_tasks`, `staff_tasks_gcal`, `studio_reels`, `talabat_orders`, `talabat_queue`, `task_comments`, `task_routines`, `variant_barcode`, `variant_name_en`, `variant_shelf_stock`.
- **⚠ Data-mutating (change live data):** `malak_audit_product_id_uuid.sql` (bigint→uuid rename + backfill; **run in prod 2026-07-02**), `step11_clear_bucketA_prices`, `step12_fix_bucketB_67` (UPDATE channel_price), `step13_set_snoonu_images`, `step14_set_storage_images` (UPDATE image_url), `step9_reword_products`, `step5/8/10` (compliance_rules), `step6_sample_verdicts`, `seed_sample_data`, **`delete_sample_data`** (DELETE `SKU LIKE 'TEST-%'`).
- **Read-only/verification:** `step4_extract_products`, `step7_extract_multichannel`, `compliance_checks`, `loop_state_checks`.
- **Destructive down/rollback:** `compliance_down.sql`, `loop_state_layer_down.sql`.

**Duplicates/conflicts:** `shelf_slots` DDL in both `shelf_locations.sql` and `seed_shelves_A-G.sql`; `social_posts` and `staff_tasks` schemas fragmented across 3-4 files; destructive scripts sit in the same folder as schema files (easy to run the wrong one).

### 7B. shift-app `/home/user/ghost/supabase/migrations/*.sql` — properly versioned (project `fibkwudabuwfjqpyeeng`)
Timestamp-prefixed, transactional (`begin;/commit;`), each header says "review only — not auto-applied." Two series: **audit** (`20260720190001`-`190007` triggers on leaves/overrides/point_shifts/settings/employees, `190009` rollback — **note `190008` is missing**) and **leave-balance** (`20260721190000`-`190010`). Context in `supabase/AUDIT_LOG.md`. **Handover flags:** rollback files sort *after* their forward migrations (blind directory-order apply would wipe features — safe only because manual); `20260721190005` redefines `audit_capture` (series are coupled). `supabase/repair/` has two `.DEPRECATED.sql` files (direct `auth.users` writes — do not run; superseded by `scripts/repair-missing-auth-users.mjs`).

---

# 8. Edge Functions

**There are NO Supabase Edge Functions in the repo.** Verified: no `supabase/functions/` directory (root or app), no `Deno.serve`, no `admin-account-status` / `apply-snoonu-images` in source.

**What plays the backend-function role instead** — all **Next.js route handlers on Vercel** using the service-role client:
| "Function" | File | Purpose | Auth | Env | External |
|---|---|---|---|---|---|
| availability-sync cron | `app/api/cron/availability-sync/route.ts` | reconcile channel availability | `CRON_SECRET` Bearer | — | Supabase |
| notify cron | `app/api/cron/notify/route.ts` | push alerts + daily social drafts | `CRON_SECRET` | VAPID, `SOCIAL_PLATFORMS` | web-push, Anthropic, Gemini |
| publish-social cron | `app/api/cron/publish-social/route.ts` | publish approved+due social | `CRON_SECRET` | Meta | Instagram Graph |
| Meta webhook | `app/api/webhooks/meta/route.ts` | IG/WhatsApp DM ingestion + auto-reply | GET verify token; POST HMAC (`META_APP_SECRET`) | Meta | Supabase, Anthropic |
| Talabat webhook | `app/api/webhooks/talabat/[token]/route.ts` | order ingestion | path token == `TALABAT_WEBHOOK_TOKEN` | — | Supabase |
| Malak commit | `app/api/malak/commit/route.ts` | execute confirmed mutation | single-use HMAC action token | `MALAK_SIGNING_SECRET` | Supabase |

**External cron mechanism:** `supabase/social_publish_cron.sql` schedules **pg_cron + pg_net** to hit `/api/cron/publish-social` every 15 min (operator pastes `CRON_SECRET`); `vercel.json` alone fires it only at 10:00 and 17:00 UTC.

**Known risk:** Meta webhook **skips signature verification entirely if `META_APP_SECRET` is unset** (`webhooks/meta/route.ts:24-26`) — see §23 H2.

---

# 9. Authentication and Roles

**Two independent auth systems:**
1. **Owner/admin — Supabase email+password.** `components/LoginForm.tsx:20-31` → `signInWithPassword` (browser anon client). Session in Supabase SSR cookies, refreshed by `proxy.ts` → `lib/supabase/middleware.ts` (`getUser()` revalidates on every request). No public sign-up; users created in Supabase dashboard.
2. **Staff — shared-page signed PIN, no Supabase account.** `app/staff/actions.ts:77-148` `staffLogin` looks up `staff_members` by `hashPin(code)` (HMAC-SHA256, `lib/staff/pin.ts`), mints an HMAC-signed `staff_session` cookie (`lib/staff/session.ts`; `httpOnly`, `sameSite:lax`, `secure` in prod, `path:/staff`, 12h).

**Route protection:** middleware `PUBLIC_PATHS` (§4). `/staff` self-gates via `currentStaff()` (re-reads live perms + `active` each call). `/rewards` fully public. `(app)/layout.tsx` is a second `getUser()` check. Fails **closed** in prod on missing env.

**Roles / permissions — every constant:**
| Concept | Defined | Checked |
|---|---|---|
| `OWNER_EMAIL = "clanqtr@gmail.com"` | `lib/malak/authz.ts:7` | `requireMalakWriter` |
| `MALAK_WRITER_EMAILS` (env allowlist) | `lib/malak/authz.ts:10-14` | same |
| `StaffPermission`: `stock, add_product, products, prices, edit_products, edit_images, malak, reports, tasks, manage_tasks` | `lib/staff/permissions.ts:5-9` | `hasPerm` |
| `DEFAULT_PERMISSIONS = ["stock"]` | `permissions.ts:15` | fallback |
| dependency rules (`prices`/`edit_*` need `products`) | `permissions.ts:17-28` | `parsePermissions` |

**There is no `superadmin`/`admin`/`customer` role table.** "Admin" == the owner Supabase account; "customer" == unauthenticated rewards user. **Account enable/disable:** `staff_members.active` toggled by `setStaffActive` (`team/actions.ts`); enforced at login and mid-shift (`currentStaff` returns null if `active===false`). There is **no `account_enable`/`account_disable` action anywhere**, and staff enable/disable/delete/permission changes are **not audit-logged** (§10, §23 M1).

**Bypass concerns:** admin app has no per-user RBAC (any authenticated user = full owner). Staff safety depends on live-perm re-read (good). The biggest exposure is that most writes go through the service-role client, so **RLS is not the enforcement boundary** — see §23 H1.

---

# 10. Audit Log System

**Schema** (`supabase/malak_audit.sql:13-25`): `id uuid`, `created_at`, `action_type text NOT NULL`, `agent`, `sku`, `product_id uuid`, `field`, `old_value`, `new_value`, `details jsonb`, `status default 'committed'`.

- **No CHECK constraint on `action_type`** — it is free-form text. The premise "action values violating a constraint" therefore does not apply. Values actually written include `update_stock, set_price, set_approval, add_product, stock_in/stock_out, stocktake, shelf_move/assign/remove, variant_stock_in/out, new_product, image`.
- **Legacy `action` column:** the live table (renamed from `audit_log`) still has a NOT-NULL `action`; writers populate **both** `action` and `action_type` (`commit/route.ts:262-263`, `inventory/actions.ts:43-44`). Writing only `action_type` would violate the NOT-NULL on `action` — the real constraint risk, mitigated by always writing both.
- **product_id drift healer:** `lib/audit.ts:27-39` writes `product_id`, retrying without it on `22P02`/`42703`, keeping uuid in `details.productId`.

**Insertion sites:** `api/malak/commit/route.ts:276`, `lib/inventory/movements.ts:55`, `app/(app)/inventory/actions.ts` (171, 238, 299, 463, 563, 615, 678, 738, 1057), `app/staff/actions.ts:512`.

**Error handling:** inserts are checked but **swallowed by design** ("best-effort, never fail the business write") — e.g. `inventory/actions.ts:40-55` try/catch + `console.error`, never rethrow.

**Mutability:** despite an "append-only" comment, rows are **UPDATEd in place** via service role (`movements.ts:116,148`, `approvals-actions.ts:104,139`). No RLS/trigger prevents UPDATE/DELETE — history is rewritable by anyone with the service-role key.

**Actor/target:** actor in `agent`; **owner-side inventory edits log `agent:"inventory"`, not the specific user** (no per-user attribution). Target (`product_id`+`sku`+`field`+old/new) stored correctly.

**Requested actions:** `insert`/`update`/`delete` of catalog are logged. **`account_enable`/`account_disable` — NOT logged at all;** `setStaffActive`, `deleteStaff`, `setStaffPermissions`, `resetStaffPin` write nothing to `malak_audit`. **Admin account/permission operations have zero audit trail.**

---

# 11. AI Features

Provider/model map (strings quoted from source; every provider is env-gated and degrades to an Arabic "not configured" message):

| Feature | UI entry | Backend | Provider · model | Prompt location | Storage | Status |
|---|---|---|---|---|---|---|
| **Malak assistant** (chat/agent) | `malak/MalakClient.tsx` | `app/api/malak/route.ts` (1681 lines) | Anthropic · `"claude-opus-4-8"` (`MALAK_MODEL`) | inline Gulf-Arabic `SYSTEM_PROMPT` `route.ts:45-160` | reads products/inventory; writes via commit | working |
| **Product draft** (photo→listing) | `products/new`, `/staff` | `products/actions.ts:484`, `staff/actions.ts:591` | Anthropic · `"claude-sonnet-5"`/`"claude-sonnet-4-6"` | `lib/products/draft-compute.ts` | products | working |
| **Catalog enrich** (fill/verify AR⇄EN) | `/catalog/enrich` | `catalog/enrich/actions.ts:124` | Anthropic · `claude-sonnet-5` | `lib/products/enrich-compute.ts` | products | working |
| **Captions / social copy** | `/content`, `/social` | `lib/social/generate.ts`, `content-compute.ts`, `ad-copy-compute.ts` | Gemini (photo) + Anthropic (`STAFF_MALAK_MODEL`) | those files | social_posts | working |
| **Image generation/edit** | `/malak`, `/social` | `api/malak/generate-image`, `lib/products/imageEdit.ts`, `lib/social/scene-gemini.ts` | OpenAI `gpt-image-1(-mini)` + Gemini `gemini-2.5-flash-image` | `route.ts:24` buildPrompt | `product-images` | working |
| **Video / reels** | `/studio`, `/content` | `lib/video/*`, `lib/social/higgsfield.ts`, `compose.ts` | FLORA + Higgsfield (`dop-turbo`/kling/seedance) + Creatomate | `shot-plan.ts`, `templates.ts` | `studio_reels`, `social_posts` | working (see §12) |
| **DM auto-reply** | `/inbox` (auto) | `lib/dm/inbox.ts:289` | Anthropic · `"claude-sonnet-5"` (`DM_MODEL`) | `lib/dm/respond-compute.ts` | dm_messages | working (delivery gated by Meta approval) |
| **Compliance agent** | (background) | `lib/compliance/agent.ts:66` | Anthropic · `"claude-opus-4-8"` | `lib/compliance/*` | compliance_log | working |
| **Voice / TTS** | `/studio/voice`, Malak | `api/malak/speak`, `lib/social/voiceover.ts` | ElevenLabs `eleven_multilingual_v2` / `eleven_v3` | `lib/voice/voice-compute.ts` | `product-images/reels-audio/` | working |
| **Task generation/scheduling** | `/tasks` | `lib/tasks/routines-compute.ts`, `weekly-report.ts` | **NOT AI — pure deterministic logic** | — | staff_tasks | working |

**Malak architecture:** tool-use loop (`MAX_TOOL_ROUNDS=4`, `MAX_TOKENS=4096`, `maxDuration=60`). **Read tools** query Supabase (service role) + live Shopify. **Write tools never write directly** — they return a signed confirm token; the actual write happens in `/api/malak/commit` only after the user taps confirm (`lib/malak/confirm.ts`). Prompt-injection hardening: tool results labelled "data, not instructions." Single persona "ملاك"; legacy multi-agent names (Noor/Reem/…) are explicitly forbidden. **Cost:** Opus 4.8 per chat turn is the single largest AI cost driver; image gen capped 40/user/day, speak 40/user/min.

---

# 12. Image and Video Generation

**Images — upload:** `components/ImageUpload.tsx`, `BulkImageUpload.tsx`, `CatalogImageBySku.tsx` → routes `api/products/image`, `api/malak/upload` → validate MIME + 10MB → admin client → bucket **`product-images`**. Primary product images named **`<sku>.<ext>`** (`lib/products/imageStore.ts:38`) to match Talabat's filename column. Bulk apply-by-SKU: `lib/products/image-apply-compute.ts` (`skuFromFilename`) + `storePrimaryProductImageBySku`.

**Images — generation/edit:**
- Malak ad image: `api/malak/generate-image` — OpenAI `gpt-image-1-mini`; uses `/images/edits` when a product photo exists (keeps the real bottle), else `/images/generations`; hard "no text" rule (AI garbles Arabic — text added by a human later); returns a `set_image` confirm token.
- Shared edit: `lib/products/imageEdit.ts` — OpenAI `gpt-image-1`, `input_fidelity:"high"` (fixes garbled labels), `quality:"high"`.
- Gemini "Nano Banana" scene: `lib/social/scene-gemini.ts` (`gemini-2.5-flash-image`) — analyze photo → design scene from product palette → place exact product in a luxury scene.
- One-shot full ad: `lib/social/full-ad-compute.ts` — prefers Gemini, falls back to OpenAI raw mode.
- **Background removal/replacement:** no dedicated library — achieved via the Gemini/OpenAI edit prompts.

**Video — routing:** `lib/video/routing.ts` maps product kinds → **FLORA**, talking/UGC → **Higgsfield**; `VIDEO_PROVIDER` overrides. `lib/video/provider-router.ts` auto-falls-back FLORA→Higgsfield if FLORA unconfigured; requestIds tagged `flora:`/`higgsfield:`.
| Provider | Status | Evidence |
|---|---|---|
| FLORA | integrated & real (primary product video) | `lib/video/flora.ts` |
| Higgsfield | integrated & real (talking/UGC + fallback) | `lib/social/higgsfield.ts` |
| Creatomate | integrated & real (final compositor) | `lib/social/compose.ts` |
| Kling/Seedance | via Higgsfield only (`HIGGSFIELD_VIDEO_MODEL`) | `higgsfield.ts` |
| Runway/Luma | **not present** | zero refs |
| Higgsfield Marketing Studio (talking-avatar) | **manual paste-back** (not in public API) | `higgsfield.ts:11-13`, `content/reel-request-actions.ts` |

**Shot structure:** `lib/video/shot-plan.ts` (hero→detail→[lifestyle]→cta, 3-4 FLORA runs). **Captions:** `lib/studio/caption-compute.ts` synced to ElevenLabs char timestamps. **Logo/overlay:** `lib/social/compose-compute.ts` (Creatomate JSON, logo ~11% top-right, «اطلبي الآن» CTA, burned-in Arabic captions; logo `MALIKA_LOGO_URL`, music `REELS_MUSIC_URL`). **Output:** enforced 1080×1920 mp4 with a `reelQA` gate. **Storage:** Creatomate URL → `studio_reels`. **Flow:** all **polling** (no webhooks); per-shot failures tolerated (reel proceeds if ≥1 shot renders).

**`malikas-product-commercial-v1`** = the **FLORA "technique" slug** (a saved image→video workflow on the FLORA canvas), set via env `FLORA_TECHNIQUE_SLUG`. Referenced only in `lib/video/flora.ts:7` (doc comment) and `studio/settings/page.tsx:76` (example value). `submitFloraRun` uploads the product image to FLORA (FLORA rejects external URLs), then `POST /api/v1/techniques/malikas-product-commercial-v1/runs`, polls, prefers `.mp4`. **The whole product-video engine is inert until that technique is created in the FLORA account and its slug set in env.**

---

# 13. ElevenLabs and Voice

**ElevenLabs is the only TTS** (browser `speechSynthesis` as last-resort fallback). Used in:
1. **Malak's voice** — `app/api/malak/speak/route.ts`. Model `"eleven_multilingual_v2"` (`ELEVENLABS_MODEL_ID`), voice `ELEVENLABS_VOICE_ID`. Settings: `stability 0.55, similarity 0.9, style 0.15, speed 0.95` (high `style` causes Arabic stutter → kept low). 204 → browser fallback if unconfigured. Custom Arabic number speller (`numToArabic`) because ElevenLabs mispronounces digits, but leaves codes like `mk1215` intact.
2. **Reel/social voiceover** — `lib/social/voiceover.ts`. Model `"eleven_v3"` (better Gulf accent). `/with-timestamps` for caption sync. Uploads mp3 to `product-images/reels-audio/`. Settings env-tunable (`ELEVENLABS_STABILITY/STYLE/SIMILARITY/SPEED`). **Deliberately does NOT send `language_code`** (accent drift).
3. **Studio Voice Engine** — `app/(app)/studio/voice-actions.ts`, `components/studio/StudioVoiceEngine.tsx` — auditions Gulf voices, model×text comparison, picks `ELEVENLABS_VOICE_ID`.

**Voice IDs:** none hardcoded — all from env. `.env.local.example:94-103` lists `ELEVENLABS_VOICE_ID` + commented legacy per-persona slots (unused). **Language:** strong white-Gulf (Qatari) focus (`lib/voice/voice-compute.ts`), TTS-safe pronunciation, line-break pauses. **Cost:** speak rate-limited 40/user/min; voiceover text capped 800 chars; **no monthly quota cap in code**.

---

# 14. Tasks and Google Calendar

**Task CRUD** — server actions in `app/(app)/tasks/actions.ts` (service-role, `requireUser`-gated): `listTasks` (materializes routines first), `createTask`, `updateTask`, `deleteTask`, `bulkSetTaskStatus`, `bulkDeleteTasks`. **Tables:** `staff_tasks` (+`staff_tasks_gcal.sql` adds `gcal_event_id`), `task_comments` (two-way thread), `task_routines` (recurring templates + partial unique index `(routine_id, routine_date)`).

**Google Calendar auth** — **service account, signed-JWT → OAuth token** (NOT interactive OAuth, no refresh token). `lib/integrations/gcal.ts`: builds RS256 JWT (scope `calendar`), POSTs `grant_type=jwt-bearer`. Env `GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_CALENDAR_ID`. **Token cached in module memory only** (refreshed 60s before expiry); nothing persisted.

**Events:** `upsertTaskEvent` create/update; stale (404/410) → one-time recreate; `deleteTaskEvent` treats 404/410 as success. All-day date-only events with Arabic summary, priority→colorId, `extendedProperties.private.malikaTaskId` tag.

**Sync DIRECTION = ONE-WAY, app → Google, AUTOMATIC.** Every task write auto-calls `syncTaskRow`/`removeTaskEvent`. Manual bulk reconcile via `syncAllTasksToCalendar` (`TasksCalendarCard.tsx`). **No read-back from Google** — edits made directly in Google Calendar are never pulled back.

**Conflict/failure handling:** no duplicates (`gcal_event_id` stored; if the column is missing, sync is **skipped entirely** rather than risk duplicates). Failures `console.error`'d and swallowed (never block the task write). No retry queue. **Timezone:** events are date-only (no per-event TZ); routine "today" uses **UTC** `getUTCDay()`, not Qatar midnight. **Recurring:** routines materialize as concrete `staff_tasks` rows (not Google recurring events).

**ICS feed** `app/api/calendar/[token]/route.ts` — read-only public `.ics` subscribe feed; auth = `TASKS_ICS_TOKEN` in path (constant-time compare, 404 on mismatch); `X-WR-TIMEZONE:Asia/Qatar`.

**Handover flags:** calendar sync silently no-ops until `staff_tasks_gcal.sql` runs in prod; sync is push-only.

---

# 15. Instagram and Social Publishing

| Capability | Status | Evidence |
|---|---|---|
| **Instagram publish (posts/reels/stories)** | **WORKING** (real Graph API v21.0) | `lib/social/instagram.ts` — two-step container→poll `status_code`→`media_publish`; `publishToInstagram/Story/VideoStory/Reel` |
| **Insights/metrics** | WORKING | `fetchIgMediaStats` (like/comments/reach/saved/shares); `lib/social/insights-compute.ts`, `reels-metrics.ts` |
| **Scheduling + approval** | WORKING | `social_schedule.sql` (`scheduled_at`, `approved`); `schedule-compute.ts` (7d×3 Qatar slots); **nothing publishes without owner approval** |
| **publish-social cron** | WORKING | `app/api/cron/publish-social/route.ts` — `CRON_SECRET`; selects `pending AND approved AND due`, cap 3/run; **only `platform==="instagram"` publishes** |
| **Daily draft generation** | WORKING | `generateDailySocialPosts` (`generate.ts`), triggered from `notify` cron; env `SOCIAL_PLATFORMS` + `ANTHROPIC_API_KEY` |
| **DM auto-reply bot** | WORKING (delivery gated) | `lib/dm/inbox.ts` — Claude reply → `sendInstagramDm`; needs Meta App Review for `instagram_manage_messages` + 24h window |
| **Meta webhook** | WORKING | `app/api/webhooks/meta/route.ts` — GET verify (`META_VERIFY_TOKEN`), POST HMAC (`META_APP_SECRET`); **⚠ skips signature check if secret unset** |
| **Pro reels** | PARTIAL | AI writes script (`content/reel-request-actions.ts`); **video produced externally, mp4 URL pasted back** |
| **TikTok** | PLACEHOLDER/blocked | `lib/social/tiktok.ts` — real code but forced `SELF_ONLY` until app audit; **not wired into the cron** |

**Cron scheduling caveat:** `vercel.json` fires publish-social only at 10:00 & 17:00 UTC. Real sub-daily scheduling needs the **Supabase pg_cron every-15-min** job (`social_publish_cron.sql`) installed. **Env (names):** `INSTAGRAM_USER_ID`/`IG_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`/`META_ACCESS_TOKEN`, `META_MESSAGING_TOKEN`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `CRON_SECRET`, `SOCIAL_PLATFORMS`, `DM_MODEL`, `TIKTOK_ACCESS_TOKEN`, `CREATOMATE_API_KEY`, `MALIKA_LOGO_URL`, `REELS_MUSIC_URL`.

---

# 16. Product and Catalogue System

**Schema** (mirrored in `lib/types.ts`): `sku` **IS** the master SKU (no separate `master_sku`); `barcode` (+ per-variant); images `image_url`/`image_filename` + `product_images` table; titles `name_en`/`name_ar`; descriptions `description_en`/`description_ar` + keywords; categories `main_category` (11 locked, `lib/constants.ts`), `sub_category`, `product_type`; pricing `price`/`discount_price`/`cost`; platform ids `snoonu_id`, `pure_seoul_id`, `rafeeq_product_id` + Snoonu flags `approval`/`is_featured`/`is_promoted`/`has_buy1get1`. `product_variants` (parent/child, drives Talabat splitter). **No "collections" table** — grouping via category + `channels`/`channel_products`.

**Shared-inventory principle (critical):** every channel draws from ONE `inventory` pool; `channel_products.channel_stock` is always NULL by design (`enforce_shared_inventory.sql` adds an optional CHECK).

**Multi-platform code map:**
| Platform | Logic | UI | Route | Scripts | ID |
|---|---|---|---|---|---|
| Shopify | `lib/shopify/{admin,inventory-sync,oauth-compute,orders-compute,order-deduct-compute}.ts`, `lib/shopify-diff.ts` | `ShopifySync.tsx` | `api/shopify/*`, `import-export/shopify-sync` | — | Shopify GID; token in `shopify_tokens` |
| Snoonu | `lib/snoonu-diff.ts`, `snoonu-fill.ts` | `SnoonuSync/Fill.tsx` | `import-export/snoonu-sync` | `fill_snoonu_id.mjs`, `snoonu_real_breakdown.mjs` | `products.snoonu_id` |
| Talabat | `lib/talabat-diff.ts`, `lib/talabat/*`, `lib/malak/talabat-export.mjs` | `Talabat{Sync,Export,Orders}.tsx` | `import-export/talabat-*`, `webhooks/talabat/[token]` | `export_talabat.mjs` | email-based; `talabat_queue`/`talabat_orders` |
| Rafeeq | `lib/exporters.ts` (`buildRafeeqAoa`) | export button | `api/export/[channel]` | `add_rafeeq_product_id.sql` | `rafeeq_product_id` |
| Pure Seoul | `lib/pure-seoul-map-compute.ts` | `PureSeoulSync.tsx` | `import-export/pure-seoul` | — | `pure_seoul_id` |

**Imports/exports:** `components/ExcelImport.tsx` (client `xlsx`, 28-col map) → `import-export/actions.ts`; `lib/exporters.ts` pure builders; `api/export/[channel]` + `api/export/images` (hand-rolled image ZIP). **Image matching/readiness:** `image-apply-compute.ts` (SKU=filename), `ImageHealth.tsx` + `image-health-actions.ts` (probe URLs + Gemini quality audit), `lib/compliance/publishGate.ts` (`assertPublishAllowed` fails **closed** if no compliance verdict). **Scripts:** see §21.

---

# 17. External Integrations

| Service | Purpose | Code | Env NAMES | Auth | Status | Risks |
|---|---|---|---|---|---|---|
| Supabase | DB/Storage/Auth | `lib/supabase/*` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | anon + service-role | Working | service-role = DB master key, broad blast radius |
| Anthropic | Malak/compliance/DM/copy | `api/malak/route.ts`, `lib/compliance/agent.ts`, `lib/dm/inbox.ts`, `lib/social/generate.ts` | `ANTHROPIC_API_KEY`, `MALAK_MODEL`, `STAFF_MALAK_MODEL`, `DM_MODEL` | Bearer | Working | core dependency |
| Google Calendar | push tasks | `lib/integrations/gcal.ts`, `api/calendar/[token]` | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `TASKS_ICS_TOKEN` | service-account JWT | Working | full SA key in env |
| Google Gemini | scene image + quality audit | `lib/social/scene-gemini.ts` | `GEMINI_API_KEY`/`GOOGLE_AI_API_KEY`, `GEMINI_IMAGE_MODEL`, `GEMINI_TEXT_MODEL` | key | Working (optional) | — |
| Google (YouTube) | song→video id (HTML scrape) | `lib/malak/youtube.ts` | none | none | Partial | brittle scrape |
| OpenAI | image gen (fallback to Gemini) | `api/malak/generate-image`, `lib/products/imageEdit.ts` | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY` | Bearer | Working (optional) | — |
| Meta/Instagram/Facebook | publish + DM + webhooks | `lib/social/instagram.ts`, `lib/dm/inbox.ts`, `api/webhooks/meta`, `api/social/*` | `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_MESSAGING_TOKEN`, `INSTAGRAM_USER_ID`/`IG_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`, `STORE_DOMAIN` | Graph tokens + webhook HMAC | Partial | token expiry manual; sig check skipped if secret unset |
| WhatsApp (Cloud API) | morning alert to owner | `lib/whatsapp.ts` | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TO`, `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` | Bearer | Partial (ships inactive) | needs approved template |
| Shopify | Admin sync + OAuth + order deduct | `lib/shopify/*`, `api/shopify/*` | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` OR `SHOPIFY_CLIENT_ID`+`SHOPIFY_CLIENT_SECRET`, `SHOPIFY_SHOP`, `SHOPIFY_API_VERSION`, `SHOPIFY_LOCATION_ID` | admin token or OAuth (token in `shopify_tokens`) | Working | two auth modes; env undocumented |
| ElevenLabs | Arabic TTS | `api/malak/speak`, `lib/social/voiceover.ts` | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_{SIMILARITY,SPEED,STABILITY,STYLE}` | key header | Working (optional) | no monthly cap |
| Higgsfield | image→video | `lib/social/higgsfield.ts` | `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET`, `HIGGSFIELD_API_BASE`, `HIGGSFIELD_VIDEO_MODEL`, `HIGGSFIELD_VIDEO_SECONDS` | key+secret | Partial | API shape varies |
| Creatomate | reel compositor | `lib/social/compose.ts` | `CREATOMATE_API_KEY`, `MALIKA_LOGO_URL`, `REELS_MUSIC_URL` | key | Working (optional) | — |
| FLORA | product video (primary) | `lib/video/flora.ts` | `FLORA_API_KEY`, `FLORA_TECHNIQUE_SLUG`, `FLORA_API_BASE`, `FLORA_INPUT_*`, `FLORA_SEND_*`, `FLORA_UPLOAD_IMAGE`, `FLORA_WORKSPACE_ID` | `sk_live_` key | Partial | many tuning envs, undocumented |
| TikTok | photo post | `lib/social/tiktok.ts` | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_PRIVACY` | OAuth | **Placeholder/blocked** | SELF_ONLY until audit |
| web-push/VAPID | owner push | `lib/push.ts`, `api/push/*` | `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | VAPID | Working (optional) | public key correctly `NEXT_PUBLIC_` |
| Hyperbeam / Browserbase / Browserless | Malak live/headless browser | `lib/malak/{live,browserbase,browser}.ts` | `HYPERBEAM_*`, `BROWSERBASE_API_KEY`/`_PROJECT_ID`, `BROWSERLESS_URL`/`_TOKEN` | key | Working (optional) | SSRF guarded |
| Brave/Tavily | Malak web search | `lib/malak/search.ts` | `BRAVE_SEARCH_TOKEN`, `TAVILY_API_KEY` (aliases) | key | Working (optional, one-of) | — |
| Upstash Redis | staff PIN rate limit | `lib/ratelimit.ts` | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | REST token | Working (optional) | **fails open** if Redis down |
| Vercel Cron | 3 crons | `api/cron/*`, `vercel.json` | `CRON_SECRET` | Bearer | Working | manual Run button doesn't send secret |

---

# 18. Environment Variables

**Client-exposed (`NEXT_PUBLIC_`) — all legitimately public, NO secrets misclassified:**
`NEXT_PUBLIC_SUPABASE_URL` (req), `NEXT_PUBLIC_SUPABASE_ANON_KEY` (req), `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (opt), `NEXT_PUBLIC_SITE_URL` (opt), `NEXT_PUBLIC_STAFF_GUIDE_VIDEO_URL` (opt). The anon key and VAPID public key are designed to be public; the privileged key is correctly `SUPABASE_SERVICE_ROLE_KEY` (no `NEXT_PUBLIC_`).

**Server-only — Required:** `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `MALAK_SIGNING_SECRET` (prod), `STAFF_PIN`, `CRON_SECRET` (for crons).

**Server-only — Optional (feature-gated):** `MALAK_MODEL`, `STAFF_MALAK_MODEL`, `DM_MODEL`, `MALAK_WRITER_EMAILS`, `STAFF_LOGIN_RATE_LIMIT`, `STAFF_LOGIN_RATE_WINDOW_SEC`, `UPSTASH_REDIS_REST_URL/TOKEN`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, all `WHATSAPP_*`, `SOCIAL_PLATFORMS`, `INSTAGRAM_USER_ID`/`IG_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`, all `META_*`, `STORE_DOMAIN`, `TIKTOK_ACCESS_TOKEN`/`TIKTOK_PRIVACY`, all `ELEVENLABS_*`, `OPENAI_*`, `GEMINI_*`/`GOOGLE_AI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_ID`, `TASKS_ICS_TOKEN`, `BROWSERLESS_*`, `BRAVE_SEARCH_TOKEN`, `TAVILY_API_KEY`, `HYPERBEAM_*`, `BROWSERBASE_*`, all `SHOPIFY_*`, all `HIGGSFIELD_*`, all `FLORA_*`, `VIDEO_PROVIDER`, `CREATOMATE_API_KEY`, `MALIKA_LOGO_URL`, `REELS_MUSIC_URL`, `TALABAT_WEBHOOK_TOKEN`.

**Runtime/CI:** `NODE_ENV`, `VERCEL_ENV`, `DRY_RUN`, `RULES_OVERRIDE_JSON`. **Root scripts only:** `SUPABASE_URL` (⚠ different name from the app's `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`.

**⚠ Documentation gaps — in code but NOT in either `.env.example`/`.env.local.example`:** all `SHOPIFY_*`, all server-side `META_*` + `STORE_DOMAIN` + `IG_USER_ID`, all `HIGGSFIELD_*`, all `FLORA_*` + `VIDEO_PROVIDER`, `CREATOMATE_API_KEY`/`MALIKA_LOGO_URL`/`REELS_MUSIC_URL`, `GOOGLE_SERVICE_ACCOUNT_JSON`/`GOOGLE_CALENDAR_ID`/`TASKS_ICS_TOKEN`/`GOOGLE_AI_API_KEY`/`GEMINI_TEXT_MODEL`, `TALABAT_WEBHOOK_TOKEN`, `STAFF_MALAK_MODEL`, `DM_MODEL`, `MALAK_WRITER_EMAILS`, both extra `NEXT_PUBLIC_*`. **A new operator setting up from the examples would silently have Shopify, Meta, Higgsfield, FLORA, Creatomate, and Calendar disabled.** **Documented but unused:** `ELEVENLABS_VOICE_{NOOR,REEM,SIRAJ,RAZAN,RASHID,LATIFA}`.

---

# 19. Vercel and Deployment

**`vercel.json` contains ONLY a `crons` array** — no build/install/functions/regions/rewrites (Vercel dashboard defaults; **Root Directory must = `commerce-ai-os`**). Crons: `/api/cron/availability-sync` (03:00 UTC), `/api/cron/notify` (05:00), `/api/cron/publish-social` (10:00 & 17:00). Auth via `CRON_SECRET` Bearer; cron paths must stay in `PUBLIC_PATHS`.

**GitHub Actions (`/home/user/ghost/.github/workflows/`):**
- **`ci.yml`** (name "CI") — push/PR to `master` + weekly Mon 05:00. All jobs `working-directory: commerce-ai-os`, pnpm 10, Node 22, frozen lockfile. Jobs: `typecheck` (`tsc --noEmit`), `test` (`pnpm test`), `build` (`pnpm build` with placeholder envs), `lint` (`eslint . --max-warnings 74`), `audit` (`pnpm audit --audit-level high`, tolerates retired-endpoint 410). **Required checks (`protect-master` ruleset): `typecheck`, `test`, `build`, `lint`** — audit advisory. Job names must match exactly.
- **`nextjs.yml`** — stock GitHub-Pages Next template that **does NOT fit this server app** (expects `out/` static export); likely dormant/misconfigured — flag for review.
- **`shift-app-pages.yml`** — deploys `shift-app/` to GitHub Pages (unrelated).
- **`dependabot.yml`** — weekly npm updates on `/commerce-ai-os` (minor+patch grouped, `xlsx` ignored) + Actions on `/`.

**Deployment constraints:** canonical host `app.malikasuniverse.com` (`components/StaleDeploymentBanner.tsx:9`) with a banner detecting frozen Vercel hash-hosts; anti-stale `no-store` on `/malak`; `.env.local` on disk holds placeholders only (real values in Vercel).

---

# 20. Testing

**Command:** `node --conditions=react-server --experimental-strip-types --test "lib/**/*.test.ts"` (Node built-in runner; **no Jest/Vitest/Playwright**). **73 test files, 508 tests, all pass (~3.7s).**

**Strategy = `-compute.ts` / `.test.ts` pattern:** 35 pure `*-compute.ts` modules hold logic (no `@/`/server-only imports) and are tested; the I/O wrappers that call them are **untested**.

| Area | Example test files | Status |
|---|---|---|
| Compliance | `lib/compliance/{checker,priceContext,publishGate,rulesFix}.test.ts` | ✅ |
| Staff security | `lib/staff/{pin,session,permissions,name-compute,stats-compute}.test.ts` | ✅ |
| Shopify | `lib/shopify-diff.test.ts`, `lib/shopify/{oauth,order-deduct,orders}-compute.test.ts` | ✅ |
| Snoonu/Talabat | `lib/snoonu-*.test.ts`, `lib/talabat-*.test.ts`, `lib/talabat/order-compute.test.ts` | ✅ |
| Social (17 files) | `lib/social/*-compute.test.ts` | ✅ |
| Video | `lib/video/{flora,routing,shot-plan,templates}-compute.test.ts` | ✅ |
| Tasks | `lib/tasks/{ics,routines,verify}-compute.test.ts`, `weekly-report.test.ts` | ✅ |
| Inventory | `lib/inventory/{analytics,lowStock,movements,sales,shrinkage}*.test.ts` | ✅ |
| Malak | `lib/malak/{confirm,intent,ratelimit}.test.ts` | ✅ |
| Utilities | `lib/{audit,briefing,exporters,i18n,shelf,ratelimit,whatsapp-compute,push-compute}.test.ts`, `lib/supabase/paginate.test.ts` | ✅ |

**No tests exist for:** all 20 server-action files, all 27 API routes, all 70 React components, Supabase/RLS/migrations, middleware, cron/webhook behavior. **The entire I/O boundary (DB, network, auth, webhooks) is unverified by automated tests.** Run: `pnpm test` (no env needed — pure modules).

---

# 21. Scripts and Commands

**`package.json` scripts:** `dev` (`next dev`), `build` (`next build`), `start`, `lint` (`eslint . --max-warnings 74` — ratchet), `test` (Node runner). `scripts/**` is excluded from typecheck (`tsconfig.json`) and lint (`eslint.config.mjs`), so **these scripts are not CI-gated.**

**`commerce-ai-os/scripts/` — ALL read `.env.local` for the prod service-role key (bypasses RLS, hits live prod):**
| Script | Purpose | Prod writes? |
|---|---|---|
| `import_products.mjs` | one-time master import | **writes** |
| `seed_channels.mjs` | seed channels/channel_products | **writes** |
| `clean_categories.mjs` | normalize categories | writes only with `--apply` |
| `clean_product_names.mjs` | strip emojis from names | writes with `--apply` |
| `fill_en_descriptions.mjs` | fill EN descriptions | writes with `--apply` |
| `fill_snoonu_id.mjs` | backfill snoonu_id | **writes** |
| `upload_images.mjs` | upload/link images to Storage | **writes Storage+DB** |
| `download_images.mjs` | download images from Storage | read-only |
| `export_talabat.mjs` | build talabat CSV | read-only |
| `snoonu_real_breakdown.mjs` | diff Snoonu export vs DB | read-only |
| `test_exports.mjs`, `test_snoonu_diff.mjs` | dev tests vs live DB | read-only |
| `test_malak.mjs` | live Anthropic tool loop | read-only DB + **API spend** |
| `run-compliance-audit.ts` | full-catalog compliance audit | writes `compliance_log` (`DRY_RUN=1` to preview) |
| `add_rafeeq_product_id.sql` | SQL migration | manual SQL |

**Root `/home/user/ghost/scripts/`** (shift-app, npm not pnpm): `repair-missing-auth-users.mjs` / `rollback-missing-auth-users.mjs` — write to prod auth via `SUPABASE_URL`+`SUPABASE_SERVICE_ROLE_KEY`, guarded by `DRY_RUN` + explicit `APPLY_*=YES_*` env flags.

**Local run-from-scratch:**
```bash
cd /home/user/ghost/commerce-ai-os
cp .env.local.example .env.local   # fill Supabase URL/anon/service-role, ANTHROPIC_API_KEY,
                                   # MALAK_SIGNING_SECRET, STAFF_PIN, + optional service keys
pnpm install                       # pnpm 10, Node 22
pnpm dev                           # http://localhost:3000 → /dashboard → /login
# Quality gates (mirror CI):
pnpm exec tsc --noEmit             # typecheck (required)
pnpm test                          # 508 tests (required)
pnpm build                         # (required)
pnpm lint                          # eslint --max-warnings 74 (required)
```
Before any DB script, verify `.env.local` URL is `vqstcmattiarhblqshvb` — **never** the frozen `awlevukqqsaxvifrfteb`.

---

# 22. Current Bugs and Incomplete Work

**Markers:** only **1** TODO/FIXME/HACK (`lib/malak/youtube.ts:41`, a false positive). Incomplete work is generally **unmarked**. **`as any` = 185 across 52 files** (heaviest: `inventory/actions.ts` 35, `staff/actions.ts` 24, `api/malak/route.ts` 13) — invisible to CI because `no-explicit-any` is **off**. **~141 swallowed-error patterns** (`catch { /* ignore */ }` / `.catch(() => …)`); 0 truly empty `catch {}`.

**ESLint:** exactly **74 warnings, 0 errors** (at the ceiling — one new warning breaks `lint`). Categories: `react-hooks/static-components` ×31, `react-hooks/set-state-in-effect` ×17, `@typescript-eslint/no-unused-expressions` ×14, `react-hooks/refs` ×4, `exhaustive-deps` ×3, `purity` ×2, `no-unused-vars` ×2, others ×1.

**Placeholders (by design):** `agents/index.ts` (all agents throw "Phase 1 stub"), `components/studio/ModuleScaffold.tsx` (10 studio pages inert), `components/MilestonePlaceholder.tsx`, `content/page.tsx:56` ("image/video coming soon"), `lib/dashboard.ts:27,103` (hard-coded 50-unit inventory placeholder pre-stocktake), `import-export/shopify-actions.ts:60` (Shopify push = prices/stock only).

**Ranked concrete issues:**
| Rank | Issue | Evidence | Impact | Fix |
|---|---|---|---|---|
| **Critical** | Core-table RLS unverifiable; catalog writable via anon client | §23 H1 | full catalog tamper if RLS off | verify RLS on `products/inventory/platform_status/channel_products` in prod |
| **High** | Meta webhook accepts unsigned payloads if `META_APP_SECRET` unset | `webhooks/meta/route.ts:24-26` | forged DM events → service-role writes | set `META_APP_SECRET`; fail closed |
| **High** | Silent Talabat queue failures | `products/actions.ts:288,325` | products never reach Talabat, no error | log + surface retryable error |
| **High** | Scheduled social publish failures swallowed | `cron/publish-social/route.ts:65` | failed post reported as done | record failure state + alert |
| **High** | Shopify import can silently zero stock | `shopify-actions.ts:200` | stock wiped to 0 on parse hiccup | skip row instead of writing 0 |
| **High** | Rewards IDOR (phone-only identity, no OTP) | §23 H3 | enumerate/alter any customer's card | add OTP/rate limit |
| **Medium** | Dashboard inventory KPIs fabricated (50/product) | `lib/dashboard.ts:27,103` | owner sees fake stock/value | gate behind `inventoryTracked` |
| **Medium** | Admin account ops not audit-logged | `team/actions.ts:65-139` | no trail for privilege changes | log to `malak_audit` |
| **Medium** | `set-state-in-effect` ×17 | eslint | cascading re-renders/jank | compute in render/handlers |
| **Medium** | Lint at exact 74 ceiling | `package.json:9` | any new warning fails CI | fix batch, lower ceiling |
| **Low** | 185 `as any`, `no-explicit-any` off | `eslint.config.mjs:31` | type holes invisible to CI | re-enable as warn |
| **Low** | N+1 loops in inventory bulk ops | §24 | slow bulk shelf/stocktake | batch with `.in()` |

No broken imports or crash-inducing dead code found; stubs are isolated.

---

# 23. Security Audit

**Positives:** service-role key is server-only (73 hits, **no Client Component imports it**); no secret misclassified as `NEXT_PUBLIC_`; Shopify OAuth verifies state+HMAC+shop before storing token; no open redirects; APIs same-origin (no permissive CORS); file uploads enforce 10MB + MIME allow-list; SSRF guard (`lib/net/safeImage.ts`) re-validates each redirect hop + blocks numeric-IP encodings.

**CRITICAL / HIGH**
- **H1 (Critical-if-true) — Core tables' RLS unverifiable; written via browser-exposed anon client.** `products, inventory, platform_status, channel_products` have **no RLS/DDL in the repo**. Several actions write via the *anon* client (`import-export/availability-actions.ts:81,119`, `platforms/actions.ts:141,157`, `pure-seoul-actions.ts:33,63`). If any lacks RLS or has an anon-permissive policy, anyone with the public anon key can read/write the catalog. **Must be verified in the live DB.** (`SOURCE_OF_TRUTH.md` claims prod RLS was verified 2026-07-02, but not via the repo.)
- **H2 — Meta webhook fail-open.** `webhooks/meta/route.ts:24-26` `if (!secret) return true` — unsigned POSTs accepted when `META_APP_SECRET` unset → forged DM events trigger service-role writes + `autoReplyDm`. `/api/webhooks` is public.
- **H3 — Rewards IDOR.** `api/rewards/{state,choose,submit}` take `phone` from the body with no ownership proof/OTP (`lib/loyalty/rewards.ts:323-347`). Anyone can enumerate/alter any customer's card by guessing a Qatari number. No rate limit on these three routes.

**MEDIUM**
- **M1** — Admin/staff account ops not audit-logged (`team/actions.ts:65-139`).
- **M2** — Audit log mutable/deletable via service role (`movements.ts:116,148`).
- **M3** — `staff_members` RLS `for all to authenticated using(true)` (`staff_members.sql:19-20`) — any second Supabase user gets all staff PIN hashes + toggle/delete. PINs are unsalted `HMAC(secret,"staff-pin:"+code)` over a 4-8 digit space (brute-forceable if hash + `MALAK_SIGNING_SECRET` leak).
- **M4** — SSRF residual: guard validates hostname strings, not resolved IPs → **DNS-rebinding** to 169.254.169.254 passes (`lib/net/safeImage.ts:60-85`); browse path also allows `http:`.
- **M5** — Shared-secret tokens in URL paths (`TALABAT_WEBHOOK_TOKEN`, `TASKS_ICS_TOKEN`) land in logs/history; no rotation.
- **M6** — `writableClient()` silent fallback to anon RLS client (`inventory/actions.ts:25-31`) — when service key unset, inventory writes/audit inserts run under RLS and may silently affect 0 rows.
- **M7** — Signing-secret coupling: `staff/session.ts:13` & `pin.ts:14` fall back to `SUPABASE_SERVICE_ROLE_KEY` when `MALAK_SIGNING_SECRET` unset — rotating the service key invalidates all sessions/PINs and reuses a high-value secret as an HMAC key.

**LOW:** L1 `dangerouslySetInnerHTML` (single, server-generated QR SVG, safe — `loyalty/qr/page.tsx:53`); L2 verify-token plain `===`; L3 rate limiters fail-open/in-memory + no limit on rewards routes; L4 service-role handling clean; L5 no `NEXT_PUBLIC_` secret; L6 upload type from `file.type` (no magic-byte sniff); L7 no open redirects; L8 `shopify_tokens` RLS no-policy (correct), verify `staff_tasks_gcal` holds no tokens readable via anon; L9 no CORS headers.

---

# 24. Performance Review

- **Full-table loads, no caching:** dashboard loads 5 whole tables every render (`lib/dashboard.ts:96-100` via `fetchAll`) with no `revalidate`/`cache()`. Same pattern in `lib/inventory/{sales,lowStock,analytics}.ts`, `platforms/actions.ts:70` (all variants).
- **Whole-catalog in memory:** `markOutOfStockByNames` (`inventory/actions.ts:1238-1289`) builds a per-row index on every paste, run twice (preview + apply).
- **N+1 loops:** `inventory/actions.ts` bulk ops do per-item select→delete→insert→update→audit (`bulkAssignShelf:650`, `bulkAssignVariantShelf:702`, `applyStocktake:136,211`) — ~5N sequential queries. **Fix: batch with `.in()`/bulk upsert.** (Good patterns exist: `social/actions.ts:281,601,701` use `Promise.all`.)
- **Client polling (6-7 timers):** `Sidebar.tsx:20` (DM count 30s — mounted on **every** page), `NotificationsBell`, `DmMetricsPanel` (30s), `InboxClient` (10s), `MalakClient` (1s clock), `DashboardRefresh` (1s). Consider SWR/visibility-gating.
- **Images: `<img>` everywhere, no `next/image`** (~30 `eslint-disable no-img-element`) — no resize/lazy/AVIF; full-size remote images in grids. **Single biggest front-end perf lever.**
- **Expensive AI calls** un-cached (each is a fresh paid request). No `unstable_cache`/`cache()` anywhere; only `revalidatePath` after writes.
- **Index reliance:** heavy `.eq("inventory_id"/"parent_product_id"/"location")` filters assume indexes on `shelf_stock`/`variant_shelf_stock`/`product_variants` — verify in prod (not defined in repo).

---

# 25. UI and Design System

**Layout:** `app/layout.tsx` sets `<html lang dir>` from a `locale` cookie. `components/AppShell.tsx` decides desktop-vs-mobile via **JS hardware signals** (touch/pointer/width/UA), not CSS media queries (in-app webviews misreport width) → desktop static `Sidebar` (w-64), mobile drawer + `BottomNav`. `Topbar` = title + `NotificationsBell` + `LanguageToggle` + avatar.

**Design tokens (`globals.css` `@theme`):** warm brown/copper luxury palette (`--color-brand:#a8683a`, ink `#3f2a1d`, cream bg `#faf5f0`) despite `violet` var names (all browns). `@utility` primitives: `card`, `btn/btn-primary/btn-ghost`, `input`, `label`, `badge`.

**Fonts:** `public/fonts/` ships Almarai/El Messiri/Marcellus (woff2) — **but they are NOT loaded in the app UI** (no `@font-face`/`next/font`); headings fall to **Georgia serif**, body to system fonts. The webfonts are used only for server-rendered social-ad SVGs (`lib/social/ad-fonts.ts`). **Gap:** Arabic-first UI renders in system/Georgia, not the intended fonts.

**RTL / Arabic:** cookie-based i18n (`lib/i18n.ts`, `DEFAULT_LOCALE="ar"`, `<html dir="rtl">`). Tiny shared `DICT`; most copy is inline `L(ar,en)` and **much is Arabic-only** (CRM/loyalty/many toasts). **`Topbar` is force-`dir="ltr"`** and the drawer always slides from the **physical left** regardless of RTL — won't mirror for Arabic.

**Responsive:** viewport zoom locked (`userScalable:false` — a11y concern); `overflow-x:hidden` + `min-w-0` guards prevent horizontal scroll; wide tables get inner scroll. Generally mobile-considered.

**Dark mode:** effectively **none** (no `prefers-color-scheme`/toggle; `themeColor:#ffffff`). A few stray `dark:` utilities, no system.

**States:** **no route-level `loading.tsx`/`error.tsx`/`not-found.tsx`** anywhere (failures fall to Next defaults); client-level busy/pending common (~75 files); empty states handled at component level (`KpiCard` "No data yet").

**Likely mobile/RTL trouble spots:** force-LTR Topbar; left-only drawer in RTL; Arabic-only strings leave English toggle half-translated; unused Arabic webfonts → inconsistent rendering; `<img>` grids heavy on mobile data; JS pointer heuristic can misclassify desktop touchscreens.

---

# 26. Data Flow by Feature

**A. Owner edits a product price (Malak):**
1. Owner types in `/malak` chat → `MalakClient.tsx` POSTs to `/api/malak`.
2. Claude tool loop calls `set_price` (read tools hit Supabase service-role) → returns a **signed confirm token** (no write yet).
3. UI shows a confirm card → owner taps → POST `/api/malak/commit` (verifies HMAC, single-use).
4. `commit` writes `products` (service role) + inserts `malak_audit`.
5. `revalidatePath` refreshes; `/malak/audit` shows the row.
6. **On failure:** commit returns `"failed"` but the write may already have applied; audit insert is best-effort (swallowed).

**B. Staff marks stock in (PWA):**
1. Staff on `/staff` submits qty → server action `recordStaffMovement` (`app/staff/actions.ts`).
2. `currentStaff()` re-reads perms + `active`; `hasPerm(...,"stock")`.
3. `applyMovement` updates `inventory` + logs `malak_audit` (`agent`=staff name).
4. May create a catalog task; `revalidatePath("/staff")`.
5. **Failure:** returns `{error}`; audit swallowed.

**C. Scheduled Instagram post:**
1. `notify` cron (05:00) → `generateDailySocialPosts` (Gemini reads photo, Claude writes caption) → inserts `social_posts` `pending, approved=false`.
2. Owner at `/social` restyles image, `approveSocialPost` → `approved=true`.
3. `publish-social` cron (Vercel 10:00/17:00 or pg_cron 15-min) selects `approved AND due`, cap 3 → `publishIg` (container→poll→publish).
4. Row → `posted` + `external_id`; feed posts best-effort story mirror.
5. `fetchSocialInsights` reads live stats. **Failure:** story failure swallowed (§22); IG env missing = no-op.

**D. Customer DM auto-reply:**
1. Meta webhook POST → `api/webhooks/meta` (HMAC verify) → `upsertDmConversation` + `insertDmMessage` (dedup on `mid`).
2. If `auto_reply` on → `autoReplyDm`: Claude reply from last 10 turns + matched catalog → `sendInstagramDm` → logs outbound (`ai=true`).
3. Complaint/uncertain → `needs_human=true` (owner sees badge in `/inbox`). **Failure:** flagged for human.

**E. Shopify catalog sync:** `/import-export/shopify-sync` → `ShopifySync.tsx` → `shopify-actions.ts` → `lib/shopify/admin.ts` (Admin GraphQL) diff vs catalog → push prices/stock (cap-chunked); orders deducted from `inventory` via `shopify_synced_orders` idempotency ledger.

---

# 27. Recent Changes

**Branch:** `claude/new-session-nsf53g` @ `458e41a`; working tree **clean** (no uncommitted changes). At audit time this branch is **3 commits behind `master`** because PR #455 was squash-merged to `master` (`277aab7`) after this branch's tip — the branch predates that squash. **No commit/push was performed for this audit.** Repo total: 503 commits.

**Last ~20 commerce-ai-os commits (newest first):**
`458e41a` inventory «الكل نفذ» fix · `25382c5`+`de0a95a` deps override (brace-expansion/sharp/postcss) · `38d1da1` tasks multi-select · `13b6be5` bulk apply images by SKU (#399) · `09f90ec` bilingual option names (#398) · `1c294d4` defer products search filter (INP fix) · `36c89e8` staff new-product AI note · `c89dd12` rewards guide · `9d10e63` seller-note field · `98bea07`/`4ba1b18`/`9c4265a` catalog→platform tasks (#393/#394) · `548cd99` copy-all details (#391) · `2c5d43f` copy/download product image (#390) · `2cd2b6b` catalog auto-task json fix (#389) · `68476d8`/`b1aeac4`/`7aa3e93` loyalty mobile/print (#386-#388) · `420999e`/`75fabab`/`3a0ffb2`/`dd3fdf1`/`bc0e566`/`335e2fe` loyalty prizes/vouchers/WhatsApp (#380-#385).

**Themes:** loyalty rewards buildout, catalog→platform task automation, product copy/image UX, Shopify Phase 4, dependency-security hardening, then the two most recent UX fixes (tasks bulk + inventory bulk switch). Interleaved in full `git log` are **shift-app** commits (leave balances #453/#454) — a different project.

---

# 28. Production Readiness (score /10)

| Area | Score | Why |
|---|---|---|
| Authentication | 8 | Solid Supabase + signed-PIN dual system, fail-closed middleware. −2: no admin RBAC. |
| Authorization | 5 | Staff perms strong (live re-read); admin app has none; RLS not the boundary. |
| Database | 6 | Live & functioning, but base schema not in repo; unversioned manual migrations; `platform_status` DDL only in a comment. |
| Admin panel | 8 | Broad, coherent, working; some placeholder KPIs. |
| AI assistant (Malak) | 8 | Real, confirm-token-gated, audited, injection-hardened. −2: Opus cost, no convo persistence. |
| Studio | 3 | Only video/voice/settings live; 10 placeholder pages. |
| Tasks | 8 | Full CRUD + routines + bulk + ICS. −2: calendar push-only, UTC boundary. |
| Google Calendar sync | 6 | Reliable one-way push; no read-back; silent no-op until migration run. |
| Image generation | 7 | Multi-provider, real, label-fidelity tuned. −3: no cost cap on `/social` paths. |
| Video generation | 6 | FLORA/Higgsfield/Creatomate real but inert until FLORA technique + env set; manual pro-reel path. |
| Social publishing | 5 | IG real & working; TikTok not wired; scheduling needs pg_cron; DM delivery needs Meta approval. |
| Product catalogue | 8 | Rich schema, 5-channel sync, shared inventory, image tooling. |
| Testing | 4 | 508 pure-logic tests; entire I/O boundary untested. |
| Security | 4 | Good primitives, but RLS-unverifiable core tables (H1), webhook fail-open (H2), rewards IDOR (H3), mutable audit log. |
| Monitoring | 2 | Only `console.error` + `malak_audit`; no error tracking/alerting/APM. |
| Deployment | 7 | Vercel + strong CI gate. −3: subdir root-dir dependency, stray `nextjs.yml`, undocumented env. |

---

# 29. Recommended Next Steps

### Immediate (before any new deploy)
| Priority | Step | Files | Risk | Verify |
|---|---|---|---|---|
| P0 | **Verify prod RLS** on `products/inventory/platform_status/channel_products`; fix any anon-permissive policy | prod DB (H1) | catalog tamper | `select tablename from pg_tables where rowsecurity=false` = 0 rows; anon-key write test fails |
| P0 | **Set `META_APP_SECRET`** in prod + make webhook fail-closed | `api/webhooks/meta/route.ts:24-26` | forged events | POST without sig → 401 |
| P0 | **Rewards IDOR**: add OTP or rate-limit + ownership check | `api/rewards/*`, `lib/loyalty/rewards.ts` | data tamper | can't alter card w/o OTP |
| P1 | **Surface swallowed failures** (Talabat queue, social publish, Shopify stock-zero) | `products/actions.ts:288,325`, `cron/publish-social/route.ts:65`, `shopify-actions.ts:200` | silent data loss | inject failure → visible error/row state |
| P1 | **Audit-log admin ops** (enable/disable/delete/perms) + make audit append-only | `team/actions.ts`, RLS trigger | no trail | ops appear in `malak_audit`; UPDATE blocked |
| P1 | **Export & commit base schema** (`products`, …, `platform_status`) as real migrations | new `supabase/*.sql` | un-reproducible DB | fresh project builds from repo |

### Next development phase
- Add admin RBAC (or document single-owner assumption explicitly).
- Introduce error tracking (Sentry) + structured logging + cron/webhook alerting.
- Batch the N+1 inventory bulk ops (`.in()`/bulk upsert); add caching to dashboard reads.
- Test the I/O boundary: server actions, API routes, webhook signature paths.
- Migrate `<img>` → `next/image`; load the bundled Arabic fonts in-app.
- Finish or hide the 10 placeholder Studio pages and the `/agents` stubs.
- Wire the Supabase pg_cron for real social scheduling; document TikTok/Meta approval gates.

### Later improvements
- Two-way Google Calendar sync; Qatar-local routine boundary.
- Dark mode; RTL mirroring for Topbar/drawer; complete AR/EN translations.
- Consolidate fragmented table schemas (`social_posts`, `staff_tasks`) into single sources.
- Split the 1600-1700-line files (`staff/actions.ts`, `inventory/actions.ts`, `api/malak/route.ts`).
- Re-enable `no-explicit-any` as a warning and chip away at 185 casts; lower the lint ceiling below 74.

---

# 30. Handover Summary (read in 5 minutes)

**What this is:** an internal Arabic-first commerce OS for Malika's Universe (Qatar K-beauty), Next.js 16 + Supabase + Claude (Malak). It lives in **`commerce-ai-os/`** (ignore the unrelated Ghost Android framework at repo root and the separate `shift-app/`). Production DB = Supabase `vqstcmattiarhblqshvb`; host = `app.malikasuniverse.com` (Vercel).

**What works:** catalog + shared inventory, Malak AI (confirm-gated, audited), Shopify/Snoonu/Talabat/Rafeeq/Pure-Seoul sync, loyalty rewards, staff PWA, tasks + one-way calendar, Instagram publishing + DM bot, AI image/video/voice generation. **508 pure-logic tests pass; CI gates typecheck/test/build/lint.**

**What doesn't (yet):** 10 Studio pages + `/agents` are placeholders; TikTok not wired; pro-reel video is manual; dashboard inventory KPIs are fabricated pre-stocktake; several failures are silently swallowed; no error monitoring.

**Where to start:** read `SOURCE_OF_TRUTH.md` → `docs/PROJECT_OVERVIEW_AR.md` → `UPDATES.md`. Run `pnpm install && pnpm dev`. Trace one flow end-to-end: `app/api/malak/route.ts` → `/api/malak/commit` → `lib/audit.ts`.

**Most important files:** `SOURCE_OF_TRUTH.md`, `proxy.ts` + `lib/supabase/{middleware,admin,server}.ts`, `app/api/malak/route.ts` + `lib/malak/confirm.ts`, `app/(app)/inventory/actions.ts`, `app/staff/actions.ts`, `lib/staff/permissions.ts`, `lib/shopify/admin.ts`, `lib/types.ts`, `supabase/malak_audit.sql`, `vercel.json` + `.github/workflows/ci.yml`.

**Three most dangerous problems:** (1) **RLS on core catalog tables is unverified and they're written via the browser anon key** — verify in prod immediately (§23 H1). (2) **Meta webhook accepts unsigned payloads if `META_APP_SECRET` is unset** (§23 H2). (3) **Rewards endpoints are an unauthenticated phone-only IDOR** (§23 H3). Runner-up: the **audit log is mutable** and **admin account ops aren't logged**.

**Logical next step:** run the P0 security verifications (§29), then commit the base DB schema so the project is reproducible.

**Do NOT touch before understanding:** the frozen Supabase project `awlevukqqsaxvifrfteb` (never connect it); the `supabase/*_down.sql` and `step11-14`/`delete_sample_data` scripts (destructive/data-mutating); the shift-app `supabase/migrations/` rollback files (sort after their forward migrations); `MALAK_SIGNING_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` (rotating them silently breaks staff sessions, PINs, and all service-role access); the required CI job names in `ci.yml` (a renamed required check blocks all merges).

---

*End of PROJECT_FULL_CONTEXT.md — generated read-only on 2026-07-25. No code, data, migrations, or deployments were modified.*
