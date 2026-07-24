-- =====================================================================
--  Rollback محدود — للمُشغّل الحارس على auth.users فقط.
--
--  استخدمه فقط إن سبّب المُشغّل مشكلة في GoTrue (أخطاء Auth/HTTP 500 عند
--  تسجيل الدخول أو التجديد أو تحديثات auth.users). يُسقط المُشغّل ودالته فقط.
--
--  لا يحذف — ولا يجوز أن يحذف — أيًّا مما يلي (حتى لا تعود ثغرة التوكن القديم):
--    * public.audit_current_user_is_active()
--    * تحصينات دوال الهوية/النطاق وسياسات RLS
--    * public.audit_current_emp_id() / audit_current_emp_team()
--    * سياسات archived_employees / archived_leaves
--    * RPCs إدارة الحسابات و public._sa_lock_superadmin_guard()
--
--  بعد هذا الـRollback: يبقى منع «آخر مدير نظام» مفروضًا في مسارات RPC عبر
--  القفل التسلسلي، لكن كتابات Admin API المباشرة لن تُحرَس ذرّيًا حتى تُعاد
--  الهجرة 20260724121000. صمّم عملية التعطيل الإدارية وفق ذلك مؤقتًا.
-- =====================================================================
begin;

drop trigger if exists sa_guard_no_orphan on auth.users;
drop function if exists public._sa_guard_no_orphan();

commit;
