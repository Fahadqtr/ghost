# ACC-01 — `loop_board` exposure closed (applied 2026-09-13)

Companion to `ACCESS_CONTROL_AUDIT.md` and `ACCESS_REMEDIATION_PLAN.md`. Those two
files record the exposure as it was found and are **left unmodified** — the finding was
real, and this document records the fix rather than editing the evidence away.

Owner-approved **Option A** from the remediation plan: authenticated-only read plus
`security_invoker = true`. Applied via
`supabase/migrations/20260913000000_loop_board_authenticated_only.sql`.

## Root cause

`public.loop_board` is a **VIEW** over `public.loop_state` (not a table — so it never had
RLS or policies of its own). It was created without `security_invoker`, so it executed
with the privileges of its owner, `postgres`. Because `loop_state` has
`force_rls = false`, the owner is not subject to that table's row-level security, so
every query routed through the view **bypassed `loop_state`'s RLS**.

The view also carried Supabase's default blanket schema grants — `arwdDxtm` to both
`anon` and `authenticated` — and PostgreSQL reports it as auto-updatable
(`is_updatable = YES`, `is_insertable_into = YES`). Every `NOT NULL` column of
`loop_state` is either exposed by the view or defaulted (`id` is `GENERATED ALWAYS AS
IDENTITY`, `context` defaults `'{}'`, `status` `'idle'`, `run_count` `0`, `updated_at`
`now()`), so an unauthenticated caller could read `loop_state` through the view and also
insert, update and delete rows in it.

The grants were never a deliberate decision: `supabase/loop_state_layer.sql` contains no
`GRANT` statements at all, and its own comment states the intended model — service-role
writes, signed-in users read, **no client-side writes**, `anon` not a consumer.

## Before → after

| | Before | After |
| --- | --- | --- |
| `relacl` | `postgres=arwdDxtm/postgres` `anon=arwdDxtm/postgres` `authenticated=arwdDxtm/postgres` `service_role=arwdDxtm/postgres` | `postgres=arwdDxtm/postgres` `authenticated=rm/postgres` `service_role=arwdDxtm/postgres` |
| `reloptions` | `(none)` — runs as owner | `{security_invoker=true}` — runs as caller |
| anon SELECT / INSERT / UPDATE / DELETE | allowed | **denied** (`has_table_privilege` false ×4) |
| authenticated SELECT | allowed | allowed |
| authenticated INSERT / UPDATE / DELETE | allowed | **denied** |
| service_role | full | full (unchanged) |
| `loop_state` policies | `loop_state_read_authenticated` SELECT/{authenticated}/true | **unchanged** |
| `loop_state` grants, RLS flags | unchanged | **unchanged** |
| `loop_state` rows | 0 | 0 |
| Supabase linter | 1 ERROR (`security_definer_view`) | **0 ERROR** |

Note: `authenticated` retains `rm` — `r` = SELECT (intended) and `m` = MAINTAIN, a
PostgreSQL 17 privilege covering ANALYZE/VACUUM/REINDEX/CLUSTER. `MAINTAIN` was not in
the approved revoke list so it was deliberately left in place; it conveys no read or
write of data beyond SELECT. Revoking it would be a separate, owner-approved change.

## Defence in depth

The two halves reinforce each other. Even if the grants were somehow restored,
`security_invoker = true` makes the view honour `loop_state`'s RLS — and `loop_state` has
**no INSERT/UPDATE/DELETE policy at all**, so writes through the view are denied
independently of the ACL.

## Scope

`public.loop_board` ACL and `reloptions` only. No `loop_state` policy or grant change, no
other object, no rows touched, no application code change. The wider default-grant issue
on ~45 other tables (**ACC-05**) is deliberately **not** addressed here and remains open
for a separate owner-reviewed phase.

## Rollback

`supabase/migrations/20260913000001_loop_board_authenticated_only_down.sql` restores the
exact pre-change ACL and unsets `security_invoker`. No rows are touched either way, so
the rollback is lossless. Running it reopens the unauthenticated read/write path; it
exists for reversibility, not because reverting is advisable.

## Verification performed

- Pre-write re-verification of all six STEP ACCESS 02 facts against production — all matched.
- Transactional dry run (apply → assert → forced `RAISE EXCEPTION` → rollback), then a
  re-read proving production was untouched before the real apply.
- Post-apply re-read: `has_table_privilege` for anon and authenticated across
  SELECT/INSERT/UPDATE/DELETE; view kind, owner, columns and `reloptions`; `loop_state`
  policies, ACL, RLS flags and row count.
- Supabase security linter re-run: the `security_definer_view` ERROR is gone.
- loop tests 17/17 · auth+RLS tests 368/368 · full suite 5530/5530 · typecheck 0 errors ·
  lint 73 warnings / 0 errors (unchanged baseline).

No production rows were written, no policies were created or dropped, no users or auth
settings were changed, and no catalog, channel or email data was touched.
