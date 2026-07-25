-- ============================================================================
-- المرحلة الرابعة: الإشعارات وسير اعتماد الإجازات
-- ملف مستقل — لا يُعدّل أي migration مطبَّق.
--
-- ما يضيفه:
--   1) أعمدة قرار على leaves (submitted_at, decided_*, reject_reason) + تعبئة آمنة.
--   2) جدول notifications (موجّه لمستخدم واحد) + فهارس + RLS + منح مقيّدة.
--   3) جدول leave_decisions (إضافة-فقط) + RLS يمنع الوصول المباشر.
--   4) triggers على leaves: تعبئة التقديم، حارس القرار (هوية/سبب من الخادم)،
--      تسجيل القرار + إشعار الموظف، وإشعار المخوّلين عند التقديم.
--   5) RPCs آمنة: submit/decide + إدارة الإشعارات.
--   6) إضافة notifications إلى نشر Realtime (لا يُطبَّق على الإنتاج الآن).
--
-- ثوابت الحالة: 'قيد الانتظار' (معلّق) / 'معتمد' (مُعتمد) / 'مرفوض' (مرفوض).
-- الأمان: الهوية دائمًا من auth.uid()/employee_auth/employees — لا من العميل.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) أعمدة القرار على leaves
-- ---------------------------------------------------------------------------
alter table public.leaves
  add column if not exists submitted_at  timestamptz,
  add column if not exists decided_at    timestamptz,
  add column if not exists decided_by    uuid,
  add column if not exists decided_role  text,
  add column if not exists reject_reason text;

-- تعبئة سجلّية للصفوف الموجودة دون إطلاق triggers (تفادي تدقيق/تحقّق رصيد زائف).
-- ملاحظة: يُنفَّذ بدور مالك الجدول (postgres) في الـmigration فيُسمح بتعطيل الـtriggers.
do $backfill$
begin
  alter table public.leaves disable trigger trg_balance_validate;
  alter table public.leaves disable trigger trg_audit;

  update public.leaves
     set submitted_at = coalesce(submitted_at, updated_at, now()),
         decided_at   = coalesce(decided_at,
                                 case when status = 'معتمد' then coalesce(updated_at, now()) end);

  alter table public.leaves enable trigger trg_balance_validate;
  alter table public.leaves enable trigger trg_audit;
end
$backfill$;

-- ---------------------------------------------------------------------------
-- 2) جدول الإشعارات
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,                       -- المستلم (auth.users.id)
  type        text not null check (type in (
                'leave_submitted','leave_approved','leave_rejected','leave_cancelled',
                'account_changed','department_changed')),  -- الإجازات فقط تُنفَّذ الآن
  title       text not null,
  body        text not null default '',
  entity_type text not null default 'leave',
  entity_id   uuid,                                -- مرجع غير مقيّد بـ FK (يحفظ التاريخ، بلا CASCADE)
  is_read     boolean not null default false,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  created_by  uuid,                                -- منفّذ الحدث (لا يُعرض للموظف)
  data        jsonb not null default '{}'::jsonb   -- معلومات غير حساسة فقط
);

create index if not exists idx_notifications_user_created
  on public.notifications (user_id, created_at desc);
create index if not exists idx_notifications_user_unread
  on public.notifications (user_id) where is_read = false;

alter table public.notifications enable row level security;

-- المستخدم يرى إشعاراته فقط، وفقط إن كان حسابه فعّالًا. لا إدراج/تعديل/حذف مباشر.
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (
    user_id = (select auth.uid())
    and public.audit_current_user_is_active()
  );

revoke all on public.notifications from anon;
revoke all on public.notifications from authenticated;
grant  select on public.notifications to authenticated;   -- قراءة فقط عبر RLS (يدعم Realtime)

-- ---------------------------------------------------------------------------
-- 3) سجل قرارات الإجازة (إضافة-فقط)
-- ---------------------------------------------------------------------------
create table if not exists public.leave_decisions (
  id              uuid primary key default gen_random_uuid(),
  leave_id        uuid not null,                   -- مرجع غير مقيّد بـ FK (يحفظ التاريخ)
  decision        text not null check (decision in ('approved','rejected','cancelled')),
  decided_by      uuid,
  decided_at      timestamptz not null default now(),
  reason          text not null default '',
  previous_status text,
  new_status      text,
  actor_role      text,
  team            text,
  dept            text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_leave_decisions_leave on public.leave_decisions (leave_id, decided_at desc);

alter table public.leave_decisions enable row level security;
-- بلا سياسات = لا وصول مباشر لأي دور عبر PostgREST؛ الكتابة عبر trigger/definer فقط.
revoke all on public.leave_decisions from anon;
revoke all on public.leave_decisions from authenticated;

-- ---------------------------------------------------------------------------
-- 4) محدِّد المستلمين (داخلي — لا يُمنح لأحد)
-- ---------------------------------------------------------------------------
create or replace function public._leave_notify_recipients(p_emp_id uuid, p_team text)
returns table(uid uuid)
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_dept text := public.audit_team_dept(p_team);
  v_self uuid := (select auth.uid());
begin
  return query
  with recips as (
    select u.id
      from auth.users u
     where (u.banned_until is null or u.banned_until <= now())
       and (
             (u.raw_app_meta_data->>'role' = 'owner'
              and v_dept is not null
              and u.raw_app_meta_data->>'dept' = v_dept)
          or (u.raw_app_meta_data->>'role' = 'admin'
              and u.raw_app_meta_data->>'team' = p_team)
       )
  ),
  final as (
    select id from recips
    union
    select u.id                                   -- احتياطي: superadmin فقط عند غياب أي مخوّل
      from auth.users u
     where not exists (select 1 from recips)
       and u.raw_app_meta_data->>'role' = 'superadmin'
       and (u.banned_until is null or u.banned_until <= now())
  )
  select distinct f.id
    from final f
   where f.id is distinct from v_self;             -- لا يُشعَر مقدّم الطلب
end
$fn$;

revoke all on function public._leave_notify_recipients(uuid, text) from public;
revoke all on function public._leave_notify_recipients(uuid, text) from anon;
revoke all on function public._leave_notify_recipients(uuid, text) from authenticated;

-- ---------------------------------------------------------------------------
-- 5) triggers على leaves
-- ---------------------------------------------------------------------------

-- (أ) BEFORE INSERT: تعبئة وقت التقديم + تطهير حقول القرار
create or replace function public.fn_leave_submit_meta()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  NEW.submitted_at := now();
  if NEW.status = 'قيد الانتظار' then
    NEW.decided_at := null; NEW.decided_by := null; NEW.decided_role := null; NEW.reject_reason := null;
  elsif NEW.status in ('معتمد','مرفوض') then
    -- إدراج مباشر لطلب محسوم (مثل حجز مسؤول لإجازة معتمدة) — نثبّت المنفّذ من الخادم
    NEW.decided_at   := now();
    NEW.decided_by   := (select auth.uid());
    NEW.decided_role := public.audit_current_user_role();
    if NEW.status <> 'مرفوض' then NEW.reject_reason := null; end if;
  end if;
  return NEW;
end
$fn$;

-- (ب) BEFORE UPDATE: حارس القرار — الهوية والسبب من الخادم، لا من العميل
create or replace function public.fn_leave_decision_guard()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  -- تجاهل أي حقول قرار يرسلها العميل: أعِد بناءها من الحالة الفعلية
  NEW.decided_at   := OLD.decided_at;
  NEW.decided_by   := OLD.decided_by;
  NEW.decided_role := OLD.decided_role;

  if NEW.status is distinct from OLD.status then
    if OLD.status = 'قيد الانتظار' and NEW.status in ('معتمد','مرفوض') then
      -- قرار: يجب أن يكون المنفّذ مخوّلًا لنطاق الوردية (دفاع عميق فوق RLS)
      if not public.can_write_team(NEW.team) then
        raise exception 'غير مصرح باتخاذ القرار على هذه الوردية' using errcode = '42501';
      end if;
      NEW.decided_by   := (select auth.uid());
      NEW.decided_at   := now();
      NEW.decided_role := public.audit_current_user_role();
      if NEW.status = 'مرفوض' then
        if coalesce(btrim(NEW.reject_reason), '') = '' then
          raise exception 'سبب الرفض مطلوب';
        end if;
      else
        NEW.reject_reason := null;                 -- الاعتماد يمسح السبب
      end if;
    elsif NEW.status = 'قيد الانتظار' then
      -- إعادة الطلب للانتظار: صفّر حقول القرار
      NEW.decided_at := null; NEW.decided_by := null; NEW.decided_role := null; NEW.reject_reason := null;
    end if;
  else
    -- لا تغيير حالة: لا يُسمح للعميل بتعديل حقول القرار
    NEW.reject_reason := OLD.reject_reason;
  end if;

  return NEW;
end
$fn$;

-- (ج) AFTER UPDATE: تسجيل القرار + إشعار الموظف (عند التحوّل معلّق→محسوم)
create or replace function public.fn_leave_decision_after()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_uid uuid;
begin
  if not (OLD.status = 'قيد الانتظار'
          and NEW.status in ('معتمد','مرفوض')
          and NEW.status is distinct from OLD.status) then
    return NEW;
  end if;

  insert into public.leave_decisions(
    leave_id, decision, decided_by, decided_at, reason,
    previous_status, new_status, actor_role, team, dept)
  values (
    NEW.id,
    case when NEW.status = 'معتمد' then 'approved' else 'rejected' end,
    NEW.decided_by, coalesce(NEW.decided_at, now()), coalesce(NEW.reject_reason, ''),
    OLD.status, NEW.status, NEW.decided_role, NEW.team, public.audit_team_dept(NEW.team));

  -- إشعار الموظف صاحب الطلب (إن كان له حساب) — لا اسم المنفّذ في النص
  select ea.user_id into v_uid from public.employee_auth ea where ea.emp_id = NEW.emp_id;
  if v_uid is not null then
    insert into public.notifications(user_id, type, title, body, entity_type, entity_id, created_by, data)
    values (
      v_uid,
      case when NEW.status = 'معتمد' then 'leave_approved' else 'leave_rejected' end,
      case when NEW.status = 'معتمد' then 'تم اعتماد طلب الإجازة' else 'تم رفض طلب الإجازة' end,
      NEW.type || ' • ' || to_char(NEW.from_date,'YYYY-MM-DD') || ' ← ' || to_char(NEW.to_date,'YYYY-MM-DD')
        || case when NEW.status = 'مرفوض' and coalesce(btrim(NEW.reject_reason),'') <> ''
                then ' — السبب: ' || NEW.reject_reason else '' end,
      'leave', NEW.id, NEW.decided_by,
      jsonb_build_object('leave_type', NEW.type, 'from', NEW.from_date, 'to', NEW.to_date,
                         'status', NEW.status, 'reason', coalesce(NEW.reject_reason,'')));
  end if;
  -- إن لم يوجد حساب مرتبط: القرار مطبَّق ويُتخطّى الإشعار (لا فشل).
  return NEW;
end
$fn$;

-- (د) AFTER INSERT: إشعار المخوّلين عند تقديم طلب معلّق
create or replace function public.fn_leave_submit_after()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_emp_name text;
  r record;
begin
  if NEW.status <> 'قيد الانتظار' then
    return NEW;
  end if;
  select e.name into v_emp_name from public.employees e where e.id = NEW.emp_id;
  for r in select uid from public._leave_notify_recipients(NEW.emp_id, NEW.team) loop
    insert into public.notifications(user_id, type, title, body, entity_type, entity_id, created_by, data)
    values (
      r.uid, 'leave_submitted', 'طلب إجازة جديد',
      coalesce(v_emp_name,'موظف') || ' — ' || NEW.type || ' • '
        || to_char(NEW.from_date,'YYYY-MM-DD') || ' ← ' || to_char(NEW.to_date,'YYYY-MM-DD'),
      'leave', NEW.id, (select auth.uid()),
      jsonb_build_object('emp_name', coalesce(v_emp_name,''), 'leave_type', NEW.type,
                         'from', NEW.from_date, 'to', NEW.to_date, 'team', NEW.team));
  end loop;
  return NEW;
end
$fn$;

drop trigger if exists trg_leave_submit_meta   on public.leaves;
drop trigger if exists trg_leave_decision_guard on public.leaves;
drop trigger if exists trg_leave_decision_after on public.leaves;
drop trigger if exists trg_leave_submit_after  on public.leaves;

create trigger trg_leave_submit_meta   before insert on public.leaves
  for each row execute function public.fn_leave_submit_meta();
create trigger trg_leave_decision_guard before update on public.leaves
  for each row execute function public.fn_leave_decision_guard();
create trigger trg_leave_decision_after after update on public.leaves
  for each row execute function public.fn_leave_decision_after();
create trigger trg_leave_submit_after  after insert on public.leaves
  for each row execute function public.fn_leave_submit_after();

-- ---------------------------------------------------------------------------
-- 6) RPCs
-- ---------------------------------------------------------------------------

-- تقديم طلب إجازة (الموظف) — الهوية والوردية من القاعدة الموثوقة
create or replace function public.submit_leave_request(
  p_type text, p_from date, p_to date, p_notes text default '')
returns uuid
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_emp   uuid;
  v_team  text;
  v_types jsonb;
  v_id    uuid;
begin
  v_emp := public.audit_current_emp_id();
  if v_emp is null then
    raise exception 'غير مصرح: لا توجد هوية موظف فعّالة' using errcode = '42501';
  end if;
  select e.team into v_team from public.employees e where e.id = v_emp;  -- الوردية الموثوقة
  if v_team is null then
    raise exception 'وردية الموظف غير معروفة' using errcode = '42501';
  end if;
  if p_from is null or p_to is null then raise exception 'حدّد تواريخ الطلب'; end if;
  if p_to < p_from then raise exception 'تاريخ النهاية قبل البداية'; end if;
  if coalesce(btrim(p_type),'') = '' then raise exception 'نوع الإجازة مطلوب'; end if;

  select s.data->'leaveTypes' into v_types from public.settings s where s.team = v_team;
  if v_types is not null and jsonb_typeof(v_types) = 'array' and not (v_types ? p_type) then
    raise exception 'نوع إجازة غير صالح';
  end if;

  -- تسلسل لكل موظف يمنع الإرسال المزدوج المتزامن
  perform pg_advisory_xact_lock(hashtextextended('leave_submit|' || v_emp::text, 0));

  if exists (
    select 1 from public.leaves l
     where l.emp_id = v_emp and l.status <> 'مرفوض'
       and l.from_date <= p_to and l.to_date >= p_from
  ) then
    raise exception 'يوجد طلب متداخل مع هذه الفترة';
  end if;

  insert into public.leaves(emp_id, type, from_date, to_date, status, notes, team)
  values (v_emp, p_type, p_from, p_to, 'قيد الانتظار', coalesce(btrim(p_notes),''), v_team)
  returning id into v_id;

  return v_id;
end
$fn$;

-- القرار (اعتماد/رفض) — قفل الصف يمنع القرار المزدوج
create or replace function public.decide_leave_request(
  p_leave_id uuid, p_decision text, p_reason text default '',
  p_override boolean default false, p_override_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_lv  public.leaves%rowtype;
  v_new text;
begin
  if p_decision not in ('approve','reject') then
    raise exception 'قرار غير صالح';
  end if;

  select * into v_lv from public.leaves where id = p_leave_id for update;  -- قفل
  if not found then
    raise exception 'الطلب غير موجود';
  end if;
  if not public.can_write_team(v_lv.team) then
    raise exception 'غير مصرح باتخاذ القرار على هذه الوردية' using errcode = '42501';
  end if;
  if v_lv.status <> 'قيد الانتظار' then
    raise exception 'تم اتخاذ قرار بشأن الطلب مسبقاً' using errcode = '55006';
  end if;
  if p_decision = 'reject' and coalesce(btrim(p_reason),'') = '' then
    raise exception 'سبب الرفض مطلوب';
  end if;

  v_new := case when p_decision = 'approve' then 'معتمد' else 'مرفوض' end;

  update public.leaves set
    status                  = v_new,
    reject_reason           = case when p_decision = 'reject' then btrim(p_reason) else null end,
    balance_override        = case when p_decision = 'approve' and p_override then true
                                   else balance_override end,
    balance_override_reason = case when p_decision = 'approve' and p_override then btrim(p_override_reason)
                                   else balance_override_reason end
  where id = p_leave_id;
  -- triggers: تحقّق الرصيد + حارس القرار + تسجيل/إشعار + تدقيق (كله في هذه المعاملة)

  return jsonb_build_object('ok', true, 'status', v_new, 'id', p_leave_id);
end
$fn$;

-- عدّاد غير المقروء (للمستخدم الحالي)
create or replace function public.notification_unread_count()
returns integer
language sql
stable
security definer
set search_path to ''
as $fn$
  select count(*)::int from public.notifications
   where user_id = (select auth.uid()) and is_read = false
     and public.audit_current_user_is_active()
$fn$;

-- قائمة إشعاراتي (ترقيم آمن، الأحدث أولًا)
create or replace function public.list_my_notifications(p_page integer default 1, p_page_size integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_size int  := least(greatest(coalesce(p_page_size,20), 1), 50);
  v_page int  := greatest(coalesce(p_page,1), 1);
  v_total int; v_unread int; v_items jsonb;
begin
  if v_uid is null or not public.audit_current_user_is_active() then
    return jsonb_build_object('items','[]'::jsonb,'total',0,'unread',0,
                              'page',v_page,'page_size',v_size,'total_pages',0);
  end if;
  select count(*) into v_total  from public.notifications where user_id = v_uid;
  select count(*) into v_unread from public.notifications where user_id = v_uid and is_read = false;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_items from (
    select jsonb_build_object(
             'id', n.id, 'type', n.type, 'title', n.title, 'body', n.body,
             'entity_type', n.entity_type, 'entity_id', n.entity_id,
             'is_read', n.is_read, 'created_at', n.created_at, 'data', n.data) as x
      from public.notifications n
     where n.user_id = v_uid
     order by n.created_at desc, n.id desc
     limit v_size offset (v_page - 1) * v_size
  ) t;
  return jsonb_build_object(
    'items', v_items, 'total', v_total, 'unread', v_unread,
    'page', v_page, 'page_size', v_size,
    'total_pages', case when v_total = 0 then 0 else ((v_total + v_size - 1) / v_size) end);
end
$fn$;

-- تعليم إشعار كمقروء (لصاحبه فقط)
create or replace function public.mark_notification_read(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_n int;
begin
  update public.notifications
     set is_read = true, read_at = now()
   where id = p_id and user_id = (select auth.uid()) and is_read = false;
  get diagnostics v_n = row_count;
  return v_n > 0;
end
$fn$;

-- تعليم الكل كمقروء (لصاحبه فقط)
create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path to ''
as $fn$
declare v_n int;
begin
  update public.notifications
     set is_read = true, read_at = now()
   where user_id = (select auth.uid()) and is_read = false;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

-- المنح: خارجية لـ authenticated فقط؛ حرمان anon/public
revoke all on function public.submit_leave_request(text,date,date,text)               from public;
revoke all on function public.submit_leave_request(text,date,date,text)               from anon;
grant  execute on function public.submit_leave_request(text,date,date,text)           to authenticated;

revoke all on function public.decide_leave_request(uuid,text,text,boolean,text)        from public;
revoke all on function public.decide_leave_request(uuid,text,text,boolean,text)        from anon;
grant  execute on function public.decide_leave_request(uuid,text,text,boolean,text)    to authenticated;

revoke all on function public.notification_unread_count()                              from public;
revoke all on function public.notification_unread_count()                              from anon;
grant  execute on function public.notification_unread_count()                          to authenticated;

revoke all on function public.list_my_notifications(integer,integer)                   from public;
revoke all on function public.list_my_notifications(integer,integer)                   from anon;
grant  execute on function public.list_my_notifications(integer,integer)               to authenticated;

revoke all on function public.mark_notification_read(uuid)                             from public;
revoke all on function public.mark_notification_read(uuid)                             from anon;
grant  execute on function public.mark_notification_read(uuid)                         to authenticated;

revoke all on function public.mark_all_notifications_read()                            from public;
revoke all on function public.mark_all_notifications_read()                            from anon;
grant  execute on function public.mark_all_notifications_read()                        to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Realtime — إضافة notifications للنشر (لا يُطبَّق على الإنتاج الآن)
-- ---------------------------------------------------------------------------
do $rt$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications')
  then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end
$rt$;
