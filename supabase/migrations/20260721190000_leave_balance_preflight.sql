-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 0/8: Preflight (قراءة فقط — يوقف التطبيق)
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  يتحقّق قبل إنشاء أي ربط أن مصدر البيانات نظيف ويصلح لربط 1:1 بين
--  الموظف وحساب Auth عبر بريد التزويد e{emp_no}@shift.local.
--  يرفع استثناءً (فيوقف الـmigration) عند أي شذوذ — ولا يُنشئ أي ربط تخميني.
-- =====================================================================
do $$
declare
  n_emp int; n_linkable int; n_missing int;
  n_dup_empno int; n_ambig int; n_multi_user int;
begin
  -- موظفون لهم رقم وظيفي (المؤهّلون للربط)
  select count(*) into n_emp
    from public.employees where coalesce(emp_no,'') <> '';

  -- (1) رقم وظيفي مكرر ⇒ بريد تزويد متطابق (ربط ملتبس)
  select count(*) into n_dup_empno from (
    select emp_no from public.employees
     where coalesce(emp_no,'') <> '' group by emp_no having count(*) > 1
  ) d;

  -- (2) حساب Auth واحد يطابق أكثر من موظف (user_id مكرر لو رُبط)
  select count(*) into n_ambig from (
    select u.id
      from public.employees e
      join auth.users u on u.email = 'e' || e.emp_no || '@shift.local'
     where coalesce(e.emp_no,'') <> ''
     group by u.id having count(*) > 1
  ) a;

  -- (3) رقم وظيفي واحد يطابق أكثر من حساب Auth (نظرياً مستحيل ببريد فريد)
  select count(*) into n_multi_user from (
    select e.emp_no
      from public.employees e
      join auth.users u on u.email = 'e' || e.emp_no || '@shift.local'
     where coalesce(e.emp_no,'') <> ''
     group by e.emp_no having count(distinct u.id) > 1
  ) m;

  -- موظفون لهم حساب Auth مطابق فعلاً
  select count(*) into n_linkable
    from public.employees e
   where coalesce(e.emp_no,'') <> ''
     and exists (select 1 from auth.users u where u.email = 'e' || e.emp_no || '@shift.local');
  n_missing := n_emp - n_linkable;

  if n_dup_empno > 0 then raise exception 'PREFLIGHT: أرقام وظيفية مكررة = % (بريد تزويد متطابق) — أصلح قبل الربط', n_dup_empno; end if;
  if n_ambig      > 0 then raise exception 'PREFLIGHT: حساب Auth يطابق أكثر من موظف = % — ربط ملتبس', n_ambig; end if;
  if n_multi_user > 0 then raise exception 'PREFLIGHT: رقم وظيفي يطابق أكثر من حساب = %', n_multi_user; end if;
  if n_missing    > 0 then raise exception 'PREFLIGHT: موظفون بلا حساب Auth = % (متوقّع %=%) — لا ربط تخميني؛ يلزم قرارك', n_missing, n_emp, n_linkable; end if;

  raise notice 'PREFLIGHT OK: employees(emp_no)=%، روابط متوقعة=% (1:1)', n_emp, n_linkable;
end $$;
