-- =====================================================================
--  إصلاح حسابات Auth الناقصة — Preflight (قراءة فقط، يوقف عند أي شذوذ)
--  المشروع المستهدف حصراً: shift-scheduler (fibkwudabuwfjqpyeeng)
--  الأهداف: الأرقام الوظيفية 392 / 5552 / 2306 فقط.
--  (مراجعة فقط — لا يُطبَّق حتى موافقة منفصلة. لا يُنشئ أو يعدّل شيئاً.)
--
--  يتحقّق أنّ كلّ رقم مستهدف: صف موظف واحد، بلا تكرار، وبلا حساب/هوية Auth
--  مسبقين، وبلا مستخدم آخر يحمل الرقم في الميتاداتا (تطابق غامض).
--  البريد يُبنى من الرقم (e{emp_no}@shift.local) فلا تُكتب عناوين كاملة.
-- =====================================================================
do $$
declare
  v_targets constant text[] := array['392','5552','2306'];
  v_emp_rows   int;
  v_dup        int;
  v_have_auth  int;
  v_have_ident int;
  v_carry      int;
begin
  -- (1) صف موظف واحد لكل رقم (المتوقّع 3 صفوف إجمالاً)
  select count(*) into v_emp_rows
    from public.employees where emp_no = any(v_targets);

  -- (2) تكرار أيّ من الأرقام المستهدفة
  select count(*) into v_dup from (
    select emp_no from public.employees
     where emp_no = any(v_targets) group by emp_no having count(*) > 1
  ) d;

  -- (3) حساب Auth موجود مسبقاً بالبريد المتوقّع
  select count(*) into v_have_auth
    from auth.users
   where email = any (select 'e' || x || '@shift.local' from unnest(v_targets) x);

  -- (4) هوية Auth موجودة مسبقاً بالبريد المتوقّع
  select count(*) into v_have_ident
    from auth.identities
   where identity_data->>'email' = any (select 'e' || x || '@shift.local' from unnest(v_targets) x);

  -- (5) مستخدم آخر يحمل أحد الأرقام في app_metadata أو user_metadata (تطابق غامض)
  select count(*) into v_carry
    from auth.users
   where (raw_app_meta_data ->> 'emp_no')  = any(v_targets)
      or (raw_user_meta_data ->> 'emp_no') = any(v_targets);

  if v_emp_rows <> 3 then raise exception 'PREFLIGHT: صفوف الموظفين المستهدفين = % (المتوقّع 3)', v_emp_rows; end if;
  if v_dup        > 0 then raise exception 'PREFLIGHT: رقم وظيفي مكرر بين المستهدفين = %', v_dup; end if;
  if v_have_auth  > 0 then raise exception 'PREFLIGHT: حساب Auth موجود مسبقاً = % — أوقف، لا تُنشئ', v_have_auth; end if;
  if v_have_ident > 0 then raise exception 'PREFLIGHT: هوية Auth موجودة مسبقاً = %', v_have_ident; end if;
  if v_carry      > 0 then raise exception 'PREFLIGHT: مستخدم آخر يحمل أحد الأرقام = % (تطابق غامض)', v_carry; end if;

  raise notice 'PREFLIGHT OK: 3 موظفين مستهدفين، لا حسابات/هويات/تطابق غامض — جاهز للإصلاح';
end $$;
