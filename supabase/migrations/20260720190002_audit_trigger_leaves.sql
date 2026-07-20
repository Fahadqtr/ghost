-- =====================================================================
--  Audit Log — Migration 2/3 : Trigger على جدول leaves فقط
--  طبّقه بعد Migration 1، ثم شغّل الاختبارات للتأكد قبل Migration 3.
-- =====================================================================
begin;

drop trigger if exists trg_audit on public.leaves;
create trigger trg_audit
  after insert or update or delete on public.leaves
  for each row execute function public.audit_capture();

commit;
