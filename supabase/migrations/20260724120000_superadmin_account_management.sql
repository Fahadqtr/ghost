-- =====================================================================
--  المرحلة الثانية: إدارة آمنة للحسابات ورؤساء الأقسام (مدير النظام)
--
--  يضيف RPCs آمنة (superadmin فقط) لـ:
--   * تعطيل/إعادة تفعيل حساب (على مستوى المصادقة: auth.users.banned_until
--     + إنهاء الجلسات الحالية auth.sessions) — لا حذف للبيانات.
--   * تغيير الدور/الوردية/القسم ذرّيًا مع تحقّق كامل من المخطط.
--   * ترقية مستخدم موجود إلى رئيس قسم، واستبدال/إزالة رئيس القسم.
--   * قائمة حسابات غنيّة (معرّف داخلي + حالة + هل رئيس قسم) — بلا إيميل/كلمات مرور.
--
--  الأمان:
--   * كل RPC: SECURITY DEFINER + search_path='' + جداول مؤهّلة + بوّابة is_superadmin()
--     (هوية موثوقة من auth.users لا من JWT) + قيم مسموحة فقط + عملية ذرّية.
--   * EXECUTE لـ authenticated فقط؛ anon و PUBLIC محرومان.
--   * يُدرَج فحص «غير معطّل» في دوال الهوية الخمس، فيرفض RLS/RPCs الحساب المعطّل
--     فورًا (تعزيز للأمان، لا إضعاف؛ المستخدم غير المعطّل لا يتأثر).
--   * تسجيل كل عملية في public.audit_log (منفّذ/نوع/معرّف داخلي/قديم/جديد/وقت) —
--     بلا كلمات مرور أو tokens.
--
--  لا يمسّ: employee_auth (يبقى مقفلًا)، leave_ledger (إضافة فقط)، عزل الأقسام،
--  ولا يعدّل أي Migration سابقة. لا يفرض قيد «رئيس واحد للقسم» (النموذج الحالي
--  يسمح بأكثر من رئيس؛ تغييره يحتاج Migration/قيدًا منفصلًا).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1) فحص «غير معطّل» داخل دوال الهوية: الحساب المعطّل (banned_until مستقبلي)
--    يفقد أي هوية موثوقة، فترفضه can_see_team/can_write_team وكل RPC.
--    (create or replace يحفظ صلاحيات EXECUTE القائمة.)
-- ---------------------------------------------------------------------
create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u
                where u.id = (select auth.uid())
                  and (u.raw_app_meta_data->>'role') = 'superadmin'
                  and (u.banned_until is null or u.banned_until <= now()))
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u
                where u.id = (select auth.uid())
                  and (u.raw_app_meta_data->>'role') = 'owner'
                  and (u.banned_until is null or u.banned_until <= now()))
$$;

create or replace function public.audit_current_user_role()
returns text language sql stable security definer set search_path = '' as $$
  select u.raw_app_meta_data->>'role' from auth.users u
   where u.id = (select auth.uid())
     and (u.banned_until is null or u.banned_until <= now())
$$;

create or replace function public.audit_current_user_team()
returns text language sql stable security definer set search_path = '' as $$
  select u.raw_app_meta_data->>'team' from auth.users u
   where u.id = (select auth.uid())
     and (u.banned_until is null or u.banned_until <= now())
$$;

create or replace function public.audit_current_user_dept()
returns text language sql stable security definer set search_path = '' as $$
  select u.raw_app_meta_data->>'dept' from auth.users u
   where u.id = (select auth.uid())
     and (u.banned_until is null or u.banned_until <= now())
$$;

revoke all on function public.is_superadmin()             from public, anon;
revoke all on function public.is_owner()                  from public, anon;
revoke all on function public.audit_current_user_role()   from public, anon;
revoke all on function public.audit_current_user_team()   from public, anon;
revoke all on function public.audit_current_user_dept()   from public, anon;
grant execute on function public.is_superadmin()          to authenticated;
grant execute on function public.is_owner()               to authenticated;
grant execute on function public.audit_current_user_role() to authenticated;
grant execute on function public.audit_current_user_team() to authenticated;
grant execute on function public.audit_current_user_dept() to authenticated;

-- ---------------------------------------------------------------------
-- 2) مساعد تدقيق داخلي (غير مُتاح لأحد خارجيًا؛ يُستدعى فقط من دوال DEFINER
--    المملوكة لـ postgres، فلا يمكن تزوير سجلّ تدقيق).
-- ---------------------------------------------------------------------
create or replace function public._sa_audit(
  p_action text, p_entity text, p_entity_id text, p_summary text, p_changed jsonb, p_team text)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log(at, team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  select now(), p_team, (select auth.uid()),
         (select u.raw_user_meta_data->>'full_name' from auth.users u where u.id = (select auth.uid())),
         'superadmin', p_action, p_entity, p_entity_id, p_summary, p_changed;
$$;
revoke all on function public._sa_audit(text,text,text,text,jsonb,text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) قائمة الحسابات الغنيّة (superadmin فقط) — معرّف داخلي + حالة + هل رئيس قسم.
--    لا تعيد إيميلًا ولا كلمة مرور ولا metadata كاملة.
-- ---------------------------------------------------------------------
create or replace function public.superadmin_list_accounts()
returns table(user_id uuid, username text, full_name text, role text, dept text, team text, active boolean, is_head boolean)
language sql stable security definer set search_path = '' as $$
  select u.id,
         u.raw_user_meta_data->>'username',
         u.raw_user_meta_data->>'full_name',
         u.raw_app_meta_data->>'role',
         u.raw_app_meta_data->>'dept',
         u.raw_app_meta_data->>'team',
         (u.banned_until is null or u.banned_until <= now()) as active,
         ((u.raw_app_meta_data->>'role') = 'owner'
           and coalesce(btrim(u.raw_app_meta_data->>'dept'),'') <> '') as is_head
  from auth.users u
  where public.is_superadmin()
  order by (u.raw_app_meta_data->>'dept') nulls first, (u.raw_app_meta_data->>'role'), lower(u.raw_user_meta_data->>'full_name');
$$;
revoke all on function public.superadmin_list_accounts() from public, anon;
grant execute on function public.superadmin_list_accounts() to authenticated;

-- ---------------------------------------------------------------------
-- 4) تعطيل / إعادة تفعيل حساب (على مستوى المصادقة).
-- ---------------------------------------------------------------------
create or replace function public.superadmin_set_account_active(p_user_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_role  text;
  v_was   boolean;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط' using errcode = '42501'; end if;
  if p_active is null then raise exception 'قيمة الحالة مطلوبة'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'حساب غير موجود'; end if;
  select u.raw_app_meta_data->>'role', (u.banned_until is null or u.banned_until <= now())
    into v_role, v_was from auth.users u where u.id = p_user_id;

  if not p_active then
    if p_user_id = v_actor then raise exception 'لا يمكنك تعطيل نفسك'; end if;
    if v_role = 'superadmin'
       and (select count(*) from auth.users
              where raw_app_meta_data->>'role' = 'superadmin' and id <> p_user_id
                and (banned_until is null or banned_until <= now())) = 0
      then raise exception 'لا يمكن تعطيل آخر مدير نظام'; end if;
    update auth.users set banned_until = timestamptz '9999-12-31 23:59:59+00', updated_at = now()
      where id = p_user_id;
    delete from auth.sessions where user_id = p_user_id;   -- إنهاء الجلسات الحالية فورًا
  else
    update auth.users set banned_until = null, updated_at = now() where id = p_user_id;
  end if;

  perform public._sa_audit(
    case when p_active then 'account_enable' else 'account_disable' end,
    'account', p_user_id::text,
    case when p_active then 'إعادة تفعيل حساب' else 'تعطيل حساب' end,
    jsonb_build_object('old', jsonb_build_object('active', v_was),
                       'new', jsonb_build_object('active', p_active)),
    null);
end $$;
revoke all on function public.superadmin_set_account_active(uuid, boolean) from public, anon;
grant execute on function public.superadmin_set_account_active(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 5) تغيير الدور/الوردية/القسم ذرّيًا (تحديث واحد لـ raw_app_meta_data).
--    القيم المسموحة فقط؛ بلا fallback؛ القيمة الفارغة لا تتحوّل إلى نطاق.
-- ---------------------------------------------------------------------
create or replace function public.superadmin_update_account_scope(
  p_user_id uuid, p_role text, p_team text, p_dept text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_old   jsonb;
  v_old_role text;
  v_new   jsonb;
  v_team  text := nullif(btrim(coalesce(p_team,'')), '');
  v_dept  text := nullif(btrim(coalesce(p_dept,'')), '');
  v_tdept text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('superadmin','owner','admin','viewer') then
    raise exception 'دور غير صالح'; end if;
  select u.raw_app_meta_data, u.raw_app_meta_data->>'role' into v_old, v_old_role
    from auth.users u where u.id = p_user_id;
  if v_old is null then raise exception 'حساب غير موجود'; end if;

  if p_user_id = v_actor and p_role <> coalesce(v_old_role,'') then
    raise exception 'لا يمكنك تغيير دورك بنفسك'; end if;

  if v_old_role = 'superadmin' and p_role <> 'superadmin'
     and (select count(*) from auth.users
            where raw_app_meta_data->>'role' = 'superadmin' and id <> p_user_id
              and (banned_until is null or banned_until <= now())) = 0
    then raise exception 'لا يمكن تخفيض آخر مدير نظام'; end if;

  v_new := (coalesce(v_old,'{}'::jsonb) - 'role' - 'team' - 'dept');
  if p_role = 'superadmin' then
    v_new := v_new || jsonb_build_object('role','superadmin');                 -- عالمي: بلا وردية/قسم
  elsif p_role = 'owner' then
    if v_dept is null then raise exception 'رئيس القسم يحتاج قسمًا صالحًا'; end if;
    if not exists (select 1 from public.departments d where d.id = v_dept) then raise exception 'قسم غير موجود'; end if;
    v_new := v_new || jsonb_build_object('role','owner','dept',v_dept);         -- بلا وردية
  else  -- admin / viewer: يحتاج وردية موجودة؛ القسم يُشتق منها (لا عبور أقسام)
    if v_team is null then raise exception 'هذا الدور يحتاج وردية صالحة'; end if;
    if not exists (select 1 from public.settings s where s.team = v_team) then raise exception 'وردية غير موجودة'; end if;
    select s.dept into v_tdept from public.settings s where s.team = v_team;
    if v_tdept is null or btrim(v_tdept) = '' then raise exception 'الوردية بلا قسم مرتبط'; end if;
    if v_dept is not null and v_dept <> v_tdept then raise exception 'الوردية من قسم مختلف'; end if;
    v_new := v_new || jsonb_build_object('role',p_role,'team',v_team,'dept',v_tdept);
  end if;

  update auth.users set raw_app_meta_data = v_new, updated_at = now() where id = p_user_id;

  perform public._sa_audit('account_scope_update','account', p_user_id::text, 'تغيير نطاق الحساب',
    jsonb_build_object(
      'old', jsonb_build_object('role',v_old->>'role','team',v_old->>'team','dept',v_old->>'dept'),
      'new', jsonb_build_object('role',v_new->>'role','team',v_new->>'team','dept',v_new->>'dept')),
    v_new->>'team');
end $$;
revoke all on function public.superadmin_update_account_scope(uuid,text,text,text) from public, anon;
grant execute on function public.superadmin_update_account_scope(uuid,text,text,text) to authenticated;

-- ---------------------------------------------------------------------
-- 6) ترقية مستخدم موجود إلى رئيس قسم (لا إنشاء حساب Auth جديد).
-- ---------------------------------------------------------------------
create or replace function public.superadmin_promote_department_head(p_user_id uuid, p_dept text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_old_role text; v_active boolean; v_new jsonb;
  v_dept text := nullif(btrim(coalesce(p_dept,'')), '');
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط' using errcode = '42501'; end if;
  if v_dept is null then raise exception 'قسم مطلوب'; end if;
  if not exists (select 1 from public.departments d where d.id = v_dept) then raise exception 'قسم غير موجود'; end if;
  select u.raw_app_meta_data, u.raw_app_meta_data->>'role', (u.banned_until is null or u.banned_until <= now())
    into v_old, v_old_role, v_active from auth.users u where u.id = p_user_id;
  if v_old is null then raise exception 'حساب غير موجود'; end if;
  if v_old_role = 'superadmin' then raise exception 'لا يمكن ترقية مدير النظام'; end if;
  if not v_active then raise exception 'الحساب معطّل — فعّله أولًا'; end if;

  v_new := (coalesce(v_old,'{}'::jsonb) - 'team' - 'dept') || jsonb_build_object('role','owner','dept',v_dept);
  update auth.users set raw_app_meta_data = v_new, updated_at = now() where id = p_user_id;

  perform public._sa_audit('head_promote','account', p_user_id::text, 'ترقية إلى رئيس قسم',
    jsonb_build_object(
      'old', jsonb_build_object('role',v_old->>'role','team',v_old->>'team','dept',v_old->>'dept'),
      'new', jsonb_build_object('role','owner','team',null,'dept',v_dept)),
    null);
end $$;
revoke all on function public.superadmin_promote_department_head(uuid,text) from public, anon;
grant execute on function public.superadmin_promote_department_head(uuid,text) to authenticated;

-- ---------------------------------------------------------------------
-- 7) إزالة صفة رئيس القسم (تخفيض إلى viewer + مسح القسم/الوردية؛ الحساب يبقى فعّالًا).
-- ---------------------------------------------------------------------
create or replace function public.superadmin_remove_department_head(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old jsonb; v_old_role text; v_new jsonb;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط' using errcode = '42501'; end if;
  select u.raw_app_meta_data, u.raw_app_meta_data->>'role' into v_old, v_old_role
    from auth.users u where u.id = p_user_id;
  if v_old is null then raise exception 'حساب غير موجود'; end if;
  if v_old_role <> 'owner' then raise exception 'الحساب ليس رئيس قسم'; end if;

  v_new := (coalesce(v_old,'{}'::jsonb) - 'team' - 'dept') || jsonb_build_object('role','viewer');
  update auth.users set raw_app_meta_data = v_new, updated_at = now() where id = p_user_id;

  perform public._sa_audit('head_remove','account', p_user_id::text, 'إزالة صفة رئيس القسم',
    jsonb_build_object(
      'old', jsonb_build_object('role','owner','dept',v_old->>'dept'),
      'new', jsonb_build_object('role','viewer','dept',null)),
    null);
end $$;
revoke all on function public.superadmin_remove_department_head(uuid) from public, anon;
grant execute on function public.superadmin_remove_department_head(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 8) استبدال رئيس القسم ذرّيًا: تخفيض القديم (viewer) + ترقية الجديد (owner لنفس القسم).
--    الطلبات المعلّقة لا تُمسّ (لا حذف بيانات). النموذج يسمح بعدّة رؤساء؛ هذا
--    الاستبدال يستهدف حسابًا محدّدًا بحساب محدّد.
-- ---------------------------------------------------------------------
create or replace function public.superadmin_replace_department_head(
  p_old_user_id uuid, p_new_user_id uuid, p_dept text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_old_role text;
  v_new jsonb; v_new_role text; v_new_active boolean;
  v_dept text := nullif(btrim(coalesce(p_dept,'')), '');
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط' using errcode = '42501'; end if;
  if v_dept is null then raise exception 'قسم مطلوب'; end if;
  if not exists (select 1 from public.departments d where d.id = v_dept) then raise exception 'قسم غير موجود'; end if;
  if p_old_user_id = p_new_user_id then raise exception 'الحسابان متطابقان'; end if;

  select u.raw_app_meta_data, u.raw_app_meta_data->>'role' into v_old, v_old_role
    from auth.users u where u.id = p_old_user_id;
  if v_old is null then raise exception 'الرئيس الحالي غير موجود'; end if;
  if v_old_role <> 'owner' then raise exception 'الحساب الحالي ليس رئيس قسم'; end if;

  select u.raw_app_meta_data, u.raw_app_meta_data->>'role', (u.banned_until is null or u.banned_until <= now())
    into v_new, v_new_role, v_new_active from auth.users u where u.id = p_new_user_id;
  if v_new is null then raise exception 'الرئيس الجديد غير موجود'; end if;
  if v_new_role = 'superadmin' then raise exception 'لا يمكن ترقية مدير النظام'; end if;
  if not v_new_active then raise exception 'الحساب الجديد معطّل — فعّله أولًا'; end if;

  -- تخفيض القديم ثم ترقية الجديد — داخل نفس المعاملة (ذرّي)
  update auth.users
     set raw_app_meta_data = (coalesce(v_old,'{}'::jsonb) - 'team' - 'dept') || jsonb_build_object('role','viewer'),
         updated_at = now()
   where id = p_old_user_id;
  update auth.users
     set raw_app_meta_data = (coalesce(v_new,'{}'::jsonb) - 'team' - 'dept') || jsonb_build_object('role','owner','dept',v_dept),
         updated_at = now()
   where id = p_new_user_id;

  perform public._sa_audit('head_replace','department', v_dept, 'استبدال رئيس القسم',
    jsonb_build_object(
      'old_head', jsonb_build_object('id', p_old_user_id::text, 'new_role','viewer'),
      'new_head', jsonb_build_object('id', p_new_user_id::text, 'new_role','owner', 'dept', v_dept)),
    null);
end $$;
revoke all on function public.superadmin_replace_department_head(uuid,uuid,text) from public, anon;
grant execute on function public.superadmin_replace_department_head(uuid,uuid,text) to authenticated;

commit;
