# Commerce AI OS — Phase 1 Milestone Tracker

Build order: **M0 → M1 → (M2 skipped, schema already done) → M3 → M4 → M5 → M6**

Scope guardrail: Phase 1 = UI + schema + placeholders ONLY. No real commerce APIs,
no agent AI logic, no paid services.

| Milestone | Description | Status |
|-----------|-------------|--------|
| M0 | Setup — toolchain, subfolder, env template | ✅ Done |
| M1 | Scaffold & clean architecture (Next.js + Tailwind) | ⬜ Pending |
| M2 | Schema (15 tables, seeds) | ⏭️ **Skipped — already created & seeded in Supabase** |
| M3 | Auth + CEO Dashboard | ⬜ Pending |
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
