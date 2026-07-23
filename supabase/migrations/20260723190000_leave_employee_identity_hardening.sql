-- =====================================================================
--  تحصين هوية الموظف في طلبات الإجازة (Migration — أمني)
--
--  الثغرة: سياسات public.leaves الخاصة بالموظف (staff_insert/update/delete)
--  كانت تشتقّ هوية الموظف من  auth.jwt()->'user_metadata'->>'emp_no'  وهي
--  قيمة يعدّلها المستخدم بنفسه، فيستطيع تقديم/تعديل/حذف طلب باسم زميل في
--  ورديته (مُثبَت اختباريًا). كما كانت تعتمد fallback إلى 'w1' للوردية.
--
--  الإصلاح: اشتقاق الهوية حصريًا من الربط الموثوق داخل قاعدة البيانات
--  (public.employee_auth.user_id = auth.uid()) — لا من الـ JWT ولا العميل،
--  وبلا أي قيمة افتراضية.
--
--  النطاق: سياسات الموظف على public.leaves فقط + دالتا هوية موثوقتان.
--  لا يمسّ: صلاحيات owner/admin/superadmin، عزل الوردية/القسم، leave_ledger،
--  employee_auth (يبقى مقفلًا)، ولا يعالج fallback 'w1' في can_see/can_write.
-- =====================================================================
begin;

-- هوية الموظف الحالي من الربط الموثوق (لا user_metadata، لا قيم من العميل).
-- تُعيد NULL عند غياب الربط أو تعدّده (غموض) — لا تختار سجلًّا بصمت.
create or replace function public.audit_current_emp_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select case when count(*) = 1 then (array_agg(ea.emp_id))[1] end
  from public.employee_auth ea
  where ea.user_id = (select auth.uid())
$$;

-- وردية الموظف الحالي من نفس الربط الموثوق (بلا fallback).
create or replace function public.audit_current_emp_team()
returns text language sql stable security definer set search_path = '' as $$
  select case when count(*) = 1 then (array_agg(ea.team))[1] end
  from public.employee_auth ea
  where ea.user_id = (select auth.uid())
$$;

-- anon محروم؛ authenticated يحتاج EXECUTE لأن الدالتين تُستدعيان داخل سياسات
-- RLS على leaves ويجب أن تُقيَّم لكل مستخدم مُسجَّل (وإلا يُحبَط أي كتابة).
-- كلٌّ منهما تُعيد هوية المُستدعِي نفسه فقط (غير حسّاسة) — كنمط audit_current_user_role/team.
revoke all on function public.audit_current_emp_id()   from public, anon;
revoke all on function public.audit_current_emp_team() from public, anon;
grant  execute on function public.audit_current_emp_id()   to authenticated;
grant  execute on function public.audit_current_emp_team() to authenticated;

-- ---------------------------------------------------------------------
-- إعادة كتابة سياسات الموظف على public.leaves بالهوية الموثوقة
-- ---------------------------------------------------------------------
drop policy if exists staff_insert_own_leave   on public.leaves;
drop policy if exists staff_update_own_pending  on public.leaves;
drop policy if exists staff_delete_own_pending  on public.leaves;

-- إدراج: طلب معلّق، لموظف نفسه فقط، ووردية الصف = ورديته الموثوقة.
create policy staff_insert_own_leave on public.leaves for insert
  with check (
        status = 'قيد الانتظار'
    and public.audit_current_emp_id() is not null
    and emp_id = public.audit_current_emp_id()
    and team   = public.audit_current_emp_team()
  );

-- تعديل: فقط طلباته المعلّقة، ولا يمكنه تغيير emp_id أو الوردية لغير الموثوق.
create policy staff_update_own_pending on public.leaves for update
  using (
        status = 'قيد الانتظار'
    and public.audit_current_emp_id() is not null
    and emp_id = public.audit_current_emp_id()
  )
  with check (
        status = 'قيد الانتظار'
    and emp_id = public.audit_current_emp_id()
    and team   = public.audit_current_emp_team()
  );

-- حذف: فقط طلباته المعلّقة.
create policy staff_delete_own_pending on public.leaves for delete
  using (
        status = 'قيد الانتظار'
    and public.audit_current_emp_id() is not null
    and emp_id = public.audit_current_emp_id()
  );

commit;
