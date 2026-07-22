-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 5/8: توسيع سجل التعديلات (Audit Log)
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  أولاً: إغلاق ثغرة cross-team في leave_ledger (يفرض الوردية من الموظف
--  قبل تقييم RLS WITH CHECK) ثم إعادة تعريف audit_capture مع الحفاظ على كل
--  الفروع الحالية + إضافة:
--   • leave_policies (Allowlist: policy_mode/entitled_days/max_carryover/day_count_basis)
--   • leave_ledger  (ملخّص فقط؛ نص السبب لا يُخزَّن؛ الوردية من الموظف)
--   • حقول تجاوز الرصيد في leaves (السبب لا يُخزَّن نصّاً)
--  ثم مشغّلا trg_audit على leave_policies و leave_ledger.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- (0) حماية leave_ledger: فرض الوردية والحقول الموثوقة من الخادم قبل RLS.
--     يعمل كـ BEFORE INSERT فيسبق تقييم RLS WITH CHECK: إذا حاول مسؤول w1
--     إدخال قيد لموظف w2 بوسم team='w1'، يُعاد team إلى w2 فترفضه سياسة RLS
--     (لأن وردية المسؤول w1)، ولا يتغيّر رصيد موظف w2.
-- ---------------------------------------------------------------------
create or replace function public.fn_leave_ledger_server_fields()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_team text;
begin
  select e.team
    into v_team
    from public.employees e
   where e.id = NEW.emp_id;

  if v_team is null or v_team = '' then
    raise exception 'leave_ledger: الموظف غير موجود أو ورديته غير صالحة';
  end if;

  NEW.team       := v_team;                 -- من employees لا من العميل
  NEW.created_by := (select auth.uid());    -- من الجلسة لا من العميل
  NEW.created_at := now();                   -- من الخادم لا من العميل

  return NEW;
end $$;

drop trigger if exists trg_ledger_server on public.leave_ledger;
create trigger trg_ledger_server
  before insert on public.leave_ledger
  for each row execute function public.fn_leave_ledger_server_fields();

revoke all on function public.fn_leave_ledger_server_fields()
  from public, anon, authenticated;

create or replace function public.audit_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid;
  v_role    text;
  v_name    text;
  v_team    text;
  v_action  text := lower(tg_op);
  v_entity  text := tg_table_name;
  v_id      text;
  v_summary text;
  v_changed jsonb;
  v_new     jsonb;
  v_old     jsonb;
  v_row     jsonb;
  v_emp_id  public.employees.id%type;
  v_emp     text;
  v_nd      jsonb;
  v_od      jsonb;
begin
  if v_entity = 'audit_log' then
    return null;
  end if;

  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old); end if;
  v_row := coalesce(v_new, v_old);

  v_actor := (select auth.uid());
  if v_actor is not null then
    select coalesce(u.raw_app_meta_data->>'name', split_part(u.email, '@', 1)),
           coalesce(u.raw_app_meta_data->>'role', 'unknown')
      into v_name, v_role
      from auth.users u
     where u.id = v_actor;
  end if;
  if v_actor is null then v_role := 'system'; v_name := 'system'; end if;
  v_role := coalesce(v_role, 'unknown');
  v_name := coalesce(v_name, 'unknown');

  v_team := case when tg_op = 'DELETE' then (v_old->>'team') else (v_new->>'team') end;

  -- ---------------- employees ----------------
  if v_entity = 'employees' then
    v_id := v_row->>'id';
    if tg_op = 'INSERT' then
      v_summary := 'أضاف موظفاً: ' || coalesce(v_new->>'name','');
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف موظفاً: ' || coalesce(v_old->>'name','');
    else
      v_summary := 'عدّل بيانات موظف: ' || coalesce(v_new->>'name','');
      v_changed := '{}'::jsonb;
      if (v_new->>'name')        is distinct from (v_old->>'name')        then v_changed := v_changed || jsonb_build_object('name',        jsonb_build_object('old', v_old->'name',        'new', v_new->'name')); end if;
      if (v_new->>'cycle_start') is distinct from (v_old->>'cycle_start') then v_changed := v_changed || jsonb_build_object('cycle_start', jsonb_build_object('old', v_old->'cycle_start', 'new', v_new->'cycle_start')); end if;
      if (v_new->>'sort_order')  is distinct from (v_old->>'sort_order')  then v_changed := v_changed || jsonb_build_object('sort_order',  jsonb_build_object('old', v_old->'sort_order',  'new', v_new->'sort_order')); end if;
      if (v_new->>'emp_no')      is distinct from (v_old->>'emp_no')      then v_changed := v_changed || jsonb_build_object('emp_no',      jsonb_build_object('changed', true)); end if;
      if v_changed = '{}'::jsonb then v_changed := null; end if;
    end if;

  -- ---------------- leaves ----------------
  elsif v_entity = 'leaves' then
    v_emp_id := (case when tg_op = 'DELETE' then (v_old->>'emp_id') else (v_new->>'emp_id') end);
    v_emp := coalesce((select e.name from public.employees e where e.id = v_emp_id), '—');
    v_id := v_row->>'id';
    if tg_op = 'INSERT' then
      if coalesce((v_new->>'balance_override')::boolean, false) then
        v_summary := 'أضاف طلب إجازة مع تجاوز الرصيد لـ ' || v_emp;
      else
        v_summary := 'أضاف طلب إجازة لـ ' || v_emp;
      end if;
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف طلب إجازة لـ ' || v_emp;
    else
      if (v_new->>'status') is distinct from (v_old->>'status') then
        if    (v_new->>'status') = 'معتمد' then
          -- الاعتماد إلى «معتمد»: إن كان التجاوز مفعّلاً (حتى لو كان true مسبقاً
          -- ولم يتغيّر في هذا التحديث) يُسجَّل كاعتماد مع تجاوز الرصيد.
          if coalesce((v_new->>'balance_override')::boolean, false) then
            v_summary := 'اعتمد طلب إجازة مع تجاوز الرصيد لـ ' || v_emp;
          else
            v_summary := 'اعتمد طلب إجازة لـ ' || v_emp;
          end if;
        elsif (v_new->>'status') = 'مرفوض' then v_summary := 'رفض طلب إجازة لـ ' || v_emp;
        else  v_summary := 'غيّر حالة طلب إجازة لـ ' || v_emp || ' إلى ' || coalesce(v_new->>'status','');
        end if;
      else
        v_summary := 'عدّل طلب إجازة لـ ' || v_emp;
      end if;
      v_changed := '{}'::jsonb;
      if (v_new->>'status')    is distinct from (v_old->>'status')    then v_changed := v_changed || jsonb_build_object('status', jsonb_build_object('old', v_old->'status', 'new', v_new->'status')); end if;
      if (v_new->>'type')      is distinct from (v_old->>'type')      then v_changed := v_changed || jsonb_build_object('type',      jsonb_build_object('changed', true)); end if;
      if (v_new->>'from_date') is distinct from (v_old->>'from_date') then v_changed := v_changed || jsonb_build_object('from_date', jsonb_build_object('changed', true)); end if;
      if (v_new->>'to_date')   is distinct from (v_old->>'to_date')   then v_changed := v_changed || jsonb_build_object('to_date',   jsonb_build_object('changed', true)); end if;
      if (v_new->>'notes')     is distinct from (v_old->>'notes')     then v_changed := v_changed || jsonb_build_object('notes',     jsonb_build_object('changed', true)); end if;
      -- تجاوز الرصيد: نسجّل الحدث فقط، لا نص السبب
      if (v_new->>'balance_override') is distinct from (v_old->>'balance_override') then
        v_changed := v_changed || jsonb_build_object('balance_override', jsonb_build_object('old', v_old->'balance_override', 'new', v_new->'balance_override'));
      end if;
      if (v_new->>'balance_override_reason') is distinct from (v_old->>'balance_override_reason') then
        -- الحدث فقط (changed) — لا يُخزَّن نص السبب مطلقاً
        v_changed := v_changed || jsonb_build_object('balance_override_reason', jsonb_build_object('changed', true));
      end if;
      if v_changed = '{}'::jsonb then v_changed := null; end if;
    end if;

  -- ---------------- overrides ----------------
  elsif v_entity = 'overrides' then
    v_emp_id := (case when tg_op = 'DELETE' then (v_old->>'emp_id') else (v_new->>'emp_id') end);
    v_emp := coalesce((select e.name from public.employees e where e.id = v_emp_id), '—');
    v_id := (v_row->>'emp_id') || '|' || (v_row->>'day');
    if tg_op = 'DELETE' then
      v_summary := 'أزال تعديل جدول ' || v_emp || ' ليوم ' || (v_old->>'day');
    else
      v_summary := 'عدّل جدول موظف ' || v_emp || ' ليوم ' || (v_new->>'day') || ' إلى ' || coalesce(v_new->>'value','—');
      if tg_op = 'UPDATE' then
        v_changed := '{}'::jsonb;
        if (v_new->>'day')   is distinct from (v_old->>'day')   then v_changed := v_changed || jsonb_build_object('day',   jsonb_build_object('old', v_old->'day',   'new', v_new->'day')); end if;
        if (v_new->>'value') is distinct from (v_old->>'value') then v_changed := v_changed || jsonb_build_object('value', jsonb_build_object('old', v_old->'value', 'new', v_new->'value')); end if;
        if v_changed = '{}'::jsonb then v_changed := null; end if;
      end if;
    end if;

  -- ---------------- point_shifts ----------------
  elsif v_entity = 'point_shifts' then
    v_id := (v_row->>'day') || '|' || (v_row->>'shift');
    if tg_op = 'INSERT' then
      v_summary := case when coalesce((v_new->>'approved')::boolean, false)
                        then 'اعتمد توزيع النقطة (' else 'عدّل توزيع النقطة (' end
                   || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف توزيع النقطة (' || (v_old->>'shift') || ' ' || (v_old->>'day') || ')';
    else
      if coalesce((v_new->>'approved')::boolean, false) and not coalesce((v_old->>'approved')::boolean, false) then
        v_summary := 'اعتمد توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      elsif not coalesce((v_new->>'approved')::boolean, false) and coalesce((v_old->>'approved')::boolean, false) then
        v_summary := 'ألغى اعتماد توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      else
        v_summary := 'عدّل توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      end if;
      v_changed := '{}'::jsonb;
      if (v_new->>'approved')       is distinct from (v_old->>'approved')       then v_changed := v_changed || jsonb_build_object('approved',       jsonb_build_object('old', v_old->'approved',   'new', v_new->'approved')); end if;
      if (v_new->>'day')            is distinct from (v_old->>'day')            then v_changed := v_changed || jsonb_build_object('day',            jsonb_build_object('old', v_old->'day',        'new', v_new->'day')); end if;
      if (v_new->>'shift')          is distinct from (v_old->>'shift')          then v_changed := v_changed || jsonb_build_object('shift',          jsonb_build_object('old', v_old->'shift',      'new', v_new->'shift')); end if;
      if (v_new->>'point_name')     is distinct from (v_old->>'point_name')     then v_changed := v_changed || jsonb_build_object('point_name',     jsonb_build_object('old', v_old->'point_name', 'new', v_new->'point_name')); end if;
      if (v_new->'emp_order')       is distinct from (v_old->'emp_order')       then v_changed := v_changed || jsonb_build_object('emp_order',      jsonb_build_object('changed', true)); end if;
      if (v_new->>'approved_by')    is distinct from (v_old->>'approved_by')    then v_changed := v_changed || jsonb_build_object('approved_by',    jsonb_build_object('changed', true)); end if;
      if (v_new->>'approved_title') is distinct from (v_old->>'approved_title') then v_changed := v_changed || jsonb_build_object('approved_title', jsonb_build_object('changed', true)); end if;
      if v_changed = '{}'::jsonb then v_changed := null; end if;
    end if;

  -- ---------------- settings ----------------
  elsif v_entity = 'settings' then
    v_id := case when tg_op = 'DELETE' then (v_old->>'team') else (v_new->>'team') end;
    if tg_op = 'INSERT' then
      v_summary := 'أنشأ إعدادات الوردية';
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف إعدادات الوردية';
    else
      v_nd := coalesce(v_new->'data', '{}'::jsonb);
      v_od := coalesce(v_old->'data', '{}'::jsonb);
      v_changed := (
        select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
        from (
          select k from jsonb_object_keys(v_nd) as k
          union
          select k from jsonb_object_keys(v_od) as k
        ) kk
        where k not in ('logo','logoW','logoH')
          and (v_od->k) is distinct from (v_nd->k)
      );
      if (v_od->'logo')  is distinct from (v_nd->'logo')
      or (v_od->'logoW') is distinct from (v_nd->'logoW')
      or (v_od->'logoH') is distinct from (v_nd->'logoH') then
        v_changed := coalesce(v_changed, '[]'::jsonb) || to_jsonb('الشعار'::text);
      end if;
      v_summary := 'عدّل إعدادات الوردية'
        || case when jsonb_array_length(coalesce(v_changed, '[]'::jsonb)) > 0
                then ' (' || array_to_string(array(select jsonb_array_elements_text(v_changed)), '، ') || ')'
                else '' end;
      if jsonb_array_length(coalesce(v_changed, '[]'::jsonb)) = 0 then v_changed := null; end if;
    end if;

  -- ---------------- leave_policies (جديد) ----------------
  elsif v_entity = 'leave_policies' then
    v_id := (v_row->>'team') || '|' || (v_row->>'year') || '|' || (v_row->>'type');
    if tg_op = 'INSERT' then
      v_summary := 'ضبط سياسة رصيد (' || (v_new->>'type') || ' ' || (v_new->>'year') || ')';
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف سياسة رصيد (' || (v_old->>'type') || ' ' || (v_old->>'year') || ')';
    else
      v_summary := 'عدّل سياسة رصيد (' || (v_new->>'type') || ' ' || (v_new->>'year') || ')';
      v_changed := '{}'::jsonb;
      if (v_new->>'policy_mode')     is distinct from (v_old->>'policy_mode')     then v_changed := v_changed || jsonb_build_object('policy_mode',     jsonb_build_object('old', v_old->'policy_mode',     'new', v_new->'policy_mode')); end if;
      if (v_new->>'entitled_days')   is distinct from (v_old->>'entitled_days')   then v_changed := v_changed || jsonb_build_object('entitled_days',   jsonb_build_object('old', v_old->'entitled_days',   'new', v_new->'entitled_days')); end if;
      if (v_new->>'max_carryover')   is distinct from (v_old->>'max_carryover')   then v_changed := v_changed || jsonb_build_object('max_carryover',   jsonb_build_object('old', v_old->'max_carryover',   'new', v_new->'max_carryover')); end if;
      if (v_new->>'day_count_basis') is distinct from (v_old->>'day_count_basis') then v_changed := v_changed || jsonb_build_object('day_count_basis', jsonb_build_object('old', v_old->'day_count_basis', 'new', v_new->'day_count_basis')); end if;
      if v_changed = '{}'::jsonb then v_changed := null; end if;
    end if;

  -- ---------------- leave_ledger (جديد) — ملخّص فقط، لا نص السبب ----------------
  elsif v_entity = 'leave_ledger' then
    v_emp_id := (case when tg_op = 'DELETE' then (v_old->>'emp_id') else (v_new->>'emp_id') end);
    v_emp := coalesce((select e.name from public.employees e where e.id = v_emp_id), '—');
    -- وردية سجل التدقيق من الموظف في القاعدة، لا من قيمة team المرسلة
    v_team := coalesce((select e.team from public.employees e where e.id = v_emp_id), v_team);
    v_id := v_row->>'id';
    if tg_op = 'INSERT' then
      v_summary := 'أضاف '
        || case (v_new->>'kind')
             when 'initial'   then 'رصيداً ابتدائياً'
             when 'carryover' then 'ترحيل رصيد'
             else 'تعديل رصيد' end
        || ' (' || (case when (v_new->>'days')::numeric >= 0 then '+' else '' end) || (v_new->>'days')
        || ' ' || (v_new->>'type') || ' ' || (v_new->>'year') || ') لـ ' || v_emp;
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف قيد رصيد لـ ' || v_emp;
    else
      v_summary := 'عدّل قيد رصيد لـ ' || v_emp;
    end if;

  else
    v_id := null;
    v_summary := v_action || ' ' || v_entity;
  end if;

  insert into public.audit_log
    (team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  values
    (v_team, v_actor, v_name, v_role, v_action, v_entity, v_id, v_summary, v_changed);

  return null;
exception when others then
  raise warning 'audit_capture failed for %.% [%]: %', tg_table_schema, tg_table_name, sqlstate, sqlerrm;
  return null;
end $$;

-- مشغّلا التدقيق على جدولي الرصيد
drop trigger if exists trg_audit on public.leave_policies;
create trigger trg_audit
  after insert or update or delete on public.leave_policies
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.leave_ledger;
create trigger trg_audit
  after insert or update or delete on public.leave_ledger
  for each row execute function public.audit_capture();

revoke all on function public.audit_capture() from public, anon, authenticated;

commit;
