-- =====================================================================
--  المنصّة متعدّدة الأقسام — الأساس + العزل (Migration 3)
--
--  الفكرة: «القسم» (dept) طبقة عليا فوق «الوردية» (team). كل وردية تنتمي
--  لقسم واحد (settings.dept). رئيس القسم يرى ورديات قسمه فقط؛ مسؤول/موظف
--  الوردية يرى ورديته؛ ومدير النظام (superadmin) يرى كل شيء.
--
--  آمن للبيانات الحالية: قسم واحد d1 (العمليات الجمركية)، وكل المستخدمين
--  والورديات تُنسب إليه. المنطق الجديد يكافئ السابق تمامًا ما دام هناك قسم
--  واحد؛ العزل يبدأ فعليًا عند إنشاء قسم ثانٍ.
--
--  الأمان: العزل عبر دوال موثوقة SECURITY DEFINER تقرأ الدور/القسم/الوردية
--  من auth.users (غير قابلة للتزوير عبر JWT):
--    is_superadmin(), audit_current_user_dept(), audit_team_dept(team),
--    can_see_team(team), can_write_team(team).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- جدول الأقسام + نسب الورديات الحالية إلى القسم d1
-- ---------------------------------------------------------------------
create table if not exists public.departments (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
insert into public.departments(id, name) values ('d1','العمليات الجمركية')
  on conflict (id) do nothing;

-- RLS: القراءة لمدير النظام (الكل) ولكل مستخدم قسمه؛ الكتابة عبر دوال SECURITY DEFINER فقط.
alter table public.departments enable row level security;
drop policy if exists departments_read on public.departments;
create policy departments_read on public.departments for select
  using ( public.is_superadmin() or id = public.audit_current_user_dept() );

alter table public.settings add column if not exists dept text;
update public.settings set dept = 'd1' where dept is null or btrim(dept) = '';
alter table public.settings alter column dept set default 'd1';
alter table public.settings alter column dept set not null;

-- نسب كل المستخدمين الحاليين إلى القسم d1 (رئيس القسم/المسؤولون/الموظفون)
update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || jsonb_build_object('dept','d1')
  where coalesce(raw_app_meta_data->>'dept','') = '';

-- ---------------------------------------------------------------------
-- الدوال الموثوقة
-- ---------------------------------------------------------------------
-- قسم المستخدم الحالي (افتراضيًا d1 لأي حساب قديم قبل ضبط القسم)
create or replace function public.audit_current_user_dept()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select u.raw_app_meta_data->>'dept' from auth.users u where u.id = (select auth.uid())), 'd1')
$$;

-- مدير النظام؟
create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u
                where u.id = (select auth.uid()) and (u.raw_app_meta_data->>'role') = 'superadmin')
$$;

-- قسم وردية معيّنة (يتجاوز RLS للجدول settings — لمنع التكرار داخل السياسات)
create or replace function public.audit_team_dept(p_team text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select s.dept from public.settings s where s.team = p_team), 'd1')
$$;

-- صلاحية القراءة على صفوف وردية: مدير النظام، أو رئيس قسمٍ للورديات ضمن قسمه،
-- أو مالك الوردية نفسها (مسؤول/موظف). افتراض الوردية w1 يطابق السلوك القديم.
create or replace function public.can_see_team(p_team text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_superadmin()
      or (public.is_owner() and public.audit_team_dept(p_team) = public.audit_current_user_dept())
      -- الفرع العام (مسؤول/موظف): مقصور على ورديته. الحارس not is_owner() يمنع
      -- تسرّب رؤية رئيس قسمٍ آخر إلى الوردية الافتراضية w1 لعدم امتلاكه وردية.
      or (not public.is_owner() and p_team = coalesce(public.audit_current_user_team(), 'w1'))
$$;

-- صلاحية الكتابة: كالقراءة لكن الفرع الأخير للمسؤول (admin) فقط لا الموظف.
create or replace function public.can_write_team(p_team text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_superadmin()
      or (public.is_owner() and public.audit_team_dept(p_team) = public.audit_current_user_dept())
      or (public.audit_current_user_role() = 'admin'
          and p_team = coalesce(public.audit_current_user_team(), 'w1'))
$$;

revoke all on function public.audit_current_user_dept()  from public, anon, authenticated;
revoke all on function public.is_superadmin()            from public, anon, authenticated;
revoke all on function public.audit_team_dept(text)      from public, anon, authenticated;
-- can_see_team/can_write_team تُستدعى داخل السياسات فقط (تعمل تحت صلاحية المالك)
revoke all on function public.can_see_team(text)  from public, anon, authenticated;
revoke all on function public.can_write_team(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- إعادة كتابة سياسات RLS للجداول المستأجرة عبر الدوال المركزية
-- (الفروع الخاصة بالموظف على leaves تبقى كما هي — مقصورة على الوردية وآمنة)
-- ---------------------------------------------------------------------
-- employees
drop policy if exists read_employees  on public.employees;
drop policy if exists write_employees on public.employees;
create policy read_employees  on public.employees for select using ( public.can_see_team(team) );
create policy write_employees on public.employees for all
  using ( public.can_write_team(team) ) with check ( public.can_write_team(team) );

-- leaves (سياسات الموظف تبقى دون تغيير)
drop policy if exists read_leaves  on public.leaves;
drop policy if exists write_leaves on public.leaves;
create policy read_leaves  on public.leaves for select using ( public.can_see_team(team) );
create policy write_leaves on public.leaves for all
  using ( public.can_write_team(team) ) with check ( public.can_write_team(team) );

-- overrides
drop policy if exists read_overrides  on public.overrides;
drop policy if exists write_overrides on public.overrides;
create policy read_overrides  on public.overrides for select using ( public.can_see_team(team) );
create policy write_overrides on public.overrides for all
  using ( public.can_write_team(team) ) with check ( public.can_write_team(team) );

-- point_shifts
drop policy if exists read_point_shifts  on public.point_shifts;
drop policy if exists write_point_shifts on public.point_shifts;
create policy read_point_shifts  on public.point_shifts for select using ( public.can_see_team(team) );
create policy write_point_shifts on public.point_shifts for all
  using ( public.can_write_team(team) ) with check ( public.can_write_team(team) );

-- settings
drop policy if exists read_settings  on public.settings;
drop policy if exists write_settings on public.settings;
create policy read_settings  on public.settings for select using ( public.can_see_team(team) );
create policy write_settings on public.settings for all
  using ( public.can_write_team(team) ) with check ( public.can_write_team(team) );

-- leave_policies
drop policy if exists read_leave_policies  on public.leave_policies;
drop policy if exists write_leave_policies on public.leave_policies;
create policy read_leave_policies  on public.leave_policies for select using ( public.can_see_team(team) );
create policy write_leave_policies on public.leave_policies for all
  using ( public.can_write_team(team) ) with check ( public.can_write_team(team) );

-- leave_ledger
drop policy if exists read_leave_ledger   on public.leave_ledger;
drop policy if exists insert_leave_ledger on public.leave_ledger;
create policy read_leave_ledger   on public.leave_ledger for select using ( public.can_see_team(team) );
create policy insert_leave_ledger on public.leave_ledger for insert with check ( public.can_write_team(team) );

-- archived_leave_ledger
drop policy if exists read_archived_leave_ledger on public.archived_leave_ledger;
create policy read_archived_leave_ledger on public.archived_leave_ledger for select using ( public.can_see_team(team) );

-- audit_log (قراءة فقط)
drop policy if exists read_audit on public.audit_log;
create policy read_audit on public.audit_log for select using ( public.can_see_team(team) );

-- ---------------------------------------------------------------------
-- الإفادات: تحديث فروع المالك لتصبح مقصورة على القسم عبر can_see/can_write
-- ---------------------------------------------------------------------
drop policy if exists report_threads_read   on public.report_threads;
drop policy if exists report_threads_insert on public.report_threads;
drop policy if exists report_threads_update on public.report_threads;
drop policy if exists report_threads_delete on public.report_threads;
create policy report_threads_read on public.report_threads for select
  using ( public.can_see_team(team) );
create policy report_threads_insert on public.report_threads for insert
  with check ( (public.is_owner() and public.audit_team_dept(team) = public.audit_current_user_dept())
            or (public.audit_current_user_role() = 'admin' and team = public.audit_current_user_team()) );
create policy report_threads_update on public.report_threads for update
  using ( public.is_owner() and public.audit_team_dept(team) = public.audit_current_user_dept() )
  with check ( public.is_owner() and public.audit_team_dept(team) = public.audit_current_user_dept() );
create policy report_threads_delete on public.report_threads for delete
  using ( public.can_write_team(team) );

drop policy if exists report_messages_read   on public.report_messages;
drop policy if exists report_messages_insert on public.report_messages;
create policy report_messages_read on public.report_messages for select
  using ( exists (select 1 from public.report_threads t where t.id = thread_id and public.can_see_team(t.team)) );
create policy report_messages_insert on public.report_messages for insert
  with check ( exists (select 1 from public.report_threads t where t.id = thread_id and public.can_write_team(t.team)) );

drop policy if exists report_files_read   on public.report_files;
drop policy if exists report_files_insert on public.report_files;
create policy report_files_read on public.report_files for select
  using ( exists (select 1 from public.report_messages m join public.report_threads t on t.id = m.thread_id
                  where m.id = message_id and public.can_see_team(t.team)) );
create policy report_files_insert on public.report_files for insert
  with check ( exists (select 1 from public.report_messages m join public.report_threads t on t.id = m.thread_id
                  where m.id = message_id and public.can_write_team(t.team)) );

-- ---------------------------------------------------------------------
-- تحديث دوال الورديات لتراعي القسم
-- ---------------------------------------------------------------------
-- إنشاء وردية: تُنسب لقسم رئيس القسم المُنشئ (أو مدير النظام للقسم المطلوب)
create or replace function public.create_team(
  p_team_name text, p_admin_user text, p_admin_pass text, p_admin_name text, p_assistant text default '')
returns text language plpgsql security definer set search_path to 'public','auth','extensions' as $function$
declare code text; n int; uid uuid := gen_random_uuid(); em text; v_dept text;
begin
  if not (public.is_owner() or public.is_superadmin()) then
    raise exception 'غير مصرّح — لرئيس القسم أو مدير النظام فقط';
  end if;
  if coalesce(p_admin_user,'')='' or coalesce(p_admin_pass,'')='' or coalesce(p_team_name,'')='' then
    raise exception 'الحقول مطلوبة';
  end if;
  v_dept := public.audit_current_user_dept();
  em := lower(p_admin_user)||'@shift.local';
  if exists(select 1 from auth.users where email=em) then raise exception 'اسم المستخدم موجود مسبقاً'; end if;
  select coalesce(max((regexp_replace(team,'\D','','g'))::int),0)+1 into n from public.settings where team ~ '^w[0-9]+$';
  code := 'w'||n;
  insert into public.settings(team,dept,data) values(code, v_dept,
    (select data from public.settings where dept = v_dept order by team limit 1)
      || jsonb_build_object('teamName',p_team_name,'supervisor',p_admin_name,'assistant',coalesce(p_assistant,''),
                            'deptHead',coalesce((select data->>'deptHead' from public.settings where dept=v_dept order by team limit 1),'')));
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token)
   values('00000000-0000-0000-0000-000000000000',uid,'authenticated','authenticated',em,crypt(p_admin_pass,gen_salt('bf')),now(),now(),now(),
     jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'role','admin','team',code,'dept',v_dept),
     jsonb_build_object('username',p_admin_user,'full_name',p_admin_name),'','','','','','');
  insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
   values(uid::text,uid,jsonb_build_object('sub',uid::text,'email',em,'email_verified',true),'email',now(),now(),now());
  return code;
end $function$;

-- حذف وردية: مقصور على قسم رئيس القسم (لا يحذف الوردية الأولى في القسم)
create or replace function public.delete_team(p_team text)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
declare v_dept text; v_first text;
begin
  if not (public.is_owner() or public.is_superadmin()) then
    raise exception 'غير مصرّح — لرئيس القسم أو مدير النظام فقط';
  end if;
  v_dept := public.audit_current_user_dept();
  if p_team is null then raise exception 'وردية غير محدّدة'; end if;
  if not public.is_superadmin() and public.audit_team_dept(p_team) <> v_dept then
    raise exception 'الوردية خارج قسمك';
  end if;
  select team into v_first from public.settings
    where dept = public.audit_team_dept(p_team) order by team limit 1;
  if p_team = v_first then raise exception 'لا يمكن حذف الوردية الأساسية للقسم'; end if;
  delete from public.point_shifts where team = p_team;
  delete from public.overrides    where team = p_team;
  delete from public.leaves       where team = p_team;
  delete from public.employees    where team = p_team;
  delete from public.settings     where team = p_team;
  delete from auth.identities where user_id in (
    select id from auth.users where (raw_app_meta_data->>'team') = p_team
      and coalesce(raw_app_meta_data->>'role','') <> 'owner');
  delete from auth.users where (raw_app_meta_data->>'team') = p_team
      and coalesce(raw_app_meta_data->>'role','') <> 'owner';
end $function$;

-- بثّ رئيس القسم: مقصور على ورديات قسمه فقط
create or replace function public.owner_broadcast(p_patch jsonb)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
begin
  if not (public.is_owner() or public.is_superadmin()) then
    raise exception 'غير مصرّح — لرئيس القسم فقط';
  end if;
  if public.is_superadmin() then
    update public.settings set data = coalesce(data,'{}'::jsonb) || p_patch where team is not null;
  else
    update public.settings set data = coalesce(data,'{}'::jsonb) || p_patch
    where dept = public.audit_current_user_dept();
  end if;
end $function$;

commit;
