-- =====================================================================
--  استعادة صلاحية EXECUTE لدوال مساعِدات RLS (إصلاح إنتاج عاجل)
--
--  المشكلة: migration العزل (departments_isolation) وmigration الإفادات سحبت
--  EXECUTE من الدور authenticated عن دوال predicate تُستدعى داخل سياسات RLS،
--  فعجز Postgres عن تقييم السياسات وفشل أي قراءة/كتابة مباشرة من المستخدمين
--  المسجّلين (permission denied for function can_write_team / audit_current_user_dept).
--
--  الإصلاح: منح EXECUTE لهذه الدوال لدور authenticated فقط (كنمط is_owner
--  وaudit_current_user_role/team الممنوحة أصلًا). anon وPUBLIC يبقيان محرومين.
--  لا تغيير على تعريف الدوال ولا على السياسات ولا على البيانات.
-- =====================================================================
begin;

revoke all on function public.can_see_team(text)        from public, anon;
revoke all on function public.can_write_team(text)      from public, anon;
revoke all on function public.is_superadmin()           from public, anon;
revoke all on function public.audit_current_user_dept() from public, anon;
revoke all on function public.audit_team_dept(text)     from public, anon;

grant execute on function public.can_see_team(text)
  to authenticated;

grant execute on function public.can_write_team(text)
  to authenticated;

grant execute on function public.is_superadmin()
  to authenticated;

grant execute on function public.audit_current_user_dept()
  to authenticated;

grant execute on function public.audit_team_dept(text)
  to authenticated;

commit;
