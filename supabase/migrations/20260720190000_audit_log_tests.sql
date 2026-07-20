-- =====================================================================
--  اختبارات يدوية لسجل التعديلات — للتحقق فقط، لا تُطبَّق تلقائياً.
--  كل اختبار داخل معاملة تُلغى (ROLLBACK) فلا يبقى أثر.
--
--  مبدأ مهم: اختبارات RLS تعمل تحت  SET LOCAL ROLE authenticated  + مطالبات JWT،
--  ولا تعتمد على صلاحية مالك القاعدة (الذي يتجاوز RLS). تهيئة البيانات فقط
--  تُنفَّذ بالدور الافتراضي قبل تبديل الدور.
--
--  الدور/الوردية للقراءة يُقرآن من auth.users (لا من الرمز)، لذا يكفي في مطالبات
--  الاختبار ضبط sub (وrole=authenticated). حقل app_metadata مطلوب فقط لتمرير
--  سياسات الكتابة الحالية على leaves/overrides/settings.
--
--  استبدل عناوين البريد أدناه بحسابات حقيقية في مشروعك:
--    • مشرف w1 : salemm@shift.local
--    • رئيس القسم: clanqtr@gmail.com
--    • موظف w1 : e392@shift.local
-- =====================================================================


-- =====================================================================
-- T1 — leaves: INSERT + UPDATE + DELETE تُسجَّل
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id::text from auth.users where email='salemm@shift.local'),
      'role','authenticated',
      'app_metadata', json_build_object('role','admin','team','w1')
    )::text, true);

  -- (1) INSERT
  with e as (select id from public.employees where team='w1' order by sort_order limit 1)
  insert into public.leaves(id, emp_id, type, from_date, to_date, status, notes, team)
  select gen_random_uuid(), e.id, 'عارض', current_date, current_date, 'قيد الانتظار', 'ملاحظة سرية', 'w1' from e;

  -- (2) UPDATE (اعتماد) + تغيير الملاحظة (يجب أن تُحجب في changed)
  update public.leaves set status='معتمد', notes='ملاحظة سرية معدّلة'
   where notes like 'ملاحظة سرية%' and team='w1';

  -- (3) DELETE
  delete from public.leaves where notes like 'ملاحظة سرية%' and team='w1';

  -- التحقّق: ٣ سطور، والأدوار/الأسماء صحيحة، وأن changed لا يحوي محتوى الملاحظة
  select action, entity, summary, actor_name, actor_role, team, changed
  from public.audit_log
  where entity='leaves' and at > now() - interval '2 minutes'
  order by id;
  -- المتوقّع:
  --   insert → 'أضاف طلب إجازة (عارض) لـ <الاسم>'      | changed = null
  --   update → 'اعتمد طلب إجازة لـ <الاسم>'            | changed يذكر status، وnotes بصيغة {"changed":true} بلا محتوى
  --   delete → 'حذف طلب إجازة لـ <الاسم>'              | changed = null
rollback;


-- =====================================================================
-- T2 — overrides (INSERT+DELETE) و settings (UPDATE) تُسجَّل
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object(
      'sub', (select id::text from auth.users where email='salemm@shift.local'),
      'role','authenticated',
      'app_metadata', json_build_object('role','admin','team','w1')
    )::text, true);

  -- override: إضافة ثم حذف
  with e as (select id from public.employees where team='w1' order by sort_order limit 1)
  insert into public.overrides(emp_id, day, value, team)
  select e.id, current_date, 'صباح', 'w1' from e;
  delete from public.overrides
   where team='w1' and day=current_date
     and emp_id=(select id from public.employees where team='w1' order by sort_order limit 1);

  -- settings: تعديل حقل غير حساس (يجب أن يُذكر اسم الحقل فقط)
  update public.settings
     set data = data || jsonb_build_object('__audit_probe__', now()::text)
   where team='w1';

  select action, entity, summary, changed
  from public.audit_log
  where entity in ('overrides','settings') and at > now() - interval '2 minutes'
  order by id;
  -- المتوقّع:
  --   overrides insert → 'عدّل جدول موظف <الاسم> ليوم <اليوم> إلى صباح'
  --   overrides delete → 'أزال تعديل جدول <الاسم> ليوم <اليوم>'
  --   settings  update → 'عدّل إعدادات الوردية (__audit_probe__)' | changed = ["__audit_probe__"]
rollback;


-- =====================================================================
-- T3 — عزل القراءة (RLS) تحت دور authenticated
--   تهيئة: نزرع سطرين (w1 و w2) بالدور الافتراضي، ثم نبدّل الدور ونختبر.
-- =====================================================================
begin;
  -- (تهيئة بالدور الافتراضي — ليست اختبار RLS)
  insert into public.audit_log(team, actor_id, actor_name, actor_role, action, entity, entity_id, summary)
  values ('w1', null, 'seed', 'system', 'update', 'settings', 'w1', '__seed_w1__'),
         ('w2', null, 'seed', 'system', 'update', 'settings', 'w2', '__seed_w2__');

  -- حساب مشرف بلا وردية (مؤقّت، يُلغى مع المعاملة)
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
          'authenticated','authenticated','__noteam_admin__@shift.local','x',
          now(), now(), now(),
          '{"role":"admin"}'::jsonb, '{"full_name":"مشرف بلا وردية"}'::jsonb);

  -- (أ) رئيس القسم (owner): يرى الورديتين
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='clanqtr@gmail.com'),
                      'role','authenticated')::text, true);
  select 'owner' as who,
         count(*) filter (where team='w1') as sees_w1,
         count(*) filter (where team='w2') as sees_w2
  from public.audit_log where summary in ('__seed_w1__','__seed_w2__');
  -- المتوقّع: sees_w1 >= 1 و sees_w2 >= 1

  -- (ب) مشرف w1: يرى w1 فقط
  reset role;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='salemm@shift.local'),
                      'role','authenticated')::text, true);
  select 'admin_w1' as who,
         count(*) filter (where team='w1') as sees_w1_expected_ge_1,
         count(*) filter (where team='w2') as sees_w2_expected_0
  from public.audit_log where summary in ('__seed_w1__','__seed_w2__');
  -- المتوقّع: sees_w1 >= 1 و sees_w2 = 0

  -- (ج) مشرف بلا وردية: لا يرى شيئاً
  reset role;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='__noteam_admin__@shift.local'),
                      'role','authenticated')::text, true);
  select 'admin_no_team' as who, count(*) as should_be_0
  from public.audit_log where summary in ('__seed_w1__','__seed_w2__');
  -- المتوقّع: 0

  -- (د) موظف (viewer): لا يرى شيئاً
  reset role;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='e392@shift.local'),
                      'role','authenticated')::text, true);
  select 'viewer' as who, count(*) as should_be_0
  from public.audit_log where summary in ('__seed_w1__','__seed_w2__');
  -- المتوقّع: 0

  reset role;
rollback;


-- =====================================================================
-- T4 — منع الكتابة المباشرة على audit_log من مستخدم الواجهة
--   كل جملة أدناه يجب أن تفشل (RLS / انعدام صلاحية). شغّلها فُرادى.
-- =====================================================================
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    json_build_object('sub',(select id::text from auth.users where email='clanqtr@gmail.com'),
                      'role','authenticated')::text, true);

  -- INSERT مباشر — متوقّع: خطأ صلاحية/سياسة
  -- insert into public.audit_log(action, entity, summary) values ('insert','x','تلاعب');

  -- UPDATE مباشر — متوقّع: خطأ صلاحية
  -- update public.audit_log set summary='تلاعب' where true;

  -- DELETE مباشر — متوقّع: خطأ صلاحية
  -- delete from public.audit_log where true;

  reset role;
rollback;
-- ملاحظة: أزل التعليق عن جملة واحدة في كل تشغيل للتأكد من فشلها،
--         لأن أول خطأ يُنهي المعاملة. المتوقّع رفض الثلاث جميعاً.


-- =====================================================================
-- T5 — فشل التسجيل لا يُعطّل العملية الأصلية
--   دالة audit_capture محاطة بـ EXCEPTION WHEN OTHERS → RETURN NULL،
--   لذا أي خطأ داخل الالتقاط لا يُفشل الـINSERT/UPDATE/DELETE الأصلي.
--   إثبات عملي (اختياري، بالدور الافتراضي): نُفشِل الالتقاط مؤقتاً
--   بجعل audit_log غير قابل للكتابة، ثم نتأكد أن تعديل leaves ينجح.
-- =====================================================================
begin;
  -- منع الإدراج في audit_log عبر قيد تحقّق مستحيل (مؤقّت داخل المعاملة)
  alter table public.audit_log add constraint __force_fail check (false) not valid;
  -- ملاحظة: not valid لا يفحص الصفوف القائمة، لكنه يُفشل أي INSERT جديد ⇒
  --         يجعل الالتقاط يفشل، ويجب أن يبتلعه الحارس دون تعطيل التعديل الأصلي.

  update public.employees set sort_order = sort_order
   where id = (select id from public.employees order by sort_order limit 1);
  -- المتوقّع: نجاح التحديث (صف واحد) رغم فشل التسجيل داخلياً.

  select 'original op survived' as result;
rollback;
