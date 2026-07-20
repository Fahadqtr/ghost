-- Audit Log — Trigger: point_shifts فقط
begin;
drop trigger if exists trg_audit on public.point_shifts;
create trigger trg_audit
  after insert or update or delete on public.point_shifts
  for each row execute function public.audit_capture();
commit;
