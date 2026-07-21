-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 4/8: حماية التجاوز + قفل الاعتماد + التحقّق
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  BEFORE INSERT/UPDATE على leaves:
--   (أ) حماية حقول التجاوز: غير owner/admin لا يستطيع تعيينها إطلاقاً؛
--       owner/admin يضبط السبب فقط، وby/at من الخادم؛ التجاوز بلا سبب مرفوض.
--   (ب) قفل معاملي تصاعدي لكل (emp_id|type|year) قبل فحص الرصيد ⇒ تسلسل
--       الاعتمادات المتزامنة (آمن ضد deadlock بترتيب السنوات تصاعدياً).
--   (ج) إعادة حساب الرصيد بعد القفل، وإعادة التحقّق عند أي تعديل يجعل الحالة
--       «معتمد» (يشمل تغيّر emp_id/type/from_date/to_date/team/status).
-- =====================================================================
begin;

create or replace function public.fn_validate_leave_balance()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_is_admin boolean;
  v_exceeds  boolean := false;
  y int; v_from_y int; v_to_y int;
  v_mode text; v_entitled int; v_basis text;
  v_available numeric; v_used_others numeric; v_new_days numeric;
begin
  v_is_admin := public.is_owner() or public.audit_current_user_role() = 'admin';

  -- (أ) حماية حقول تجاوز الرصيد -----------------------------------------
  if not v_is_admin then
    -- الموظف (viewer) لا يملك حق تعيين أي حقل تجاوز — تُطهَّر دائماً
    NEW.balance_override := false;
    NEW.balance_override_reason := null;
    NEW.balance_override_by := null;
    NEW.balance_override_at := null;
  else
    if coalesce(NEW.balance_override, false) then
      if coalesce(btrim(NEW.balance_override_reason), '') = '' then
        raise exception 'سبب التجاوز مطلوب';
      end if;
      NEW.balance_override_by := (select auth.uid());   -- من الخادم لا من العميل
      NEW.balance_override_at := now();                  -- من الخادم لا من العميل
    else
      NEW.balance_override_reason := null;
      NEW.balance_override_by := null;
      NEW.balance_override_at := null;
    end if;
  end if;

  if NEW.status <> 'معتمد' then
    return NEW;   -- لا فحص رصيد إلا عند الاعتماد
  end if;

  v_from_y := extract(year from NEW.from_date)::int;
  v_to_y   := extract(year from NEW.to_date)::int;

  -- (ب) أقفال معاملية تصاعدية لكل سنة متأثرة (تسلسل الاعتمادات المتزامنة)
  y := v_from_y;
  while y <= v_to_y loop
    perform pg_advisory_xact_lock(
      hashtextextended(NEW.emp_id::text || '|' || NEW.type || '|' || y::text, 0));
    y := y + 1;
  end loop;

  -- (ج) إعادة حساب الرصيد بعد القفل ثم التحقّق --------------------------
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
    if not v_is_admin then
      raise exception 'تجاوز الرصيد يتطلّب صلاحية owner أو admin';
    end if;
    if not (coalesce(NEW.balance_override,false)
            and coalesce(btrim(NEW.balance_override_reason),'') <> '') then
      raise exception 'يتطلّب موافقة استثنائية: مدة الطلب تتجاوز الرصيد المتبقّي — فعّل التجاوز واكتب السبب';
    end if;
  end if;

  return NEW;
end $$;

drop trigger if exists trg_balance_validate on public.leaves;
create trigger trg_balance_validate
  before insert or update on public.leaves
  for each row execute function public.fn_validate_leave_balance();

commit;
