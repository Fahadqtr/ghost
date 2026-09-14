# ACC-02 — authenticated DML review (READ-ONLY, 2026-09-14)

Companion to `ACCESS_CONTROL_AUDIT.md`. Nothing was changed: no production write, no
permission change, no migration. Table-by-table data is in `ACC-02_TABLE_INVENTORY.csv`.

## 1. Re-measured, not reused

The earlier audit said "approximately 21 tables". Re-measured from production with
`has_table_privilege` and `pg_policies` rather than carried forward:

| Measure | Count |
| --- | --- |
| Tables granting `authenticated` any of INSERT/UPDATE/DELETE | **50** |
| …of those, with a matching write **policy** (effective full write) | **21** |
| …effective **INSERT-only** (`export_runs`, `platform_snapshots`) | **2** |
| …grants present but **no write policy → writes already denied** | **27** |

The 21 figure reproduces exactly. Two refinements the earlier count missed: `export_runs`
and `platform_snapshots` are effectively **INSERT-only**, and 27 tables carrying the same
grants are already inert because RLS denies what no policy permits. **Effective total
needing attention: 23** (21 + 2), minus `malak_audit` which is excluded here → **22**.

## 2. The correction that matters most

The earlier audit led with `customers`, `orders` and `expenses` as the crown jewels. Row
counts say otherwise:

    customers  0 rows      orders  0 rows      expenses  0 rows

They are **empty**. Their *schemas* are sensitive (`customers`: name/phone/email;
`orders`: customer_id/total/status; `expenses`: category/amount/note), so they stay HIGH
by classification and must be fixed before data lands — but they are not today's
exposure. The data actually at risk is the **catalogue and operational state**:

    platform_snapshots 7797 · platform_status 6120 · channel_products 5596
    product_images 2644 · staff_tasks 1580 · products 1530 · product_archive 395

`products` carries `cost`, `price`, `discount_price`, `stock_quantity`, `notes`,
`approval` — margin-bearing commercial data, and the single highest-value target.

## 3. Application consumers — the finding that shapes the fix

Both `lib/supabase/client.ts` (browser) and `lib/supabase/server.ts` (cookie) use the
**anon key**, so both act as DB role `authenticated`. Only `lib/supabase/admin.ts` is
service-role.

**`DIRECT_BROWSER_WRITE = NO` for every table.** Five files import the browser client
(login, password recovery, Rafeeq upload, reel/story publishers) and **none of them
write** — verified by inspection, not grep alone.

**But six server actions write as `authenticated`, not via service-role.** These files
import no admin client at all:

| File | Table | Op | App-level gate |
| --- | --- | --- | --- |
| `app/(app)/catalog/health/actions.ts` | `products` | DELETE | `requireOwner` |
| `app/(app)/catalog/enrich/actions.ts` | `products` | UPDATE | `requireUser` / `isSignedIn` |
| `app/(app)/platforms/actions.ts` | `products`, `platform_status` | UPDATE, UPSERT | inline `getUser()` (signed-in) |
| `app/(app)/import-export/availability-actions.ts` | `platform_status` | UPSERT | `requireMalakWriter` |
| `app/(app)/channels/actions.ts` | `channel_products` | INSERT | `requireMalakWriter` |
| `app/(app)/agents/actions.ts` | `agent_logs` | INSERT | `requireUser` |

Note on `platforms/actions.ts`: a name-based grep reports no gate, but inspection shows
all three write-bearing actions gate inline with `sb.auth.getUser()` + an early return
(lines 88/130/178). It is gated at "any signed-in user", **not** ungated.

**Consequence:** revoking `authenticated` INSERT/UPDATE/DELETE on `products`,
`platform_status`, `channel_products` or `agent_logs` **would break live server actions**.
Those four cannot be locked without a code change moving the write to the admin client.
The other 18 write only through service-role paths and can be tightened with no code
change at all.

## 4. Effective risk

For all 21 full-write tables and 2 insert-only tables the answer to *"could any
authenticated account INSERT/UPDATE/DELETE directly through the Data API, bypassing the
application UI and its `requireMalakWriter`/`requireOwner` gates?"* is **YES**.

Evidence class: **PROVEN_FROM_GRANT_POLICY** — grant and permissive `USING(true)
WITH CHECK(true)` policy both read from the live catalog. Not runtime-tested: proving a
write would require a production write, which this step forbids.

The application's owner/writer roles exist only in TypeScript. Postgres sees one
interactive identity, `authenticated`, and the Data API is a second door that never
passes through those gates.

## 5. Self-registration — UNKNOWN, not assumed

    SELF_REGISTRATION = UNKNOWN

What was checked:

- `GET /auth/v1/settings` on the project → **HTTP 401**, `"No API key found in request"`.
  Determining it would mean obtaining and using the anon key; not done.
- **No `supabase/config.toml`** in the repository.
- **No `signUp()` call anywhere** in `app/`, `lib/` or `components/`; `LoginForm.tsx`
  offers only `signInWithPassword` and `resetPasswordForEmail`.
- `auth.users` = 1 confirmed user, email provider, **0 created in the last 30 days**.

That establishes the *application* exposes no signup path. It does **not** establish the
project-level Auth setting, which is independent of the app. Creating a test user would
settle it and is forbidden. So it stays UNKNOWN, and severity is reported conditionally:

| | Severity | Reasoning |
| --- | --- | --- |
| `SEVERITY_IF_INVITE_ONLY` | **MEDIUM** | Exploitation needs an account the owner issued. It is a privilege boundary between owner and future staff, and a latent risk the first time a second account exists. |
| `SEVERITY_IF_PUBLIC_SIGNUP` | **CRITICAL** | Anyone on the internet registers, becomes `authenticated`, and gains full DML over 1530 products (incl. cost/price), 5596 channel mappings, 2644 images and 6120 status rows — no UI, no gate. |

**This single setting is the difference between MEDIUM and CRITICAL.** It should be
confirmed in the Supabase dashboard before anything else in this plan is scheduled.

## 6. Fix groups

**A — owner-write, currently empty, fix before data lands (3):** `customers`, `orders`,
`expenses`. No code writes them today; tightening is free.

**B — owner/writer-write via service-role, safe to restrict now (5):** `product_images`,
`product_archive`, `brands`, `product_categories`, `channels`.

**C — operational, service-role only, safe to restrict now (6):** `shelf_slots`,
`pure_seoul_status`, `import_batches`, `marketing_posts`, `tasks`, `task_comments`,
`task_routines`.

**D — INSERT-only, already narrow (2):** `export_runs`, `platform_snapshots`. Lowest
priority; consider whether even the INSERT is still needed.

**E — already denied, no action (27):** grants present but no write policy. Includes
`shopify_tokens`, `staff_members`, `app_settings`, the loyalty tables and the channel
job/delivery tables. **Do not "fix" these** — they are already correct.

**F — needs a code change first (4):** `products`, `platform_status`, `channel_products`,
`agent_logs`. Locking these requires moving six server actions onto the admin client.

**EXCLUDED:** `malak_audit` (ACC-04, separate), `loop_board`/`loop_state` (ACC-01, done).

## 7. Phased plan

**ACC-02A — empty high-sensitivity tables** · `customers`, `orders`, `expenses`
Revoke `authenticated` INSERT/UPDATE/DELETE; replace `ALL` policy with SELECT-only.
Code change: none. Migration: yes. Breakage risk: **very low** — nothing writes them and
they hold no rows. Owner decision: whether staff may *read* customer PII. Rollback:
re-create the prior `ALL` policy and re-grant, recorded verbatim in the CSV.

**ACC-02B — catalogue support tables** · `product_images`, `product_archive`, `brands`,
`product_categories`, `channels`
Same shape. Code change: none (writes already go through admin). Migration: yes.
Breakage risk: **low**, but each write path should be re-confirmed as admin-client before
executing. Tests: catalogue edit, image upload/download, channel preview, package build.

**ACC-02C — operational tables** · `shelf_slots`, `pure_seoul_status`, `import_batches`,
`marketing_posts`, `tasks`, `task_comments`, `task_routines`
Same shape. Breakage risk: **low**. Tests: task board, shelf assignment, import flows.

**ACC-02D — insert-only** · `export_runs`, `platform_snapshots`
Decide whether client INSERT is still required; if not, revoke. Breakage risk: low but
non-zero (7797 rows suggest something writes snapshots regularly — confirm the writer
first).

**ACC-02E — the four that need code first** · `products`, `platform_status`,
`channel_products`, `agent_logs`
Two steps, in order: (1) move the six server actions to `createAdminClient()`, keeping
their existing `requireOwner`/`requireMalakWriter`/`requireUser` gates as the real
authorization; (2) only then revoke the grants and narrow the policies. Doing (2) first
breaks catalogue delete, enrich, platform approval, availability sync, channel mapping
and agent logging. Migration: yes, after the code ships. **This phase carries the real
workflow risk and should be last.**

Across every phase the owner cannot be locked out of the application: the server
authenticates server-side and the service role bypasses RLS. The risk is a feature
silently losing a write path, which is why ACC-02E is sequenced behind a code change.

## 8. Top 5 to fix first

1. **`products`** (1530 rows; cost/price/stock) — highest-value data, but in group F:
   needs the code change first. Highest priority *to schedule*, not to execute first.
2. **`channel_products`** (5596) — marketplace mappings; corruption causes duplicate or
   mis-priced listings. Also group F.
3. **`customers`** (0 rows, HIGH schema) — free to fix now, before data lands.
4. **`orders`** (0 rows, HIGH schema) — same.
5. **`expenses`** (0 rows, HIGH schema) — same.

**Recommended first phase to execute: ACC-02A.** It removes three HIGH-classification
tables from the exposed set with zero code change, zero rows at risk and effectively zero
breakage risk — while the group-F code work is planned and D-1 is confirmed.

## 9. Exclusions honoured

    MALAK_AUDIT_TOUCHED     = NO   (1188 rows, still ALL/true for authenticated; ACC-04)
    LOOP_BOARD_STILL_SECURE = YES  (acl: postgres + authenticated=rm + service_role;
                                    anon absent; reloptions {security_invoker=true};
                                    has_table_privilege(anon,SELECT) = false)
    ACC-05 (~45-table anon default grants) — not addressed here.
