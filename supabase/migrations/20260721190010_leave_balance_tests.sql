-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | اختبارات يدوية (مراجعة فقط، لا تُطبَّق تلقائياً)
--  كل اختبار داخل BEGIN/ROLLBACK فلا يبقى أثر. تُشغَّل بعد تطبيق 1..7.
--  الحسابات (عدّلها لبيئتك):
--    owner: clanqtr@gmail.com | admin(w1): salemm@shift.local | viewer(w1): e2424@shift.local
-- =====================================================================

-- ============ PREFLIGHT ============
do $$
begin
  if not exists (select 1 from auth.users where email='clanqtr@gmail.com') then raise exception 'PREFLIGHT: owner مفقود'; end if;
  if not exists (select 1 from auth.users where email='salemm@shift.local') then raise exception 'PREFLIGHT: admin(w1) مفقود'; end if;
  if not exists (select 1 from auth.users where email='e2424@shift.local')   then raise exception 'PREFLIGHT: viewer مفقود'; end if;
  if not exists (select 1 from public.employee_auth) then raise exception 'PREFLIGHT: employee_auth فارغ (لم تُملأ)'; end if;
  raise notice 'PREFLIGHT OK';
end $$;

-- ============ T1: احتساب الأيام calendar + scheduled_workdays ============
begin;
  do $$
  declare v_emp uuid; v_cal numeric; v_wd numeric;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    -- calendar: 5 أيام تقويمية 2026-07-01..2026-07-05
    v_cal := public.fn_leave_days_in_range(v_emp, '2026-07-01','2026-07-05', 2026, 'calendar');
    if v_cal <> 5 then raise exception 'T1 FAIL calendar=% (متوقع 5)', v_cal; end if;
    -- scheduled_workdays: ≤ calendar (تُستبعد أيام الراحة)
    v_wd := public.fn_leave_days_in_range(v_emp, '2026-07-01','2026-07-31', 2026, 'scheduled_workdays');
    if v_wd > 31 or v_wd < 0 then raise exception 'T1 FAIL workdays=%', v_wd; end if;
    raise notice 'T1 OK: calendar=5, workdays(يوليو)=%', v_wd;
  end $$;
rollback;

-- ============ T2: الإجازة الممتدة بين سنتين تُقسّم على كل سنة ============
begin;
  do $$
  declare v_emp uuid; d2026 numeric; d2027 numeric;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    -- 2026-12-28 .. 2027-01-03 : calendar
    d2026 := public.fn_leave_days_in_range(v_emp,'2026-12-28','2027-01-03',2026,'calendar'); -- 28,29,30,31 = 4
    d2027 := public.fn_leave_days_in_range(v_emp,'2026-12-28','2027-01-03',2027,'calendar'); -- 1,2,3 = 3
    if d2026 <> 4 or d2027 <> 3 then raise exception 'T2 FAIL 2026=% 2027=% (متوقع 4/3)', d2026, d2027; end if;
    raise notice 'T2 OK: 2026=4, 2027=3';
  end $$;
rollback;

-- ============ T3: fn_leave_balance حسب policy_mode ============
begin;
  do $$
  declare v_emp uuid; v_team text; r record; v_ok boolean := false;
  begin
    select id, team into v_emp, v_team from public.employees where team='w1' order by sort_order limit 1;
    -- اضبط سنوية limited=10 لهذا الاختبار
    update public.leave_policies set entitled_days=10 where team=v_team and year=2026 and type='سنوية';
    -- قيد ابتدائي +2 وتعديل −1
    insert into public.leave_ledger(team,emp_id,year,type,kind,days,reason) values (v_team,v_emp,2026,'سنوية','initial',2,'اختبار'),(v_team,v_emp,2026,'سنوية','adjustment',-1,'اختبار');
    for r in select * from public.fn_leave_balance(v_emp,2026) loop
      if r.type='سنوية' then
        -- available = 10 + 2 + 0 + (-1) = 11
        if r.available <> 11 then raise exception 'T3 FAIL سنوية available=% (متوقع 11)', r.available; end if;
        v_ok := true;
      end if;
      if r.type='مرضية' and r.remaining is not null then raise exception 'T3 FAIL: unlimited يجب remaining=NULL'; end if;
      if r.type='غياب' and r.remaining is not null then raise exception 'T3 FAIL: tracking_only يجب remaining=NULL'; end if;
    end loop;
    if not v_ok then raise exception 'T3 FAIL: لم تُحسب سنوية'; end if;
    raise notice 'T3 OK: available سنوية=11، unlimited/tracking_only remaining=NULL';
  end $$;
rollback;

-- ============ T4: منع اعتماد يتجاوز الرصيد إلا بتجاوز موثّق ============
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),
      'role','authenticated','app_metadata',json_build_object('role','admin','team','w1'))::text, true);
  do $$
  declare v_emp uuid; v_id uuid := gen_random_uuid(); v_blocked boolean := false;
  begin
    reset role;  -- تهيئة السياسة بصلاحية كاملة
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    update public.leave_policies set entitled_days=1 where team='w1' and year=2026 and type='سنوية';
    set local role authenticated;
    select set_config('request.jwt.claims',
      json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),
        'role','authenticated','app_metadata',json_build_object('role','admin','team','w1'))::text, true);
    -- محاولة اعتماد 5 أيام (يتجاوز 1) دون تجاوز → يجب أن تفشل
    begin
      insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team)
        values (v_id,v_emp,'سنوية','2026-08-01','2026-08-05','معتمد','__LB_T4__','w1');
      raise exception 'T4 FAIL: نجح الاعتماد المتجاوز دون تجاوز موثّق';
    exception when others then
      if sqlerrm like '%موافقة استثنائية%' then v_blocked := true; else raise; end if;
    end;
    if not v_blocked then raise exception 'T4 FAIL: لم يُمنع'; end if;
    -- مع تجاوز موثّق + سبب → ينجح
    insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team,balance_override,balance_override_reason)
      values (v_id,v_emp,'سنوية','2026-08-01','2026-08-05','معتمد','__LB_T4__','w1',true,'ظرف طارئ');
    raise notice 'T4 OK: مُنع دون تجاوز، ونجح مع تجاوز موثّق';
  end $$;
  reset role;
rollback;

-- ============ T5: إلغاء الاعتماد وتعديل التاريخ يعيدان حساب المستخدَم ============
begin;
  do $$
  declare v_emp uuid; v_id uuid := gen_random_uuid(); u1 numeric; u2 numeric;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team)
      values (v_id,v_emp,'عارض','2026-09-01','2026-09-03','معتمد','__LB_T5__','w1');
    u1 := public.fn_leave_used(v_emp,2026,'عارض');   -- يشمل 3 أيام
    update public.leaves set status='مرفوض' where id=v_id;
    u2 := public.fn_leave_used(v_emp,2026,'عارض');   -- يعود بلا الـ3
    if (u1 - u2) <> 3 then raise exception 'T5 FAIL: إلغاء الاعتماد لم يُعِد الحساب (u1=% u2=%)', u1, u2; end if;
    raise notice 'T5 OK: المستخدَم مشتق (u1=% → u2=%)', u1, u2;
  end $$;
rollback;

-- ============ T6: RLS — viewer لا يقرأ leave_ledger مباشرة، ويرى رصيده عبر RPC ============
begin;
  -- بذر قيد للموظف (بصلاحية كاملة)
  do $$
  declare v_emp uuid; v_team text;
  begin
    select ea.emp_id, e.team into v_emp, v_team
      from public.employee_auth ea join public.employees e on e.id=ea.emp_id
      join auth.users u on u.id=ea.user_id where u.email='e2424@shift.local';
    insert into public.leave_ledger(team,emp_id,year,type,kind,days,reason) values (v_team,v_emp,2026,'سنوية','initial',5,'بذر');
  end $$;

  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='e2424@shift.local'),'role','authenticated',
      'app_metadata',json_build_object('role','viewer','team','w1'))::text, true);
  do $$
  declare c int; rc int;
  begin
    -- قراءة مباشرة → 0 (السياسة تمنع viewer)
    select count(*) into c from public.leave_ledger;
    if c <> 0 then raise exception 'T6 FAIL: viewer يقرأ leave_ledger مباشرة (%)', c; end if;
    -- RPC → يرى رصيده
    select count(*) into rc from public.my_leave_balances(2026);
    if rc < 1 then raise exception 'T6 FAIL: my_leave_balances فارغ للموظف'; end if;
    raise notice 'T6 OK: قراءة مباشرة=0، my_leave_balances=% صفوف', rc;
  end $$;
  reset role;
rollback;

-- ============ T7: viewer لا يكتب سياسة/ledger، والكتابة المباشرة مرفوضة ============
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='e2424@shift.local'),'role','authenticated',
      'app_metadata',json_build_object('role','viewer','team','w1'))::text, true);
  do $$
  declare denied int := 0; v_emp uuid;
  begin
    -- emp_id صالح (viewer يقرأ موظفي ورديته) لاختبار رفض RLS لا رفض «موظف غير موجود»
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    begin insert into public.leave_ledger(emp_id,year,type,kind,days) values(v_emp,2026,'سنوية','adjustment',1); exception when others then denied:=denied+1; end;
    begin insert into public.leave_policies(team,year,type,policy_mode) values('w1',2026,'X','limited'); exception when others then denied:=denied+1; end;
    if denied <> 2 then raise exception 'T7 FAIL: الموظف كتب رصيداً/سياسة (denied=%)', denied; end if;
    raise notice 'T7 OK: viewer ممنوع من الكتابة ×2 (RLS)';
  end $$;
  reset role;
rollback;

-- ============ T8: team_leave_balances — admin ورديته فقط ============
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),'role','authenticated',
      'app_metadata',json_build_object('role','admin','team','w1'))::text, true);
  do $$
  declare c_w1 int; c_w2 int;
  begin
    select count(*) into c_w1 from public.team_leave_balances(2026,'w1');
    select count(*) into c_w2 from public.team_leave_balances(2026,'w2');  -- ليست ورديته → 0
    if c_w1 < 1 then raise exception 'T8 FAIL: admin لا يرى ورديته'; end if;
    if c_w2 <> 0 then raise exception 'T8 FAIL: admin يرى وردية أخرى (%)', c_w2; end if;
    raise notice 'T8 OK: admin w1=% w2=0', c_w1;
  end $$;
  reset role;
rollback;

-- ============ T9: التدقيق يسجّل سياسة/ledger دون نص السبب ============
begin;
  do $$
  declare v_emp uuid; v_row record; leaked boolean;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    insert into public.leave_ledger(team,emp_id,year,type,kind,days,reason) values('w1',v_emp,2026,'سنوية','adjustment',3,'سبب سرّي جداً __SECRET__');
    update public.leave_policies set entitled_days=7 where team='w1' and year=2026 and type='سنوية';
    -- لا يظهر نص السبب في أي سجل تدقيق
    select bool_or(coalesce(changed::text,'') like '%__SECRET__%' or coalesce(summary,'') like '%__SECRET__%')
      into leaked from public.audit_log where at > now()-interval '1 minute';
    if leaked then raise exception 'T9 FAIL: نص السبب ظهر في التدقيق'; end if;
    if not exists(select 1 from public.audit_log where entity='leave_ledger' and at>now()-interval '1 minute') then raise exception 'T9 FAIL: لا سجل ledger'; end if;
    if not exists(select 1 from public.audit_log where entity='leave_policies' and at>now()-interval '1 minute') then raise exception 'T9 FAIL: لا سجل policy'; end if;
    raise notice 'T9 OK: سُجّلت السياسة والـledger، ونص السبب محجوب';
  end $$;
rollback;

-- ============ T10: الأرشفة — حذف موظف يؤرشف الـledger بلا يتيم ============
begin;
  do $$
  declare v_id uuid; v_arch int; v_left int; v_dup int;
  begin
    -- موظف اختباري (يُنشئ trg_provision مستخدم Auth وربطاً) — كله يُلغى بالـROLLBACK
    insert into public.employees(name,emp_no,cycle_start,sort_order,team)
      values('موظف اختبار رصيد','9999888','2026-01-01',999,'w1') returning id into v_id;
    -- عدّة قيود بأنواع/سنوات مختلفة (team/created_by/created_at يفرضها الخادم)
    insert into public.leave_ledger(emp_id,year,type,kind,days,source_year,reason) values
      (v_id,2026,'سنوية','initial',    4, null, 'بذر'),
      (v_id,2026,'سنوية','adjustment',-1, null, 'خصم'),
      (v_id,2026,'عارض', 'initial',    2, null, 'بذر عارض'),
      (v_id,2027,'سنوية','carryover',  3, 2026, 'ترحيل');
    delete from public.employees where id=v_id;   -- يُشغّل الأرشفة قبل ON DELETE CASCADE
    select count(*) into v_arch from public.archived_leave_ledger where emp_id=v_id;
    select count(*) into v_left from public.leave_ledger where emp_id=v_id;
    select count(*) - count(distinct id) into v_dup from public.archived_leave_ledger where emp_id=v_id;
    if v_arch <> 4 then raise exception 'T10 FAIL: أُرشِف % قيد (متوقع 4)', v_arch; end if;
    if v_left <> 0 then raise exception 'T10 FAIL: قيود يتيمة متبقية (%)', v_left; end if;
    if v_dup <> 0 then raise exception 'T10 FAIL: أرشيف مكرر'; end if;
    if exists(select 1 from public.employee_auth where emp_id=v_id) then raise exception 'T10 FAIL: employee_auth لم يُحذف (cascade)'; end if;
    raise notice 'T10 OK: أُرشِف % قيد (بلا يتيم/تكرار)، cascade تم', v_arch;
  end $$;
rollback;

-- ============ T11: الترحيل idempotent (قيد فريد يمنع التكرار) ============
begin;
  do $$
  declare v_emp uuid; dup boolean := false;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    insert into public.leave_ledger(team,emp_id,year,type,kind,days,source_year,reason) values('w1',v_emp,2027,'سنوية','carryover',3,2026,'ترحيل');
    begin
      insert into public.leave_ledger(team,emp_id,year,type,kind,days,source_year,reason) values('w1',v_emp,2027,'سنوية','carryover',3,2026,'ترحيل مكرر');
      raise exception 'T11 FAIL: سُمح بترحيل مكرر';
    exception when unique_violation then dup := true; end;
    if not dup then raise exception 'T11 FAIL'; end if;
    raise notice 'T11 OK: الترحيل المكرر مرفوض بالقيد الفريد';
  end $$;
rollback;

-- ============ T12: idempotency لـled_add — نفس id لا يُنشئ قيداً ثانياً ============
begin;
  do $$
  declare v_emp uuid; v_id uuid := gen_random_uuid(); n int; dup boolean := false;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    insert into public.leave_ledger(id,emp_id,year,type,kind,days,reason) values(v_id,v_emp,2026,'سنوية','adjustment',3,'أول');
    -- إعادة إرسال نفس id ⇒ يجب أن تفشل بمفتاح مكرر (والعميل يعاملها idempotent)
    begin
      insert into public.leave_ledger(id,emp_id,year,type,kind,days,reason) values(v_id,v_emp,2026,'سنوية','adjustment',3,'أول');
    exception when unique_violation then dup := true; end;
    if not dup then raise exception 'T12 FAIL: قُبل id مكرر (لا idempotency)'; end if;
    select count(*) into n from public.leave_ledger where id=v_id;
    if n <> 1 then raise exception 'T12 FAIL: عدد الصفوف=% (متوقع 1)', n; end if;
    raise notice 'T12 OK: نفس id ⇒ صف واحد فقط (idempotent)';
  end $$;
rollback;

-- ============ T13: حماية التجاوز + خوادم الحقول ============
begin;
  do $$
  declare v_emp uuid; v_id uuid := gen_random_uuid();
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    update public.leave_policies set entitled_days=1 where team='w1' and year=2026 and type='سنوية';
  end $$;
  -- (أ) viewer: أي محاولة تعيين تجاوز على طلبه تُطهَّر — والاعتماد ليس من حقه أصلاً
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='e2424@shift.local'),'role','authenticated',
      'app_metadata',json_build_object('role','viewer','team','w1'))::text, true);
  do $$
  declare v_emp uuid; ovr boolean;
  begin
    select ea.emp_id into v_emp from public.employee_auth ea join auth.users u on u.id=ea.user_id where u.email='e2424@shift.local';
    insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team,balance_override,balance_override_reason)
      values (gen_random_uuid(),v_emp,'سنوية','2026-08-01','2026-08-01','قيد الانتظار','__LB_T13__','w1',true,'أحاول التلاعب');
    select balance_override into ovr from public.leaves where notes='__LB_T13__';
    if ovr then raise exception 'T13 FAIL: الموظف عيّن balance_override'; end if;
    raise notice 'T13a OK: تجاوز الموظف طُهِّر (=false)';
  end $$;
  reset role;
  -- (ب) admin: اعتماد متجاوز بلا سبب مرفوض؛ ومع سبب تُختم by/at من الخادم
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),'role','authenticated',
      'app_metadata',json_build_object('role','admin','team','w1'))::text, true);
  do $$
  declare v_emp uuid; blocked boolean := false; v_by uuid; v_at timestamptz;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    begin
      insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team,balance_override,balance_override_reason)
        values (gen_random_uuid(),v_emp,'سنوية','2026-08-10','2026-08-14','معتمد','__LB_T13b__','w1',true,'   ');
      raise exception 'T13 FAIL: قُبل تجاوز بسبب فارغ';
    exception when others then if sqlerrm like '%سبب التجاوز مطلوب%' then blocked:=true; else raise; end if; end;
    if not blocked then raise exception 'T13 FAIL'; end if;
    insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team,balance_override,balance_override_reason)
      values (gen_random_uuid(),v_emp,'سنوية','2026-08-10','2026-08-14','معتمد','__LB_T13b__','w1',true,'ظرف طارئ');
    select balance_override_by, balance_override_at into v_by, v_at from public.leaves where notes='__LB_T13b__';
    if v_by is null or v_at is null then raise exception 'T13 FAIL: by/at لم تُختم من الخادم'; end if;
    raise notice 'T13b OK: سبب فارغ مرفوض؛ by/at مختومان من الخادم';
  end $$;
  reset role;
rollback;

-- ============ T14: قيود leave_ledger (days<>0، source_year، initial فريد) ============
begin;
  do $$
  declare v_emp uuid; e1 boolean:=false; e2 boolean:=false; e3 boolean:=false; e4 boolean:=false;
  begin
    select id into v_emp from public.employees where team='w1' order by sort_order limit 1;
    begin insert into public.leave_ledger(emp_id,year,type,kind,days,reason) values(v_emp,2026,'سنوية','adjustment',0,'صفر'); exception when check_violation then e1:=true; end;
    begin insert into public.leave_ledger(emp_id,year,type,kind,days,source_year,reason) values(v_emp,2026,'سنوية','adjustment',1,2025,'source خاطئ'); exception when check_violation then e2:=true; end;
    begin insert into public.leave_ledger(emp_id,year,type,kind,days,reason) values(v_emp,2027,'سنوية','carryover',1,'بلا source'); exception when check_violation then e3:=true; end;
    insert into public.leave_ledger(emp_id,year,type,kind,days,reason) values(v_emp,2026,'مرضية','initial',3,'أول');
    begin insert into public.leave_ledger(emp_id,year,type,kind,days,reason) values(v_emp,2026,'مرضية','initial',5,'ثانٍ'); exception when unique_violation then e4:=true; end;
    if not (e1 and e2 and e3 and e4) then raise exception 'T14 FAIL: e1=% e2=% e3=% e4=%', e1,e2,e3,e4; end if;
    raise notice 'T14 OK: days<>0، source_year للترحيل فقط، initial فريد';
  end $$;
rollback;

-- ملاحظة: بعد كل الاختبارات (ROLLBACK) يجب أن تعود الأعداد كما كانت: leaves=14،
-- leave_policies = 6×عدد الورديات، leave_ledger=0، audit_log بلا سجلات اختبارية.
