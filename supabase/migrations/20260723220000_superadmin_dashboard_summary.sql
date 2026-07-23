-- =====================================================================
--  RPC ملخّص لوحة مدير النظام (أمني — للقراءة فقط)
--
--  الغرض: تزويد لوحة مدير النظام بإحصائيات المنصّة عبر استدعاء واحد آمن،
--  بدل تجميع البيانات في العميل من عدّة جداول حسّاسة.
--
--  الأمان:
--   * SECURITY DEFINER + search_path='' + كل الجداول مؤهّلة (public./auth.).
--   * متاحة لـ superadmin فقط — تُقاس الهوية بـ public.is_superadmin()
--     التي تقرأ auth.users.raw_app_meta_data (لا من JWT قابل للتزوير).
--   * غير المدير يُرفض بوضوح (SQLSTATE 42501).
--   * تُعيد أعدادًا وإحصائيات فقط + رموز/أسماء الأقسام والورديات (بنية تنظيمية)
--     — لا أسماء أشخاص ولا إيميلات ولا UUIDs.
--   * EXECUTE لـ authenticated فقط؛ anon و PUBLIC محرومان.
--   * بلا أي fallback إلى team/dept.
--
--  لا يعدّل بيانات ولا سياسات ولا الإصلاحات الأمنية السابقة.
-- =====================================================================
begin;

create or replace function public.superadmin_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  -- بوّابة: مدير النظام فقط (هوية موثوقة من auth.users لا من الـ JWT)
  if not public.is_superadmin() then
    raise exception 'forbidden: superadmin only' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'stats', jsonb_build_object(
      'employees',       (select count(*) from public.employees),
      'accounts',        (select count(*) from auth.users),
      'departments',     (select count(*) from public.departments),
      'shifts',          (select count(*) from public.settings),
      'leaves_pending',  (select count(*) from public.leaves where status = 'قيد الانتظار'),
      'leaves_approved', (select count(*) from public.leaves where status = 'معتمد'),
      'leaves_rejected', (select count(*) from public.leaves where status = 'مرفوض'),
      -- موظفون بلا حساب مرتبط في employee_auth
      'employees_without_account',
        (select count(*) from public.employees e
           where not exists (select 1 from public.employee_auth ea where ea.emp_id = e.id)),
      -- حسابات موظفين (viewer) بلا ربط بموظف
      'accounts_without_employee',
        (select count(*) from auth.users u
           where coalesce(u.raw_app_meta_data->>'role', 'viewer') = 'viewer'
             and not exists (select 1 from public.employee_auth ea where ea.user_id = u.id)),
      -- مستخدمون بلا نطاق صحيح: viewer/admin بلا وردية موجودة، أو owner بلا قسم موجود
      'users_invalid_scope',
        (select count(*) from auth.users u
           where (coalesce(u.raw_app_meta_data->>'role', '') in ('viewer', 'admin')
                    and not exists (select 1 from public.settings s
                                    where s.team = u.raw_app_meta_data->>'team'))
              or (u.raw_app_meta_data->>'role' = 'owner'
                    and not exists (select 1 from public.departments d
                                    where d.id = u.raw_app_meta_data->>'dept'))
        )
    ),
    -- توزيع الموظفين حسب الوردية (كل صفّ settings = وردية)
    'by_shift', coalesce((
      select jsonb_agg(jsonb_build_object(
               'team',  s.team,
               'name',  coalesce(s.data->>'teamName', s.team),
               'dept',  s.dept,
               'count', (select count(*) from public.employees e where e.team = s.team)
             ) order by s.team)
      from public.settings s), '[]'::jsonb),
    -- توزيع الموظفين حسب القسم (عبر ربط الوردية بالقسم)
    'by_dept', coalesce((
      select jsonb_agg(jsonb_build_object(
               'dept',  d.id,
               'name',  d.name,
               'count', (select count(*) from public.employees e
                          join public.settings s on s.team = e.team
                          where s.dept = d.id)
             ) order by d.id)
      from public.departments d), '[]'::jsonb),
    -- توزيع الحسابات حسب الدور
    'by_role', jsonb_build_object(
      'superadmin', (select count(*) from auth.users where raw_app_meta_data->>'role' = 'superadmin'),
      'owner',      (select count(*) from auth.users where raw_app_meta_data->>'role' = 'owner'),
      'admin',      (select count(*) from auth.users where raw_app_meta_data->>'role' = 'admin'),
      'viewer',     (select count(*) from auth.users where coalesce(raw_app_meta_data->>'role', 'viewer') = 'viewer')
    ),
    -- تنبيهات (أعداد؛ الواجهة تُظهر التنبيه عند > 0)
    'alerts', jsonb_build_object(
      'employee_without_shift',
        (select count(*) from public.employees e
           where e.team is null or btrim(e.team) = ''
              or not exists (select 1 from public.settings s where s.team = e.team)),
      'account_without_dept',
        (select count(*) from auth.users u
           where u.raw_app_meta_data->>'role' = 'owner'
             and (u.raw_app_meta_data->>'dept' is null
                  or btrim(u.raw_app_meta_data->>'dept') = ''
                  or not exists (select 1 from public.departments d where d.id = u.raw_app_meta_data->>'dept'))),
      'account_without_role',
        (select count(*) from auth.users u
           where u.raw_app_meta_data->>'role' is null
              or btrim(u.raw_app_meta_data->>'role') = ''),
      'dept_without_owner',
        (select count(*) from public.departments d
           where not exists (select 1 from auth.users u
                              where u.raw_app_meta_data->>'role' = 'owner'
                                and u.raw_app_meta_data->>'dept' = d.id)),
      'shift_without_dept',
        (select count(*) from public.settings s
           where s.dept is null or btrim(s.dept) = ''
              or not exists (select 1 from public.departments d where d.id = s.dept)),
      'pending_leaves',
        (select count(*) from public.leaves where status = 'قيد الانتظار'),
      'invalid_links',
        (select count(*) from public.employee_auth ea
           where not exists (select 1 from public.employees e where e.id = ea.emp_id)
              or not exists (select 1 from auth.users u where u.id = ea.user_id)
              or exists (select 1 from public.employees e where e.id = ea.emp_id and e.team <> ea.team))
    )
  ) into v;

  return v;
end;
$$;

-- anon و PUBLIC محرومان؛ authenticated فقط (البوّابة الداخلية تحصر النتيجة على superadmin)
revoke all on function public.superadmin_dashboard_summary() from public, anon;
grant execute on function public.superadmin_dashboard_summary() to authenticated;

commit;
