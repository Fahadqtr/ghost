-- =====================================================================
--  إزالة قيم fallback الافتراضية للوردية/القسم من دوال العزل (أمني)
--
--  المشكلة: can_see_team/can_write_team كانت تستخدم coalesce(team,'w1')،
--  وaudit_current_user_dept/audit_team_dept كانت تستخدم coalesce(...,'d1').
--  فمستخدم بلا team/dept موثوق كان يُربط تلقائيًا بـ w1/d1 ويحصل على وصول.
--
--  الإصلاح: إزالة الـ fallback — القيمة الفارغة/المعدومة تعني «بلا نطاق»
--  والمستخدم يُرفض بدل ربطه تلقائيًا. تُقرأ القيم الموثوقة من auth.users
--  (لا من user_metadata). لا مساس بالأرصدة/employee_auth/leave_ledger/الأدوار.
--
--  النطاق: أربع دوال فقط (لا سياسات تقرأ team/dept من JWT، ولا أعمدة).
-- =====================================================================
begin;

-- قسم المستخدم الحالي — بلا fallback (NULL إذا لم يملك قسمًا)
create or replace function public.audit_current_user_dept()
returns text language sql stable security definer set search_path = '' as $$
  select u.raw_app_meta_data->>'dept' from auth.users u where u.id = (select auth.uid())
$$;

-- قسم وردية معيّنة — بلا fallback (NULL إذا لا يوجد صفّ settings للوردية)
create or replace function public.audit_team_dept(p_team text)
returns text language sql stable security definer set search_path = '' as $$
  select s.dept from public.settings s where s.team = p_team
$$;

-- القراءة: مدير النظام، أو رئيس قسمٍ لورديات قسمه (بقسم موثوق غير فارغ)،
-- أو مالك الوردية (بوردية موثوقة غير فارغة). بلا أي fallback إلى w1/d1.
create or replace function public.can_see_team(p_team text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_superadmin()
      or (public.is_owner()
          and public.audit_current_user_dept() is not null
          and btrim(public.audit_current_user_dept()) <> ''
          and public.audit_team_dept(p_team) = public.audit_current_user_dept())
      or (not public.is_owner()
          and public.audit_current_user_team() is not null
          and btrim(public.audit_current_user_team()) <> ''
          and p_team = public.audit_current_user_team())
$$;

-- الكتابة: كالقراءة لكن الفرع الأخير للمسؤول (admin) فقط. بلا fallback.
create or replace function public.can_write_team(p_team text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_superadmin()
      or (public.is_owner()
          and public.audit_current_user_dept() is not null
          and btrim(public.audit_current_user_dept()) <> ''
          and public.audit_team_dept(p_team) = public.audit_current_user_dept())
      or (public.audit_current_user_role() = 'admin'
          and public.audit_current_user_team() is not null
          and btrim(public.audit_current_user_team()) <> ''
          and p_team = public.audit_current_user_team())
$$;

-- الإبقاء على صلاحيات EXECUTE الحالية (authenticated فقط؛ anon/PUBLIC محرومان)
revoke all on function public.can_see_team(text)        from public, anon;
revoke all on function public.can_write_team(text)      from public, anon;
revoke all on function public.audit_current_user_dept() from public, anon;
revoke all on function public.audit_team_dept(text)     from public, anon;
grant execute on function public.can_see_team(text)        to authenticated;
grant execute on function public.can_write_team(text)      to authenticated;
grant execute on function public.audit_current_user_dept() to authenticated;
grant execute on function public.audit_team_dept(text)     to authenticated;

commit;
