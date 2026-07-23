-- =====================================================================
--  create_team: وسيط قسم اختياري لمدير النظام (Migration 6)
--  رئيس القسم: الوردية تُنشأ في قسمه (كما هو). مدير النظام (بلا قسم): يمرّر
--  القسم المستهدَف صراحةً عند إدارته لقسم معيّن، وإلا تعود للسلوك الافتراضي.
-- =====================================================================
begin;

create or replace function public.create_team(
  p_team_name text, p_admin_user text, p_admin_pass text, p_admin_name text,
  p_assistant text default '', p_dept text default null)
returns text language plpgsql security definer set search_path to 'public','auth','extensions' as $function$
declare code text; n int; uid uuid := gen_random_uuid(); em text; v_dept text;
begin
  if not (public.is_owner() or public.is_superadmin()) then
    raise exception 'غير مصرّح — لرئيس القسم أو مدير النظام فقط';
  end if;
  if coalesce(p_admin_user,'')='' or coalesce(p_admin_pass,'')='' or coalesce(p_team_name,'')='' then
    raise exception 'الحقول مطلوبة';
  end if;
  -- مدير النظام يحدّد القسم؛ غيره من قسمه الموثوق
  if public.is_superadmin() and p_dept is not null and exists (select 1 from public.departments d where d.id = p_dept) then
    v_dept := p_dept;
  else
    v_dept := public.audit_current_user_dept();
  end if;
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

commit;
