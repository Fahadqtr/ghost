-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 2/8: سياسات RLS
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  owner: كل الورديات · admin: ورديته فقط · viewer/anon: لا وصول مباشر.
--  (viewer يقرأ رصيده عبر RPC my_leave_balances فقط — 3/8.)
--
--  الدور/الوردية يُقرآن من القاعدة (دوال SECURITY DEFINER من Phase 1):
--    is_owner()  ·  audit_current_user_role()  ·  audit_current_user_team()
--  لا اعتماد على قيمة يرسلها العميل، ولا وردية افتراضية (w1) عند غياب metadata:
--    يُشترط أن تكون وردية المسؤول غير فارغة وتُطابق صف الجدول تماماً.
-- =====================================================================
begin;

-- ---------- employee_auth: لا وصول مباشر لأحد (definer فقط) ----------
alter table public.employee_auth enable row level security;
revoke all privileges on public.employee_auth from anon, authenticated;
-- لا GRANT ولا سياسات: كل وصول مباشر مرفوض؛ الدوال SECURITY DEFINER فقط.

-- ---------- leave_policies (owner كل الورديات · admin ورديته · لا viewer) ----------
alter table public.leave_policies enable row level security;
revoke all privileges on public.leave_policies from anon, authenticated;
grant select, insert, update on public.leave_policies to authenticated;

create policy read_leave_policies on public.leave_policies
  for select to authenticated
  using (
    (select public.is_owner())
    or ((select public.audit_current_user_role()) = 'admin'
        and (select public.audit_current_user_team()) is not null
        and (select public.audit_current_user_team()) <> ''
        and team = (select public.audit_current_user_team()))
  );

create policy write_leave_policies on public.leave_policies
  for all to authenticated
  using (
    (select public.is_owner())
    or ((select public.audit_current_user_role()) = 'admin'
        and (select public.audit_current_user_team()) is not null
        and (select public.audit_current_user_team()) <> ''
        and team = (select public.audit_current_user_team()))
  )
  with check (
    (select public.is_owner())
    or ((select public.audit_current_user_role()) = 'admin'
        and (select public.audit_current_user_team()) is not null
        and (select public.audit_current_user_team()) <> ''
        and team = (select public.audit_current_user_team()))
  );

-- ---------- leave_ledger (إضافة-فقط؛ لا viewer؛ لا UPDATE/DELETE) ----------
alter table public.leave_ledger enable row level security;
revoke all privileges on public.leave_ledger from anon, authenticated;
grant select, insert on public.leave_ledger to authenticated;   -- لا UPDATE ولا DELETE

create policy read_leave_ledger on public.leave_ledger
  for select to authenticated
  using (
    (select public.is_owner())
    or ((select public.audit_current_user_role()) = 'admin'
        and (select public.audit_current_user_team()) is not null
        and (select public.audit_current_user_team()) <> ''
        and team = (select public.audit_current_user_team()))
  );

create policy insert_leave_ledger on public.leave_ledger
  for insert to authenticated
  with check (
    (select public.is_owner())
    or ((select public.audit_current_user_role()) = 'admin'
        and (select public.audit_current_user_team()) is not null
        and (select public.audit_current_user_team()) <> ''
        and team = (select public.audit_current_user_team()))
  );
-- عمداً: لا سياسة UPDATE ولا DELETE ⇒ الجدول إضافة-فقط (immutable). التصحيح بقيد adjustment معاكس.

-- ---------- archived_leave_ledger (قراءة owner/admin على ورديته؛ لا viewer/anon) ----------
alter table public.archived_leave_ledger enable row level security;
revoke all privileges on public.archived_leave_ledger from anon, authenticated;
grant select on public.archived_leave_ledger to authenticated;

create policy read_archived_leave_ledger on public.archived_leave_ledger
  for select to authenticated
  using (
    (select public.is_owner())
    or ((select public.audit_current_user_role()) = 'admin'
        and (select public.audit_current_user_team()) is not null
        and (select public.audit_current_user_team()) <> ''
        and team = (select public.audit_current_user_team()))
  );

commit;
