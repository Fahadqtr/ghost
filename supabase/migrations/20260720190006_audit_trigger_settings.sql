-- Audit Log — Trigger: settings فقط
begin;
drop trigger if exists trg_audit on public.settings;
create trigger trg_audit
  after insert or update or delete on public.settings
  for each row execute function public.audit_capture();
commit;
