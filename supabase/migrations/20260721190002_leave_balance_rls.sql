-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 2/8: سياسات RLS
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  owner: كل الورديات · admin: ورديته فقط · viewer: لا وصول مباشر
--  (viewer يقرأ رصيده عبر RPC my_leave_balances فقط — 3/8).
-- =====================================================================
begin;

-- ---------- employee_auth: لا وصول مباشر لأحد (definer فقط) ----------
alter table public.employee_auth enable row level security;
revoke all privileges on public.employee_auth from anon, authenticated;
-- لا سياسات: كل الوصول مرفوض لدور authenticated؛ الدوال SECURITY DEFINER فقط.

-- ---------- leave_policies ----------
alter table public.leave_policies enable row level security;
revoke all privileges on public.leave_policies from anon, authenticated;
grant select, insert, update on public.leave_policies to authenticated;

create policy read_leave_policies on public.leave_policies
  for select to authenticated
  using (
    (select public.is_owner())
    or team = coalesce(((auth.jwt() -> 'app_metadata') ->> 'team'), 'w1')
  );

create policy write_leave_policies on public.leave_policies
  for all to authenticated
  using (
    (select public.is_owner())
    or (((auth.jwt() -> 'app_metadata') ->> 'role') = 'admin'
        and team = coalesce(((auth.jwt() -> 'app_metadata') ->> 'team'), 'w1'))
  )
  with check (
    (select public.is_owner())
    or (((auth.jwt() -> 'app_metadata') ->> 'role') = 'admin'
        and team = coalesce(((auth.jwt() -> 'app_metadata') ->> 'team'), 'w1'))
  );

-- ---------- leave_ledger (viewer ممنوع من القراءة المباشرة) ----------
alter table public.leave_ledger enable row level security;
revoke all privileges on public.leave_ledger from anon, authenticated;
grant select, insert on public.leave_ledger to authenticated;   -- لا UPDATE/DELETE

create policy read_leave_ledger on public.leave_ledger
  for select to authenticated
  using (
    (select public.is_owner())
    or (((auth.jwt() -> 'app_metadata') ->> 'role') = 'admin'
        and team = coalesce(((auth.jwt() -> 'app_metadata') ->> 'team'), 'w1'))
  );

create policy insert_leave_ledger on public.leave_ledger
  for insert to authenticated
  with check (
    (select public.is_owner())
    or (((auth.jwt() -> 'app_metadata') ->> 'role') = 'admin'
        and team = coalesce(((auth.jwt() -> 'app_metadata') ->> 'team'), 'w1'))
  );
-- عمداً: لا سياسة UPDATE ولا DELETE ⇒ الجدول إضافة-فقط (immutable).

-- ---------- archived_leave_ledger (قراءة للمسؤول/المالك على ورديته) ----------
alter table public.archived_leave_ledger enable row level security;
revoke all privileges on public.archived_leave_ledger from anon, authenticated;
grant select on public.archived_leave_ledger to authenticated;

create policy read_archived_leave_ledger on public.archived_leave_ledger
  for select to authenticated
  using (
    (select public.is_owner())
    or (((auth.jwt() -> 'app_metadata') ->> 'role') = 'admin'
        and team = coalesce(((auth.jwt() -> 'app_metadata') ->> 'team'), 'w1'))
  );

commit;
