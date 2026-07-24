-- =====================================================================
--  تدقيق آمن لعمليات تعطيل/تفعيل الحسابات (RPC) + توسيع قائمة الإجراءات
--
--  السبب الجذري المُثبَت لفشل التدقيق السابق:
--    قيد الفحص public.audit_log_action_check كان يسمح فقط بـ
--    action ∈ {'insert','update','delete'}. أي قيمة أخرى تُرفض بخطأ
--    check_violation (SQLSTATE 23514). لذلك كان إدراج 'account_disable'/
--    'account_enable' من Edge Function يفشل — وكان الخطأ يُبتلع في v1.
--
--    نفس القيد يكسر ضمنيًا دوال الإدارة المنشورة سلفًا التي تستدعي في
--    نهاية معاملتها: _sa_audit('account_scope_update' | 'head_promote' |
--    'head_remove' | 'head_replace', ...). أي استدعاء لها في الإنتاج كان
--    سيُطلق 23514 ويُلغي العملية بالكامل (لذا لا توجد صفوف بهذه القيم).
--
--  الإصلاح: توسيع القيد ليشمل أفعال إدارة النظام الفعلية (توسيع فقط —
--  القيم الثلاث الأصلية تبقى صالحة، فلا يتأثر أي صف قائم)، ثم إضافة RPC
--  تدقيق SECURITY DEFINER تُمنح صلاحية تنفيذها إلى service_role فقط.
--
--  لا مساس بـ RLS، ولا بدوال الهوية/النطاق، ولا بالمُشغّل الحارس.
-- =====================================================================
begin;

-- 1) توسيع قيد الإجراءات المسموحة (توسيع فقط — لا تضييق).
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action = any (array[
    'insert', 'update', 'delete',
    'account_disabled', 'account_enabled',
    'account_scope_update', 'head_promote', 'head_remove', 'head_replace'
  ]));

-- 2) RPC تدقيق تعطيل/تفعيل الحساب.
--    تُستدعى من Edge Function بمفتاح service-role (auth.uid() = null هناك)،
--    لذا يُمرَّر معرّف الفاعل صراحةً؛ اسم الفاعل يُقرأ من التخزين الخادمي
--    (raw_user_meta_data) لا من توكن العميل. الإجراء يُشتق من علم boolean
--    ضمن مجموعة ثابتة (enabled/disabled) عبر CASE — لا SQL ديناميكي.
create or replace function public.superadmin_audit_account_status(
  p_actor_id uuid,
  p_target_id uuid,
  p_active boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_name text;
begin
  if p_actor_id is null or p_target_id is null or p_active is null then
    raise exception 'معطيات تدقيق غير صالحة' using errcode = '22023';
  end if;

  select u.raw_user_meta_data->>'full_name'
    into v_actor_name
    from auth.users u
   where u.id = p_actor_id;

  insert into public.audit_log(
    at, team, actor_id, actor_name, actor_role,
    action, entity, entity_id, summary, changed)
  values (
    now(), null, p_actor_id, v_actor_name, 'superadmin',
    case when p_active then 'account_enabled' else 'account_disabled' end,
    'account', p_target_id::text,
    case when p_active then 'إعادة تفعيل حساب' else 'تعطيل حساب' end,
    jsonb_build_object('field', 'active', 'new', p_active)
  );
end $$;

-- صلاحية التنفيذ إلى service_role فقط (لا PUBLIC/anon/authenticated).
revoke all on function public.superadmin_audit_account_status(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.superadmin_audit_account_status(uuid, uuid, boolean)
  to service_role;

commit;
