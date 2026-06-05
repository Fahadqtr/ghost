# Commerce AI OS — Phase 1 Milestone Tracker

Build order: **M0 → M1 → (M2 skipped, schema already done) → M3 → M4 → M5 → M6**

Scope guardrail: Phase 1 = UI + schema + placeholders ONLY. No real commerce APIs,
no agent AI logic, no paid services.

| Milestone | Description | Status |
|-----------|-------------|--------|
| M0 | Setup — toolchain, subfolder, env template | ✅ Done |
| M1 | Scaffold & clean architecture (Next.js + Tailwind) | ✅ Done |
| M2 | Schema (15 tables, seeds) | ⏭️ **Skipped — already created & seeded in Supabase** |
| M3 | Auth + CEO Dashboard | ✅ Done |
| M4 | Core pages (Product Hub, Inventory, Channels, Agents) | ⬜ Pending |
| M5 | Import / Export placeholders | ⬜ Pending |
| M6 | Seed sample data + final QA + README | ⬜ Pending |

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
