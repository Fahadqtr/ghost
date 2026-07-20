-- =====================================================================
--  سجل التعديلات (Audit Log) — الإصدار الثاني، المرحلة ١
--  ملف مراجعة فقط — لا يُطبَّق تلقائياً. طبّقه يدوياً بالخطوات أدناه.
--
--  ترتيب التطبيق الآمن:
--    STEP 1  : الجدول + الفهارس + RLS + الصلاحيات   (لا يغيّر أي سلوك)
--    STEP 2  : دالة الالتقاط audit_capture()
--    STEP 3  : مشغّل على جدول leaves فقط ثم اختبره (ملف الاختبارات المرافق)
--    STEP 4  : بعد التأكد، بقية المشغّلات (employees/overrides/point_shifts/settings)
-- =====================================================================


-- =====================================================================
-- STEP 1 — الجدول والفهارس وRLS والصلاحيات
-- =====================================================================
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  team        text,                               -- الوردية المتأثّرة (من صف البيانات نفسه)
  actor_id    uuid,                               -- معرّف المستخدم المنفّذ (auth.uid)
  actor_name  text,                               -- اسمه (يُستخرج من auth.users وقت التسجيل)
  actor_role  text,                               -- owner / admin / viewer / system
  action      text not null check (action in ('insert','update','delete')),
  entity      text not null,                      -- اسم الجدول
  entity_id   text,                               -- مفتاح الصف
  summary     text,                               -- ملخّص عربي مقروء
  changed     jsonb                               -- تغيّر مختصر (بلا حقول حساسة/كبيرة)
);

create index if not exists audit_log_team_at_idx on public.audit_log (team, id desc);
create index if not exists audit_log_at_idx      on public.audit_log (id desc);
create index if not exists audit_log_entity_idx  on public.audit_log (entity, id desc);
create index if not exists audit_log_actor_idx   on public.audit_log (actor_id, id desc);

alter table public.audit_log enable row level security;

-- القراءة فقط:
--   • رئيس القسم (owner): كل الورديات   (تحقّق من القاعدة عبر is_owner())
--   • مسؤول الوردية (admin): ورديته فقط
--   • الموظف (viewer): لا يرى أي سجل (لا فرع يطابقه)
drop policy if exists read_audit on public.audit_log;
create policy read_audit on public.audit_log for select to authenticated
using (
  public.is_owner()
  or (
    coalesce(((auth.jwt()->'app_metadata')->>'role'),'') = 'admin'
    and team = coalesce(((auth.jwt()->'app_metadata')->>'team'),'w1')
  )
);

-- لا توجد سياسة INSERT/UPDATE/DELETE ⇒ ممنوعة على كل مستخدمي الواجهة.
-- الكتابة تتم حصراً عبر دالة المشغّل (SECURITY DEFINER). تعزيز إضافي:
grant  select on public.audit_log to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
revoke all on public.audit_log from anon;


-- =====================================================================
-- STEP 2 — دالة الالتقاط (SECURITY DEFINER + search_path ثابت)
--   • لا تعتمد على team القادمة من الواجهة (تأخذها من صف البيانات).
--   • تستخرج الفاعل ودوره من المستخدم المسجّل، وبديله 'system'.
--   • حارس EXCEPTION يمنع تعطّل العملية الأصلية إذا فشل التسجيل.
--   • تستبعد الحقول الحساسة/الكبيرة (الشعار)، ولا تسجّل نفسها (لا تكرار).
-- =====================================================================
create or replace function public.audit_capture()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_actor  uuid;
  v_role   text;
  v_name   text;
  v_team   text;
  v_action text := lower(tg_op);
  v_entity text := tg_table_name;
  v_id     text;
  v_summary text;
  v_changed jsonb;
  v_emp    text;
  v_old    jsonb;
  v_new    jsonb;
begin
  -- عدم تسجيل سجل التعديلات داخل نفسه (منع التكرار اللانهائي)
  if v_entity = 'audit_log' then
    return coalesce(new, old);
  end if;

  -- الفاعل: من الجلسة المسجّلة فقط (لا من الواجهة)
  v_actor := auth.uid();
  if v_actor is not null then
    select coalesce((raw_app_meta_data->>'role'), 'admin'),
           coalesce((raw_user_meta_data->>'full_name'),
                    (raw_user_meta_data->>'username'),
                    split_part(email, '@', 1))
      into v_role, v_name
      from auth.users
     where id = v_actor;
  end if;
  if v_actor is null then
    v_role := 'system';
    v_name := 'system';
  end if;
  v_role := coalesce(v_role, 'unknown');
  v_name := coalesce(v_name, 'unknown');

  -- الوردية من صف البيانات نفسه (كل الجداول المُراقَبة تحوي عمود team)
  v_team := case when tg_op = 'DELETE'
                 then (to_jsonb(old) ->> 'team')
                 else (to_jsonb(new) ->> 'team') end;

  -- المفتاح + الملخّص + التغيّر حسب الجدول
  if v_entity = 'employees' then
    if tg_op = 'DELETE' then
      v_id := old.id::text; v_summary := 'حذف موظفاً: ' || coalesce(old.name, '');
    elsif tg_op = 'INSERT' then
      v_id := new.id::text; v_summary := 'أضاف موظفاً: ' || coalesce(new.name, '');
    else
      v_id := new.id::text; v_summary := 'عدّل بيانات موظف: ' || coalesce(new.name, '');
    end if;

  elsif v_entity = 'leaves' then
    v_emp := coalesce((select name from public.employees
                        where id = coalesce(new.emp_id, old.emp_id)), '—');
    if tg_op = 'DELETE' then
      v_id := old.id::text; v_summary := 'حذف طلب إجازة لـ ' || v_emp;
    elsif tg_op = 'INSERT' then
      v_id := new.id::text; v_summary := 'أضاف طلب إجازة (' || coalesce(new.type, '') || ') لـ ' || v_emp;
    else
      v_id := new.id::text;
      if new.status is distinct from old.status then
        if    new.status = 'معتمد'  then v_summary := 'اعتمد طلب إجازة لـ ' || v_emp;
        elsif new.status = 'مرفوض'  then v_summary := 'رفض طلب إجازة لـ ' || v_emp;
        else  v_summary := 'غيّر حالة طلب إجازة لـ ' || v_emp || ' إلى ' || coalesce(new.status, '');
        end if;
      else
        v_summary := 'عدّل طلب إجازة لـ ' || v_emp;
      end if;
    end if;

  elsif v_entity = 'overrides' then
    v_emp := coalesce((select name from public.employees
                        where id = coalesce(new.emp_id, old.emp_id)), '—');
    if tg_op = 'DELETE' then
      v_id := old.emp_id::text || '|' || old.day::text;
      v_summary := 'أزال تعديل جدول ' || v_emp || ' ليوم ' || old.day::text;
    else
      v_id := new.emp_id::text || '|' || new.day::text;
      v_summary := 'عدّل جدول موظف ' || v_emp || ' ليوم ' || new.day::text
                   || ' إلى ' || coalesce(new.value, '—');
    end if;

  elsif v_entity = 'point_shifts' then
    if tg_op = 'DELETE' then
      v_id := old.day::text || '|' || old.shift;
      v_summary := 'حذف توزيع النقطة (' || old.shift || ' ' || old.day::text || ')';
    else
      v_id := new.day::text || '|' || new.shift;
      if coalesce(new.approved, false) and (tg_op = 'INSERT' or not coalesce(old.approved, false)) then
        v_summary := 'اعتمد توزيع النقطة (' || new.shift || ' ' || new.day::text || ')';
      elsif tg_op = 'UPDATE' and coalesce(old.approved, false) and not coalesce(new.approved, false) then
        v_summary := 'ألغى اعتماد توزيع النقطة (' || new.shift || ' ' || new.day::text || ')';
      else
        v_summary := 'عدّل توزيع النقطة (' || new.shift || ' ' || new.day::text || ')';
      end if;
    end if;

  elsif v_entity = 'settings' then
    v_id := coalesce(new.team, old.team);
    if tg_op = 'UPDATE' then
      -- سجّل أسماء الحقول المتغيّرة فقط، دون JSON الكامل ودون الشعار
      v_old := coalesce(old.data, '{}'::jsonb);
      v_new := coalesce(new.data, '{}'::jsonb);
      v_changed := (
        select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
        from (
          select k from jsonb_object_keys(v_new) as k
          union
          select k from jsonb_object_keys(v_old) as k
        ) kk
        where k not in ('logo', 'logoW', 'logoH')          -- استبعاد الشعار والحقول الكبيرة
          and (v_old -> k) is distinct from (v_new -> k)
      );
      -- تغيّر الشعار يُذكر كاسم فقط (بلا محتوى)
      if (v_old -> 'logo') is distinct from (v_new -> 'logo') then
        v_changed := coalesce(v_changed, '[]'::jsonb) || to_jsonb('الشعار'::text);
      end if;
      v_summary := 'عدّل إعدادات الوردية'
        || case when jsonb_array_length(coalesce(v_changed, '[]'::jsonb)) > 0
                then ' (' || array_to_string(
                       array(select jsonb_array_elements_text(v_changed)), '، ') || ')'
                else '' end;
    elsif tg_op = 'INSERT' then
      v_summary := 'أنشأ إعدادات الوردية';
    else
      v_summary := 'حذف إعدادات الوردية';
    end if;

  else
    v_id := null; v_summary := v_action || ' ' || v_entity;
  end if;

  -- تغيّر مختصر عام لغير settings في حالة التعديل (الجداول لا تحوي أسراراً)
  if v_changed is null and tg_op = 'UPDATE' and v_entity <> 'settings' then
    v_new := to_jsonb(new);
    v_old := to_jsonb(old);
    select jsonb_object_agg(kk.k, jsonb_build_object('old', v_old -> kk.k, 'new', v_new -> kk.k))
      into v_changed
      from (
        select k from jsonb_object_keys(v_new) as k
        union
        select k from jsonb_object_keys(v_old) as k
      ) kk
     where (v_old -> kk.k) is distinct from (v_new -> kk.k)
       and kk.k <> 'updated_at';
  end if;

  insert into public.audit_log
    (team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  values
    (v_team, v_actor, v_name, v_role, v_action, v_entity, v_id, v_summary, v_changed);

  return coalesce(new, old);

exception when others then
  -- لا يجوز أن يُفشل التسجيل العملية الأصلية أبداً
  return coalesce(new, old);
end $$;

revoke all on function public.audit_capture() from public;


-- =====================================================================
-- STEP 3 — المشغّل على جدول leaves فقط (ثم شغّل ملف الاختبارات)
-- =====================================================================
drop trigger if exists trg_audit on public.leaves;
create trigger trg_audit
  after insert or update or delete on public.leaves
  for each row execute function public.audit_capture();


-- =====================================================================
-- STEP 4 — بقية المشغّلات (طبّقها بعد نجاح اختبار leaves)
-- =====================================================================
drop trigger if exists trg_audit on public.employees;
create trigger trg_audit
  after insert or update or delete on public.employees
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.overrides;
create trigger trg_audit
  after insert or update or delete on public.overrides
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.point_shifts;
create trigger trg_audit
  after insert or update or delete on public.point_shifts
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.settings;
create trigger trg_audit
  after insert or update or delete on public.settings
  for each row execute function public.audit_capture();
