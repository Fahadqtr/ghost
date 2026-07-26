-- =====================================================================
--  المرحلة 8 — إصلاح تصحيحي: قيمة Audit action لتوليد الجدول
--
--  العيب: generate_work_schedule كان يستدعي _ws_audit(..., 'generate', ...)
--  و public.audit_log لديه قيد audit_log_action_check لا يسمح بالقيمة
--  'generate' (يسمح فقط بـ insert/update/delete/account_*/head_*/access_denied)،
--  فتفشل الدالة على الإنتاج بخطأ 23514 عند كتابة سطر التدقيق.
--
--  الإصلاح الوحيد: CREATE OR REPLACE للتعريف الحرفي من Commit 5a5c12a مع
--  تغيير action من 'generate' إلى 'insert' فقط (قيمة قائمة ومسموحة، متسقة مع
--  _att_audit(..., 'insert', ...) عند تسجيل الدخول). لا تغيير في التوقيع أو
--  النطاق أو الصلاحيات أو منطق الدوران/التوليد/Versioning/History/Lock/
--  الإرجاع أو الجداول/الفهارس/المنح؛ ولا تعديل على قيد audit_log.
--  SECURITY DEFINER + search_path='' كما هي.
-- =====================================================================

create or replace function public.generate_work_schedule(p_from_date date, p_to_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.audit_current_user_role();
  v_teams text[]; v_now timestamptz := now();
  v_created int := 0; v_updated int := 0; v_skip_lock int := 0; v_skip_manual int := 0; v_skip_nodef int := 0; v_days int;
  t record; e record; d date; v_code text; v_working boolean; v_shift text;
  v_ov text; v_src text; v_es timestamptz; v_ee timestamptz;
  v_def_id uuid; v_def_ov boolean; v_def_start time; v_def_end time; v_pol_id uuid;
  ex record; v_new jsonb; v_id uuid;
begin
  if v_role is null or v_role not in ('superadmin','owner') then
    raise exception using errcode='42501', message='غير مصرّح بتوليد الجدول';
  end if;
  if p_from_date is null or p_to_date is null or p_to_date < p_from_date then
    raise exception using errcode='22007', message='نطاق تواريخ غير صالح';
  end if;
  v_days := (p_to_date - p_from_date) + 1;
  if v_days < 1 or v_days > 90 then
    raise exception using errcode='22003', message='النطاق يجب أن يكون بين 1 و90 يومًا';
  end if;
  v_teams := public._report_scope_teams();   -- forbidden للخارج عن النطاق
  if v_teams is null or array_length(v_teams,1) is null then
    return jsonb_build_object('ok', true, 'created',0,'updated',0,'skipped_locked',0,'skipped_manual',0,'skipped_no_definition',0);
  end if;

  for t in select team, dept, data from public.settings where team = any(v_teams) loop
    for e in select id, cycle_start, team from public.employees where team = t.team loop
      d := p_from_date;
      while d <= p_to_date loop
        v_code := public._ws_rotation_code(
          coalesce(e.cycle_start, (t.data->>'scheduleStart')::date),
          nullif((t.data->>'workDays'),'')::int, nullif((t.data->>'restDays'),'')::int,
          t.data->>'startShift', d);
        if v_code in ('__before__','__invalid__') then d := d + 1; continue; end if;

        -- override يدوي نصّي لليوم
        select value into v_ov from public.overrides where emp_id = e.id and day = d;
        if v_ov is not null then
          v_src := 'override';
          if v_ov in ('صباح','عصر','ليل') then v_working := true; v_shift := v_ov;
          else v_working := false; v_shift := null; end if;
        else
          v_src := 'rotation';
          if v_code = '' then v_working := false; v_shift := null;
          else v_working := true; v_shift := v_code; end if;
        end if;

        v_es := null; v_ee := null; v_def_id := null; v_def_ov := null; v_pol_id := null;
        if v_working then
          select id, is_overnight, start_local_time, end_local_time
            into v_def_id, v_def_ov, v_def_start, v_def_end from public._ws_shift_def_at(v_shift, d);
          if v_def_id is null then v_skip_nodef := v_skip_nodef + 1; d := d + 1; continue; end if;
          v_es := ((d::text||' '||v_def_start::text)::timestamp at time zone 'Asia/Qatar');
          if v_def_ov then
            v_ee := (((d + 1)::text||' '||v_def_end::text)::timestamp at time zone 'Asia/Qatar');
          else
            v_ee := ((d::text||' '||v_def_end::text)::timestamp at time zone 'Asia/Qatar');
          end if;
          select id into v_pol_id from public._ws_policy_at(t.team, t.dept, v_shift, d);
        end if;

        select * into ex from public.employee_work_schedule where employee_id = e.id and work_date = d;
        if ex.id is not null then
          if ex.locked_at is not null then v_skip_lock := v_skip_lock + 1; d := d + 1; continue; end if;
          if ex.source = 'manual' then v_skip_manual := v_skip_manual + 1; d := d + 1; continue; end if;
          -- تحديث فقط عند اختلاف فعلي (idempotent)
          if ex.is_working_day is distinct from v_working
             or ex.shift_code is distinct from v_shift
             or ex.expected_start_at is distinct from v_es
             or ex.expected_end_at is distinct from v_ee
             or ex.shift_definition_id is distinct from v_def_id
             or ex.policy_id is distinct from v_pol_id
             or ex.source is distinct from v_src then
            update public.employee_work_schedule
              set team=t.team, department=t.dept, shift_definition_id=v_def_id, policy_id=v_pol_id,
                  shift_code=v_shift, is_working_day=v_working, expected_start_at=v_es, expected_end_at=v_ee,
                  is_overnight=coalesce(v_def_ov,false), source=v_src, generated_at=v_now,
                  generated_by=(select auth.uid()), updated_at=v_now
              where id = ex.id;
            v_new := to_jsonb((select r from public.employee_work_schedule r where r.id=ex.id));
            insert into public.work_schedule_history(schedule_id, event_type, actor_id, actor_role, old_data, new_data)
              values (ex.id, 'generated', (select auth.uid()), v_role, public._ws_hist_json(to_jsonb(ex)), public._ws_hist_json(v_new));
            v_updated := v_updated + 1;
          end if;
        else
          insert into public.employee_work_schedule(employee_id, work_date, team, department, shift_definition_id,
              policy_id, shift_code, is_working_day, expected_start_at, expected_end_at, is_overnight, source,
              generated_at, generated_by)
            values (e.id, d, t.team, t.dept, v_def_id, v_pol_id, v_shift, v_working, v_es, v_ee,
              coalesce(v_def_ov,false), v_src, v_now, (select auth.uid()))
            on conflict (employee_id, work_date) do nothing   -- تزامن: نسخة أخرى أنشأته
            returning id into v_id;
          if v_id is not null then
            v_new := to_jsonb((select r from public.employee_work_schedule r where r.id=v_id));
            insert into public.work_schedule_history(schedule_id, event_type, actor_id, actor_role, new_data)
              values (v_id, 'generated', (select auth.uid()), v_role, public._ws_hist_json(v_new));
            v_created := v_created + 1;
          end if;
        end if;
        d := d + 1;
      end loop;
    end loop;
    -- الإصلاح الوحيد: 'generate' غير مسموح بقيد audit_log_action_check ⇒ 'insert' (مسموحة، متسقة)
    perform public._ws_audit(t.team, 'insert', null, 'توليد جدول '||p_from_date||'…'||p_to_date);
  end loop;

  return jsonb_build_object('ok', true, 'from', p_from_date, 'to', p_to_date,
    'created', v_created, 'updated', v_updated, 'skipped_locked', v_skip_lock,
    'skipped_manual', v_skip_manual, 'skipped_no_definition', v_skip_nodef);
end $$;

-- تثبيت ACL بعد CREATE OR REPLACE: authenticated فقط (anon/PUBLIC محظوران) — دون تغيير عن الأصل
revoke all on function public.generate_work_schedule(date,date) from anon, public;
grant execute on function public.generate_work_schedule(date,date) to authenticated;
