-- =====================================================================
--  Audit Log — اختبارات يدوية (مراجعة فقط، لا تُطبَّق تلقائياً).
--  كل اختبار داخل BEGIN/ROLLBACK فلا يبقى أثر.
--  اختبارات RLS/الصلاحيات تعمل تحت SET LOCAL ROLE authenticated (لا بصلاحية المالك).
--  الدور/الوردية للقراءة يُقرآن من auth.users؛ يكفي ضبط sub. app_metadata مطلوب
--  فقط لتمرير سياسات الكتابة الحالية على leaves/overrides/point_shifts.
--
--  الحسابات المستخدمة (عدّلها لبيئتك):
--    owner : clanqtr@gmail.com | admin(w1): salemm@shift.local | viewer(w1): e392@shift.local
--  قيم اختبارية فريدة لتجنّب التعارض: تواريخ 2099، وسوم __AUDIT_*__.
-- =====================================================================


-- =====================================================================
-- PREFLIGHT — تأكد من وجود الحسابات قبل الاختبار (يفشل بوضوح إن نقصت)
-- =====================================================================
do $$
begin
  if not exists (select 1 from auth.users where email='clanqtr@gmail.com') then raise exception 'PREFLIGHT: حساب owner مفقود'; end if;
  if not exists (select 1 from auth.users where email='salemm@shift.local') then raise exception 'PREFLIGHT: حساب admin(w1) مفقود'; end if;
  if not exists (select 1 from auth.users where email='e392@shift.local')   then raise exception 'PREFLIGHT: حساب viewer مفقود'; end if;
  if not exists (select 1 from public.employees where team='w1')            then raise exception 'PREFLIGHT: لا يوجد موظفون في w1'; end if;
  raise notice 'PREFLIGHT OK';
end $$;


-- =====================================================================
-- T1 — leaves: كل الفروع (INSERT / اعتماد / رفض / تعديل غير الحالة / DELETE)
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),
      'role','authenticated','app_metadata',json_build_object('role','admin','team','w1'))::text, true);

  -- INSERT
  with e as (select id from public.employees where team='w1' order by sort_order limit 1)
  insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team)
  select gen_random_uuid(), e.id,'عارض','2099-01-01','2099-01-01','قيد الانتظار','__AUDIT_T1__ سري','w1' from e;

  -- UPDATE: اعتماد
  update public.leaves set status='معتمد' where notes like '__AUDIT_T1__%' and team='w1';
  -- UPDATE: تعديل غير الحالة (يجب أن يُسجَّل «عدّل طلب إجازة» وأن notes محجوبة)
  update public.leaves set to_date='2099-01-02', notes='__AUDIT_T1__ معدّل' where notes like '__AUDIT_T1__%' and team='w1';
  -- UPDATE: رفض
  update public.leaves set status='مرفوض' where notes like '__AUDIT_T1__%' and team='w1';
  -- DELETE
  delete from public.leaves where notes like '__AUDIT_T1__%' and team='w1';

  select action, summary, actor_name, actor_role, team, changed
  from public.audit_log where entity='leaves' and at > now()-interval '2 minutes' order by id;
  -- المتوقّع بالترتيب:
  --   insert 'أضاف طلب إجازة لـ X'                       changed=null
  --   update 'اعتمد طلب إجازة لـ X'                      changed={status:{old,new}}
  --   update 'عدّل طلب إجازة لـ X'                       changed={to_date:{changed:true}, notes:{changed:true}}
  --   update 'رفض طلب إجازة لـ X'                        changed={status:{old,new}}
  --   delete 'حذف طلب إجازة لـ X'                        changed=null
  --   ملاحظة: actor_name = 'salemm' (بلا بريد كامل)، actor_role='admin'
rollback;


-- =====================================================================
-- T2 — overrides: INSERT / UPDATE / DELETE
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),
      'role','authenticated','app_metadata',json_build_object('role','admin','team','w1'))::text, true);

  with e as (select id from public.employees where team='w1' order by sort_order limit 1)
  insert into public.overrides(emp_id,day,value,team) select e.id,'2099-01-01','صباح','w1' from e;
  update public.overrides set value='عصر'
   where team='w1' and day='2099-01-01'
     and emp_id=(select id from public.employees where team='w1' order by sort_order limit 1);
  delete from public.overrides
   where team='w1' and day='2099-01-01'
     and emp_id=(select id from public.employees where team='w1' order by sort_order limit 1);

  select action, summary, changed from public.audit_log
  where entity='overrides' and at > now()-interval '2 minutes' order by id;
  -- المتوقّع:
  --   insert 'عدّل جدول موظف X ليوم 2099-01-01 إلى صباح'   changed=null
  --   update 'عدّل جدول موظف X ليوم 2099-01-01 إلى عصر'    changed={value:{old:"صباح",new:"عصر"}}
  --   delete 'أزال تعديل جدول X ليوم 2099-01-01'          changed=null
rollback;


-- =====================================================================
-- T3 — point_shifts: INSERT / UPDATE(اعتماد) / DELETE
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),
      'role','authenticated','app_metadata',json_build_object('role','admin','team','w1'))::text, true);

  insert into public.point_shifts(day,shift,point_name,emp_order,approved,team)
  values ('2099-01-02','صباح','النقطة الأمنية','[]'::jsonb,false,'w1');
  update public.point_shifts set approved=true where day='2099-01-02' and shift='صباح' and team='w1';
  delete from public.point_shifts where day='2099-01-02' and shift='صباح' and team='w1';

  select action, summary, changed from public.audit_log
  where entity='point_shifts' and at > now()-interval '2 minutes' order by id;
  -- المتوقّع:
  --   insert 'عدّل توزيع النقطة (صباح 2099-01-02)'   changed=null
  --   update 'اعتمد توزيع النقطة (صباح 2099-01-02)'  changed={approved:{old:false,new:true}}
  --   delete 'حذف توزيع النقطة (صباح 2099-01-02)'    changed=null
rollback;


-- =====================================================================
-- T4 — settings: INSERT / UPDATE / DELETE لوردية اختبارية (بصلاحية owner)
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='clanqtr@gmail.com'),
      'role','authenticated')::text, true);

  insert into public.settings(team,data) values ('wtest_audit','{}'::jsonb);
  update public.settings set data = data || jsonb_build_object('__probe__','v') where team='wtest_audit';
  delete from public.settings where team='wtest_audit';

  select action, summary, changed from public.audit_log
  where entity='settings' and entity_id='wtest_audit' and at > now()-interval '2 minutes' order by id;
  -- المتوقّع:
  --   insert 'أنشأ إعدادات الوردية'                  changed=null
  --   update 'عدّل إعدادات الوردية (__probe__)'      changed=["__probe__"]   (أسماء فقط)
  --   delete 'حذف إعدادات الوردية'                   changed=null
rollback;


-- =====================================================================
-- T5 — عزل القراءة (RLS) — تأكيدات تلقائية
--   تهيئة بالدور الافتراضي (بذر سطرين)، ثم قراءة تحت authenticated.
-- =====================================================================
begin;
  insert into public.audit_log(team,actor_id,actor_name,actor_role,action,entity,entity_id,summary)
  values ('w1',null,'seed','system','update','settings','w1','__seed_w1__'),
         ('w2',null,'seed','system','update','settings','w2','__seed_w2__');

  -- (أ) owner يرى الورديتين
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='clanqtr@gmail.com'),'role','authenticated')::text,true);
  do $$
  declare c1 int; c2 int;
  begin
    select count(*) filter (where team='w1'), count(*) filter (where team='w2')
      into c1,c2 from public.audit_log where summary in ('__seed_w1__','__seed_w2__');
    if c1 < 1 or c2 < 1 then raise exception 'T5 FAIL: owner لا يرى كل الورديات (w1=%,w2=%)',c1,c2; end if;
    raise notice 'T5 owner OK';
  end $$;

  -- (ب) admin(w1) يرى w1 فقط
  reset role; set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),'role','authenticated')::text,true);
  do $$
  declare c1 int; c2 int;
  begin
    select count(*) filter (where team='w1'), count(*) filter (where team='w2')
      into c1,c2 from public.audit_log where summary in ('__seed_w1__','__seed_w2__');
    if c1 < 1 then raise exception 'T5 FAIL: admin(w1) لا يرى w1'; end if;
    if c2 <> 0 then raise exception 'T5 FAIL: admin(w1) يرى w2!'; end if;
    raise notice 'T5 admin(w1) OK';
  end $$;

  -- (ج) viewer لا يرى شيئاً
  reset role; set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='e392@shift.local'),'role','authenticated')::text,true);
  do $$
  declare c int;
  begin
    select count(*) into c from public.audit_log where summary in ('__seed_w1__','__seed_w2__');
    if c <> 0 then raise exception 'T5 FAIL: viewer يرى سجلات! (%)',c; end if;
    raise notice 'T5 viewer OK';
  end $$;

  reset role;
rollback;

-- ملاحظة: حالة «admin بلا وردية» تتطلّب إنشاء حساب بلا team، ويجب ألا يُعدَّل
--         auth.users على الإنتاج. نفّذها في بيئة محلية/Staging فقط:
--         أنشئ مستخدماً raw_app_meta_data='{"role":"admin"}' بلا team، ثم تأكّد
--         أن استعلامه على audit_log يرجع 0 (السياسة ترفض team NULL/الفارغة).


-- =====================================================================
-- T6 — منع الكتابة المباشرة على audit_log (تأكيد تلقائي: يجب أن تفشل الثلاث)
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='clanqtr@gmail.com'),'role','authenticated')::text,true);
  do $$
  begin
    begin
      insert into public.audit_log(action,entity,summary) values ('insert','x','tamper');
      raise exception 'SECURITY FAIL: نجح INSERT المباشر';
    exception when insufficient_privilege then null; end;

    begin
      update public.audit_log set summary='tamper' where true;
      raise exception 'SECURITY FAIL: نجح UPDATE المباشر';
    exception when insufficient_privilege then null; end;

    begin
      delete from public.audit_log where true;
      raise exception 'SECURITY FAIL: نجح DELETE المباشر';
    exception when insufficient_privilege then null; end;

    raise notice 'T6 OK: كل محاولات الكتابة المباشرة مرفوضة';
  end $$;
  reset role;
rollback;


-- =====================================================================
-- T7 — فشل التسجيل لا يُعطّل العملية الأصلية (ويُبرِز WARNING)
-- =====================================================================
begin;
  -- يُفشل أي INSERT في audit_log ⇒ الالتقاط يفشل، ويجب أن يبتلعه الحارس
  alter table public.audit_log add constraint __force_fail check (false) not valid;
  do $$
  declare n int;
  begin
    update public.employees set sort_order = sort_order
     where id = (select id from public.employees order by sort_order limit 1);
    get diagnostics n = row_count;
    if n < 1 then raise exception 'T7 FAIL: تعطّلت العملية الأصلية'; end if;
    raise notice 'T7 OK: العملية الأصلية نجحت رغم فشل التسجيل (راقب WARNING في السجلّات)';
  end $$;
rollback;
