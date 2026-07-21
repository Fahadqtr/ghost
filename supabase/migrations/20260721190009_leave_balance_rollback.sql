-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | Rollback موحّد مرتّب (مراجعة فقط)
--  يُلغي كل ما أنشأته migrations 1..7 ويعيد الدوال المعدّلة إلى نسختها
--  قبل المرحلة ٢. لا يُشغَّل تلقائياً.
--  الترتيب الآمن: مشغّلات ← استعادة الدوال المعدّلة ← دوال جديدة ← جداول ← أعمدة.
-- =====================================================================
begin;

-- (1) مشغّلات المرحلة ٢
drop trigger if exists trg_balance_validate on public.leaves;
drop trigger if exists trg_audit on public.leave_policies;
drop trigger if exists trg_audit on public.leave_ledger;

-- (2) استعادة audit_capture إلى نسخة ما قبل المرحلة ٢ (بلا فروع الرصيد)
create or replace function public.audit_capture()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid; v_role text; v_name text; v_team text;
  v_action text := lower(tg_op); v_entity text := tg_table_name;
  v_id text; v_summary text; v_changed jsonb;
  v_new jsonb; v_old jsonb; v_row jsonb;
  v_emp_id public.employees.id%type; v_emp text; v_nd jsonb; v_od jsonb;
begin
  if v_entity = 'audit_log' then return null; end if;
  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old); end if;
  v_row := coalesce(v_new, v_old);
  v_actor := (select auth.uid());
  if v_actor is not null then
    select coalesce(u.raw_app_meta_data->>'name', split_part(u.email,'@',1)),
           coalesce(u.raw_app_meta_data->>'role','unknown')
      into v_name, v_role from auth.users u where u.id = v_actor;
  end if;
  if v_actor is null then v_role := 'system'; v_name := 'system'; end if;
  v_role := coalesce(v_role,'unknown'); v_name := coalesce(v_name,'unknown');
  v_team := case when tg_op='DELETE' then (v_old->>'team') else (v_new->>'team') end;

  if v_entity = 'employees' then
    v_id := v_row->>'id';
    if tg_op='INSERT' then v_summary := 'أضاف موظفاً: ' || coalesce(v_new->>'name','');
    elsif tg_op='DELETE' then v_summary := 'حذف موظفاً: ' || coalesce(v_old->>'name','');
    else
      v_summary := 'عدّل بيانات موظف: ' || coalesce(v_new->>'name','');
      v_changed := '{}'::jsonb;
      if (v_new->>'name') is distinct from (v_old->>'name') then v_changed := v_changed || jsonb_build_object('name', jsonb_build_object('old',v_old->'name','new',v_new->'name')); end if;
      if (v_new->>'cycle_start') is distinct from (v_old->>'cycle_start') then v_changed := v_changed || jsonb_build_object('cycle_start', jsonb_build_object('old',v_old->'cycle_start','new',v_new->'cycle_start')); end if;
      if (v_new->>'sort_order') is distinct from (v_old->>'sort_order') then v_changed := v_changed || jsonb_build_object('sort_order', jsonb_build_object('old',v_old->'sort_order','new',v_new->'sort_order')); end if;
      if (v_new->>'emp_no') is distinct from (v_old->>'emp_no') then v_changed := v_changed || jsonb_build_object('emp_no', jsonb_build_object('changed',true)); end if;
      if v_changed = '{}'::jsonb then v_changed := null; end if;
    end if;
  elsif v_entity = 'leaves' then
    v_emp_id := (case when tg_op='DELETE' then (v_old->>'emp_id') else (v_new->>'emp_id') end);
    v_emp := coalesce((select e.name from public.employees e where e.id=v_emp_id),'—');
    v_id := v_row->>'id';
    if tg_op='INSERT' then v_summary := 'أضاف طلب إجازة لـ ' || v_emp;
    elsif tg_op='DELETE' then v_summary := 'حذف طلب إجازة لـ ' || v_emp;
    else
      if (v_new->>'status') is distinct from (v_old->>'status') then
        if (v_new->>'status')='معتمد' then v_summary := 'اعتمد طلب إجازة لـ ' || v_emp;
        elsif (v_new->>'status')='مرفوض' then v_summary := 'رفض طلب إجازة لـ ' || v_emp;
        else v_summary := 'غيّر حالة طلب إجازة لـ ' || v_emp || ' إلى ' || coalesce(v_new->>'status',''); end if;
      else v_summary := 'عدّل طلب إجازة لـ ' || v_emp; end if;
      v_changed := '{}'::jsonb;
      if (v_new->>'status') is distinct from (v_old->>'status') then v_changed := v_changed || jsonb_build_object('status', jsonb_build_object('old',v_old->'status','new',v_new->'status')); end if;
      if (v_new->>'type') is distinct from (v_old->>'type') then v_changed := v_changed || jsonb_build_object('type', jsonb_build_object('changed',true)); end if;
      if (v_new->>'from_date') is distinct from (v_old->>'from_date') then v_changed := v_changed || jsonb_build_object('from_date', jsonb_build_object('changed',true)); end if;
      if (v_new->>'to_date') is distinct from (v_old->>'to_date') then v_changed := v_changed || jsonb_build_object('to_date', jsonb_build_object('changed',true)); end if;
      if (v_new->>'notes') is distinct from (v_old->>'notes') then v_changed := v_changed || jsonb_build_object('notes', jsonb_build_object('changed',true)); end if;
      if v_changed = '{}'::jsonb then v_changed := null; end if;
    end if;
  elsif v_entity = 'overrides' then
    v_emp_id := (case when tg_op='DELETE' then (v_old->>'emp_id') else (v_new->>'emp_id') end);
    v_emp := coalesce((select e.name from public.employees e where e.id=v_emp_id),'—');
    v_id := (v_row->>'emp_id') || '|' || (v_row->>'day');
    if tg_op='DELETE' then v_summary := 'أزال تعديل جدول ' || v_emp || ' ليوم ' || (v_old->>'day');
    else
      v_summary := 'عدّل جدول موظف ' || v_emp || ' ليوم ' || (v_new->>'day') || ' إلى ' || coalesce(v_new->>'value','—');
      if tg_op='UPDATE' then
        v_changed := '{}'::jsonb;
        if (v_new->>'day') is distinct from (v_old->>'day') then v_changed := v_changed || jsonb_build_object('day', jsonb_build_object('old',v_old->'day','new',v_new->'day')); end if;
        if (v_new->>'value') is distinct from (v_old->>'value') then v_changed := v_changed || jsonb_build_object('value', jsonb_build_object('old',v_old->'value','new',v_new->'value')); end if;
        if v_changed = '{}'::jsonb then v_changed := null; end if;
      end if;
    end if;
  elsif v_entity = 'point_shifts' then
    v_id := (v_row->>'day') || '|' || (v_row->>'shift');
    if tg_op='INSERT' then
      v_summary := case when coalesce((v_new->>'approved')::boolean,false) then 'اعتمد توزيع النقطة (' else 'عدّل توزيع النقطة (' end || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
    elsif tg_op='DELETE' then v_summary := 'حذف توزيع النقطة (' || (v_old->>'shift') || ' ' || (v_old->>'day') || ')';
    else
      if coalesce((v_new->>'approved')::boolean,false) and not coalesce((v_old->>'approved')::boolean,false) then v_summary := 'اعتمد توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      elsif not coalesce((v_new->>'approved')::boolean,false) and coalesce((v_old->>'approved')::boolean,false) then v_summary := 'ألغى اعتماد توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      else v_summary := 'عدّل توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')'; end if;
      v_changed := '{}'::jsonb;
      if (v_new->>'approved') is distinct from (v_old->>'approved') then v_changed := v_changed || jsonb_build_object('approved', jsonb_build_object('old',v_old->'approved','new',v_new->'approved')); end if;
      if (v_new->>'day') is distinct from (v_old->>'day') then v_changed := v_changed || jsonb_build_object('day', jsonb_build_object('old',v_old->'day','new',v_new->'day')); end if;
      if (v_new->>'shift') is distinct from (v_old->>'shift') then v_changed := v_changed || jsonb_build_object('shift', jsonb_build_object('old',v_old->'shift','new',v_new->'shift')); end if;
      if (v_new->>'point_name') is distinct from (v_old->>'point_name') then v_changed := v_changed || jsonb_build_object('point_name', jsonb_build_object('old',v_old->'point_name','new',v_new->'point_name')); end if;
      if (v_new->'emp_order') is distinct from (v_old->'emp_order') then v_changed := v_changed || jsonb_build_object('emp_order', jsonb_build_object('changed',true)); end if;
      if (v_new->>'approved_by') is distinct from (v_old->>'approved_by') then v_changed := v_changed || jsonb_build_object('approved_by', jsonb_build_object('changed',true)); end if;
      if (v_new->>'approved_title') is distinct from (v_old->>'approved_title') then v_changed := v_changed || jsonb_build_object('approved_title', jsonb_build_object('changed',true)); end if;
      if v_changed = '{}'::jsonb then v_changed := null; end if;
    end if;
  elsif v_entity = 'settings' then
    v_id := case when tg_op='DELETE' then (v_old->>'team') else (v_new->>'team') end;
    if tg_op='INSERT' then v_summary := 'أنشأ إعدادات الوردية';
    elsif tg_op='DELETE' then v_summary := 'حذف إعدادات الوردية';
    else
      v_nd := coalesce(v_new->'data','{}'::jsonb); v_od := coalesce(v_old->'data','{}'::jsonb);
      v_changed := (select coalesce(jsonb_agg(k order by k),'[]'::jsonb) from (select k from jsonb_object_keys(v_nd) as k union select k from jsonb_object_keys(v_od) as k) kk where k not in ('logo','logoW','logoH') and (v_od->k) is distinct from (v_nd->k));
      if (v_od->'logo') is distinct from (v_nd->'logo') or (v_od->'logoW') is distinct from (v_nd->'logoW') or (v_od->'logoH') is distinct from (v_nd->'logoH') then v_changed := coalesce(v_changed,'[]'::jsonb) || to_jsonb('الشعار'::text); end if;
      v_summary := 'عدّل إعدادات الوردية' || case when jsonb_array_length(coalesce(v_changed,'[]'::jsonb))>0 then ' (' || array_to_string(array(select jsonb_array_elements_text(v_changed)),'، ') || ')' else '' end;
      if jsonb_array_length(coalesce(v_changed,'[]'::jsonb))=0 then v_changed := null; end if;
    end if;
  else v_id := null; v_summary := v_action || ' ' || v_entity; end if;

  insert into public.audit_log(team,actor_id,actor_name,actor_role,action,entity,entity_id,summary,changed)
  values (v_team,v_actor,v_name,v_role,v_action,v_entity,v_id,v_summary,v_changed);
  return null;
exception when others then
  raise warning 'audit_capture failed for %.% [%]: %', tg_table_schema, tg_table_name, sqlstate, sqlerrm;
  return null;
end $$;
revoke all on function public.audit_capture() from public;

-- (3) استعادة shift_archive_user إلى نسختها الأصلية (بلا أرشفة ledger)
create or replace function public.shift_archive_user()
returns trigger language plpgsql security definer
set search_path to 'public','auth','extensions'
as $function$
begin
  insert into public.archived_employees(id,name,emp_no,cycle_start) values(OLD.id,OLD.name,OLD.emp_no,OLD.cycle_start);
  insert into public.archived_leaves(id,emp_id,type,from_date,to_date,status,notes)
    select id,emp_id,type,from_date,to_date,status,notes from public.leaves where emp_id = OLD.id;
  delete from auth.users where email = 'e'||OLD.emp_no||'@shift.local';
  return OLD;
end $function$;

-- (4) استعادة shift_provision_user إلى نسختها الأصلية (بلا employee_auth)
create or replace function public.shift_provision_user()
returns trigger language plpgsql security definer
set search_path to 'public','auth','extensions'
as $function$
declare uid uuid := gen_random_uuid(); em text := 'e'||NEW.emp_no||'@shift.local';
begin
  if NEW.emp_no is null or NEW.emp_no = '' then return NEW; end if;
  if exists(select 1 from auth.users where email = em) then return NEW; end if;
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token)
   values('00000000-0000-0000-0000-000000000000',uid,'authenticated','authenticated',em,crypt(NEW.emp_no,gen_salt('bf')),now(),now(),now(),
     jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'role','viewer','team',coalesce(NEW.team,'w1')),
     jsonb_build_object('username','e'||NEW.emp_no,'full_name',NEW.name,'emp_no',NEW.emp_no),
     '','','','','','');
  insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
   values(uid::text,uid,jsonb_build_object('sub',uid::text,'email',em,'email_verified',true),'email',now(),now(),now());
  return NEW;
end $function$;

-- (5) دوال المرحلة ٢
drop function if exists public.my_leave_balances(int);
drop function if exists public.team_leave_balances(int,text);
drop function if exists public.fn_leave_balance(uuid,int);
drop function if exists public.fn_leave_used(uuid,int,text,uuid);
drop function if exists public.fn_leave_days_in_range(uuid,date,date,int,text);
drop function if exists public.fn_validate_leave_balance();

-- (6) جداول المرحلة ٢
drop table if exists public.leave_ledger;
drop table if exists public.archived_leave_ledger;
drop table if exists public.leave_policies;
drop table if exists public.employee_auth;

-- (7) أعمدة تجاوز الرصيد + فهرس الاشتقاق
alter table public.leaves
  drop column if exists balance_override,
  drop column if exists balance_override_reason,
  drop column if exists balance_override_by,
  drop column if exists balance_override_at;
drop index if exists public.leaves_balance_idx;

commit;
