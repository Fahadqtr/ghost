-- =====================================================================
--  إصلاح حسابات Auth الناقصة — Rollback (يحذف فقط ما أنشأه الإصلاح)
--  المشروع المستهدف حصراً: shift-scheduler (fibkwudabuwfjqpyeeng)
--  (مراجعة فقط — لا يُطبَّق حتى موافقة منفصلة.)
--
--  يحذف حصراً الحسابات المسجّلة في public.auth_repair_batch (أي التي أنشأها
--  ملف الإصلاح، والتي أثبت الـPreflight أنّها لم تكن موجودة قبله)، مع حارس
--  إضافي: البريد يطابق نمط e{emp_no}@shift.local والدور viewer. فلا يمسّ أياً
--  من الحسابات الستة القائمة (ليست في الجدول ولا تطابق شرط الإنشاء).
-- =====================================================================
begin;

-- تحقّق أمان: لا تحذف إلا ما هو مسجّل في batch ويطابق شكل ما أنشأه الإصلاح
with to_delete as (
  select u.id
    from auth.users u
    join public.auth_repair_batch b on b.user_id = u.id
   where u.email = 'e' || b.emp_no || '@shift.local'
     and (u.raw_app_meta_data ->> 'role') = 'viewer'
)
delete from auth.identities i using to_delete d where i.user_id = d.id;

with to_delete as (
  select u.id
    from auth.users u
    join public.auth_repair_batch b on b.user_id = u.id
   where u.email = 'e' || b.emp_no || '@shift.local'
     and (u.raw_app_meta_data ->> 'role') = 'viewer'
)
delete from auth.users u using to_delete d where u.id = d.id;

drop table if exists public.auth_repair_batch;

commit;
