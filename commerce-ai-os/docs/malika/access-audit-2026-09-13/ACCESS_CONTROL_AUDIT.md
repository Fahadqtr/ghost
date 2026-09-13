# ACCESS CONTROL AUDIT — RLS, Auth and Proxy
**Date:** 2026-09-13 · **Scope:** STEP SYSTEM ACCESS AUDIT 01 · **Mode:** READ-ONLY on production

    CURRENT_MASTER              f54c2d8f7e546536985df61dfc6ccc6de9a41acc
    PRODUCTION_DEPLOY_COMMIT    UNKNOWN (host app.malikasuniverse.com confirmed serving; commit not exposed)
    Supabase project            vqstcmattiarhblqshvb
    pnpm audit at this commit   No known vulnerabilities found (exit 0) — checkpoint re-verified

    PRODUCTION_WRITES 0 · PERMISSION_CHANGES 0 · USER_CHANGES 0
    EMAILS_SENT 0 · MARKETPLACE_WRITES 0 · DELETIONS 0

Evidence labels used throughout: **PROVEN_FROM_POLICY** (derived deterministically from
grants/policy definitions read from the live catalog) · **TESTED** (observed directly) ·
**INFERRED** (follows from documented Postgres behaviour but not executed) ·
**NOT_VERIFIED**.

---

## 0. Corrections to earlier reporting

This audit contradicts three claims made in earlier steps of this project. The earlier
claims were wrong or too coarse; the corrections below are what the live catalog says.

| Earlier claim | Correction |
| --- | --- |
| "RLS is enabled on all 53 tables but every policy is `{authenticated}` + `USING(true)`" | Half right. Every policy *is* `{authenticated}`-scoped — **no policy anywhere targets `anon`** — but they are **not** all `USING(true)` ALL policies. 21 tables carry blanket `ALL/true`; 12 carry SELECT-only or INSERT-only policies; **18 tables carry no policy at all**, which under RLS means deny-all. Four tables are correctly restricted at the *grant* level. |
| "4 un-gated mutating API routes" / my own later grep suggesting 3 | **0.** All three routes my pattern flagged (`/api/export/images`, `/api/malak/browse`, `/api/malak/upload`) gate inline with `createClient().auth.getUser()` + 401. The pattern missed them because they do not import a named `require*` helper. |
| "`middleware-manifest.json` builds empty — the Supabase session-refresh proxy may not be running" | **Disproven.** The proxy runs. See §6. |

---

## 1. The auth model as actually implemented

| Role | Identity verified where | Permission source | Who can change it |
| --- | --- | --- | --- |
| **Owner** | `getUser()` server-side (`lib/malak/authz.ts:46`) | Hardcoded `OWNER_EMAIL = "clanqtr@gmail.com"` (`authz.ts:8`) | Code change + deploy |
| **Writer / staff** | `getUser()` (`authz.ts:24`) | `MALAK_WRITER_EMAILS` env, union with owner | Whoever controls Vercel env vars |
| **Any signed-in user** | `getUser()` | Supabase session | Supabase Auth |
| **Unauthenticated** | n/a | `PUBLIC_PATHS` in `lib/supabase/middleware.ts:18` | Code change |
| **Cron** | `CRON_SECRET` bearer | env | Vercel env |
| **Webhooks** | token in path | env/DB | server |
| **Service processes** | `SUPABASE_SERVICE_ROLE_KEY` (`lib/supabase/admin.ts`) | bypasses RLS | Vercel env |

Identity is verified correctly. `getUser()` revalidates the token against Supabase Auth
rather than trusting a decoded JWT, and the owner email is read from the server-side
session — never from client input. The owner is unioned into the writer set so a
misconfigured env cannot lock the owner out. All of that is sound.

**The structural problem is the gap between the application's roles and the database's
role.** "Owner" and "writer" exist *only in application code*. To Postgres there is one
interactive identity: `authenticated`. Any account that holds a valid Supabase session is
`authenticated`, whether or not it appears in `MALAK_WRITER_EMAILS`. So every
authorization decision made by `requireMalakWriter` / `requireOwner` is enforced only on
the path that goes through the Next.js server — and the Data API is a second path that
does not.

`auth.users` currently holds **1** confirmed user (email provider, 0 created in the last
30 days), so there is no second account to abuse today. That is a fact about the present
population, not a property of the configuration, and per the step's own instruction it is
not treated as making broad permissions safe.

**Signup configuration: `UNKNOWN`.** It is not readable via SQL or the tools available
here, and establishing it by attempting a registration would create a production user,
which this step forbids. This is the single most consequential unknown in the audit: if
self-registration is open, every finding in §3 marked "any signed-in account" becomes
reachable by any member of the public who registers. **Owner decision required.**

Supabase's own linter additionally reports **leaked-password protection disabled**
(HaveIBeenPwned check off).

---

## 2. Database access — what the effective combination actually allows

Two independent mechanisms decide Data API access: the **grant** and the **policy**. A
role needs both. Reading them together produces four distinct groups, and only one is a
real problem.

### Group A — blanket write access to `authenticated` (21 tables) — **THE MAIN RISK**

`ALL` policy, `USING(true) WITH CHECK(true)`, `{authenticated}`, plus full DML grants:

`agent_logs`, `brands`, `channel_products`, `channels`, `customers`, `expenses`,
`import_batches`, `malak_audit`, `marketing_posts`, `orders`, `platform_status`,
`product_archive`, `product_categories`, `product_images`, `products`,
`pure_seoul_status`, `shelf_slots`, `staff_tasks`, `task_comments`, `task_routines`,
`tasks`.

Any account with a session can `SELECT`, `INSERT`, `UPDATE`, `DELETE` every row of these
tables directly through the Data API, using only the public anon key plus its own JWT —
without ever touching the Next.js server, and therefore without passing
`requireMalakWriter` or `requireOwner`.

The most sensitive members of this group are **`customers`** (customer PII),
**`orders`**, **`expenses`** (financial records), and **`malak_audit`** — the audit trail
itself, which is `UPDATE`- and `DELETE`-able by any signed-in account. An audit log that
the actors it records can rewrite provides no forensic guarantee.

`products` additionally carries **two identical** `ALL/true` policies
(`authenticated_all_products` and `products_authenticated_all`) — redundant, and a sign
these accumulated rather than being designed.

### Group B — read-only to `authenticated` (12 tables) — appropriate

SELECT-only (and in two cases INSERT-only) policies: `channel_variant_mappings`,
`compliance_log`, `compliance_rules`, `export_runs`, `external_channel_listings`,
`loop_log`, `loop_state`, `platform_snapshots`, `rafeeq_packages`,
`rafeeq_package_items`, `shelf_stock`, `talabat_orders`, `variant_shelf_stock`.

Writes to these already happen server-side under the service role. This is the intended
shape.

### Group C — grant-restricted (4 tables) — the correct pattern, already in use

`product_variants`, `inventory`, `shelf_stock`, `variant_shelf_stock`: **no grant to
`anon` at all**, and only `SELECT` to `authenticated`.

Note a useful detail: `product_variants` and `inventory` each carry an `UPDATE` policy,
but the grant omits `UPDATE`, so **the update is denied** — the grant is the binding
constraint. These policies are currently inert. Anyone tightening grants elsewhere must
not "tidy up" by granting `UPDATE` here, which would silently activate them.

### Group D — RLS with no policy (18 tables) — deny-all, and that is protective

`app_settings`, `dm_conversations`, `dm_messages`, `kpi_snapshots`, `loyalty_customers`,
`loyalty_prizes`, `loyalty_submissions`, `push_subscriptions`,
`rafeeq_email_deliveries`, `rafeeq_package_jobs`, `shopify_synced_orders`,
**`shopify_tokens`**, `snoonu_sync_audits`, `social_posts`, `staff_members`,
`talabat_email_deliveries`, `talabat_package_jobs`, `talabat_queue`.

Supabase's linter flags these as `rls_enabled_no_policy` at INFO level. In this codebase
that pattern is deliberate and correct: these tables are reached only by the service
role, and RLS-with-no-policy denies `anon` and `authenticated` outright. **`shopify_tokens`
(OAuth credentials) and `staff_members` are protected by exactly this mechanism** despite
carrying broad grants. No change recommended.

### The `anon` grants

~45 tables, plus `storage.objects`, grant full DML to `anon`. Today this is inert,
because **no policy anywhere targets `anon`**, and RLS denies what no policy permits.

That is a single point of failure rather than a defence. The day anyone adds a policy
written `FOR ALL USING (true)` without a `TO authenticated` clause — the Postgres default
is `TO PUBLIC`, which includes `anon` — every one of those tables becomes world-writable
in the same instant. The grants should be revoked so that the policy layer is not the
only thing standing between the public internet and the catalog.

---

## 3. The one live unauthenticated exposure: `loop_board`

`public.loop_board` is a **view owned by `postgres` with `security_invoker` unset**. Such
a view executes with its owner's privileges, so the RLS on its base table does not apply
to the querying role. It holds **full DML grants to both `anon` and `authenticated`**.

    SELECT loop_key, agent_key, status, goal, next_action, run_count, updated_at,
           now() - updated_at AS staleness
    FROM loop_state ORDER BY (CASE status ... END), updated_at DESC;

`loop_state` itself is correctly limited to a SELECT-only policy for `authenticated`. The
view bypasses that.

- **Read:** unauthenticated callers can read agent-orchestration state (`loop_key`,
  `agent_key`, `status`, `goal`, `next_action`, `run_count`). `PROVEN_FROM_POLICY`.
- **Write:** the view is a single-table projection with no aggregate/DISTINCT/GROUP BY, so
  Postgres treats it as **auto-updatable**; the computed `staleness` column does not
  prevent this for the remaining columns. Combined with the `anon` INSERT/UPDATE/DELETE
  grants and owner-privilege execution, unauthenticated writes to `loop_state` are the
  expected consequence. Marked **INFERRED**, not TESTED — verifying it would require a
  production write, which this step forbids.

Supabase's own database linter reports this independently as its **only ERROR-level
security finding**: `security_definer_view` on `public.loop_board`.

Business impact is operational rather than commercial: no customer PII, pricing or
catalog data is exposed through this view. It leaks internal automation metadata and
offers an unauthenticated handle on the agent loop's state.

---

## 4. Server-side privileged access

`createAdminClient()` (service role, RLS-bypassing) is referenced from **175 modules**,
**46 of them under `app/`**. Spot-inspection of the mutating API surface found:

- **0** mutating API routes without an authentication gate. Every `POST`/`PUT`/`PATCH`/
  `DELETE` route handler verifies a session, either through a named `require*` helper or
  inline via `createClient().auth.getUser()` + 401.
- Gate *strength* varies, and that is the meaningful observation. Several privileged
  operations gate only on "signed in", not on writer/owner. `POST /api/malak/upload` is
  the clearest example: it checks `getUser()` only, then uses the **service role** to
  write into the public `product-images` bucket (10 MB cap, MIME allow-list). Any signed-in
  account can therefore place files in the public bucket.
- Owner-only operations that have external effect — channel email sends, marketplace
  publishes — are correctly behind `requireOwner`, which `MALAK_WRITER_EMAILS` does not
  satisfy.

---

## 5. Views, functions and direct API access

- **Functions:** 25 `SECURITY DEFINER` functions, all owned by `postgres`, **all with an
  explicit `search_path=public, pg_temp`**, and all with `PUBLIC EXECUTE revoked` — ACLs
  read `postgres=X/postgres service_role=X/postgres`. They are **not** callable by `anon`
  or `authenticated` through the Data API. This surface is clean and was verified against
  `pg_proc.proacl` rather than assumed from the absence of a named grant.
- `set_updated_at` (trigger function, `SECURITY INVOKER`) has **no `search_path` set** —
  linter WARN. Low severity given it is invoker-rights and trigger-only.
- **Views:** one view, `loop_board` — see §3.
- **Extension:** `pg_net` installed in `public` — linter WARN, hardening nit.
- **Could a signed-in staff user bypass UI restrictions through the database API?**
  **Yes, for the Group A tables** — `PROVEN_FROM_POLICY`. Not demonstrated by execution:
  no production data was read beyond schema/metadata and aggregate counts, and no writes
  were attempted.

---

## 6. `proxy.ts` — resolved: **WORKING**

The earlier "empty `middleware-manifest.json`" concern is explained and closed. Evidence,
in the order it was gathered:

1. **The convention exists in the installed version.** Next 16.3.3's compiled
   `dist/lib/constants` defines `PROXY_FILENAME = "proxy"` alongside
   `MIDDLEWARE_FILENAME = "middleware"`.
2. **The earlier empty manifests came from builds that aborted.** Both prior builds failed
   at prerender on the missing-Supabase-env guard. Re-running the build locally with
   placeholder env values completed successfully (`BUILD_EXIT=0`), and its route table
   prints **`ƒ Proxy (Middleware)`**.
3. **`middleware-manifest.json` is vestigial in Next 16** — it stays `{"middleware":{}}`
   even on that successful build. The proxy is registered in
   **`.next/server/functions-config-manifest.json`**, which carries the exact matcher
   regexp compiled from `proxy.ts`'s `config.matcher`. Looking at the legacy file was
   simply looking in the wrong place.
4. **Runtime behaviour on the live host**, unauthenticated, read-only (`TESTED`):

   | Path | Result |
   | --- | --- |
   | `/v2/catalog` | `307 → /login` |
   | `/v2/settings/email` | `307 → /login` |
   | `/v2/operations/channels/rafeeq-package` | `307 → /login` |
   | `/api/export/rafeeq/package/jobs` | `307 → /login` |
   | `/login` | `200` |
   | `/staff` | `200` (public, shared-PIN gate) |
   | `/rewards` | `200` (public, customer loyalty) |
   | `/manifest.webmanifest` | `200` (matcher-excluded, not redirected) |

Protected pages **and** protected API routes redirect; public paths serve; excluded static
paths are untouched. Session handling is sound: `getUser()` revalidates server-side, and
missing Supabase env in production **fails closed** (`lib/supabase/middleware.ts:43-50`).

    PROXY_RUNTIME_STATUS = WORKING

No code change is warranted, and specifically none should be made to force the legacy
manifest to be non-empty.

---

## 7. Summary of confirmed risks

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| ACC-01 | HIGH | `loop_board` SECURITY DEFINER view grants `anon` full DML and bypasses `loop_state` RLS | PROVEN_FROM_POLICY + linter ERROR |
| ACC-02 | HIGH | 21 tables give any signed-in account full DML via Data API, bypassing app authorization — incl. `customers`, `orders`, `expenses` | PROVEN_FROM_POLICY |
| ACC-03 | HIGH (conditional) | Supabase self-registration setting UNKNOWN; if open, ACC-02 is publicly reachable | NOT_VERIFIED |
| ACC-04 | MEDIUM | `malak_audit` is UPDATE/DELETE-able by any signed-in account — audit trail tamperable | PROVEN_FROM_POLICY |
| ACC-05 | MEDIUM | `anon` holds full DML grants on ~45 tables + `storage.objects`; inert only because no policy targets `anon` | PROVEN_FROM_POLICY |
| ACC-06 | MEDIUM | Leaked-password protection disabled | Supabase linter |
| ACC-07 | LOW | `/api/malak/upload` uses service role behind a signed-in-only gate | TESTED |
| ACC-08 | LOW | Duplicate identical `ALL/true` policies on `products` | PROVEN_FROM_POLICY |
| ACC-09 | LOW | `set_updated_at` has a mutable `search_path` | Supabase linter |
| ACC-10 | LOW | `pg_net` installed in `public` schema | Supabase linter |

Explicitly **not** risks, having been checked: the 18 no-policy tables (deny-all, and the
mechanism protecting `shopify_tokens`), `storage.objects` (RLS on, 0 policies — private
buckets safe), the SECURITY DEFINER function surface (PUBLIC EXECUTE revoked), the
mutating API surface (0 ungated), and the proxy (working).

Remediation is in `ACCESS_REMEDIATION_PLAN.md`. Nothing was implemented in this step.
