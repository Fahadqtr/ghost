-- =====================================================================
--  Audit Log — Migration 3/3 : Triggers على بقية الجداول
--  طبّقه بعد نجاح اختبار leaves (Migration 2).
-- =====================================================================
begin;

drop trigger if exists trg_audit on public.employees;
create trigger trg_audit
  after insert or update or delete on public.employees
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.overrides;
create trigger trg_audit
  after insert or update or delete on public.overrides
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.point_shifts;
create trigger trg_audit
  after insert or update or delete on public.point_shifts
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.settings;
create trigger trg_audit
  after insert or update or delete on public.settings
  for each row execute function public.audit_capture();

commit;
