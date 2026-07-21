-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 6/8: أرشفة قيود الرصيد عند حذف موظف
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  ترتيب مشغّلات employees الحالي:
--    trg_archive  BEFORE DELETE (SECURITY DEFINER)  ← هنا نضيف أرشفة الـledger
--    trg_audit    AFTER  INSERT/UPDATE/DELETE
--    trg_provision AFTER INSERT · trg_sync AFTER UPDATE
--  بما أنّ الأرشفة BEFORE DELETE وداخل نفس المعاملة: أي فشل في الأرشفة
--  يرفع استثناءً فيُلغى حذف الموظف بالكامل (لا حذف دون أرشفة ناجحة).
--  employee_auth يُحذف تلقائياً عبر ON DELETE CASCADE عند حذف الموظف.
-- =====================================================================
begin;

create or replace function public.shift_archive_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth', 'extensions'
as $function$
begin
  insert into public.archived_employees(id,name,emp_no,cycle_start)
    values(OLD.id, OLD.name, OLD.emp_no, OLD.cycle_start);

  insert into public.archived_leaves(id,emp_id,type,from_date,to_date,status,notes)
    select id, emp_id, type, from_date, to_date, status, notes
      from public.leaves where emp_id = OLD.id;

  -- أرشفة قيود الرصيد ثم حذفها داخل نفس المعاملة (لا FK؛ حذف صريح)
  insert into public.archived_leave_ledger(id,team,emp_id,year,type,kind,days,source_year,reason,created_by,created_at)
    select id, team, emp_id, year, type, kind, days, source_year, reason, created_by, created_at
      from public.leave_ledger where emp_id = OLD.id;
  delete from public.leave_ledger where emp_id = OLD.id;

  delete from auth.users where email = 'e'||OLD.emp_no||'@shift.local';
  return OLD;
end $function$;

commit;
