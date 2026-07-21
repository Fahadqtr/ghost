-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 4/8: التحقّق من تجاوز الرصيد عند الاعتماد
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  عند تحويل طلب إلى «معتمد»: إن تجاوز الرصيد المتبقّي (نوع limited برصيد
--  مضبوط)، يجب balance_override=true وسبب غير فارغ وبواسطة owner/admin،
--  وإلا تُرفض العملية. الطلب المعلّق لا يُتحقَّق منه (يُسمح بإرساله).
-- =====================================================================
begin;

create or replace function public.fn_validate_leave_balance()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_exceeds boolean := false;
  y int; v_from_y int; v_to_y int;
  v_mode text; v_entitled int; v_basis text;
  v_available numeric; v_used_others numeric; v_new_days numeric;
begin
  if NEW.status <> 'معتمد' then
    return NEW;   -- لا تحقّق إلا عند الاعتماد
  end if;

  v_from_y := extract(year from NEW.from_date)::int;
  v_to_y   := extract(year from NEW.to_date)::int;

  y := v_from_y;
  while y <= v_to_y loop
    select lp.policy_mode, lp.entitled_days, coalesce(lp.day_count_basis,'calendar')
      into v_mode, v_entitled, v_basis
      from public.leave_policies lp
     where lp.team = NEW.team and lp.year = y and lp.type = NEW.type;

    if v_mode = 'limited' and v_entitled is not null then
      select v_entitled
           + coalesce(sum(days) filter (where kind='initial'),0)
           + coalesce(sum(days) filter (where kind='carryover'),0)
           + coalesce(sum(days) filter (where kind='adjustment'),0)
        into v_available
        from public.leave_ledger
       where emp_id = NEW.emp_id and year = y and type = NEW.type;

      v_used_others := public.fn_leave_used(NEW.emp_id, y, NEW.type, NEW.id);
      v_new_days    := public.fn_leave_days_in_range(NEW.emp_id, NEW.from_date, NEW.to_date, y, v_basis);

      if (v_used_others + v_new_days) > coalesce(v_available,0) then
        v_exceeds := true;
      end if;
    end if;
    y := y + 1;
  end loop;

  if v_exceeds then
    -- يجب تجاوز موثّق بواسطة owner/admin مع سبب غير فارغ
    if not (public.is_owner() or public.audit_current_user_role() = 'admin') then
      raise exception 'تجاوز الرصيد يتطلّب صلاحية owner أو admin';
    end if;
    if not (coalesce(NEW.balance_override,false)
            and coalesce(btrim(NEW.balance_override_reason),'') <> '') then
      raise exception 'يتطلّب موافقة استثنائية: مدة الطلب تتجاوز الرصيد المتبقّي — فعّل التجاوز واكتب السبب';
    end if;
    -- ختم بيانات التجاوز (عند الإدراج أو أول تفعيل أو تغيّر السبب)
    if TG_OP = 'INSERT'
       or coalesce(OLD.balance_override,false) = false
       or NEW.balance_override_reason is distinct from OLD.balance_override_reason then
      NEW.balance_override_by := (select auth.uid());
      NEW.balance_override_at := now();
    end if;
  else
    -- لا تجاوز: لا حاجة لختم شيء (يُترك ما أرسله المستخدم كما هو)
    null;
  end if;

  return NEW;
end $$;

drop trigger if exists trg_balance_validate on public.leaves;
create trigger trg_balance_validate
  before insert or update on public.leaves
  for each row execute function public.fn_validate_leave_balance();

commit;
