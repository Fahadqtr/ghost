-- =====================================================================
--  المنصّة متعدّدة الأقسام — التزويد (Migration 4)
--
--  دوال SECURITY DEFINER (على نمط create_team القائم) تتيح:
--    - bootstrap_superadmin: إنشاء أول «مدير نظام» (يستدعيها رئيس القسم الحالي
--      مرّة واحدة إن لم يوجد مدير نظام، أو مدير النظام لإضافة آخر).
--    - admin_create_department: إنشاء قسم جديد + وردية أولى (لمدير النظام).
--    - admin_create_owner: إنشاء حساب رئيس قسم وربطه بقسم (لمدير النظام).
--    - admin_list_accounts: سرد الحسابات للكونسول (لمدير النظام فقط).
--
--  التفويض يُفرَض داخل كل دالة عبر is_superadmin()/is_owner() (تقرأ من
--  auth.users — غير قابلة للتزوير). كلمات المرور بـ bcrypt عبر pgcrypto.
-- =====================================================================
begin;

-- إنشاء أول مدير نظام (بلا قسم ولا وردية — نطاقه عام)
create or replace function public.bootstrap_superadmin(p_user text, p_pass text, p_name text)
returns void language plpgsql security definer set search_path to 'public','auth','extensions' as $function$
declare uid uuid := gen_random_uuid(); em text;
begin
  if exists (select 1 from auth.users where (raw_app_meta_data->>'role') = 'superadmin') then
    if not public.is_superadmin() then raise exception 'مدير النظام موجود — لمدير النظام فقط إضافة آخر'; end if;
  else
    if not (public.is_owner() or public.is_superadmin()) then raise exception 'غير مصرّح'; end if;
  end if;
  if coalesce(p_user,'')='' or coalesce(p_pass,'')='' then raise exception 'الحقول مطلوبة'; end if;
  em := lower(p_user)||'@shift.local';
  if exists (select 1 from auth.users where email = em) then raise exception 'اسم المستخدم موجود مسبقاً'; end if;
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token)
   values('00000000-0000-0000-0000-000000000000',uid,'authenticated','authenticated',em,crypt(p_pass,gen_salt('bf')),now(),now(),now(),
     jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'role','superadmin'),
     jsonb_build_object('username',p_user,'full_name',coalesce(p_name,'')),'','','','','','');
  insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
   values(uid::text,uid,jsonb_build_object('sub',uid::text,'email',em,'email_verified',true),'email',now(),now(),now());
end $function$;

-- إنشاء قسم جديد + وردية أولى (القالب من w1). يعيد معرّف القسم.
create or replace function public.admin_create_department(p_dept_name text)
returns text language plpgsql security definer set search_path to 'public','auth' as $function$
declare v_id text; n int; tcode text; tn int;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if coalesce(p_dept_name,'')='' then raise exception 'اسم القسم مطلوب'; end if;
  select coalesce(max((regexp_replace(id,'\D','','g'))::int),0)+1 into n from public.departments where id ~ '^d[0-9]+$';
  v_id := 'd'||n;
  insert into public.departments(id,name) values (v_id, p_dept_name);
  select coalesce(max((regexp_replace(team,'\D','','g'))::int),0)+1 into tn from public.settings where team ~ '^w[0-9]+$';
  tcode := 'w'||tn;
  insert into public.settings(team,dept,data) values (tcode, v_id,
    (select data from public.settings where team = 'w1')
      || jsonb_build_object('teamName','الوردية 1','supervisor','','assistant','','deptHead',''));
  return v_id;
end $function$;

-- إنشاء حساب رئيس قسم وربطه بقسم موجود (بلا وردية — يرى كل ورديات قسمه)
create or replace function public.admin_create_owner(p_dept text, p_user text, p_pass text, p_name text)
returns void language plpgsql security definer set search_path to 'public','auth','extensions' as $function$
declare uid uuid := gen_random_uuid(); em text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if not exists (select 1 from public.departments where id = p_dept) then raise exception 'قسم غير موجود'; end if;
  if coalesce(p_user,'')='' or coalesce(p_pass,'')='' then raise exception 'الحقول مطلوبة'; end if;
  em := lower(p_user)||'@shift.local';
  if exists (select 1 from auth.users where email = em) then raise exception 'اسم المستخدم موجود مسبقاً'; end if;
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token)
   values('00000000-0000-0000-0000-000000000000',uid,'authenticated','authenticated',em,crypt(p_pass,gen_salt('bf')),now(),now(),now(),
     jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'role','owner','dept',p_dept),
     jsonb_build_object('username',p_user,'full_name',coalesce(p_name,'')),'','','','','','');
  insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
   values(uid::text,uid,jsonb_build_object('sub',uid::text,'email',em,'email_verified',true),'email',now(),now(),now());
  -- بثّ اسم رئيس القسم على ورديات قسمه (يظهر في اعتماد الكشوفات)
  update public.settings set data = coalesce(data,'{}'::jsonb) || jsonb_build_object('deptHead', coalesce(p_name,''))
    where dept = p_dept;
end $function$;

-- سرد الحسابات للكونسول (مدير النظام فقط — الشرط داخل الاستعلام)
create or replace function public.admin_list_accounts()
returns table(username text, full_name text, role text, dept text, team text)
language sql stable security definer set search_path to 'public','auth' as $function$
  select u.raw_user_meta_data->>'username', u.raw_user_meta_data->>'full_name',
         u.raw_app_meta_data->>'role', u.raw_app_meta_data->>'dept', u.raw_app_meta_data->>'team'
  from auth.users u
  where public.is_superadmin()
  order by (u.raw_app_meta_data->>'dept') nulls first, (u.raw_app_meta_data->>'role');
$function$;

-- تُستدعى من مستخدم مُسجَّل فقط (anon محروم)؛ التفويض الفعلي داخل كل دالة.
revoke all on function public.bootstrap_superadmin(text,text,text)      from public, anon;
revoke all on function public.admin_create_department(text)             from public, anon;
revoke all on function public.admin_create_owner(text,text,text,text)   from public, anon;
revoke all on function public.admin_list_accounts()                     from public, anon;
grant execute on function public.bootstrap_superadmin(text,text,text)    to authenticated;
grant execute on function public.admin_create_department(text)           to authenticated;
grant execute on function public.admin_create_owner(text,text,text,text) to authenticated;
grant execute on function public.admin_list_accounts()                   to authenticated;

commit;
