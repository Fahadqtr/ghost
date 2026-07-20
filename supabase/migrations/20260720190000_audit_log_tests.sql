-- =====================================================================
--  اختبارات يدوية لسجل التعديلات — للتحقق فقط، لا تُطبَّق تلقائياً.
--  كل اختبار داخل معاملة تُلغى (ROLLBACK) فلا يبقى أثر في البيانات.
--  شغّلها بعد تطبيق STEP 1..3 (مشغّل leaves) للتأكد قبل STEP 4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- اختبار leaves: INSERT + UPDATE + DELETE على إجازة تجريبية لأول موظف في w1
-- ---------------------------------------------------------------------
begin;

-- محاكاة مسؤول وردية w1 (استبدل البريد بحساب مشرف حقيقي إن لزم)
select set_config('request.jwt.claims',
  json_build_object(
    'sub', (select id::text from auth.users where email = 'salemm@shift.local'),
    'role', 'authenticated',
    'app_metadata', json_build_object('role', 'admin', 'team', 'w1')
  )::text, true);

-- (1) INSERT — إضافة طلب إجازة
with e as (select id from public.employees where team = 'w1' order by sort_order limit 1)
insert into public.leaves (id, emp_id, type, from_date, to_date, status, notes, team)
select gen_random_uuid(), e.id, 'عارض', current_date, current_date, 'قيد الانتظار', '__AUDIT_TEST__', 'w1'
from e;

-- (2) UPDATE — اعتماد الطلب (يجب أن يُسجَّل «اعتمد طلب إجازة …»)
update public.leaves set status = 'معتمد'
where notes = '__AUDIT_TEST__' and team = 'w1';

-- (3) DELETE — حذف الطلب
delete from public.leaves where notes = '__AUDIT_TEST__' and team = 'w1';

-- التحقّق: ٣ سطور (insert/update/delete) بأسماء وأدوار صحيحة
select action, entity, summary, actor_name, actor_role, team
from public.audit_log
where entity = 'leaves' and at > now() - interval '2 minutes'
order by id;

rollback;   -- إلغاء كل شيء (لا يبقى أي أثر)


-- ---------------------------------------------------------------------
-- اختبار العزل (RLS): مسؤول w2 لا يرى سجلات w1
-- (تشغيل توضيحي — عدّل البريد لحساب مشرف w2 حقيقي)
-- ---------------------------------------------------------------------
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub', (select id::text from auth.users where email='<w2-admin>@shift.local'),
--                       'role','authenticated',
--                       'app_metadata', json_build_object('role','admin','team','w2'))::text, true);
--   -- يجب أن يرجع 0 من سجلات w1، وسجلات w2 فقط:
--   select count(*) filter (where team='w1') as w1_visible_should_be_0,
--          count(*) filter (where team='w2') as w2_visible
--   from public.audit_log;
-- rollback;


-- ---------------------------------------------------------------------
-- اختبار الموظف (viewer): لا يرى أي سجل
-- ---------------------------------------------------------------------
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub', (select id::text from auth.users where email='e392@shift.local'),
--                       'role','authenticated',
--                       'app_metadata', json_build_object('role','viewer','team','w1'))::text, true);
--   select count(*) as should_be_0 from public.audit_log;   -- متوقّع 0
-- rollback;
