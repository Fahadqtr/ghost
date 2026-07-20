-- =====================================================================
--  Audit Log — Rollback (تراجُع كامل)
--  ملف مراجعة فقط — لا يُشغَّل تلقائياً. يُلغي كل ما أنشأته الـMigrations 1..3
--  بالترتيب الآمن: المشغّلات ← السياسة ← الدوال ← الجدول.
-- =====================================================================
begin;

-- 1) حذف كل مشغّلات التدقيق
drop trigger if exists trg_audit on public.leaves;
drop trigger if exists trg_audit on public.employees;
drop trigger if exists trg_audit on public.overrides;
drop trigger if exists trg_audit on public.point_shifts;
drop trigger if exists trg_audit on public.settings;

-- 2) حذف سياسة RLS
drop policy if exists read_audit on public.audit_log;

-- 3) حذف دالة الالتقاط
drop function if exists public.audit_capture();

-- 4) حذف دالتي الدور/الوردية
drop function if exists public.audit_current_user_role();
drop function if exists public.audit_current_user_team();

-- 5) حذف الجدول (مع فهارسه)
drop table if exists public.audit_log;

commit;
