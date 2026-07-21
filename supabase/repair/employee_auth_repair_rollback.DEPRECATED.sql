-- =====================================================================
--  DEPRECATED — غير قابل للتطبيق. لا تُشغّل هذا الملف.
--  الحذف اليدوي المباشر من auth.users و auth.identities ممنوع.
--  استُبدل بسكربت خادميّ يستخدم Supabase Auth Admin API:
--      scripts/rollback-missing-auth-users.mjs  (deleteUser بشروط صارمة)
--
--  حارس: أي تشغيل لهذا الملف يفشل فوراً قبل تنفيذ أي شيء.
-- =====================================================================
do $$
begin
  raise exception 'DEPRECATED: ممنوع الحذف المباشر من auth.users — استخدم scripts/rollback-missing-auth-users.mjs (Admin API).';
end $$;
