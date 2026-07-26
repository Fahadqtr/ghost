-- =====================================================================
--  المرحلة 8 — جدول العمل المتوقع + سياسة الحضور + التغطية التشغيلية
--
--  Backend-أولًا · CREATE-only + Seed كتالوج مُراجَع · لا توليد جدول على
--  الإنتاج · لا تصنيف غياب · لا Backfill. الأعمدة المضافة إلى
--  attendance_sessions كلها Nullable؛ المرحلة 7 تستمر بلا جدول
--  (expected/late/early تبقى NULL). لا Realtime/Service Worker/Edge جديد.
--
--  النموذج: Snapshot يومي (employee_work_schedule) لأن إعدادات الدوران
--  والأوقات قابلة للتحرير وغير مؤرّخة؛ الأوقات من shift_definitions
--  المؤرّخة والسياسة من attendance_policies المؤرّخة، فلا يتحرّك الماضي.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) كتالوج الورديات المؤرّخ
-- ---------------------------------------------------------------------
create table if not exists public.shift_definitions (
  id               uuid primary key default gen_random_uuid(),
  shift_code       text not null,
  name_ar          text not null,
  name_en          text,
  start_local_time time not null,
  end_local_time   time not null,
  is_overnight     boolean generated always as (end_local_time <= start_local_time) stored,
  is_active        boolean not null default true,
  effective_from   date not null,
  effective_to     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  constraint shift_def_effective_range check (effective_to is null or effective_to >= effective_from)
);
-- نسخة مفتوحة واحدة لكل رمز وردية (تغيير الوقت = إغلاق النطاق ثم نسخة جديدة)
create unique index if not exists uq_shift_def_open on public.shift_definitions (shift_code) where effective_to is null;
create index if not exists idx_shift_def_code_eff on public.shift_definitions (shift_code, effective_from);

-- ---------------------------------------------------------------------
-- 2) سياسة الحضور المؤرّخة (بلا Seed — الحساب معطّل حتى تُضبط صراحةً)
-- ---------------------------------------------------------------------
create table if not exists public.attendance_policies (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  scope_type               text not null check (scope_type in ('global','department','team','shift')),
  scope_ref                text,
  grace_minutes            int  not null check (grace_minutes >= 0),
  absence_cutoff_minutes   int  not null check (absence_cutoff_minutes >= grace_minutes),
  early_leave_grace_minutes int not null check (early_leave_grace_minutes >= 0),
  max_session_hours        numeric not null check (max_session_hours > 0 and max_session_hours <= 48),
  minimum_staff_required   int check (minimum_staff_required is null or minimum_staff_required >= 0),
  effective_from           date not null,
  effective_to             date,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid,
  constraint att_policy_effective_range check (effective_to is null or effective_to >= effective_from),
  constraint att_policy_scope_ref check (
    (scope_type = 'global' and scope_ref is null) or
    (scope_type <> 'global' and scope_ref is not null and btrim(scope_ref) <> ''))
);
create unique index if not exists uq_att_policy_open on public.attendance_policies (scope_type, coalesce(scope_ref,'')) where effective_to is null;
create index if not exists idx_att_policy_scope_eff on public.attendance_policies (scope_type, scope_ref, effective_from);

-- ---------------------------------------------------------------------
-- 3) الجدول المتوقع (Snapshot يومي)
-- ---------------------------------------------------------------------
create table if not exists public.employee_work_schedule (
  id                 uuid primary key default gen_random_uuid(),
  employee_id        uuid not null references public.employees(id),
  work_date          date not null,
  team               text not null,
  department         text,
  shift_definition_id uuid references public.shift_definitions(id),
  policy_id          uuid references public.attendance_policies(id),
  shift_code         text,
  is_working_day     boolean not null,
  expected_start_at  timestamptz,
  expected_end_at    timestamptz,
  is_overnight       boolean not null default false,
  source             text not null check (source in ('rotation','override','manual','import')),
  source_reference   text,
  generated_at       timestamptz not null default now(),
  generated_by       uuid,
  locked_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ews_working_day_times check (
    (is_working_day    and expected_start_at is not null and expected_end_at is not null and expected_end_at > expected_start_at)
 or (not is_working_day and expected_start_at is null and expected_end_at is null))
);
create unique index if not exists uq_ews_emp_date on public.employee_work_schedule (employee_id, work_date);
create index if not exists idx_ews_team_date on public.employee_work_schedule (team, work_date);
create index if not exists idx_ews_date on public.employee_work_schedule (work_date);
create index if not exists idx_ews_shift_def on public.employee_work_schedule (shift_definition_id);
create index if not exists idx_ews_team_working on public.employee_work_schedule (team, work_date) where is_working_day;

-- ---------------------------------------------------------------------
-- 4) سجل تغييرات الجدول (إضافة-فقط)
-- ---------------------------------------------------------------------
create table if not exists public.work_schedule_history (
  id          uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.employee_work_schedule(id),
  event_type  text not null check (event_type in ('generated','updated','locked','unlocked','policy_changed','shift_changed','marked_off','marked_working')),
  actor_id    uuid,
  actor_role  text,
  reason      text,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ws_hist_schedule on public.work_schedule_history (schedule_id, created_at);

-- ---------------------------------------------------------------------
-- 5) أعمدة ربط اختيارية على attendance_sessions (Nullable، بلا Backfill)
-- ---------------------------------------------------------------------
alter table public.attendance_sessions add column if not exists schedule_id uuid references public.employee_work_schedule(id);
alter table public.attendance_sessions add column if not exists policy_id uuid references public.attendance_policies(id);
alter table public.attendance_sessions add column if not exists shift_definition_id uuid references public.shift_definitions(id);

-- ---------------------------------------------------------------------
-- RLS: تفعيل + منع الوصول المباشر (كل شيء عبر RPC)
-- ---------------------------------------------------------------------
alter table public.shift_definitions       enable row level security;
alter table public.attendance_policies     enable row level security;
alter table public.employee_work_schedule  enable row level security;
alter table public.work_schedule_history   enable row level security;
revoke all on public.shift_definitions,      public.attendance_policies,
              public.employee_work_schedule, public.work_schedule_history
  from anon, authenticated;

-- =====================================================================
--  دوال داخلية (بلا منح لأي دور)
-- =====================================================================

-- تنقيح JSON للسجل التاريخي (قائمة بيضاء؛ بلا email/uuid/token)
create or replace function public._ws_hist_json(p jsonb)
returns jsonb language sql immutable security definer set search_path = '' as $$
  select case when p is null then null else left(jsonb_build_object(
    'work_date', p->>'work_date', 'team', p->>'team', 'shift_code', p->>'shift_code',
    'is_working_day', p->>'is_working_day', 'expected_start_at', p->>'expected_start_at',
    'expected_end_at', p->>'expected_end_at', 'is_overnight', p->>'is_overnight',
    'source', p->>'source', 'locked', case when (p->>'locked_at') is not null then true else false end
  )::text, 4096)::jsonb end
$$;

-- كتابة سطر تدقيق واحد
create or replace function public._ws_audit(p_team text, p_action text, p_id uuid, p_summary text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_name text; v_role text;
begin
  if v_actor is not null then
    select coalesce(u.raw_app_meta_data->>'name', split_part(u.email,'@',1)),
           coalesce(u.raw_app_meta_data->>'role','unknown') into v_name, v_role
    from auth.users u where u.id = v_actor;
  end if;
  insert into public.audit_log(team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  values (p_team, v_actor, coalesce(v_name,'system'), coalesce(v_role,'system'), p_action,
          'employee_work_schedule', p_id::text, p_summary, null);
end $$;

-- رمز الدوران لتاريخ (immutable) — منقول حرفيًا من app.js (WORK_SHIFTS ثابت)
--   يعيد: رمز الوردية / '' (راحة) / '__before__' (قبل المرساة)
create or replace function public._ws_rotation_code(p_cycle_start date, p_work_days int, p_rest_days int, p_start_shift text, p_date date)
returns text language plpgsql immutable security definer set search_path = '' as $$
declare v_shifts text[] := array['صباح','عصر','ليل']; v_diff int; v_cycle int; v_pos int; v_start int; v_idx int;
begin
  if p_cycle_start is null or p_work_days is null or p_rest_days is null or coalesce(p_work_days,0) <= 0 then
    return '__invalid__';
  end if;
  v_diff := p_date - p_cycle_start;
  if v_diff < 0 then return '__before__'; end if;
  v_cycle := p_work_days + p_rest_days;
  if v_cycle <= 0 then return '__invalid__'; end if;
  v_pos := ((v_diff % v_cycle) + v_cycle) % v_cycle;
  if v_pos < p_work_days then
    v_start := coalesce(array_position(v_shifts, p_start_shift), 1) - 1;   -- 0-based
    v_idx := (v_start + (v_pos / 2)) % 3;                                  -- تقدّم وردية كل يومَي عمل
    return v_shifts[v_idx + 1];
  else
    return '';   -- راحة
  end if;
end $$;

-- تعريف الوردية الساري في تاريخ
create or replace function public._ws_shift_def_at(p_shift_code text, p_date date)
returns public.shift_definitions language sql stable security definer set search_path = '' as $$
  select d.* from public.shift_definitions d
  where d.shift_code = p_shift_code and d.is_active
    and d.effective_from <= p_date and (d.effective_to is null or d.effective_to >= p_date)
  order by d.effective_from desc limit 1
$$;

-- السياسة السارية (الأولوية: shift > team > department > global)
create or replace function public._ws_policy_at(p_team text, p_dept text, p_shift_code text, p_date date)
returns public.attendance_policies language sql stable security definer set search_path = '' as $$
  select p.* from public.attendance_policies p
  where p.is_active and p.effective_from <= p_date and (p.effective_to is null or p.effective_to >= p_date)
    and ( (p.scope_type='shift'      and p.scope_ref = p_shift_code)
       or (p.scope_type='team'       and p.scope_ref = p_team)
       or (p.scope_type='department' and p.scope_ref = p_dept)
       or (p.scope_type='global') )
  order by case p.scope_type when 'shift' then 1 when 'team' then 2 when 'department' then 3 else 4 end,
           p.effective_from desc
  limit 1
$$;

-- حساب دقائق التأخير (immutable) — floor بالدقائق، grace شامل
create or replace function public.calculate_late_minutes(p_expected_start timestamptz, p_first_check_in timestamptz, p_grace int)
returns int language sql immutable security definer set search_path = '' as $$
  select case when p_expected_start is null or p_first_check_in is null or p_grace is null then null
    else greatest(0, floor(extract(epoch from (p_first_check_in - p_expected_start))/60)::int - p_grace) end
$$;

-- حساب دقائق الانصراف المبكر (immutable)
create or replace function public.calculate_early_leave_minutes(p_expected_end timestamptz, p_final_check_out timestamptz, p_early_grace int)
returns int language sql immutable security definer set search_path = '' as $$
  select case when p_expected_end is null or p_final_check_out is null or p_early_grace is null then null
    else greatest(0, floor(extract(epoch from (p_expected_end - p_final_check_out))/60)::int - p_early_grace) end
$$;

-- Resolver موثوق — من Snapshot فقط (لا إعادة بناء من settings)
create or replace function public.resolve_expected_schedule(p_employee_id uuid, p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s record; v_pid uuid; v_grace int; v_cut int; v_egrace int; v_min int;
begin
  select * into s from public.employee_work_schedule where employee_id = p_employee_id and work_date = p_date;
  if s.id is null then
    return jsonb_build_object('status','schedule_missing');
  end if;
  if s.policy_id is not null then
    select id, grace_minutes, absence_cutoff_minutes, early_leave_grace_minutes, minimum_staff_required
      into v_pid, v_grace, v_cut, v_egrace, v_min from public.attendance_policies where id = s.policy_id;
  end if;
  return jsonb_build_object(
    'status','ok', 'schedule_id', s.id, 'is_working_day', s.is_working_day,
    'expected_start_at', s.expected_start_at, 'expected_end_at', s.expected_end_at,
    'shift_code', s.shift_code, 'shift_definition_id', s.shift_definition_id,
    'is_overnight', s.is_overnight, 'policy_id', s.policy_id, 'source', s.source,
    'grace_minutes', v_grace, 'absence_cutoff_minutes', v_cut,
    'early_leave_grace_minutes', v_egrace, 'minimum_staff_required', v_min,
    'policy_complete', (v_pid is not null));
end $$;

-- =====================================================================
--  Seed كتالوج الورديات (مُراجَع، من settings.shiftTimes النظيفة الموحّدة)
--  صباح 06:00-13:00 · عصر 13:00-21:00 · ليل 21:00-06:00 (ليلية)
--  effective_from = مرساة الجدولة 2026-06-14 (لا جدول قبلها أصلًا)
-- =====================================================================
insert into public.shift_definitions (shift_code, name_ar, name_en, start_local_time, end_local_time, effective_from)
select v.code, v.ar, v.en, v.s::time, v.e::time, date '2026-06-14'
from (values
  ('صباح','صباح','Morning','06:00','13:00'),
  ('عصر','عصر','Evening','13:00','21:00'),
  ('ليل','ليل','Night','21:00','06:00')
) as v(code, ar, en, s, e)
where not exists (select 1 from public.shift_definitions d where d.shift_code = v.code);

-- =====================================================================
--  دوال خارجية (authenticated؛ نطاق خادمي)
-- =====================================================================

-- توليد الجدول (Snapshot) — superadmin كل، owner قسمه؛ idempotent؛ 1..90 يومًا
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
    perform public._ws_audit(t.team, 'generate', null, 'توليد جدول '||p_from_date||'…'||p_to_date);
  end loop;

  return jsonb_build_object('ok', true, 'from', p_from_date, 'to', p_to_date,
    'created', v_created, 'updated', v_updated, 'skipped_locked', v_skip_lock,
    'skipped_manual', v_skip_manual, 'skipped_no_definition', v_skip_nodef);
end $$;

-- تعديل يوم واحد يدويًا (نطاق كتابة؛ سبب إلزامي؛ source=manual)
create or replace function public.update_employee_work_schedule(
  p_employee_id uuid, p_work_date date, p_shift_definition_id uuid, p_is_working_day boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_reason text := btrim(coalesce(p_reason,'')); v_team text; v_dept text; ex record;
  v_def_code text; v_def_start time; v_def_end time; v_def_ov boolean; v_pol_id uuid;
  v_es timestamptz; v_ee timestamptz; v_now timestamptz := now(); v_old jsonb; v_new jsonb; v_id uuid; v_evt text;
begin
  if v_reason = '' then raise exception using errcode='22004', message='سبب التعديل إلزامي'; end if;
  if length(v_reason) > 1000 then raise exception using errcode='22001', message='السبب طويل'; end if;
  select team into v_team from public.employees where id = p_employee_id;
  if v_team is null then raise exception using errcode='P0002', message='الموظف غير موجود'; end if;
  if not public.can_write_team(v_team) then raise exception using errcode='42501', message='خارج النطاق'; end if;
  select dept into v_dept from public.settings where team = v_team;

  if p_is_working_day then
    if p_shift_definition_id is null then raise exception using errcode='22004', message='تعريف الوردية مطلوب ليوم عمل'; end if;
    select shift_code, start_local_time, end_local_time, is_overnight
      into v_def_code, v_def_start, v_def_end, v_def_ov from public.shift_definitions where id = p_shift_definition_id;
    if v_def_code is null then raise exception using errcode='P0002', message='تعريف الوردية غير موجود'; end if;
    v_es := ((p_work_date::text||' '||v_def_start::text)::timestamp at time zone 'Asia/Qatar');
    if v_def_ov then v_ee := (((p_work_date+1)::text||' '||v_def_end::text)::timestamp at time zone 'Asia/Qatar');
    else v_ee := ((p_work_date::text||' '||v_def_end::text)::timestamp at time zone 'Asia/Qatar'); end if;
    select id into v_pol_id from public._ws_policy_at(v_team, v_dept, v_def_code, p_work_date);
    v_evt := 'marked_working';
  else
    v_evt := 'marked_off';
  end if;

  -- إنشاء ذرّي آمن ضد سباق أول توليد لنفس (employee_id, work_date):
  -- نحاول الإدراج؛ إن سبقنا آخر (generate/update) لم يُدرَج صف ونسقط لفرع التحديث
  -- بعد قفل الصف الموجود وتطبيق قواعد القفل — بلا خطأ خام 23505 وبلا فقدان تحديث.
  insert into public.employee_work_schedule(employee_id, work_date, team, department, shift_definition_id, policy_id,
      shift_code, is_working_day, expected_start_at, expected_end_at, is_overnight, source, source_reference, generated_at, generated_by)
    values (p_employee_id, p_work_date, v_team, v_dept, p_shift_definition_id, v_pol_id, v_def_code, p_is_working_day, v_es, v_ee,
      coalesce(v_def_ov,false), 'manual', v_reason, v_now, (select auth.uid()))
    on conflict (employee_id, work_date) do nothing
    returning id into v_id;
  if v_id is not null then
    -- سجل يدوي جديد أُنشئ ذرّيًا
    v_new := to_jsonb((select r from public.employee_work_schedule r where r.id=v_id));
    insert into public.work_schedule_history(schedule_id, event_type, actor_id, actor_role, reason, new_data)
      values (v_id, v_evt, (select auth.uid()), public.audit_current_user_role(), v_reason, public._ws_hist_json(v_new));
  else
    -- الصف موجود سلفًا (أُنشئ قبلنا أو تزامنًا): اقفله ثم طبّق قواعد القفل والتعديل
    select * into ex from public.employee_work_schedule where employee_id = p_employee_id and work_date = p_work_date for update;
    if ex.id is null then raise exception using errcode='40001', message='conflict_retry'; end if;
    if ex.locked_at is not null then raise exception using errcode='42501', message='السجل مقفل'; end if;
    v_old := to_jsonb(ex);
    update public.employee_work_schedule
      set shift_definition_id=p_shift_definition_id, policy_id=v_pol_id, shift_code=v_def_code, is_working_day=p_is_working_day,
          expected_start_at=v_es, expected_end_at=v_ee, is_overnight=coalesce(v_def_ov,false),
          source='manual', source_reference=v_reason, updated_at=v_now, generated_by=(select auth.uid())
      where id = ex.id;
    v_id := ex.id;
    v_new := to_jsonb((select r from public.employee_work_schedule r where r.id=ex.id));
    insert into public.work_schedule_history(schedule_id, event_type, actor_id, actor_role, reason, old_data, new_data)
      values (ex.id, 'updated', (select auth.uid()), public.audit_current_user_role(), v_reason, public._ws_hist_json(v_old), public._ws_hist_json(v_new));
  end if;
  perform public._ws_audit(v_team, 'update', v_id, 'تعديل جدول يوم '||p_work_date);
  return jsonb_build_object('ok', true, 'schedule_id', v_id, 'is_working_day', p_is_working_day);
end $$;

-- قفل / فتح فترة (بعد القفل يُرفض التعديل)
create or replace function public.lock_work_schedule(p_from_date date, p_to_date date, p_lock boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text := public.audit_current_user_role(); v_teams text[]; v_n int := 0; r record; v_now timestamptz := now();
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
    elsif not p_lock and r.locked_at is not null then
      update public.employee_work_schedule set locked_at = null, updated_at = v_now where id = r.id;
      insert into public.work_schedule_history(schedule_id, event_type, actor_id, actor_role) values (r.id, 'unlocked', (select auth.uid()), v_role);
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'locked', p_lock, 'affected', v_n);
end $$;

-- قراءة الجدول (نطاق، مرقّم)
create or replace function public.get_work_schedule(p_from_date date, p_to_date date, p_team text default null, p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_teams text[] := public._report_scope_teams(); v_now timestamptz := now();
  v_size int := least(greatest(coalesce(p_page_size,50),1),200); v_page int := greatest(coalesce(p_page,1),1);
  v_from date := coalesce(p_from_date, (v_now at time zone 'Asia/Qatar')::date);
  v_to date := coalesce(p_to_date, v_from); v_total int;
begin
  if p_team is not null and not (p_team = any(v_teams)) then raise exception using errcode='42501', message='خارج النطاق'; end if;
  select count(*) into v_total from public.employee_work_schedule s
    where s.team = any(v_teams) and (p_team is null or s.team = p_team) and s.work_date between v_from and v_to;
  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.work_date, x.employee_name), '[]'::jsonb) from (
      select s.id as schedule_id, e.name as employee_name, s.employee_id, s.work_date, s.team, s.department,
             s.shift_code, s.is_working_day, s.expected_start_at, s.expected_end_at, s.is_overnight,
             s.source, s.locked_at is not null as is_locked
      from public.employee_work_schedule s left join public.employees e on e.id = s.employee_id
      where s.team = any(v_teams) and (p_team is null or s.team = p_team) and s.work_date between v_from and v_to
      order by s.work_date, e.name
      limit v_size offset (v_page-1)*v_size) x),
    'total', v_total, 'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total=0 then 0 else ((v_total+v_size-1)/v_size) end,
    'timezone', 'Asia/Qatar', 'generated_at', v_now);
end $$;

-- سجل تغييرات يوم (نطاق)
create or replace function public.get_schedule_timeline(p_schedule_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_teams text[] := public._report_scope_teams(); v_team text;
begin
  select team into v_team from public.employee_work_schedule where id = p_schedule_id;
  if v_team is null or not (v_team = any(v_teams)) then raise exception using errcode='42501', message='forbidden'; end if;
  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(jsonb_build_object('event_type', h.event_type, 'actor_role', h.actor_role,
      'reason', h.reason, 'old_data', h.old_data, 'new_data', h.new_data, 'at', h.created_at) order by h.created_at), '[]'::jsonb)
    from public.work_schedule_history h where h.schedule_id = p_schedule_id));
end $$;

-- كتالوج الورديات: قراءة / إضافة-نسخة
create or replace function public.list_shift_definitions(p_include_inactive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role text := public.audit_current_user_role();
begin
  if v_role is null or v_role not in ('superadmin','owner','admin') then raise exception using errcode='42501', message='forbidden'; end if;
  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(to_jsonb(d) order by d.shift_code, d.effective_from desc), '[]'::jsonb)
    from (select id, shift_code, name_ar, name_en, start_local_time::text as start_local_time,
                 end_local_time::text as end_local_time, is_overnight, is_active, effective_from, effective_to
          from public.shift_definitions where p_include_inactive or is_active) d));
end $$;

create or replace function public.upsert_shift_definition(
  p_shift_code text, p_name_ar text, p_name_en text, p_start time, p_end time, p_effective_from date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text := public.audit_current_user_role(); v_id uuid; v_now timestamptz := now();
begin
  if v_role is null or v_role <> 'superadmin' then raise exception using errcode='42501', message='superadmin فقط'; end if;
  if p_shift_code is null or btrim(p_shift_code)='' then raise exception using errcode='22004', message='رمز الوردية مطلوب'; end if;
  if p_start is null or p_end is null then raise exception using errcode='22004', message='الوقتان مطلوبان'; end if;
  if p_effective_from is null then raise exception using errcode='22004', message='تاريخ السريان مطلوب'; end if;
  -- إغلاق النسخة المفتوحة السابقة (لا تعديل تاريخي) ثم إنشاء نسخة جديدة
  update public.shift_definitions set effective_to = p_effective_from - 1, updated_at = v_now
    where shift_code = p_shift_code and effective_to is null and effective_from < p_effective_from;
  update public.shift_definitions
    set name_ar=coalesce(nullif(btrim(p_name_ar),''), p_shift_code), name_en=p_name_en,
        start_local_time=p_start, end_local_time=p_end, is_active=true, updated_at=v_now
    where shift_code=p_shift_code and effective_to is null and effective_from = p_effective_from
    returning id into v_id;
  if v_id is null then
    insert into public.shift_definitions(shift_code, name_ar, name_en, start_local_time, end_local_time, effective_from, created_by)
      values (p_shift_code, coalesce(nullif(btrim(p_name_ar),''), p_shift_code), p_name_en, p_start, p_end, p_effective_from, (select auth.uid()))
      returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- سياسة الحضور: قراءة / إضافة-نسخة
create or replace function public.list_attendance_policies(p_include_inactive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role text := public.audit_current_user_role();
begin
  if v_role is null or v_role not in ('superadmin','owner') then raise exception using errcode='42501', message='forbidden'; end if;
  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(to_jsonb(p) order by p.scope_type, p.effective_from desc), '[]'::jsonb)
    from (select id, name, scope_type, scope_ref, grace_minutes, absence_cutoff_minutes, early_leave_grace_minutes,
                 max_session_hours, minimum_staff_required, effective_from, effective_to, is_active
          from public.attendance_policies where p_include_inactive or is_active) p));
end $$;

create or replace function public.upsert_attendance_policy(
  p_name text, p_scope_type text, p_scope_ref text, p_grace int, p_absence_cutoff int,
  p_early_grace int, p_max_session_hours numeric, p_min_staff int, p_effective_from date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text := public.audit_current_user_role(); v_id uuid; v_now timestamptz := now(); v_ref text := nullif(btrim(coalesce(p_scope_ref,'')),'');
begin
  if v_role is null or v_role <> 'superadmin' then raise exception using errcode='42501', message='superadmin فقط'; end if;
  if p_scope_type is null or p_scope_type not in ('global','department','team','shift') then raise exception using errcode='22004', message='نطاق غير صالح'; end if;
  if p_effective_from is null then raise exception using errcode='22004', message='تاريخ السريان مطلوب'; end if;
  if p_grace is null or p_grace < 0 then raise exception using errcode='22004', message='grace غير صالح'; end if;
  if p_absence_cutoff is null or p_absence_cutoff < p_grace then raise exception using errcode='22004', message='cutoff يجب ≥ grace'; end if;
  if p_early_grace is null or p_early_grace < 0 then raise exception using errcode='22004', message='early grace غير صالح'; end if;
  if p_max_session_hours is null or p_max_session_hours <= 0 or p_max_session_hours > 48 then raise exception using errcode='22004', message='max_session_hours غير منطقي'; end if;
  -- إغلاق النسخة المفتوحة الأقدم فقط
  update public.attendance_policies set effective_to = p_effective_from - 1, updated_at = v_now
    where scope_type = p_scope_type and coalesce(scope_ref,'') = coalesce(v_ref,'') and effective_to is null and effective_from < p_effective_from;
  -- تحديث نسخة بنفس تاريخ السريان إن وُجدت، وإلا إدراج نسخة جديدة
  update public.attendance_policies
    set name=coalesce(nullif(btrim(p_name),''),'policy'), grace_minutes=p_grace, absence_cutoff_minutes=p_absence_cutoff,
        early_leave_grace_minutes=p_early_grace, max_session_hours=p_max_session_hours,
        minimum_staff_required=p_min_staff, is_active=true, updated_at=v_now
    where scope_type=p_scope_type and coalesce(scope_ref,'')=coalesce(v_ref,'') and effective_to is null and effective_from = p_effective_from
    returning id into v_id;
  if v_id is null then
    insert into public.attendance_policies(name, scope_type, scope_ref, grace_minutes, absence_cutoff_minutes,
        early_leave_grace_minutes, max_session_hours, minimum_staff_required, effective_from, created_by)
      values (coalesce(nullif(btrim(p_name),''),'policy'), p_scope_type, v_ref, p_grace, p_absence_cutoff, p_early_grace,
        p_max_session_hours, p_min_staff, p_effective_from, (select auth.uid()))
      returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- نظرة الحضور المتقدّمة v2 (متأخر/غائب/مبكر/تغطية مع availability flags) — لا تكسر المرحلة 7
create or replace function public.get_attendance_overview_v2(p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_teams text[] := public._report_scope_teams(); v_now timestamptz := now();
  v_today date := coalesce(p_date, (v_now at time zone 'Asia/Qatar')::date);
  v_sched int; v_present int; v_late int; v_absent int; v_early int; v_missing int; v_onleave int; v_off int;
  v_open int; v_long int; v_actual bigint; v_policy_ready boolean; v_cov_ready boolean;
  v_req int; v_cov_present int; v_cov_absent int; v_gap int;
begin
  -- جداول اليوم ضمن النطاق
  select count(*) filter (where is_working_day),
         count(*) filter (where not is_working_day)
    into v_sched, v_off
  from public.employee_work_schedule where team = any(v_teams) and work_date = v_today;

  -- توفّر السياسة: كل جداول عمل اليوم لها policy_id (وإلا الحساب غير مفعّل)
  select bool_and(policy_id is not null) into v_policy_ready
  from public.employee_work_schedule where team = any(v_teams) and work_date = v_today and is_working_day;
  v_policy_ready := coalesce(v_policy_ready, false) and v_sched > 0;

  -- حاضرون اليوم (جلسات غير مُبطَلة)
  select count(distinct employee_id) into v_present
  from public.attendance_sessions where team = any(v_teams) and attendance_date = v_today and status <> 'voided';
  select count(*) filter (where status='open'),
         count(*) filter (where status='open' and check_in_at < v_now - interval '16 hours'),
         coalesce(sum(case when status='voided' then 0 when check_out_at is not null then coalesce(work_seconds,0)
             else floor(extract(epoch from (v_now - check_in_at)))::int end),0)
    into v_open, v_long, v_actual
  from public.attendance_sessions where team = any(v_teams) and attendance_date = v_today;

  -- إجازة معتمدة اليوم ضمن المجدولين
  select count(distinct s.employee_id) into v_onleave
  from public.employee_work_schedule s
  where s.team = any(v_teams) and s.work_date = v_today and s.is_working_day
    and exists (select 1 from public.leaves l where l.emp_id = s.employee_id and l.status='معتمد' and v_today between l.from_date and l.to_date);

  if v_policy_ready then
    -- متأخر مؤكّد: أول دخول للجلسة يتجاوز expected_start + grace (من snapshot المرتبط)
    select count(distinct s.employee_id) into v_late
    from public.employee_work_schedule s
    join public.attendance_policies p on p.id = s.policy_id
    join lateral (select min(a.check_in_at) ci from public.attendance_sessions a
                  where a.employee_id = s.employee_id and a.attendance_date = v_today and a.status <> 'voided') a on true
    where s.team = any(v_teams) and s.work_date = v_today and s.is_working_day and a.ci is not null
      and public.calculate_late_minutes(s.expected_start_at, a.ci, p.grace_minutes) > 0;

    -- انصراف مبكر مؤكّد
    select count(distinct s.employee_id) into v_early
    from public.employee_work_schedule s
    join public.attendance_policies p on p.id = s.policy_id
    join lateral (select max(a.check_out_at) co from public.attendance_sessions a
                  where a.employee_id = s.employee_id and a.attendance_date = v_today and a.status <> 'voided' and a.check_out_at is not null) a on true
    where s.team = any(v_teams) and s.work_date = v_today and s.is_working_day and a.co is not null
      and public.calculate_early_leave_minutes(s.expected_end_at, a.co, p.early_leave_grace_minutes) > 0;

    -- غياب مؤكّد: يوم عمل + لا إجازة معتمدة + لا حضور صالح + تجاوز cutoff + ليس مستقبليًا + ليس عطلة رسمية
    select count(*) into v_absent
    from public.employee_work_schedule s
    join public.attendance_policies p on p.id = s.policy_id
    where s.team = any(v_teams) and s.work_date = v_today and s.is_working_day
      and v_today <= (v_now at time zone 'Asia/Qatar')::date
      and v_now > s.expected_start_at + make_interval(mins => p.absence_cutoff_minutes)
      and not exists (select 1 from public.attendance_sessions a where a.employee_id=s.employee_id and a.attendance_date=v_today and a.status<>'voided')
      and not exists (select 1 from public.leaves l where l.emp_id=s.employee_id and l.status='معتمد' and v_today between l.from_date and l.to_date)
      and not exists (select 1 from public.settings st, jsonb_array_elements(coalesce(st.data->'holidays','[]'::jsonb)) h
                      where st.team = s.team and (h->>'date')::date = v_today);
  else
    v_late := null; v_early := null; v_absent := null;
  end if;

  -- جدول مفقود: موظفو الفريق بلا snapshot لليوم
  select count(*) into v_missing
  from public.employees e
  where e.team = any(v_teams)
    and not exists (select 1 from public.employee_work_schedule s where s.employee_id = e.id and s.work_date = v_today);

  -- التغطية: فقط عند minimum_staff_required موثوق (سياسة اليوم لها min_staff)
  select bool_and(p.minimum_staff_required is not null) into v_cov_ready
  from public.employee_work_schedule s join public.attendance_policies p on p.id = s.policy_id
  where s.team = any(v_teams) and s.work_date = v_today and s.is_working_day;
  v_cov_ready := coalesce(v_cov_ready, false) and v_policy_ready and v_sched > 0;

  if v_cov_ready then
    select coalesce(sum(distinct_req),0) into v_req from (
      select p.minimum_staff_required as distinct_req
      from public.employee_work_schedule s join public.attendance_policies p on p.id = s.policy_id
      where s.team = any(v_teams) and s.work_date = v_today and s.is_working_day
      group by s.team, s.shift_code, p.minimum_staff_required) q;
    v_cov_present := v_present; v_cov_absent := coalesce(v_absent,0);
    v_gap := greatest(0, v_req - v_cov_present);
  else
    v_req := null; v_gap := null;
  end if;

  return jsonb_build_object('today', v_today, 'timezone', 'Asia/Qatar', 'generated_at', v_now,
    'scope', jsonb_build_object('role', public.audit_current_user_role(), 'teams_count', coalesce(array_length(v_teams,1),0)),
    'availability', jsonb_build_object('policy_ready', v_policy_ready, 'coverage_ready', v_cov_ready),
    'summary', jsonb_build_object(
      'scheduled_employees', v_sched, 'off_today', v_off, 'present_today', v_present,
      'on_approved_leave', v_onleave, 'schedule_missing', v_missing,
      'open_sessions', v_open, 'long_open_sessions', v_long, 'total_actual_seconds', v_actual,
      'late_confirmed', v_late, 'absent_confirmed', v_absent, 'early_leave_confirmed', v_early,
      'coverage_required', v_req, 'coverage_gap', v_gap));
end $$;

-- =====================================================================
--  دمج المرحلة 7: ملء expected/late/early من Snapshot عند توفّره فقط
--  (سلوك المرحلة 7 دون تغيير حين لا يوجد جدول/سياسة → تبقى NULL)
-- =====================================================================
create or replace function public.attendance_check_in()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := public.audit_current_emp_id(); v_team text := public.audit_current_emp_team();
  v_dept text; v_now timestamptz := now(); v_today date; v_id uuid; v_existing uuid; v_new jsonb;
  v_res jsonb; v_es timestamptz; v_ee timestamptz; v_sched uuid; v_pol uuid; v_sdef uuid; v_late int;
begin
  if v_emp is null or v_team is null then
    raise exception using errcode='42501', message='الحساب غير مرتبط بموظف فعّال';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('att_ci_'||v_emp::text, 0));
  select id into v_existing from public.attendance_sessions where employee_id=v_emp and status='open' limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'already_open', true, 'session_id', v_existing, 'message', 'لديك جلسة مفتوحة بالفعل');
  end if;
  select dept into v_dept from public.settings where team=v_team;
  v_today := (v_now at time zone 'Asia/Qatar')::date;
  -- جدول اليوم (إن وُجد Snapshot مع سياسة مكتملة)
  v_res := public.resolve_expected_schedule(v_emp, v_today);
  if (v_res->>'status') = 'ok' and (v_res->>'is_working_day')::boolean then
    v_es := nullif(v_res->>'expected_start_at','')::timestamptz;
    v_ee := nullif(v_res->>'expected_end_at','')::timestamptz;
    v_sched := nullif(v_res->>'schedule_id','')::uuid;
    v_pol := nullif(v_res->>'policy_id','')::uuid;
    v_sdef := nullif(v_res->>'shift_definition_id','')::uuid;
    if (v_res->>'policy_complete')::boolean then
      v_late := public.calculate_late_minutes(v_es, v_now, nullif(v_res->>'grace_minutes','')::int);
    end if;
  end if;
  insert into public.attendance_sessions(employee_id, attendance_date, team, department,
      check_in_at, status, check_in_source, created_by,
      expected_start_at, expected_end_at, late_minutes, schedule_id, policy_id, shift_definition_id)
    values (v_emp, v_today, v_team, v_dept, v_now, 'open', 'self', (select auth.uid()),
      v_es, v_ee, v_late, v_sched, v_pol, v_sdef)
    returning id into v_id;
  v_new := to_jsonb((select r from public.attendance_sessions r where r.id=v_id));
  insert into public.attendance_history(session_id, event_type, actor_id, actor_role, new_data)
    values (v_id, 'checked_in', (select auth.uid()), public.audit_current_user_role(), public._att_hist_json(v_new));
  perform public._att_audit(v_team, 'insert', v_id, 'تسجيل دخول');
  return jsonb_build_object('ok', true, 'already_open', false, 'session_id', v_id,
    'check_in_at', v_now, 'attendance_date', v_today, 'timezone', 'Asia/Qatar');
exception when unique_violation then
  select id into v_existing from public.attendance_sessions where employee_id=v_emp and status='open' limit 1;
  return jsonb_build_object('ok', true, 'already_open', true, 'session_id', v_existing, 'message', 'لديك جلسة مفتوحة بالفعل');
end $$;

create or replace function public.attendance_check_out()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := public.audit_current_emp_id(); v_now timestamptz := now(); v_id uuid; v_ci timestamptz; v_team text;
  v_secs int; v_old jsonb; v_new jsonb; v_ee timestamptz; v_pol uuid; v_early int; v_grace int;
begin
  if v_emp is null then raise exception using errcode='42501', message='الحساب غير مرتبط بموظف فعّال'; end if;
  select id, check_in_at, team, expected_end_at, policy_id into v_id, v_ci, v_team, v_ee, v_pol
    from public.attendance_sessions where employee_id=v_emp and status='open'
    order by check_in_at desc limit 1 for update;
  if v_id is null then raise exception using errcode='P0002', message='لا توجد جلسة مفتوحة للإغلاق'; end if;
  if v_now <= v_ci then raise exception using errcode='22007', message='تعذّر حساب المدة'; end if;
  v_old := to_jsonb((select r from public.attendance_sessions r where r.id=v_id));
  v_secs := floor(extract(epoch from (v_now - v_ci)))::int;
  if v_pol is not null and v_ee is not null then
    select early_leave_grace_minutes into v_grace from public.attendance_policies where id = v_pol;
    v_early := public.calculate_early_leave_minutes(v_ee, v_now, v_grace);
  end if;
  update public.attendance_sessions
    set check_out_at=v_now, status='closed', check_out_source='self', work_seconds=v_secs,
        early_leave_minutes=v_early, closed_by=(select auth.uid()), updated_at=v_now
    where id=v_id;
  v_new := to_jsonb((select r from public.attendance_sessions r where r.id=v_id));
  insert into public.attendance_history(session_id, event_type, actor_id, actor_role, old_data, new_data)
    values (v_id, 'checked_out', (select auth.uid()), public.audit_current_user_role(), public._att_hist_json(v_old), public._att_hist_json(v_new));
  perform public._att_audit(v_team, 'update', v_id, 'تسجيل خروج');
  return jsonb_build_object('ok', true, 'session_id', v_id, 'check_out_at', v_now, 'work_seconds', v_secs,
    'early_leave_minutes', v_early);
end $$;

-- حالة الموظف: إضافة جدول اليوم المتوقّع (قراءة؛ schedule_missing عند غيابه) — لا يكسر المرحلة 7
create or replace function public.get_my_attendance_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := public.audit_current_emp_id();
  v_now timestamptz := now(); v_today date := (v_now at time zone 'Asia/Qatar')::date;
  v_open record; v_last record; v_total int;
begin
  if v_emp is null then
    raise exception using errcode='42501', message='الحساب غير مرتبط بموظف فعّال';
  end if;
  select id, check_in_at into v_open from public.attendance_sessions
    where employee_id=v_emp and status='open' order by check_in_at desc limit 1;
  select id, check_in_at, check_out_at, status, work_seconds into v_last from public.attendance_sessions
    where employee_id=v_emp and attendance_date=v_today and status<>'voided'
    order by check_in_at desc limit 1;
  select coalesce(sum(case when status='voided' then 0
             when check_out_at is not null then coalesce(work_seconds,0)
             else floor(extract(epoch from (v_now - check_in_at)))::int end),0)
    into v_total from public.attendance_sessions where employee_id=v_emp and attendance_date=v_today;
  return jsonb_build_object(
    'recent', (select coalesce(jsonb_agg(jsonb_build_object(
        'attendance_date', attendance_date, 'check_in_at', check_in_at, 'check_out_at', check_out_at,
        'status', status,
        'work_seconds', case when status='voided' then null when check_out_at is not null then work_seconds
                             else floor(extract(epoch from (v_now - check_in_at)))::int end)
        order by check_in_at desc), '[]'::jsonb)
      from (select * from public.attendance_sessions where employee_id=v_emp and status<>'voided'
            order by check_in_at desc limit 14) r),
    'on_duty', v_open.id is not null,
    'current_check_in_at', v_open.check_in_at,
    'current_seconds', case when v_open.id is not null then floor(extract(epoch from (v_now - v_open.check_in_at)))::int else null end,
    'last_check_in_at', v_last.check_in_at, 'last_check_out_at', v_last.check_out_at, 'last_status', v_last.status,
    'today_total_seconds', v_total,
    'expected_start_at', null, 'expected_end_at', null, 'late_minutes', null, 'early_leave_minutes', null,
    'schedule', public.resolve_expected_schedule(v_emp, v_today),
    'timezone', 'Asia/Qatar', 'today', v_today, 'generated_at', v_now);
end $$;

-- تصحيح الجلسة: يعيد حساب late/early من Snapshot المرتبط بتاريخ الجلسة (ذرّي)
create or replace function public.correct_attendance_session(p_session_id uuid, p_check_in_at timestamptz, p_check_out_at timestamptz, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := now(); a record; v_reason text := btrim(coalesce(p_reason,''));
  v_secs int; v_status text; v_old jsonb; v_new jsonb; v_date date; v_res jsonb;
  v_es timestamptz; v_ee timestamptz; v_sched uuid; v_pol uuid; v_sdef uuid; v_late int; v_early int; v_grace int; v_egrace int;
begin
  if v_reason = '' then raise exception using errcode='22004', message='سبب التصحيح إلزامي'; end if;
  if length(v_reason) > 1000 then raise exception using errcode='22001', message='reason_too_long'; end if;
  if p_check_in_at is null then raise exception using errcode='22004', message='check_in_required'; end if;
  if p_check_out_at is not null and p_check_out_at <= p_check_in_at then
    raise exception using errcode='22007', message='الخروج يجب أن يكون بعد الدخول'; end if;
  select * into a from public.attendance_sessions where id=p_session_id for update;
  if a.id is null then raise exception using errcode='P0002', message='not_found'; end if;
  if a.status='voided' then raise exception using errcode='22023', message='الجلسة مُبطَلة'; end if;
  if not public.can_write_team(a.team) then raise exception using errcode='42501', message='forbidden'; end if;
  if exists(select 1 from public.attendance_sessions b where b.employee_id=a.employee_id and b.id<>a.id
       and b.status<>'voided' and b.check_in_at < coalesce(p_check_out_at, 'infinity'::timestamptz)
       and coalesce(b.check_out_at, 'infinity'::timestamptz) > p_check_in_at) then
    raise exception using errcode='23P01', message='يتداخل مع جلسة أخرى للموظف';
  end if;
  v_status := case when p_check_out_at is null then 'open' else 'corrected' end;
  v_secs := case when p_check_out_at is null then null else floor(extract(epoch from (p_check_out_at - p_check_in_at)))::int end;
  v_date := (p_check_in_at at time zone 'Asia/Qatar')::date;
  -- إعادة الربط بجدول تاريخ الدخول الجديد وإعادة حساب late/early
  v_res := public.resolve_expected_schedule(a.employee_id, v_date);
  if (v_res->>'status')='ok' and (v_res->>'is_working_day')::boolean then
    v_es := nullif(v_res->>'expected_start_at','')::timestamptz; v_ee := nullif(v_res->>'expected_end_at','')::timestamptz;
    v_sched := nullif(v_res->>'schedule_id','')::uuid; v_pol := nullif(v_res->>'policy_id','')::uuid; v_sdef := nullif(v_res->>'shift_definition_id','')::uuid;
    if (v_res->>'policy_complete')::boolean then
      v_grace := nullif(v_res->>'grace_minutes','')::int; v_egrace := nullif(v_res->>'early_leave_grace_minutes','')::int;
      v_late := public.calculate_late_minutes(v_es, p_check_in_at, v_grace);
      if p_check_out_at is not null then v_early := public.calculate_early_leave_minutes(v_ee, p_check_out_at, v_egrace); end if;
    end if;
  end if;
  v_old := to_jsonb(a);
  update public.attendance_sessions
    set check_in_at=p_check_in_at, check_out_at=p_check_out_at, status=v_status, work_seconds=v_secs,
        check_out_source=case when p_check_out_at is null then null else 'admin' end,
        correction_count=a.correction_count+1, closed_by=case when p_check_out_at is null then null else (select auth.uid()) end,
        attendance_date=v_date, expected_start_at=v_es, expected_end_at=v_ee, late_minutes=v_late,
        early_leave_minutes=v_early, schedule_id=v_sched, policy_id=v_pol, shift_definition_id=v_sdef, updated_at=v_now
    where id=a.id;
  v_new := to_jsonb((select r from public.attendance_sessions r where r.id=a.id));
  insert into public.attendance_history(session_id, event_type, actor_id, actor_role, reason, old_data, new_data)
    values (a.id, 'corrected', (select auth.uid()), public.audit_current_user_role(), v_reason, public._att_hist_json(v_old), public._att_hist_json(v_new));
  perform public._att_audit(a.team, 'update', a.id, 'تصحيح جلسة حضور');
  return jsonb_build_object('ok', true, 'session_id', a.id, 'status', v_status, 'work_seconds', v_secs,
    'late_minutes', v_late, 'early_leave_minutes', v_early);
end $$;

-- =====================================================================
--  المنح: خارجية=authenticated فقط؛ داخلية=بلا منح
-- =====================================================================
revoke all on function
  public._ws_hist_json(jsonb), public._ws_audit(text,text,uuid,text),
  public._ws_rotation_code(date,int,int,text,date), public._ws_shift_def_at(text,date),
  public._ws_policy_at(text,text,text,date), public.resolve_expected_schedule(uuid,date),
  public.calculate_late_minutes(timestamptz,timestamptz,int),
  public.calculate_early_leave_minutes(timestamptz,timestamptz,int)
  from anon, authenticated, public;

revoke all on function
  public.generate_work_schedule(date,date), public.update_employee_work_schedule(uuid,date,uuid,boolean,text),
  public.lock_work_schedule(date,date,boolean), public.get_work_schedule(date,date,text,int,int),
  public.get_schedule_timeline(uuid), public.list_shift_definitions(boolean),
  public.upsert_shift_definition(text,text,text,time,time,date), public.list_attendance_policies(boolean),
  public.upsert_attendance_policy(text,text,text,int,int,int,numeric,int,date),
  public.get_attendance_overview_v2(date)
  from anon, public;
grant execute on function
  public.generate_work_schedule(date,date), public.update_employee_work_schedule(uuid,date,uuid,boolean,text),
  public.lock_work_schedule(date,date,boolean), public.get_work_schedule(date,date,text,int,int),
  public.get_schedule_timeline(uuid), public.list_shift_definitions(boolean),
  public.upsert_shift_definition(text,text,text,time,time,date), public.list_attendance_policies(boolean),
  public.upsert_attendance_policy(text,text,text,int,int,int,numeric,int,date),
  public.get_attendance_overview_v2(date)
  to authenticated;
