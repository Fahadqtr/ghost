-- =====================================================================
--  DEPRECATED — غير قابل للتطبيق. لا تُشغّل هذا الملف.
--  الإدراج/الحذف اليدوي المباشر في auth.users و auth.identities ممنوع.
--  استُبدل بسكربت خادميّ يستخدم Supabase Auth Admin API:
--      scripts/repair-missing-auth-users.mjs   (الإنشاء + الفحص + التحقّق)
--      scripts/rollback-missing-auth-users.mjs  (الحذف الآمن)
--  الفحص القرائي فقط باقٍ في: employee_auth_repair_preflight.sql
--
--  حارس: أي تشغيل لهذا الملف يفشل فوراً قبل تنفيذ أي شيء.
-- =====================================================================
do $$
begin
  raise exception 'DEPRECATED: ممنوع الإدراج المباشر في auth.users — استخدم scripts/repair-missing-auth-users.mjs (Admin API).';
end $$;
