-- ============================================================================
-- المرحلة السابعة: أساس الحضور والانصراف الفعلي (check-in / check-out)
-- ملف مستقل — جداول جديدة فقط، لا يعدّل جدولًا/عمودًا/بيانات قائمة، لا Realtime.
--
-- المبادئ:
--  • الوقت من الخادم فقط (now()) — لا timestamp من العميل.
--  • employee_id/team/department تُشتق خادميًا من employee_auth — لا من العميل.
--  • «اليوم» = (check_in_at at time zone 'Asia/Qatar')::date (تاريخ بدء الجلسة).
--  • جلسة مفتوحة واحدة فقط لكل موظف (فهرس فريد جزئي).
--  • لا حذف صلب؛ الإبطال = status='voided'. السجل إضافة-فقط.
--  • كل RPC خارجية SECURITY DEFINER + search_path='' + بوّابة نطاق خادمية.
--  • القراءة لا تُنشئ أي كتابة. check-in/out/correct/void فقط عمليات كتابة.
--
--  التأخير/الانصراف المبكر/الغياب/نقص التغطية: **مؤجّلة** لمرحلة لاحقة.
--  السبب المُثبَت: أوقات الورديات مخزّنة كنصّ حرّ عربي في settings.data->shiftTimes
--  (مثل «6:00 ص ← 1:00 م»)، ولا توجد سياسة سماح (grace) موثّقة. تصنيف موظف
--  «متأخرًا/غائبًا» يتطلّب محلّل وقت هشًّا + عتبة سماح مخترعة — وكلاهما ممنوع.
--  لذا أعمدة expected_*/late_*/early_* موجودة لكنها تبقى NULL في هذه المرحلة.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) الجداول
-- ---------------------------------------------------------------------------
create table if not exists public.attendance_sessions (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id),   -- لا CASCADE يمحو التاريخ
  attendance_date date not null,                                  -- يُحسب خادميًا (Asia/Qatar)
  team           text not null,
  department     text,
  check_in_at    timestamptz not null,
  check_out_at   timestamptz,
  status         text not null default 'open'
                   check (status in ('open','closed','corrected','voided')),
  check_in_source  text not null default 'self' check (check_in_source in ('self','admin','import')),
  check_out_source text          check (check_out_source is null or check_out_source in ('self','admin','import')),
  work_seconds   integer check (work_seconds is null or work_seconds >= 0),
  correction_count integer not null default 0,
  -- مؤجّلة (تبقى NULL هذه المرحلة):
  expected_start_at   timestamptz,
  expected_end_at     timestamptz,
  late_minutes        integer,
  early_leave_minutes integer,
  created_by     uuid,
  closed_by      uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint attendance_out_after_in check (check_out_at is null or check_out_at > check_in_at)
);
-- جلسة مفتوحة واحدة فقط لكل موظف (الضمان الصارم للتزامن)
create unique index if not exists uq_attendance_one_open
  on public.attendance_sessions (employee_id) where status = 'open';
create index if not exists idx_attendance_emp_date on public.attendance_sessions (employee_id, attendance_date);
create index if not exists idx_attendance_team_date_status on public.attendance_sessions (team, attendance_date, status);
create index if not exists idx_attendance_open on public.attendance_sessions (team, check_in_at) where status = 'open';
create index if not exists idx_attendance_date on public.attendance_sessions (attendance_date);

-- سجل إضافة-فقط
create table if not exists public.attendance_history (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.attendance_sessions(id),
  event_type  text not null check (event_type in ('checked_in','checked_out','corrected','voided')),
  actor_id    uuid,
  actor_role  text,
  reason      text,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_attendance_hist_session on public.attendance_history (session_id, created_at);

-- ---------------------------------------------------------------------------
-- 2) RLS: تفعيل + لا وصول مباشر لأي عميل (كل شيء عبر RPCs الآمنة)
-- ---------------------------------------------------------------------------
alter table public.attendance_sessions enable row level security;
alter table public.attendance_history  enable row level security;
revoke all on table public.attendance_sessions from anon, authenticated;
revoke all on table public.attendance_history  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) دالة داخلية: تنقية JSON للسجل (لا email/uuid/metadata غير ضروري، ≤4096B)
-- ---------------------------------------------------------------------------
create or replace function public._att_hist_json(p jsonb)
returns jsonb language sql immutable security definer set search_path to '' as $fn$
  select case when p is null then null
    else left(jsonb_build_object(
      'status', p->>'status', 'attendance_date', p->>'attendance_date',
      'check_in_at', p->>'check_in_at', 'check_out_at', p->>'check_out_at',
      'check_in_source', p->>'check_in_source', 'check_out_source', p->>'check_out_source',
      'work_seconds', p->>'work_seconds', 'team', p->>'team'
    )::text, 4096)::jsonb end
$fn$;
revoke all on function public._att_hist_json(jsonb) from public, anon, authenticated;

-- دالة داخلية: كتابة Audit موحّد (سطر واحد لكل عملية)
create or replace function public._att_audit(p_team text, p_action text, p_id uuid, p_summary text)
returns void language plpgsql security definer set search_path to '' as $fn$
declare v_actor uuid := (select auth.uid()); v_name text; v_role text;
begin
  if v_actor is not null then
    select coalesce(u.raw_app_meta_data->>'name', split_part(u.email,'@',1)),
           coalesce(u.raw_app_meta_data->>'role','unknown') into v_name, v_role
    from auth.users u where u.id=v_actor;
  end if;
  insert into public.audit_log(team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  values (p_team, v_actor, coalesce(v_name,'system'), coalesce(v_role,'system'), p_action,
          'attendance_sessions', p_id::text, p_summary, null);
end $fn$;
revoke all on function public._att_audit(text,text,uuid,text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) RPC: تسجيل الدخول (بلا معاملات — كل شيء خادمي، idempotent، ذرّي)
-- ---------------------------------------------------------------------------
create or replace function public.attendance_check_in()
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare
  v_emp uuid := public.audit_current_emp_id();     -- الموظّف الحالي (نشط) أو NULL
  v_team text := public.audit_current_emp_team();
  v_dept text; v_now timestamptz := now(); v_today date;
  v_id uuid; v_existing uuid; v_new jsonb;
begin
  if v_emp is null or v_team is null then
    raise exception using errcode='42501', message='الحساب غير مرتبط بموظف فعّال';
  end if;
  -- تسلسل صارم لكل موظف يمنع سباق الإدراج
  perform pg_advisory_xact_lock(hashtextextended('att_ci_'||v_emp::text, 0));
  -- إن وُجدت جلسة مفتوحة: أعِدها (idempotent) بلا سجل جديد
  select id into v_existing from public.attendance_sessions where employee_id=v_emp and status='open' limit 1;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'already_open', true, 'session_id', v_existing,
      'message', 'لديك جلسة مفتوحة بالفعل');
  end if;
  select dept into v_dept from public.settings where team=v_team;
  v_today := (v_now at time zone 'Asia/Qatar')::date;
  insert into public.attendance_sessions(employee_id, attendance_date, team, department,
      check_in_at, status, check_in_source, created_by)
    values (v_emp, v_today, v_team, v_dept, v_now, 'open', 'self', (select auth.uid()))
    returning id into v_id;
  v_new := to_jsonb((select r from public.attendance_sessions r where r.id=v_id));
  insert into public.attendance_history(session_id, event_type, actor_id, actor_role, new_data)
    values (v_id, 'checked_in', (select auth.uid()), public.audit_current_user_role(), public._att_hist_json(v_new));
  perform public._att_audit(v_team, 'insert', v_id, 'تسجيل دخول');
  return jsonb_build_object('ok', true, 'already_open', false, 'session_id', v_id,
    'check_in_at', v_now, 'attendance_date', v_today, 'timezone', 'Asia/Qatar');
exception when unique_violation then
  -- سباق نادر رغم القفل: أعِد الجلسة المفتوحة القائمة بلا خطأ خام
  select id into v_existing from public.attendance_sessions where employee_id=v_emp and status='open' limit 1;
  return jsonb_build_object('ok', true, 'already_open', true, 'session_id', v_existing,
    'message', 'لديك جلسة مفتوحة بالفعل');
end $fn$;
revoke all on function public.attendance_check_in() from public, anon;
grant execute on function public.attendance_check_in() to authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPC: تسجيل الخروج (بلا معاملات — يقفل جلسة الموظف المفتوحة FOR UPDATE)
-- ---------------------------------------------------------------------------
create or replace function public.attendance_check_out()
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare
  v_emp uuid := public.audit_current_emp_id();
  v_now timestamptz := now(); v_id uuid; v_ci timestamptz; v_team text; v_secs int; v_old jsonb; v_new jsonb;
begin
  if v_emp is null then
    raise exception using errcode='42501', message='الحساب غير مرتبط بموظف فعّال';
  end if;
  select id, check_in_at, team into v_id, v_ci, v_team
    from public.attendance_sessions where employee_id=v_emp and status='open'
    order by check_in_at desc limit 1 for update;
  if v_id is null then
    raise exception using errcode='P0002', message='لا توجد جلسة مفتوحة للإغلاق';
  end if;
  if v_now <= v_ci then
    raise exception using errcode='22007', message='تعذّر حساب المدة';
  end if;
  v_old := to_jsonb((select r from public.attendance_sessions r where r.id=v_id));
  v_secs := floor(extract(epoch from (v_now - v_ci)))::int;
  update public.attendance_sessions
    set check_out_at=v_now, status='closed', check_out_source='self', work_seconds=v_secs,
        closed_by=(select auth.uid()), updated_at=v_now
    where id=v_id;
  v_new := to_jsonb((select r from public.attendance_sessions r where r.id=v_id));
  insert into public.attendance_history(session_id, event_type, actor_id, actor_role, old_data, new_data)
    values (v_id, 'checked_out', (select auth.uid()), public.audit_current_user_role(),
            public._att_hist_json(v_old), public._att_hist_json(v_new));
  perform public._att_audit(v_team, 'update', v_id, 'تسجيل خروج');
  return jsonb_build_object('ok', true, 'session_id', v_id, 'check_out_at', v_now, 'work_seconds', v_secs);
end $fn$;
revoke all on function public.attendance_check_out() from public, anon;
grant execute on function public.attendance_check_out() to authenticated;

-- ---------------------------------------------------------------------------
-- 6) RPC: حالة الموظف الحالية (قراءة فقط — بلا معرّفات مكشوفة)
-- ---------------------------------------------------------------------------
create or replace function public.get_my_attendance_status()
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
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
    'last_check_in_at', v_last.check_in_at,
    'last_check_out_at', v_last.check_out_at,
    'last_status', v_last.status,
    'today_total_seconds', v_total,
    -- مؤجّلة (تبقى null): expected/late/early
    'expected_start_at', null, 'expected_end_at', null, 'late_minutes', null, 'early_leave_minutes', null,
    'timezone', 'Asia/Qatar', 'today', v_today, 'generated_at', v_now);
end $fn$;
revoke all on function public.get_my_attendance_status() from public, anon;
grant execute on function public.get_my_attendance_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 7) دالة داخلية: سجل الحضور ضمن نطاق موثوق (JSON منقّح، بلا email/UUID غير لازم)
-- ---------------------------------------------------------------------------
create or replace function public._att_sessions_json(p_teams text[], p_date date, p_status text, p_limit int, p_offset int, p_now timestamptz)
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select coalesce(jsonb_agg(j order by (j->>'sort') desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'session_id', a.id, 'employee_name', coalesce(e.name,'—'), 'team_name', a.team,
      'department_name', coalesce(d.name, a.department),
      'check_in_at', a.check_in_at, 'check_out_at', a.check_out_at,
      'status', a.status, 'is_open', a.status='open',
      'work_seconds', case when a.status='voided' then null
                          when a.check_out_at is not null then a.work_seconds
                          else floor(extract(epoch from (p_now - a.check_in_at)))::int end,
      'correction_count', a.correction_count,
      'check_in_source', a.check_in_source, 'check_out_source', a.check_out_source,
      -- مؤجّلة: late/early/absence تبقى null (لا أساس دقيق)
      'late_minutes', null, 'early_leave_minutes', null,
      'sort', extract(epoch from a.check_in_at)::text) as j
    from public.attendance_sessions a
    left join public.employees e on e.id=a.employee_id
    left join public.settings s on s.team=a.team
    left join public.departments d on d.id=s.dept
    where a.team = any(p_teams)
      and (p_date is null or a.attendance_date = p_date)
      and (p_status is null or a.status = p_status)
    order by a.check_in_at desc
    limit p_limit offset p_offset
  ) t;
$fn$;
revoke all on function public._att_sessions_json(text[],date,text,int,int,timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8) RPC: قائمة الحضور للمشرف (نطاق خادمي + ترقيم مقيّد)
-- ---------------------------------------------------------------------------
create or replace function public.list_attendance_sessions(
  p_date date default null, p_status text default null, p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams();  -- forbidden لغير المخوّل
  v_now timestamptz := now();
  v_size int := least(greatest(coalesce(p_page_size,50),1),100);
  v_page int := greatest(coalesce(p_page,1),1);
  v_status text := case when p_status in ('open','closed','corrected','voided') then p_status else null end;
  v_total int;
begin
  select count(*) into v_total from public.attendance_sessions a
    where a.team=any(v_teams) and (p_date is null or a.attendance_date=p_date)
      and (v_status is null or a.status=v_status);
  return jsonb_build_object(
    'items', public._att_sessions_json(v_teams, p_date, v_status, v_size, (v_page-1)*v_size, v_now),
    'total', v_total, 'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total=0 then 0 else ((v_total + v_size - 1)/v_size) end,
    'timezone', 'Asia/Qatar', 'generated_at', v_now);
end $fn$;
revoke all on function public.list_attendance_sessions(date,text,int,int) from public, anon;
grant execute on function public.list_attendance_sessions(date,text,int,int) to authenticated;

-- ---------------------------------------------------------------------------
-- 9) دالة داخلية: الجلسات غير الطبيعية (قراءة فقط — حالات مثبتة فقط)
-- ---------------------------------------------------------------------------
create or replace function public._att_anomalies(p_teams text[], p_now timestamptz)
returns table(anomaly_type text, severity text, session_id uuid, employee_name text, team_name text,
              check_in_at timestamptz, detail text)
language sql stable security definer set search_path to '' as $fn$
  -- جلسة مفتوحة > 16 ساعة
  select 'open_over_16h','critical', a.id, coalesce(e.name,'—'), a.team, a.check_in_at,
    'جلسة مفتوحة منذ أكثر من 16 ساعة'
  from public.attendance_sessions a left join public.employees e on e.id=a.employee_id
  where a.team=any(p_teams) and a.status='open' and a.check_in_at < p_now - interval '16 hours'
  union all
  -- جلسة مفتوحة من يوم سابق (بلا خروج)
  select 'open_prev_day','warning', a.id, coalesce(e.name,'—'), a.team, a.check_in_at,
    'جلسة مفتوحة من يوم سابق دون تسجيل خروج'
  from public.attendance_sessions a left join public.employees e on e.id=a.employee_id
  where a.team=any(p_teams) and a.status='open'
    and a.attendance_date < (p_now at time zone 'Asia/Qatar')::date
  union all
  -- حضور أثناء إجازة معتمدة تشمل تاريخ الجلسة
  select 'attendance_during_approved_leave','warning', a.id, coalesce(e.name,'—'), a.team, a.check_in_at,
    'تسجيل حضور في يوم إجازة معتمدة'
  from public.attendance_sessions a left join public.employees e on e.id=a.employee_id
  join public.leaves l on l.emp_id=a.employee_id and l.status='معتمد'
    and a.attendance_date between l.from_date and l.to_date
  where a.team=any(p_teams) and a.status<>'voided'
  union all
  -- تصحيح متكرر غير طبيعي (≥3)
  select 'excessive_corrections','warning', a.id, coalesce(e.name,'—'), a.team, a.check_in_at,
    'عدد تصحيحات مرتفع على الجلسة'
  from public.attendance_sessions a left join public.employees e on e.id=a.employee_id
  where a.team=any(p_teams) and a.correction_count >= 3
  union all
  -- حساب معطّل لديه جلسة مفتوحة
  select 'disabled_with_open','critical', a.id, coalesce(e.name,'—'), a.team, a.check_in_at,
    'جلسة مفتوحة لحساب معطّل'
  from public.attendance_sessions a
  join public.employee_auth ea on ea.emp_id=a.employee_id
  join auth.users u on u.id=ea.user_id
  left join public.employees e on e.id=a.employee_id
  where a.team=any(p_teams) and a.status='open' and u.banned_until is not null and u.banned_until > p_now
$fn$;
revoke all on function public._att_anomalies(text[],timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10) RPC: ملخّص الحضور (نطاق الدور — مؤشرات مثبتة فقط؛ التأخير/الغياب مؤجّلة)
-- ---------------------------------------------------------------------------
create or replace function public.get_attendance_summary(p_date date default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams();
  v_now timestamptz := now(); v_today date := coalesce(p_date, (v_now at time zone 'Asia/Qatar')::date);
  v_summary jsonb; v_anom int;
begin
  select count(*) into v_anom from public._att_anomalies(v_teams, v_now);
  select jsonb_build_object(
    'on_duty_now', (select count(*) from public.attendance_sessions where team=any(v_teams) and status='open'),
    'closed_today', (select count(*) from public.attendance_sessions where team=any(v_teams) and attendance_date=v_today and status in ('closed','corrected')),
    'open_sessions', (select count(*) from public.attendance_sessions where team=any(v_teams) and status='open'),
    'open_long', (select count(*) from public.attendance_sessions where team=any(v_teams) and status='open' and check_in_at < v_now - interval '16 hours'),
    'checked_in_today', (select count(distinct employee_id) from public.attendance_sessions where team=any(v_teams) and attendance_date=v_today and status<>'voided'),
    'total_work_seconds_today', (select coalesce(sum(case when status='voided' then 0
        when check_out_at is not null then coalesce(work_seconds,0)
        else floor(extract(epoch from (v_now - check_in_at)))::int end),0)
      from public.attendance_sessions where team=any(v_teams) and attendance_date=v_today),
    'anomalies', v_anom,
    -- مؤجّلة صراحةً (لا أساس دقيق): تبقى null لا رقمًا مضلّلًا
    'late_confirmed', null, 'absence_confirmed', null, 'coverage_shortfall', null
  ) into v_summary;
  return jsonb_build_object('today', v_today, 'timezone', 'Asia/Qatar', 'generated_at', v_now,
    'scope', jsonb_build_object('role', public.audit_current_user_role(), 'teams_count', coalesce(array_length(v_teams,1),0)),
    'summary', v_summary);
end $fn$;
revoke all on function public.get_attendance_summary(date) from public, anon;
grant execute on function public.get_attendance_summary(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 11) RPC: تنبيهات الحضور غير الطبيعية (قراءة فقط، نطاق الدور، مرقّمة)
-- ---------------------------------------------------------------------------
create or replace function public.list_attendance_anomalies(p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams(); v_now timestamptz := now();
  v_size int := least(greatest(coalesce(p_page_size,50),1),100);
  v_page int := greatest(coalesce(p_page,1),1); v_total int;
begin
  select count(*) into v_total from public._att_anomalies(v_teams, v_now);
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(to_jsonb(x) order by x.severity, x.check_in_at), '[]'::jsonb)
              from (select anomaly_type, severity, session_id, employee_name, team_name, check_in_at, detail
                    from public._att_anomalies(v_teams, v_now)
                    order by severity, check_in_at
                    limit v_size offset (v_page-1)*v_size) x),
    'total', v_total, 'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total=0 then 0 else ((v_total + v_size - 1)/v_size) end,
    'generated_at', v_now);
end $fn$;
revoke all on function public.list_attendance_anomalies(int,int) from public, anon;
grant execute on function public.list_attendance_anomalies(int,int) to authenticated;

-- ---------------------------------------------------------------------------
-- 12) RPC: سجل جلسة (Timeline — قراءة فقط، نطاق الدور)
-- ---------------------------------------------------------------------------
create or replace function public.get_attendance_timeline(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams(); v_team text;
begin
  select team into v_team from public.attendance_sessions where id=p_session_id;
  if v_team is null or not (v_team = any(v_teams)) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'event_type', h.event_type, 'actor_role', h.actor_role, 'reason', h.reason,
      'old_data', h.old_data, 'new_data', h.new_data, 'at', h.created_at) order by h.created_at), '[]'::jsonb)
    from public.attendance_history h where h.session_id=p_session_id));
end $fn$;
revoke all on function public.get_attendance_timeline(uuid) from public, anon;
grant execute on function public.get_attendance_timeline(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 13) RPC: تصحيح إداري (نطاق كتابة عبر can_write_team؛ سبب إلزامي؛ ذرّي)
-- ---------------------------------------------------------------------------
create or replace function public.correct_attendance_session(
  p_session_id uuid, p_check_in_at timestamptz, p_check_out_at timestamptz, p_reason text)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_now timestamptz := now(); a record; v_reason text := btrim(coalesce(p_reason,''));
  v_secs int; v_status text; v_old jsonb; v_new jsonb;
begin
  if v_reason = '' then raise exception using errcode='22004', message='سبب التصحيح إلزامي'; end if;
  if length(v_reason) > 1000 then raise exception 'reason_too_long' using errcode='22001'; end if;
  if p_check_in_at is null then raise exception 'check_in_required' using errcode='22004'; end if;
  if p_check_out_at is not null and p_check_out_at <= p_check_in_at then
    raise exception using errcode='22007', message='الخروج يجب أن يكون بعد الدخول'; end if;
  -- قفل الجلسة
  select * into a from public.attendance_sessions where id=p_session_id for update;
  if a.id is null then raise exception 'not_found' using errcode='P0002'; end if;
  if a.status='voided' then raise exception using errcode='22023', message='الجلسة مُبطَلة'; end if;
  -- نطاق الكتابة الخادمي (superadmin/owner-قسمه/admin-ورديته)؛ يمنع خارج النطاق
  if not public.can_write_team(a.team) then raise exception 'forbidden' using errcode='42501'; end if;
  -- منع التداخل مع جلسة أخرى لنفس الموظف
  if exists(select 1 from public.attendance_sessions b where b.employee_id=a.employee_id and b.id<>a.id
       and b.status<>'voided' and b.check_in_at < coalesce(p_check_out_at, 'infinity'::timestamptz)
       and coalesce(b.check_out_at, 'infinity'::timestamptz) > p_check_in_at) then
    raise exception using errcode='23P01', message='يتداخل مع جلسة أخرى للموظف';
  end if;
  v_status := case when p_check_out_at is null then 'open' else 'corrected' end;
  v_secs := case when p_check_out_at is null then null else floor(extract(epoch from (p_check_out_at - p_check_in_at)))::int end;
  v_old := to_jsonb(a);
  update public.attendance_sessions
    set check_in_at=p_check_in_at, check_out_at=p_check_out_at, status=v_status, work_seconds=v_secs,
        check_out_source=case when p_check_out_at is null then null else 'admin' end,
        correction_count=a.correction_count+1, closed_by=case when p_check_out_at is null then null else (select auth.uid()) end,
        attendance_date=(p_check_in_at at time zone 'Asia/Qatar')::date, updated_at=v_now
    where id=a.id;
  v_new := to_jsonb((select r from public.attendance_sessions r where r.id=a.id));
  insert into public.attendance_history(session_id, event_type, actor_id, actor_role, reason, old_data, new_data)
    values (a.id, 'corrected', (select auth.uid()), public.audit_current_user_role(), v_reason,
            public._att_hist_json(v_old), public._att_hist_json(v_new));
  perform public._att_audit(a.team, 'update', a.id, 'تصحيح جلسة حضور');
  return jsonb_build_object('ok', true, 'session_id', a.id, 'status', v_status, 'work_seconds', v_secs);
end $fn$;
revoke all on function public.correct_attendance_session(uuid,timestamptz,timestamptz,text) from public, anon;
grant execute on function public.correct_attendance_session(uuid,timestamptz,timestamptz,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 14) RPC: إبطال جلسة (لا حذف؛ status='voided'؛ سبب إلزامي؛ لا إبطال مزدوج)
-- ---------------------------------------------------------------------------
create or replace function public.void_attendance_session(p_session_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare a record; v_reason text := btrim(coalesce(p_reason,'')); v_old jsonb; v_new jsonb;
begin
  if v_reason = '' then raise exception using errcode='22004', message='سبب الإبطال إلزامي'; end if;
  if length(v_reason) > 1000 then raise exception 'reason_too_long' using errcode='22001'; end if;
  select * into a from public.attendance_sessions where id=p_session_id for update;
  if a.id is null then raise exception 'not_found' using errcode='P0002'; end if;
  if not public.can_write_team(a.team) then raise exception 'forbidden' using errcode='42501'; end if;
  if a.status='voided' then raise exception using errcode='22023', message='الجلسة مُبطَلة سلفًا'; end if;
  v_old := to_jsonb(a);
  update public.attendance_sessions set status='voided', updated_at=now() where id=a.id;
  v_new := to_jsonb((select r from public.attendance_sessions r where r.id=a.id));
  insert into public.attendance_history(session_id, event_type, actor_id, actor_role, reason, old_data, new_data)
    values (a.id, 'voided', (select auth.uid()), public.audit_current_user_role(), v_reason,
            public._att_hist_json(v_old), public._att_hist_json(v_new));
  perform public._att_audit(a.team, 'update', a.id, 'إبطال جلسة حضور');
  return jsonb_build_object('ok', true, 'session_id', a.id, 'status', 'voided');
end $fn$;
revoke all on function public.void_attendance_session(uuid,text) from public, anon;
grant execute on function public.void_attendance_session(uuid,text) to authenticated;
