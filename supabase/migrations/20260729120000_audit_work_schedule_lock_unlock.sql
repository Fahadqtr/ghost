-- =====================================================================
--  تدقيق مركزي لعمليات قفل/فتح «جدول العمل المتوقع»
--
--  المشكلة: public.lock_work_schedule تُنشئ work_schedule_history لكل صف
--  (locked/unlocked) لكنها لا تكتب أي سطر في سجل التدقيق المركزي audit_log،
--  فلا تظهر عمليات القفل/الفتح في التدقيق (بخلاف التوليد والتعديل اليدوي).
--
--  الإصلاح: بعد اكتمال تحديث الصفوف وإنشاء history، تُضيف الدالة سطر تدقيق
--  مركزيًا واحدًا لكل استدعاء ناجح (affected > 0 فقط)، يميّز القفل عن الفتح
--  ويحمل النطاق والعدد الفعلي في العمود changed.
--
--  ملاحظة تصميمية: المساعد public._ws_audit(text,text,uuid,text) لا يقبل
--  وسيط changed (يُدرج changed=null دائمًا)، لذا يتعذّر تمرير الحقول المطلوبة
--  عبره. لتفادي تعديل مساعد مشترك يستدعيه generate/update، يُدرَج سطر التدقيق
--  مباشرةً هنا مع تكرار منطق استخلاص الفاعل نفسه المستخدم في _ws_audit
--  (الاسم/الدور من auth.users)، دون أي تغيير سلوكي آخر في الدالة.
--
--  ما لم يتغيّر (مطابق حرفيًا للتعريف الحالي): صلاحيات superadmin/owner،
--  عزل الفِرق عبر _report_scope_teams()، التحقق من النطاق، FOR UPDATE،
--  تحديث locked_at/updated_at، history لكل صف، قيمة affected، الذرّية،
--  SECURITY DEFINER، SET search_path=''، وأسماء البارامترات وشكل الإرجاع.
-- =====================================================================

create or replace function public.lock_work_schedule(p_from_date date, p_to_date date, p_lock boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_role text := public.audit_current_user_role();
  v_teams text[];
  v_n int := 0;
  r record;
  v_now timestamptz := now();
  v_actor uuid;
  v_aname text;
  v_arole text;
  v_touched text[] := '{}';
begin
  if v_role is null or v_role not in ('superadmin','owner') then raise exception using errcode='42501', message='غير مصرّح'; end if;
  if p_from_date is null or p_to_date is null or p_to_date < p_from_date then raise exception using errcode='22007', message='نطاق غير صالح'; end if;
  v_teams := public._report_scope_teams();
  for r in select id, team, locked_at from public.employee_work_schedule
             where team = any(v_teams) and work_date between p_from_date and p_to_date for update loop
    if p_lock and r.locked_at is null then
      update public.employee_work_schedule set locked_at = v_now, updated_at = v_now where id = r.id;
      insert into public.work_schedule_history(schedule_id, event_type, actor_id, actor_role) values (r.id, 'locked', (select auth.uid()), v_role);
      v_n := v_n + 1;
      if not (r.team = any(v_touched)) then v_touched := v_touched || r.team; end if;
    elsif not p_lock and r.locked_at is not null then
      update public.employee_work_schedule set locked_at = null, updated_at = v_now where id = r.id;
      insert into public.work_schedule_history(schedule_id, event_type, actor_id, actor_role) values (r.id, 'unlocked', (select auth.uid()), v_role);
      v_n := v_n + 1;
      if not (r.team = any(v_touched)) then v_touched := v_touched || r.team; end if;
    end if;
  end loop;

  -- تدقيق مركزي: سطر واحد فقط لكل استدعاء ناجح، ولا نسجّل عند غياب أي أثر.
  if v_n > 0 then
    v_actor := (select auth.uid());
    if v_actor is not null then
      select coalesce(u.raw_app_meta_data->>'name', split_part(u.email,'@',1)),
             coalesce(u.raw_app_meta_data->>'role','unknown')
        into v_aname, v_arole
      from auth.users u where u.id = v_actor;
    end if;
    insert into public.audit_log(team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
    values (
      case when array_length(v_touched, 1) = 1 then v_touched[1] else null end,
      v_actor, coalesce(v_aname, 'system'), coalesce(v_arole, 'system'),
      'update', 'employee_work_schedule', null,
      (case when p_lock then 'قفل جدول ' else 'فتح جدول ' end) || p_from_date || '…' || p_to_date || ' (' || v_n || ')',
      jsonb_build_object('from_date', p_from_date, 'to_date', p_to_date, 'locked', p_lock, 'affected', v_n, 'teams', to_jsonb(v_touched))
    );
  end if;

  return jsonb_build_object('ok', true, 'locked', p_lock, 'affected', v_n);
end $function$;
