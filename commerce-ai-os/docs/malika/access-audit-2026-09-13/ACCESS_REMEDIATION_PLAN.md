# ACCESS REMEDIATION PLAN — proposal only, nothing implemented

**Date:** 2026-09-13 · Companion to `ACCESS_CONTROL_AUDIT.md` · **No migration applied, no PR opened.**

Proxy fixes, application-authorization fixes and database-policy changes are kept in
separate stages so they stay independently reviewable and independently revertable. There
is deliberately **no blanket "replace every policy" migration** here — the tables differ,
and 34 of the 55 rows in the inventory need no change at all.

OPS-01 (Talabat job cleanup) is untouched, as instructed.

---

## Stage 0 — Owner decisions that gate everything else

Nothing below should be executed before these are answered, because the answers change
what the right fix *is*.

**D-1 — Is Supabase self-registration open?** (blocking, `ACC-03`)
Not readable from this session, and testing it would create a production user. If open,
`ACC-02` is reachable by any member of the public who registers, which moves it from
"internal privilege boundary" to "internet-facing". If closed/invite-only, `ACC-02` is a
defence-in-depth issue about future staff accounts. **Recommendation:** confirm it is
invite-only in the Supabase dashboard before anything else. This is a dashboard setting,
not a migration.

**D-2 — What may a staff account (a second Supabase login) actually do?**
The remediation needs a decision, not a guess. Specifically: may staff *read* customer
PII (`customers`) and `orders`? May staff edit catalog rows directly, or only through the
app? Nothing in this plan invents staff permissions as pre-approved business rules — the
matrix marks each as `DECIDE`.

**D-3 — Should `malak_audit` become append-only?** (`ACC-04`)
Recommended: yes. An audit trail that the actors it records can `UPDATE`/`DELETE` gives no
forensic guarantee.

---

## Stage 1 — `loop_board` (ACC-01) · RECOMMENDED FIRST FIX

    ID                      ACC-01
    SEVERITY                HIGH
    EXACT OBJECT            public.loop_board (view, owner postgres, security_invoker unset)
    EVIDENCE                PROVEN_FROM_POLICY; Supabase linter ERROR security_definer_view
    AFFECTED ROLE/ACTION    anon (unauthenticated): SELECT proven; INSERT/UPDATE/DELETE inferred
    BUSINESS IMPACT         Unauthenticated disclosure of agent-orchestration state and an
                            unauthenticated write handle on loop_state. No PII, pricing or
                            catalog data. Operational, not commercial.
    MINIMUM PROPOSED FIX    REVOKE ALL ON public.loop_board FROM anon;
                            REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
                              ON public.loop_board FROM authenticated;   -- keep SELECT
                            ALTER VIEW public.loop_board SET (security_invoker = true);
    MIGRATION_REQUIRED      YES (one migration, 3 statements, no data touched)
    LOCKOUT/BREAKAGE RISK   LOW. Nothing in the repository reads loop_board through the
                            anon key; server paths use the service role, which is
                            unaffected by both the grant and security_invoker. With
                            security_invoker=true the view begins honouring loop_state's
                            existing SELECT-for-authenticated policy, which is the intent.
    REGRESSION_TESTS        1) anon key SELECT on loop_board -> expect permission denied/empty
                            2) authenticated SELECT -> still returns rows
                            3) service-role SELECT -> unchanged
                            4) any operations dashboard reading loop state -> renders
    ROLLBACK_PLAN           Re-GRANT the prior privileges and
                            ALTER VIEW ... SET (security_invoker = false).
                            Fully reversible; no data migration.
    OWNER_DECISION_REQUIRED NO (recommended outright)

**Why first:** it is the only finding that is exploitable *without any account at all*,
it is the only ERROR the vendor's own linter raises, it is three statements, and it is
independent of D-1 and D-2. It can ship while the role questions are still open.

---

## Stage 2 — Revoke the dormant `anon` grants (ACC-05)

    ID                      ACC-05
    SEVERITY                MEDIUM (latent; becomes CRITICAL on one careless policy)
    EXACT OBJECT            ~45 public tables + storage.objects: full DML granted to anon
    EVIDENCE                PROVEN_FROM_POLICY (information_schema.role_table_grants)
    AFFECTED ROLE/ACTION    anon — currently inert, since no policy targets anon
    BUSINESS IMPACT         None today. The entire protection is "no policy mentions anon".
                            A future policy written `FOR ALL USING (true)` without
                            `TO authenticated` defaults to TO PUBLIC and instantly exposes
                            every one of these tables to the internet.
    MINIMUM PROPOSED FIX    REVOKE ALL ON <table> FROM anon;  for each affected table.
                            Do NOT touch storage.objects grants in the same migration —
                            Supabase manages that schema; handle separately if at all.
    MIGRATION_REQUIRED      YES (mechanical; one statement per table)
    LOCKOUT/BREAKAGE RISK   LOW, with one thing to check first: the public /rewards and
                            /staff flows must be confirmed to run through the service role
                            (lib/loyalty, lib/staff) and not the anon key. The middleware
                            comments state they do; verify before executing.
    REGRESSION_TESTS        /rewards submission end-to-end; /staff PIN + stock IN/OUT;
                            public product image rendering; anon key SELECT -> denied
    ROLLBACK_PLAN           Re-GRANT per table from the inventory CSV, which records the
                            exact prior privilege list for every table.
    OWNER_DECISION_REQUIRED NO

---

## Stage 3 — Narrow the blanket `authenticated` policies (ACC-02, ACC-04, ACC-08)

**Gated on D-1 and D-2.** This is where the real authorization model changes, and it is
deliberately last among the database stages.

Do this per group, not as one sweep:

**3a — Financial and PII tables** (`customers`, `orders`, `expenses`) — highest value.
Replace `ALL USING(true)` with SELECT-only for `authenticated` (subject to D-2), and move
writes onto the service-role server paths that already exist.

**3b — `malak_audit`** (`ACC-04`, subject to D-3). Drop the `ALL` policy; leave no
`UPDATE`/`DELETE` path for any interactive role; keep inserts server-side.

**3c — Catalog tables** (`products`, `product_images`, `brands`, `product_categories`,
`channels`, `channel_products`, …). Replace `ALL/true` with SELECT-only for
`authenticated`. **This is the stage with real workflow risk** — catalog editing, channel
previews, reconciliation, copy/download and image upload must keep working. They should,
because those paths run server-side under the service role, but that must be proven per
workflow before execution, not assumed.

Also fold in **ACC-08**: drop one of the two identical `products` policies.

    MIGRATION_REQUIRED      YES, one migration per sub-stage (3a, 3b, 3c separately)
    LOCKOUT/BREAKAGE RISK   MEDIUM for 3c, LOW for 3a/3b. The owner cannot be locked out of
                            the application: the app authenticates server-side and the
                            service role bypasses RLS. The risk is a *feature* silently
                            losing a write path, not loss of access.
    REGRESSION_TESTS        Per sub-stage: catalog view + approved edit; variant copy and
                            image download; Rafeeq/Snoonu/Talabat previews and
                            reconciliation; package generation; owner-only send paths;
                            existing cron and webhook jobs. Plus the 5530-test suite.
    ROLLBACK_PLAN           Each migration is a policy swap with the prior definition
                            recorded verbatim in RLS_POLICY_INVENTORY.csv; reverting is
                            re-CREATE POLICY with the old text. No data is modified.
    OWNER_DECISION_REQUIRED YES (D-2 for 3a/3c, D-3 for 3b)

---

## Stage 4 — Application-authorization hardening (ACC-07) — separate from the DB work

    ID                      ACC-07
    SEVERITY                LOW
    EXACT FILE              app/api/malak/upload/route.ts
    EVIDENCE                TESTED — gate is getUser() only; then createAdminClient()
                            writes to the public product-images bucket
    MINIMUM PROPOSED FIX    Swap the inline getUser() gate for requireWriterGate().
    MIGRATION_REQUIRED      NO (code only)
    RISK                    LOW — only narrows who may upload. Confirm the owner and any
                            MALAK_WRITER_EMAILS accounts are unaffected.
    REGRESSION_TESTS        Malak composer image upload as owner; as a non-writer signed-in
                            account -> 403
    ROLLBACK_PLAN           Revert the commit.
    OWNER_DECISION_REQUIRED YES (confirm staff should not upload)

---

## Stage 5 — Hardening nits (ACC-06, ACC-09, ACC-10)

- **ACC-06** Enable leaked-password protection — Supabase dashboard toggle, no migration.
  Recommended, and worth doing at the same time as D-1 since both are Auth settings.
- **ACC-09** `ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;`
  — one statement, matches what the other 25 functions already do.
- **ACC-10** Move `pg_net` out of `public`. Lowest priority; Supabase-managed extension,
  and moving it can disturb dependants — confirm nothing depends on it first.

---

## Recommended execution order

1. **D-1** (Auth setting — answers whether ACC-02 is internet-facing) · dashboard, no code
2. **Stage 1** — `loop_board` · one migration, independent, reversible ← **first fix**
3. **ACC-06 / ACC-09** — cheap hardening, no workflow risk
4. **Stage 2** — revoke `anon` grants, after verifying /rewards and /staff use the service role
5. **Stage 4** — upload gate (code, separate PR from any migration)
6. **Stage 3a → 3b → 3c** — policy narrowing, one reviewable migration each, gated on D-2/D-3

    RECOMMENDED_FIRST_FIX                 ACC-01 (loop_board: revoke anon grants + security_invoker=true)
    MIGRATION_REQUIRED_FOR_FIRST_FIX      YES — one migration, three statements, no data modified
