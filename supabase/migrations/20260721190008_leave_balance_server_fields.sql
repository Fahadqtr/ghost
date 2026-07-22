-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | خوادم الحقول الموثوقة (عدم الثقة بالعميل)
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  مشغّلات BEFORE تفرض القيم من الخادم وتتجاهل ما يرسله العميل:
--    leave_ledger: team (من employees) · created_by (auth.uid) · created_at (now)
--    leave_policies: updated_by (auth.uid) · updated_at (now)
--  تعمل قبل تقييم RLS WITH CHECK، فيتّسق team مع صلاحية الكاتب.
-- =====================================================================
begin;

-- ملاحظة: هذا التعريف مطابق للحماية المطبَّقة في Migration 5 (لا يُضعِفها):
--   يرفض الموظف غير الموجود ووردية فارغة/مسافات، بلا كشف UUID في الرسالة.
create or replace function public.fn_leave_ledger_server_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team text;
begin
  select e.team
    into v_team
    from public.employees e
   where e.id = NEW.emp_id;

  if v_team is null or btrim(v_team) = '' then
    raise exception 'leave_ledger: الموظف غير موجود أو ورديته غير صالحة';
  end if;

  NEW.team       := v_team;                 -- من employees لا من العميل
  NEW.created_by := (select auth.uid());    -- من الجلسة لا من العميل
  NEW.created_at := now();                   -- من الخادم لا من العميل

  return NEW;
end $$;

drop trigger if exists trg_ledger_server on public.leave_ledger;
create trigger trg_ledger_server
  before insert on public.leave_ledger
  for each row execute function public.fn_leave_ledger_server_fields();

create or replace function public.fn_leave_policies_server_fields()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  NEW.updated_by := (select auth.uid());    -- من الجلسة لا من العميل
  NEW.updated_at := now();                    -- من الخادم لا من العميل
  return NEW;
end $$;

drop trigger if exists trg_policies_server on public.leave_policies;
create trigger trg_policies_server
  before insert or update on public.leave_policies
  for each row execute function public.fn_leave_policies_server_fields();

revoke all on function public.fn_leave_ledger_server_fields()   from public, anon, authenticated;
revoke all on function public.fn_leave_policies_server_fields()  from public, anon, authenticated;

commit;
