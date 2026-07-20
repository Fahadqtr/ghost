-- Audit Log — Trigger: overrides فقط
begin;
drop trigger if exists trg_audit on public.overrides;
create trigger trg_audit
  after insert or update or delete on public.overrides
  for each row execute function public.audit_capture();
commit;
