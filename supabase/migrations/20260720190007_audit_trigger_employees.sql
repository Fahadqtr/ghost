-- Audit Log — Trigger: employees فقط (يُطبّق أخيراً، بعد التحقق من معاملية مشغّلاته الحالية)
begin;
drop trigger if exists trg_audit on public.employees;
create trigger trg_audit
  after insert or update or delete on public.employees
  for each row execute function public.audit_capture();
commit;
