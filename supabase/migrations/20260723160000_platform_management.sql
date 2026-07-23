-- =====================================================================
--  المنصّة متعدّدة الأقسام — الإدارة الكاملة لمدير النظام (Migration 5)
--
--  دوال SECURITY DEFINER (مدير النظام فقط) لإدارة الأقسام والحسابات:
--    admin_rename_department, admin_delete_department,
--    admin_reset_password, admin_rename_account, admin_delete_account,
--    admin_set_owner_dept.
--  التفويض داخل كل دالة عبر is_superadmin(). لا تمسّ حسابات مدير النظام
--  ولا القسم الأساسي d1 عند الحذف (حماية).
-- =====================================================================
begin;

create or replace function public.admin_rename_department(p_dept text, p_name text)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if coalesce(p_name,'')='' then raise exception 'اسم القسم مطلوب'; end if;
  update public.departments set name = p_name where id = p_dept;
  if not found then raise exception 'قسم غير موجود'; end if;
end $function$;

-- حذف قسم بكل ورديّاته وبياناته وحساباته (عدا القسم الأساسي d1)
create or replace function public.admin_delete_department(p_dept text)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
declare t text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if p_dept = 'd1' then raise exception 'لا يمكن حذف القسم الأساسي'; end if;
  if not exists (select 1 from public.departments where id = p_dept) then raise exception 'قسم غير موجود'; end if;
  for t in select team from public.settings where dept = p_dept loop
    delete from public.point_shifts where team = t;
    delete from public.overrides    where team = t;
    delete from public.leaves       where team = t;
    delete from public.employees    where team = t;
    delete from public.settings     where team = t;
  end loop;
  delete from auth.identities where user_id in (
    select id from auth.users where (raw_app_meta_data->>'dept') = p_dept
      and coalesce(raw_app_meta_data->>'role','') <> 'superadmin');
  delete from auth.users where (raw_app_meta_data->>'dept') = p_dept
      and coalesce(raw_app_meta_data->>'role','') <> 'superadmin';
  delete from public.departments where id = p_dept;
end $function$;

-- إعادة تعيين كلمة مرور لأي حساب (عدا مدير النظام)
create or replace function public.admin_reset_password(p_user text, p_pass text)
returns void language plpgsql security definer set search_path to 'public','auth','extensions' as $function$
declare em text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if coalesce(p_pass,'')='' then raise exception 'كلمة المرور مطلوبة'; end if;
  em := lower(p_user)||'@shift.local';
  update auth.users set encrypted_password = crypt(p_pass, gen_salt('bf')), updated_at = now()
    where email = em and coalesce(raw_app_meta_data->>'role','') <> 'superadmin';
  if not found then raise exception 'حساب غير موجود'; end if;
end $function$;

-- تعديل اسم صاحب الحساب
create or replace function public.admin_rename_account(p_user text, p_name text)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
declare em text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  em := lower(p_user)||'@shift.local';
  update auth.users
    set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || jsonb_build_object('full_name', coalesce(p_name,'')),
        updated_at = now()
    where email = em;
  if not found then raise exception 'حساب غير موجود'; end if;
end $function$;

-- حذف حساب رئيس قسم/مسؤول (لا مدير نظام)
create or replace function public.admin_delete_account(p_user text)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
declare em text; v_role text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  em := lower(p_user)||'@shift.local';
  select raw_app_meta_data->>'role' into v_role from auth.users where email = em;
  if v_role is null then raise exception 'حساب غير موجود'; end if;
  if v_role = 'superadmin' then raise exception 'لا يمكن حذف مدير نظام من هنا'; end if;
  delete from auth.identities where user_id in (select id from auth.users where email = em);
  delete from auth.users where email = em;
end $function$;

-- نقل رئيس قسم إلى قسم آخر
create or replace function public.admin_set_owner_dept(p_user text, p_dept text)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
declare em text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if not exists (select 1 from public.departments where id = p_dept) then raise exception 'قسم غير موجود'; end if;
  em := lower(p_user)||'@shift.local';
  update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || jsonb_build_object('dept', p_dept),
        updated_at = now()
    where email = em and (raw_app_meta_data->>'role') = 'owner';
  if not found then raise exception 'حساب رئيس قسم غير موجود'; end if;
end $function$;

revoke all on function public.admin_rename_department(text,text) from public, anon;
revoke all on function public.admin_delete_department(text)      from public, anon;
revoke all on function public.admin_reset_password(text,text)    from public, anon;
revoke all on function public.admin_rename_account(text,text)    from public, anon;
revoke all on function public.admin_delete_account(text)         from public, anon;
revoke all on function public.admin_set_owner_dept(text,text)    from public, anon;
grant execute on function public.admin_rename_department(text,text) to authenticated;
grant execute on function public.admin_delete_department(text)      to authenticated;
grant execute on function public.admin_reset_password(text,text)    to authenticated;
grant execute on function public.admin_rename_account(text,text)    to authenticated;
grant execute on function public.admin_delete_account(text)         to authenticated;
grant execute on function public.admin_set_owner_dept(text,text)    to authenticated;

commit;
