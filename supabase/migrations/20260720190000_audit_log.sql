-- =====================================================================
--  سجل التعديلات (Audit Log) — الإصدار الثاني، المرحلة ١  [نسخة مُراجَعة]
--  ملف مراجعة فقط — لا يُطبَّق تلقائياً.
--  كامل المعاملة داخل BEGIN/COMMIT (ذرّي). طبّقه يدوياً بعد المراجعة.
--
--  ملاحظات التصميم:
--   • كل المشغّلات AFTER ROW ⇒ الدالة تُعيد NULL دائماً (نجاحاً وفشلاً).
--   • لا يُقرأ NEW في DELETE ولا OLD في INSERT: تُحوَّل الصفوف إلى JSONB حسب TG_OP.
--   • الدور/الوردية للقراءة يُقرآن من قاعدة البيانات (auth.users) لا من الرمز (JWT).
--   • search_path فارغ + تأهيل كامل لأسماء الـschema في كل دوال SECURITY DEFINER.
--   • changed لا يحفظ محتوى الحقول الحساسة (ملاحظات/شعار/أسرار) — الاسم فقط.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) الجدول والفهارس
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  team        text,
  actor_id    uuid,
  actor_name  text,
  actor_role  text,
  action      text not null check (action in ('insert','update','delete')),
  entity      text not null,
  entity_id   text,
  summary     text,
  changed     jsonb
);

create index if not exists audit_log_team_id_idx  on public.audit_log (team, id desc);
create index if not exists audit_log_id_idx       on public.audit_log (id desc);
create index if not exists audit_log_entity_idx   on public.audit_log (entity, id desc);
create index if not exists audit_log_actor_idx    on public.audit_log (actor_id, id desc);
create index if not exists audit_log_at_idx       on public.audit_log (at);

-- ---------------------------------------------------------------------
-- 2) دوال قراءة الدور/الوردية من قاعدة البيانات (مناعة ضد قِدَم الرمز)
--    SECURITY DEFINER + search_path فارغ + تأهيل كامل.
-- ---------------------------------------------------------------------
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.raw_app_meta_data->>'role'
  from auth.users u
  where u.id = auth.uid()
$$;
revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to authenticated;

create or replace function public.current_user_team()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.raw_app_meta_data->>'team'
  from auth.users u
  where u.id = auth.uid()
$$;
revoke all on function public.current_user_team() from public;
grant execute on function public.current_user_team() to authenticated;

-- ---------------------------------------------------------------------
-- 3) RLS + سياسة القراءة فقط (بلا قيمة افتراضية w1)
--    • owner: كل الورديات.
--    • admin: بشرط أن تكون وردية حسابه غير فارغة وتطابق وردية السجل تماماً.
--    • viewer / غير ذلك: لا شيء.
-- ---------------------------------------------------------------------
alter table public.audit_log enable row level security;

drop policy if exists read_audit on public.audit_log;
create policy read_audit on public.audit_log for select to authenticated
using (
  public.current_user_role() = 'owner'
  or (
    public.current_user_role() = 'admin'
    and public.current_user_team() is not null
    and public.current_user_team() <> ''
    and audit_log.team = public.current_user_team()
  )
);

-- لا سياسة INSERT/UPDATE/DELETE ⇒ ممنوعة على كل مستخدمي الواجهة.
-- تعزيز صريح على مستوى الصلاحيات:
grant  select on public.audit_log to authenticated;
revoke insert, update, delete on public.audit_log from authenticated;
revoke all on public.audit_log from anon;

-- ---------------------------------------------------------------------
-- 4) دالة الالتقاط
-- ---------------------------------------------------------------------
create or replace function public.audit_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor   uuid;
  v_role    text;
  v_name    text;
  v_team    text;
  v_action  text := lower(tg_op);
  v_entity  text := tg_table_name;
  v_id      text;
  v_summary text;
  v_changed jsonb;
  v_new     jsonb;
  v_old     jsonb;
  v_row     jsonb;
  v_emp_id  uuid;
  v_emp     text;
  v_nd      jsonb;   -- settings: data الجديدة
  v_od      jsonb;   -- settings: data القديمة
  v_sens    text[] := array['notes','logo','logoW','logoH','password','secret',
                            'token','api_key','encrypted_password'];
begin
  -- لا نسجّل سجل التعديلات داخل نفسه
  if v_entity = 'audit_log' then
    return null;
  end if;

  -- تحويل الصفوف إلى JSONB حسب نوع العملية فقط (لا NEW في DELETE ولا OLD في INSERT)
  if tg_op in ('INSERT','UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op in ('UPDATE','DELETE') then v_old := to_jsonb(old); end if;
  v_row := coalesce(v_new, v_old);   -- coalesce على JSONB (آمن، ليس على RECORD)

  -- الفاعل ودوره واسمه من الجلسة/قاعدة البيانات (لا من الواجهة)
  v_actor := auth.uid();
  if v_actor is not null then
    select coalesce(u.raw_app_meta_data->>'role', 'unknown'),
           coalesce(u.raw_user_meta_data->>'full_name',
                    u.raw_user_meta_data->>'username',
                    split_part(u.email, '@', 1))
      into v_role, v_name
      from auth.users u
     where u.id = v_actor;
  end if;
  if v_actor is null then
    v_role := 'system';
    v_name := 'system';
  end if;
  v_role := coalesce(v_role, 'unknown');
  v_name := coalesce(v_name, 'unknown');

  -- الوردية من صف البيانات نفسه، محدّدة حسب TG_OP صراحةً
  v_team := case when tg_op = 'DELETE' then (v_old->>'team') else (v_new->>'team') end;

  -- ---------------- employees ----------------
  if v_entity = 'employees' then
    v_id := v_row->>'id';
    v_summary := case tg_op
                   when 'INSERT' then 'أضاف موظفاً: '
                   when 'DELETE' then 'حذف موظفاً: '
                   else 'عدّل بيانات موظف: '
                 end || coalesce(v_row->>'name', '');

  -- ---------------- leaves ----------------
  elsif v_entity = 'leaves' then
    v_emp_id := (case when tg_op = 'DELETE' then (v_old->>'emp_id') else (v_new->>'emp_id') end)::uuid;
    v_emp := coalesce((select e.name from public.employees e where e.id = v_emp_id), '—');
    v_id := v_row->>'id';
    if tg_op = 'INSERT' then
      v_summary := 'أضاف طلب إجازة (' || coalesce(v_new->>'type', '') || ') لـ ' || v_emp;
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف طلب إجازة لـ ' || v_emp;
    else
      if (v_new->>'status') is distinct from (v_old->>'status') then
        if    (v_new->>'status') = 'معتمد' then v_summary := 'اعتمد طلب إجازة لـ ' || v_emp;
        elsif (v_new->>'status') = 'مرفوض' then v_summary := 'رفض طلب إجازة لـ ' || v_emp;
        else  v_summary := 'غيّر حالة طلب إجازة لـ ' || v_emp || ' إلى ' || coalesce(v_new->>'status', '');
        end if;
      else
        v_summary := 'عدّل طلب إجازة لـ ' || v_emp;
      end if;
    end if;

  -- ---------------- overrides ----------------
  elsif v_entity = 'overrides' then
    v_emp_id := (case when tg_op = 'DELETE' then (v_old->>'emp_id') else (v_new->>'emp_id') end)::uuid;
    v_emp := coalesce((select e.name from public.employees e where e.id = v_emp_id), '—');
    v_id := (v_row->>'emp_id') || '|' || (v_row->>'day');
    if tg_op = 'DELETE' then
      v_summary := 'أزال تعديل جدول ' || v_emp || ' ليوم ' || (v_old->>'day');
    else
      v_summary := 'عدّل جدول موظف ' || v_emp || ' ليوم ' || (v_new->>'day')
                   || ' إلى ' || coalesce(v_new->>'value', '—');
    end if;

  -- ---------------- point_shifts ----------------
  elsif v_entity = 'point_shifts' then
    v_id := (v_row->>'day') || '|' || (v_row->>'shift');
    if tg_op = 'INSERT' then
      v_summary := case when coalesce((v_new->>'approved')::boolean, false)
                        then 'اعتمد توزيع النقطة (' else 'عدّل توزيع النقطة (' end
                   || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
    elsif tg_op = 'DELETE' then
      v_summary := 'حذف توزيع النقطة (' || (v_old->>'shift') || ' ' || (v_old->>'day') || ')';
    else
      if coalesce((v_new->>'approved')::boolean, false)
         and not coalesce((v_old->>'approved')::boolean, false) then
        v_summary := 'اعتمد توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      elsif not coalesce((v_new->>'approved')::boolean, false)
            and coalesce((v_old->>'approved')::boolean, false) then
        v_summary := 'ألغى اعتماد توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      else
        v_summary := 'عدّل توزيع النقطة (' || (v_new->>'shift') || ' ' || (v_new->>'day') || ')';
      end if;
    end if;

  -- ---------------- settings ----------------
  elsif v_entity = 'settings' then
    v_id := case when tg_op = 'DELETE' then (v_old->>'team') else (v_new->>'team') end;
    if tg_op = 'UPDATE' then
      v_nd := coalesce(v_new->'data', '{}'::jsonb);
      v_od := coalesce(v_old->'data', '{}'::jsonb);
      -- أسماء الحقول المتغيّرة فقط (بلا محتوى)، مع استبعاد الشعار
      v_changed := (
        select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
        from (
          select k from jsonb_object_keys(v_nd) as k
          union
          select k from jsonb_object_keys(v_od) as k
        ) kk
        where k not in ('logo','logoW','logoH')
          and (v_od->k) is distinct from (v_nd->k)
      );
      if (v_od->'logo') is distinct from (v_nd->'logo') then
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
    v_id := null;
    v_summary := v_action || ' ' || v_entity;
  end if;

  -- تغيّر مختصر للتعديلات (غير settings): قائمة الحقول المتغيّرة،
  -- مع حجب محتوى الحقول الحساسة (الاسم فقط). INSERT/DELETE بلا changed.
  if v_changed is null and tg_op = 'UPDATE' and v_entity <> 'settings' then
    select jsonb_object_agg(
             kk.k,
             case when kk.k = any(v_sens)
                  then jsonb_build_object('changed', true)   -- الاسم فقط، بلا محتوى
                  else jsonb_build_object('old', v_old->kk.k, 'new', v_new->kk.k)
             end)
      into v_changed
      from (
        select k from jsonb_object_keys(v_new) as k
        union
        select k from jsonb_object_keys(v_old) as k
      ) kk
     where (v_old->kk.k) is distinct from (v_new->kk.k)
       and kk.k <> 'updated_at';
  end if;

  insert into public.audit_log
    (team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  values
    (v_team, v_actor, v_name, v_role, v_action, v_entity, v_id, v_summary, v_changed);

  return null;   -- AFTER ROW ⇒ القيمة تُهمَل؛ لا نستخدم coalesce(NEW,OLD)

exception when others then
  return null;   -- فشل التسجيل لا يُعطّل العملية الأصلية أبداً
end $$;

revoke all on function public.audit_capture() from public;

-- ---------------------------------------------------------------------
-- 5) المشغّلات على الجداول الخمسة (AFTER ROW)
-- ---------------------------------------------------------------------
drop trigger if exists trg_audit on public.leaves;
create trigger trg_audit after insert or update or delete on public.leaves
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.employees;
create trigger trg_audit after insert or update or delete on public.employees
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.overrides;
create trigger trg_audit after insert or update or delete on public.overrides
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.point_shifts;
create trigger trg_audit after insert or update or delete on public.point_shifts
  for each row execute function public.audit_capture();

drop trigger if exists trg_audit on public.settings;
create trigger trg_audit after insert or update or delete on public.settings
  for each row execute function public.audit_capture();

commit;
