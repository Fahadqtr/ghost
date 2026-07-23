-- =====================================================================
--  صلاحيات رئيس القسم — يضبطها مدير النظام لكل قسم (Migration 7)
--  يُخزَّن المفتاح في settings.data.ownerPreset لكل ورديات القسم (يقرؤه رئيس
--  القسم من إعداداته). مدير النظام فقط يضبطه.
-- =====================================================================
begin;

create or replace function public.admin_set_owner_preset(p_dept text, p_preset text)
returns void language plpgsql security definer set search_path to 'public','auth' as $function$
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if not exists (select 1 from public.departments where id = p_dept) then raise exception 'قسم غير موجود'; end if;
  update public.settings
    set data = coalesce(data,'{}'::jsonb) || jsonb_build_object('ownerPreset', coalesce(p_preset,'oversight'))
    where dept = p_dept;
end $function$;

revoke all on function public.admin_set_owner_preset(text,text) from public, anon;
grant execute on function public.admin_set_owner_preset(text,text) to authenticated;

commit;
