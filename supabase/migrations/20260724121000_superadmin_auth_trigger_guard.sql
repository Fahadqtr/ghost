-- =====================================================================
--  حارس Auth فقط — مُشغّل يمنع ترك النظام بلا مدير نظام فعّال (مفصول)
--
--  يعتمد على 20260724120000 (يستخدم public._sa_lock_superadmin_guard()).
--  مفصول عمدًا: إن سبّب المُشغّل مشكلة في GoTrue يمكن إسقاطه وحده
--  (drop_auth_trigger_guard) دون إزالة فحوص نشاط الحساب — فلا تعود ثغرة
--  التوكن القديم.
--
--  لا RPCs، لا سياسات RLS، لا Grants للعميل، لا تعديل بيانات.
--  الدالة داخلية بحتة (محرومة من anon/PUBLIC/authenticated). SECURITY DEFINER
--  + search_path=''. لا تُعيد email/token/metadata كاملة.
--
--  يعمل فقط عند تغيّر banned_until أو الدور أو عند الحذف؛ غير ذلك مسار سريع
--  بلا أثر — لا يعيق تسجيل الدخول أو last_sign_in_at أو التوكنات أو استعادة
--  كلمة المرور. يحصل على قفل تسلسلي قبل العدّ، فيرفض ذرّيًا فقط ما يترك صفر
--  مدير نظام فعّال (بما فيه كتابات Supabase Admin API على auth.users).
-- =====================================================================
begin;

create or replace function public._sa_guard_no_orphan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_was_active_sa boolean; v_now_active_sa boolean;
begin
  if TG_OP = 'DELETE' then
    v_was_active_sa := (OLD.raw_app_meta_data->>'role' = 'superadmin')
                       and (OLD.banned_until is null or OLD.banned_until <= now());
    if v_was_active_sa then
      perform public._sa_lock_superadmin_guard();
      if (select count(*) from auth.users
            where raw_app_meta_data->>'role' = 'superadmin' and id <> OLD.id
              and (banned_until is null or banned_until <= now())) = 0 then
        raise exception 'لا يمكن ترك النظام بلا مدير نظام فعّال' using errcode = '42501';
      end if;
    end if;
    return OLD;
  end if;
  -- UPDATE: تصرّف فقط عند تغيّر banned_until أو الدور
  if OLD.banned_until is distinct from NEW.banned_until
     or (OLD.raw_app_meta_data->>'role') is distinct from (NEW.raw_app_meta_data->>'role') then
    v_was_active_sa := (OLD.raw_app_meta_data->>'role' = 'superadmin')
                       and (OLD.banned_until is null or OLD.banned_until <= now());
    v_now_active_sa := (NEW.raw_app_meta_data->>'role' = 'superadmin')
                       and (NEW.banned_until is null or NEW.banned_until <= now());
    if v_was_active_sa and not v_now_active_sa then
      perform public._sa_lock_superadmin_guard();
      if (select count(*) from auth.users
            where raw_app_meta_data->>'role' = 'superadmin' and id <> NEW.id
              and (banned_until is null or banned_until <= now())) = 0 then
        raise exception 'لا يمكن ترك النظام بلا مدير نظام فعّال' using errcode = '42501';
      end if;
    end if;
  end if;
  return NEW;
end $$;
revoke all on function public._sa_guard_no_orphan() from public, anon, authenticated;

drop trigger if exists sa_guard_no_orphan on auth.users;
create trigger sa_guard_no_orphan
  before update or delete on auth.users
  for each row execute function public._sa_guard_no_orphan();

commit;
