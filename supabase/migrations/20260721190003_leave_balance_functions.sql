-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 3/8: دوال الحساب وRPC
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  المستخدَم يُشتق دائماً من الإجازات المعتمدة (لا يُخزَّن).
--  الدوال المساعدة ممنوعة على authenticated؛ الوصول عبر RPC فقط:
--    my_leave_balances(year)   — الموظف: رصيده هو فقط (auth.uid()).
--    team_leave_balances(year,team) — owner/admin: أرصدة الوردية.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- عدد أيام إجازة داخل سنة معيّنة وفق أساس الاحتساب
--   calendar          = أيام تقويمية شاملة الطرفين داخل حدود السنة.
--   scheduled_workdays = فقط الأيام المجدولة عملاً (بحسب دورة الموظف)،
--                        لا تُحتسب أيام الراحة. (العطل الرسمية تُحتسب حالياً.)
-- ---------------------------------------------------------------------
create or replace function public.fn_leave_days_in_range(
  p_emp uuid, p_from date, p_to date, p_year int, p_basis text
) returns numeric
language plpgsql stable security definer set search_path = ''
as $$
declare
  gs date := greatest(p_from, make_date(p_year,1,1));
  ge date := least   (p_to,   make_date(p_year,12,31));
  v_cs date; v_team text; v_wd int; v_rd int; v_cycle int; v_cnt int;
begin
  if gs > ge then return 0; end if;
  if p_basis is distinct from 'scheduled_workdays' then
    return (ge - gs) + 1;                    -- calendar
  end if;

  select e.cycle_start, e.team into v_cs, v_team
    from public.employees e where e.id = p_emp;
  if v_cs is null then return (ge - gs) + 1; end if;   -- تعذّر التحديد ⇒ تقويمي

  select coalesce((s.data->>'workDays')::int, 6),
         coalesce((s.data->>'restDays')::int, 4)
    into v_wd, v_rd
    from public.settings s where s.team = v_team;
  v_wd := coalesce(v_wd, 6); v_rd := coalesce(v_rd, 4);
  v_cycle := v_wd + v_rd;
  if v_cycle <= 0 then return (ge - gs) + 1; end if;   -- إعداد غير صالح ⇒ تقويمي

  select count(*) into v_cnt
    from generate_series(gs, ge, interval '1 day') g(d)
   where (g.d::date - v_cs) >= 0
     and mod(((g.d::date - v_cs) % v_cycle) + v_cycle, v_cycle) < v_wd;
  return coalesce(v_cnt, 0);
end $$;

-- ---------------------------------------------------------------------
-- المستخدَم (أيام معتمدة) لموظف/سنة/نوع — بإمكان استثناء طلب واحد
-- ---------------------------------------------------------------------
create or replace function public.fn_leave_used(
  p_emp uuid, p_year int, p_type text, p_exclude uuid default null
) returns numeric
language plpgsql stable security definer set search_path = ''
as $$
declare v_basis text; v_team text; v_used numeric := 0; r record;
begin
  select e.team into v_team from public.employees e where e.id = p_emp;
  select coalesce(lp.day_count_basis,'calendar') into v_basis
    from public.leave_policies lp
   where lp.team = v_team and lp.year = p_year and lp.type = p_type;
  v_basis := coalesce(v_basis, 'calendar');

  for r in
    select l.id, l.from_date, l.to_date
      from public.leaves l
     where l.emp_id = p_emp and l.type = p_type and l.status = 'معتمد'
       and (p_exclude is null or l.id <> p_exclude)
       and l.from_date <= make_date(p_year,12,31)
       and l.to_date   >= make_date(p_year,1,1)
  loop
    v_used := v_used + public.fn_leave_days_in_range(p_emp, r.from_date, r.to_date, p_year, v_basis);
  end loop;
  return v_used;
end $$;

-- ---------------------------------------------------------------------
-- رصيد موظف واحد لكل نوع في سنة
--   available = entitled + initial + carryover + adjustments  (limited فقط)
--   remaining = available - used   (NULL لغير المحدود/التتبّع/غير المضبوط)
-- ---------------------------------------------------------------------
create or replace function public.fn_leave_balance(p_emp uuid, p_year int)
returns table(
  type text, policy_mode text, entitled_days int,
  initial numeric, carryover numeric, adjustments numeric,
  used numeric, available numeric, remaining numeric
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_team text; r record;
begin
  select e.team into v_team from public.employees e where e.id = p_emp;
  for r in
    select lp.type, lp.policy_mode, lp.entitled_days
      from public.leave_policies lp
     where lp.team = v_team and lp.year = p_year
     order by lp.type
  loop
    type := r.type; policy_mode := r.policy_mode; entitled_days := r.entitled_days;
    select coalesce(sum(days) filter (where kind='initial'),0),
           coalesce(sum(days) filter (where kind='carryover'),0),
           coalesce(sum(days) filter (where kind='adjustment'),0)
      into initial, carryover, adjustments
      from public.leave_ledger
     where emp_id = p_emp and year = p_year and type = r.type;
    used := public.fn_leave_used(p_emp, p_year, r.type);

    if r.policy_mode = 'limited' and r.entitled_days is not null then
      available := r.entitled_days + initial + carryover + adjustments;
      remaining := available - used;
    else
      available := null;   -- unlimited / tracking_only / limited غير مضبوط
      remaining := null;
    end if;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- RPC للموظف: رصيده هو فقط — يُحدَّد بـ auth.uid() من القاعدة (لا من العميل)
-- ---------------------------------------------------------------------
create or replace function public.my_leave_balances(p_year int)
returns table(
  type text, policy_mode text, entitled_days int,
  initial numeric, carryover numeric, adjustments numeric,
  used numeric, available numeric, remaining numeric
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_emp uuid;
begin
  select ea.emp_id into v_emp
    from public.employee_auth ea
   where ea.user_id = (select auth.uid());
  if v_emp is null then return; end if;   -- ليس موظفاً مرتبطاً
  return query select * from public.fn_leave_balance(v_emp, p_year);
end $$;

-- ---------------------------------------------------------------------
-- RPC إداري: أرصدة كل موظفي وردية (owner لأي وردية، admin لورديته فقط)
-- ---------------------------------------------------------------------
create or replace function public.team_leave_balances(p_year int, p_team text)
returns table(
  emp_id uuid, emp_name text, type text, policy_mode text, entitled_days int,
  initial numeric, carryover numeric, adjustments numeric,
  used numeric, available numeric, remaining numeric
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_is_owner boolean; v_role text; v_team text; e record; b record;
begin
  v_is_owner := public.is_owner();
  v_role := public.audit_current_user_role();
  v_team := public.audit_current_user_team();
  -- تحقّق الصلاحية
  if not v_is_owner then
    if v_role <> 'admin' or v_team is null or v_team = '' or v_team <> p_team then
      return;   -- ممنوع
    end if;
  end if;

  for e in
    select id, name from public.employees where team = p_team order by sort_order, name
  loop
    for b in select * from public.fn_leave_balance(e.id, p_year) loop
      emp_id := e.id; emp_name := e.name;
      type := b.type; policy_mode := b.policy_mode; entitled_days := b.entitled_days;
      initial := b.initial; carryover := b.carryover; adjustments := b.adjustments;
      used := b.used; available := b.available; remaining := b.remaining;
      return next;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- الصلاحيات: المساعِدات ممنوعة على authenticated؛ RPC فقط مسموح.
-- ---------------------------------------------------------------------
revoke all on function public.fn_leave_days_in_range(uuid,date,date,int,text) from public, anon, authenticated;
revoke all on function public.fn_leave_used(uuid,int,text,uuid)              from public, anon, authenticated;
revoke all on function public.fn_leave_balance(uuid,int)                     from public, anon, authenticated;
revoke all on function public.my_leave_balances(int)                         from public, anon, authenticated;
revoke all on function public.team_leave_balances(int,text)                  from public, anon, authenticated;
grant  execute on function public.my_leave_balances(int)        to authenticated;
grant  execute on function public.team_leave_balances(int,text) to authenticated;

commit;
