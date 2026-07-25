-- ============================================================================
-- المرحلة السادسة: لوحة التشغيل اليومية للمشرفين (قراءة فقط، محسوبة عند الطلب)
-- ملف مستقل — لا يُعدّل أي migration مطبَّق، ولا جداول/أعمدة/بيانات جديدة.
--
-- الأمان: كل RPC خارجية SECURITY DEFINER + search_path='' + بوّابة النطاق عبر
--   public._report_scope_teams() (superadmin=الكل، owner=قسمه، admin=ورديته؛
--   viewer/employee/anon/معطّل → forbidden 42501). لا اعتماد على JWT metadata.
-- التوقيت: «اليوم» = (now() at time zone 'Asia/Qatar')::date — لا CURRENT_DATE خام.
-- القراءة لا تُنشئ Audit/Notification/History/Decision/Ledger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) فهارس داعمة (IF NOT EXISTS — آمنة)
-- ---------------------------------------------------------------------------
create index if not exists idx_leaves_ops_status_team_dates on public.leaves (status, team, from_date, to_date);
create index if not exists idx_leaves_pending_submitted on public.leaves (submitted_at) where status = 'قيد الانتظار';
create index if not exists idx_leaves_emp_overlap on public.leaves (emp_id, from_date, to_date);

-- ---------------------------------------------------------------------------
-- 2) دالة داخلية: عناصر «تحتاج إجراء» ضمن نطاق موثوق (لا تُمنح لأي عميل)
--    p_teams يأتي دائمًا من _report_scope_teams() في RPC خارجية موثوقة.
-- ---------------------------------------------------------------------------
create or replace function public._ops_action_items(p_teams text[], p_today date, p_now timestamptz)
returns table(
  item_type text, priority text, sort_key timestamptz, from_sort date,
  leave_id uuid, request_id uuid, emp_id uuid,
  employee_name text, team_name text, department_name text,
  from_date date, to_date date, leave_type text, created_at timestamptz,
  age_hours numeric, action_kind text, title text, description text)
language sql stable security definer set search_path to '' as $fn$
  -- (أ) طلبات إجازة معلّقة
  select
    case when extract(epoch from (p_now - coalesce(l.submitted_at,l.updated_at)))/3600.0 > 24
         then 'stale_pending_leave' else 'pending_leave' end,
    case when l.from_date <= p_today then 'critical'
         when l.from_date = p_today + 1
           or extract(epoch from (p_now - coalesce(l.submitted_at,l.updated_at)))/3600.0 > 24 then 'warning'
         else 'info' end,
    coalesce(l.submitted_at, l.updated_at), l.from_date,
    l.id, null::uuid, l.emp_id,
    coalesce(e.name,'—'), l.team, coalesce(d.name, s.dept),
    l.from_date, l.to_date, l.type, coalesce(l.submitted_at, l.updated_at),
    round((extract(epoch from (p_now - coalesce(l.submitted_at,l.updated_at)))/3600.0)::numeric, 1),
    'decide_leave', 'طلب إجازة بانتظار القرار',
    coalesce(e.name,'—')||' — '||l.type
  from public.leaves l
  left join public.employees e on e.id = l.emp_id
  left join public.settings s on s.team = l.team
  left join public.departments d on d.id = s.dept
  where l.status = 'قيد الانتظار' and l.team = any(p_teams)

  union all
  -- (ب) طلبات إلغاء إجازة معتمدة معلّقة
  select
    'pending_leave_cancellation',
    case when l.from_date <= p_today then 'critical'
         when l.from_date = p_today + 1
           or extract(epoch from (p_now - cr.requested_at))/3600.0 > 24 then 'warning'
         else 'info' end,
    cr.requested_at, l.from_date,
    l.id, cr.id, l.emp_id,
    coalesce(e.name,'—'), l.team, coalesce(d.name, s.dept),
    l.from_date, l.to_date, l.type, cr.requested_at,
    round((extract(epoch from (p_now - cr.requested_at))/3600.0)::numeric, 1),
    'decide_cancellation', 'طلب إلغاء إجازة معتمدة',
    coalesce(e.name,'—')||' — '||l.type
  from public.leave_change_requests cr
  join public.leaves l on l.id = cr.leave_id
  left join public.employees e on e.id = l.emp_id
  left join public.settings s on s.team = l.team
  left join public.departments d on d.id = s.dept
  where cr.status = 'pending' and l.team = any(p_teams)

  union all
  -- (ج) موظف فعّال بلا ربط حساب (مشكلة ربط تحتاج انتباه المسؤول)
  select
    'account_link_issue', 'warning',
    e.updated_at, null::date,
    null::uuid, null::uuid, e.id,
    coalesce(e.name,'—'), e.team, coalesce(d.name, s.dept),
    null::date, null::date, null::text, e.updated_at,
    null::numeric, 'manage_account', 'موظف بلا حساب دخول',
    coalesce(e.name,'—')
  from public.employees e
  left join public.settings s on s.team = e.team
  left join public.departments d on d.id = s.dept
  where e.team = any(p_teams)
    and not exists (select 1 from public.employee_auth ea where ea.emp_id = e.id)
$fn$;
revoke all on function public._ops_action_items(text[],date,timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) دالة داخلية: التنبيهات التشغيلية المُثبَتة ضمن نطاق موثوق
-- ---------------------------------------------------------------------------
create or replace function public._ops_alerts(p_teams text[], p_today date, p_now timestamptz)
returns table(
  severity text, alert_type text, sort_key int,
  leave_id uuid, request_id uuid, emp_id uuid,
  employee_name text, team_name text, department_name text,
  from_date date, to_date date, title text, description text)
language sql stable security definer set search_path to '' as $fn$
  -- طلب إجازة معلّق يبدأ اليوم (حرج)
  select 'critical','pending_starts_today',1, l.id,null::uuid,l.emp_id,
    coalesce(e.name,'—'),l.team,coalesce(d.name,s.dept),l.from_date,l.to_date,
    'طلب إجازة يبدأ اليوم دون قرار', coalesce(e.name,'—')||' — '||l.type
  from public.leaves l left join public.employees e on e.id=l.emp_id
    left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
  where l.status='قيد الانتظار' and l.team=any(p_teams) and l.from_date=p_today
  union all
  -- طلب إلغاء معلّق وإجازته تبدأ اليوم (حرج)
  select 'critical','cancel_pending_starts_today',2, l.id,cr.id,l.emp_id,
    coalesce(e.name,'—'),l.team,coalesce(d.name,s.dept),l.from_date,l.to_date,
    'طلب إلغاء معلّق لإجازة تبدأ اليوم', coalesce(e.name,'—')||' — '||l.type
  from public.leave_change_requests cr join public.leaves l on l.id=cr.leave_id
    left join public.employees e on e.id=l.emp_id
    left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
  where cr.status='pending' and l.team=any(p_teams) and l.from_date=p_today
  union all
  -- تناقض: طلب إلغاء pending والإجازة ليست «معتمد» (حرج)
  select 'critical','cancel_inconsistent',3, l.id,cr.id,l.emp_id,
    coalesce(e.name,'—'),l.team,coalesce(d.name,s.dept),l.from_date,l.to_date,
    'طلب إلغاء معلّق لإجازة غير معتمدة', coalesce(e.name,'—')||' — الحالة: '||l.status
  from public.leave_change_requests cr join public.leaves l on l.id=cr.leave_id
    left join public.employees e on e.id=l.emp_id
    left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
  where cr.status='pending' and l.team=any(p_teams) and l.status<>'معتمد'
  union all
  -- حساب معطّل مرتبط بموظف فعّال (حرج — يمنعه من النظام)
  select 'critical','account_disabled_linked',4, null::uuid,null::uuid,e.id,
    coalesce(e.name,'—'),e.team,coalesce(d.name,s.dept),null::date,null::date,
    'حساب موظف معطّل', coalesce(e.name,'—')
  from public.employees e
    join public.employee_auth ea on ea.emp_id=e.id
    join auth.users u on u.id=ea.user_id
    left join public.settings s on s.team=e.team left join public.departments d on d.id=s.dept
  where e.team=any(p_teams) and u.banned_until is not null and u.banned_until > p_now
  union all
  -- طلب معلّق >24 ساعة (تحذير)
  select 'warning','pending_stale',5, l.id,null::uuid,l.emp_id,
    coalesce(e.name,'—'),l.team,coalesce(d.name,s.dept),l.from_date,l.to_date,
    'طلب معلّق أكثر من 24 ساعة', coalesce(e.name,'—')||' — '||l.type
  from public.leaves l left join public.employees e on e.id=l.emp_id
    left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
  where l.status='قيد الانتظار' and l.team=any(p_teams)
    and l.from_date > p_today
    and extract(epoch from (p_now - coalesce(l.submitted_at,l.updated_at)))/3600.0 > 24
  union all
  -- طلب معلّق يبدأ غدًا (تحذير)
  select 'warning','pending_starts_tomorrow',6, l.id,null::uuid,l.emp_id,
    coalesce(e.name,'—'),l.team,coalesce(d.name,s.dept),l.from_date,l.to_date,
    'طلب معلّق يبدأ غدًا', coalesce(e.name,'—')||' — '||l.type
  from public.leaves l left join public.employees e on e.id=l.emp_id
    left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
  where l.status='قيد الانتظار' and l.team=any(p_teams) and l.from_date = p_today + 1
  union all
  -- موظف فعّال بلا ربط حساب (تحذير)
  select 'warning','employee_no_account',7, null::uuid,null::uuid,e.id,
    coalesce(e.name,'—'),e.team,coalesce(d.name,s.dept),null::date,null::date,
    'موظف بلا حساب دخول', coalesce(e.name,'—')
  from public.employees e
    left join public.settings s on s.team=e.team left join public.departments d on d.id=s.dept
  where e.team=any(p_teams) and not exists(select 1 from public.employee_auth ea where ea.emp_id=e.id)
  union all
  -- تداخل إجازات لنفس الموظف (تحذير) — زوج واحد فقط (a.id < b.id)
  select 'warning','leave_overlap',8, a.id,b.id,a.emp_id,
    coalesce(e.name,'—'),a.team,coalesce(d.name,s.dept),a.from_date,a.to_date,
    'تداخل إجازتين لنفس الموظف', coalesce(e.name,'—')
  from public.leaves a join public.leaves b
    on a.emp_id=b.emp_id and a.id < b.id
    and a.status in ('قيد الانتظار','معتمد') and b.status in ('قيد الانتظار','معتمد')
    and a.from_date <= b.to_date and a.to_date >= b.from_date
  left join public.employees e on e.id=a.emp_id
  left join public.settings s on s.team=a.team left join public.departments d on d.id=s.dept
  where a.team=any(p_teams)
  union all
  -- إجازة معتمدة تنتهي اليوم (معلوماتي)
  select 'info','ending_today',9, l.id,null::uuid,l.emp_id,
    coalesce(e.name,'—'),l.team,coalesce(d.name,s.dept),l.from_date,l.to_date,
    'إجازة تنتهي اليوم', coalesce(e.name,'—')||' — '||l.type
  from public.leaves l left join public.employees e on e.id=l.emp_id
    left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
  where l.status='معتمد' and l.team=any(p_teams) and l.to_date=p_today
$fn$;
revoke all on function public._ops_alerts(text[],date,timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) دوال JSON مساعدة داخلية لبناء صفوف اليوم/القادم (قابلة لإعادة الاستخدام)
-- ---------------------------------------------------------------------------
create or replace function public._ops_today_leaves(p_teams text[], p_today date, p_limit int, p_offset int)
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select coalesce(jsonb_agg(x order by (x->>'from_date')), '[]'::jsonb) from (
    select jsonb_build_object(
      'leave_id', l.id, 'employee_name', coalesce(e.name,'—'), 'team_name', l.team,
      'department_name', coalesce(d.name,s.dept), 'leave_type', l.type,
      'from_date', l.from_date, 'to_date', l.to_date,
      'starts_today', l.from_date = p_today, 'ends_today', l.to_date = p_today) as x
    from public.leaves l left join public.employees e on e.id=l.emp_id
      left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
    where l.status='معتمد' and l.team=any(p_teams) and l.from_date <= p_today and l.to_date >= p_today
    order by l.from_date, l.id limit p_limit offset p_offset
  ) t;
$fn$;
revoke all on function public._ops_today_leaves(text[],date,int,int) from public, anon, authenticated;

create or replace function public._ops_upcoming_leaves(p_teams text[], p_today date, p_days int, p_limit int, p_offset int)
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select coalesce(jsonb_agg(x order by (x->>'from_date')), '[]'::jsonb) from (
    select jsonb_build_object(
      'leave_id', l.id, 'employee_name', coalesce(e.name,'—'), 'team_name', l.team,
      'department_name', coalesce(d.name,s.dept), 'leave_type', l.type,
      'from_date', l.from_date, 'to_date', l.to_date,
      'days_until', (l.from_date - p_today)) as x
    from public.leaves l left join public.employees e on e.id=l.emp_id
      left join public.settings s on s.team=l.team left join public.departments d on d.id=s.dept
    where l.status='معتمد' and l.team=any(p_teams)
      and l.from_date > p_today and l.from_date <= p_today + p_days
    order by l.from_date, l.id limit p_limit offset p_offset
  ) t;
$fn$;
revoke all on function public._ops_upcoming_leaves(text[],date,int,int,int) from public, anon, authenticated;

-- تحويل صف action item إلى JSON منقّح موحّد
create or replace function public._ops_ai_json(p_teams text[], p_today date, p_now timestamptz, p_limit int, p_offset int)
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select coalesce(jsonb_agg(j), '[]'::jsonb) from (
    select jsonb_build_object(
      'item_type', item_type, 'priority', priority,
      'leave_id', leave_id, 'request_id', request_id, 'emp_id', emp_id,
      'employee_name', employee_name, 'team_name', team_name, 'department_name', department_name,
      'from_date', from_date, 'to_date', to_date, 'leave_type', leave_type,
      'created_at', created_at, 'age_hours', age_hours,
      'can_decide', true, 'action_kind', action_kind,
      'title', title, 'description', description) as j
    from public._ops_action_items(p_teams, p_today, p_now)
    order by case priority when 'critical' then 0 when 'warning' then 1 else 2 end,
             sort_key nulls last, from_sort nulls last
    limit p_limit offset p_offset
  ) t;
$fn$;
revoke all on function public._ops_ai_json(text[],date,timestamptz,int,int) from public, anon, authenticated;

create or replace function public._ops_alerts_json(p_teams text[], p_today date, p_now timestamptz, p_limit int, p_offset int)
returns jsonb language sql stable security definer set search_path to '' as $fn$
  select coalesce(jsonb_agg(j), '[]'::jsonb) from (
    select jsonb_build_object(
      'severity', severity, 'alert_type', alert_type,
      'leave_id', leave_id, 'request_id', request_id, 'emp_id', emp_id,
      'employee_name', employee_name, 'team_name', team_name, 'department_name', department_name,
      'from_date', from_date, 'to_date', to_date,
      'title', title, 'description', description) as j
    from public._ops_alerts(p_teams, p_today, p_now)
    order by sort_key, employee_name
    limit p_limit offset p_offset
  ) t;
$fn$;
revoke all on function public._ops_alerts_json(text[],date,timestamptz,int,int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) RPC رئيسية: لوحة التشغيل اليومية (ملخّص + صفحات أولى صغيرة)
-- ---------------------------------------------------------------------------
create or replace function public.get_daily_operations_dashboard(
  p_date date default null, p_upcoming_days int default 7)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare
  v_teams text[] := public._report_scope_teams();   -- بوّابة: يرفع forbidden لغير المخوّل
  v_role  text := public.audit_current_user_role();
  v_now   timestamptz := now();
  v_today date := coalesce(p_date, (v_now at time zone 'Asia/Qatar')::date);
  v_days  int := least(greatest(coalesce(p_upcoming_days,7),1),30);
  v_summary jsonb;
begin
  select jsonb_build_object(
    'pending_leaves', (select count(*) from public.leaves where status='قيد الانتظار' and team=any(v_teams)),
    'pending_cancellations', (select count(*) from public.leave_change_requests cr join public.leaves l on l.id=cr.leave_id where cr.status='pending' and l.team=any(v_teams)),
    'on_leave_today', (select count(*) from public.leaves where status='معتمد' and team=any(v_teams) and from_date<=v_today and to_date>=v_today),
    'upcoming', (select count(*) from public.leaves where status='معتمد' and team=any(v_teams) and from_date>v_today and from_date<=v_today+v_days),
    'stale_pending_24h', (select count(*) from public.leaves where status='قيد الانتظار' and team=any(v_teams) and extract(epoch from (v_now - coalesce(submitted_at,updated_at)))/3600.0 > 24),
    'ending_today', (select count(*) from public.leaves where status='معتمد' and team=any(v_teams) and to_date=v_today),
    'active_employees', (select count(*) from public.employees where team=any(v_teams)),
    'disabled_accounts', (select count(*) from public.employees e join public.employee_auth ea on ea.emp_id=e.id join auth.users u on u.id=ea.user_id where e.team=any(v_teams) and u.banned_until is not null and u.banned_until>v_now),
    'employees_without_auth', (select count(*) from public.employees e where e.team=any(v_teams) and not exists(select 1 from public.employee_auth ea where ea.emp_id=e.id)),
    -- عدّ التنبيهات الحرجة مباشرةً من مصادرها الأربعة (يطابق severity='critical' في _ops_alerts)
    -- دون تشغيل الاتحاد الكامل/التداخل — أسرع وأدقّ.
    'critical_alerts', (
        (select count(*) from public.leaves where status='قيد الانتظار' and team=any(v_teams) and from_date=v_today)                                         -- pending_starts_today
      + (select count(*) from public.leave_change_requests cr join public.leaves l on l.id=cr.leave_id where cr.status='pending' and l.team=any(v_teams) and l.from_date=v_today)  -- cancel_pending_starts_today
      + (select count(*) from public.leave_change_requests cr join public.leaves l on l.id=cr.leave_id where cr.status='pending' and l.team=any(v_teams) and l.status<>'معتمد')     -- cancel_inconsistent
      + (select count(*) from public.employees e join public.employee_auth ea on ea.emp_id=e.id join auth.users u on u.id=ea.user_id where e.team=any(v_teams) and u.banned_until is not null and u.banned_until>v_now)  -- account_disabled_linked
    )
  ) into v_summary;

  return jsonb_build_object(
    'generated_at', v_now,
    'timezone', 'Asia/Qatar',
    'today', v_today,
    'upcoming_days', v_days,
    'scope', jsonb_build_object('role', v_role, 'teams_count', coalesce(array_length(v_teams,1),0)),
    'summary', v_summary,
    'action_items', public._ops_ai_json(v_teams, v_today, v_now, 20, 0),
    'today_leaves', public._ops_today_leaves(v_teams, v_today, 50, 0),
    'upcoming_leaves', public._ops_upcoming_leaves(v_teams, v_today, v_days, 50, 0),
    'alerts', public._ops_alerts_json(v_teams, v_today, v_now, 50, 0)
  );
end $fn$;

-- ---------------------------------------------------------------------------
-- 6) RPCs قوائم مرقّمة (للتحميل الإضافي)
-- ---------------------------------------------------------------------------
create or replace function public.list_daily_action_items(p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams(); v_now timestamptz := now();
  v_today date := (v_now at time zone 'Asia/Qatar')::date;
  v_size int := least(greatest(coalesce(p_page_size,50),1),100);
  v_page int := greatest(coalesce(p_page,1),1); v_total int;
begin
  select count(*) into v_total from public._ops_action_items(v_teams, v_today, v_now);
  return jsonb_build_object('items', public._ops_ai_json(v_teams, v_today, v_now, v_size, (v_page-1)*v_size),
    'total', v_total, 'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total=0 then 0 else ((v_total + v_size - 1)/v_size) end);
end $fn$;

create or replace function public.list_today_leaves(p_date date default null, p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams(); v_now timestamptz := now();
  v_today date := coalesce(p_date, (v_now at time zone 'Asia/Qatar')::date);
  v_size int := least(greatest(coalesce(p_page_size,50),1),100);
  v_page int := greatest(coalesce(p_page,1),1); v_total int;
begin
  select count(*) into v_total from public.leaves where status='معتمد' and team=any(v_teams) and from_date<=v_today and to_date>=v_today;
  return jsonb_build_object('items', public._ops_today_leaves(v_teams, v_today, v_size, (v_page-1)*v_size),
    'total', v_total, 'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total=0 then 0 else ((v_total + v_size - 1)/v_size) end);
end $fn$;

create or replace function public.list_upcoming_leaves(p_upcoming_days int default 7, p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams(); v_now timestamptz := now();
  v_today date := (v_now at time zone 'Asia/Qatar')::date;
  v_days int := least(greatest(coalesce(p_upcoming_days,7),1),30);
  v_size int := least(greatest(coalesce(p_page_size,50),1),100);
  v_page int := greatest(coalesce(p_page,1),1); v_total int;
begin
  select count(*) into v_total from public.leaves where status='معتمد' and team=any(v_teams) and from_date>v_today and from_date<=v_today+v_days;
  return jsonb_build_object('items', public._ops_upcoming_leaves(v_teams, v_today, v_days, v_size, (v_page-1)*v_size),
    'total', v_total, 'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total=0 then 0 else ((v_total + v_size - 1)/v_size) end);
end $fn$;

create or replace function public.list_operational_alerts(p_page int default 1, p_page_size int default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[] := public._report_scope_teams(); v_now timestamptz := now();
  v_today date := (v_now at time zone 'Asia/Qatar')::date;
  v_size int := least(greatest(coalesce(p_page_size,50),1),100);
  v_page int := greatest(coalesce(p_page,1),1); v_total int;
begin
  select count(*) into v_total from public._ops_alerts(v_teams, v_today, v_now);
  return jsonb_build_object('items', public._ops_alerts_json(v_teams, v_today, v_now, v_size, (v_page-1)*v_size),
    'total', v_total, 'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total=0 then 0 else ((v_total + v_size - 1)/v_size) end);
end $fn$;

-- ---------------------------------------------------------------------------
-- 7) المنح: خارجية لـ authenticated فقط؛ حرمان anon/public
-- ---------------------------------------------------------------------------
revoke all on function public.get_daily_operations_dashboard(date,int) from public, anon;
grant  execute on function public.get_daily_operations_dashboard(date,int) to authenticated;
revoke all on function public.list_daily_action_items(int,int) from public, anon;
grant  execute on function public.list_daily_action_items(int,int) to authenticated;
revoke all on function public.list_today_leaves(date,int,int) from public, anon;
grant  execute on function public.list_today_leaves(date,int,int) to authenticated;
revoke all on function public.list_upcoming_leaves(int,int,int) from public, anon;
grant  execute on function public.list_upcoming_leaves(int,int,int) to authenticated;
revoke all on function public.list_operational_alerts(int,int) from public, anon;
grant  execute on function public.list_operational_alerts(int,int) to authenticated;
