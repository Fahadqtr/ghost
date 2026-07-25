-- ============================================================================
-- المرحلة الخامسة: تعديل وإلغاء طلبات الإجازة + سجل تاريخي + إشعارات
-- ملف مستقل — لا يُعدّل أي migration مطبَّق.
--
-- المبدأ الأهم: الرصيد مُشتَق (fn_leave_used يعدّ leaves ذات status='معتمد').
--   الإلغاء = تغيير الحالة إلى 'ملغى' فقط → الرصيد يُستعاد تلقائيًا.
--   لا قيد Ledger عكسي (يمنع مضاعفة الاستعادة). leave_ledger يبقى إضافة-فقط دون مساس.
--
-- يضيف: حالة 'ملغى' (بلا قيد على leaves.status)، جدولا leave_change_requests و
--   leave_history، trigger تاريخ على leaves، وRPCs آمنة للتعديل/الإلغاء/طلب إلغاء
--   المعتمدة/قرار الإلغاء/عرض الـTimeline/القوائم، مع توسيع أنواع الإشعارات.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) توسيع أنواع الإشعارات (إضافي — لا يكسر القيم القائمة)
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'leave_submitted','leave_approved','leave_rejected','leave_cancelled',
  'leave_updated','leave_cancellation_requested','leave_cancellation_approved','leave_cancellation_rejected',
  'account_changed','department_changed'));

-- ---------------------------------------------------------------------------
-- 2) جدول طلبات التغيير/الإلغاء (لإلغاء المعتمدة)
-- ---------------------------------------------------------------------------
create table if not exists public.leave_change_requests (
  id              uuid primary key default gen_random_uuid(),
  leave_id        uuid not null,                       -- مرجع غير مقيّد بـ FK (يحفظ التاريخ)
  request_type    text not null check (request_type in ('cancel_approved_leave')),
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by    uuid,
  requested_at    timestamptz not null default now(),
  reason          text check (reason is null or char_length(reason) <= 1000),
  decided_by      uuid,
  decided_at      timestamptz,
  decided_role    text,
  decision_reason text check (decision_reason is null or char_length(decision_reason) <= 1000),
  created_at      timestamptz not null default now()
);
-- طلب إلغاء معلّق واحد فقط لكل إجازة
create unique index if not exists uq_lcr_one_pending on public.leave_change_requests (leave_id) where status = 'pending';
create index if not exists idx_lcr_status_leave on public.leave_change_requests (status, leave_id);

alter table public.leave_change_requests enable row level security;
revoke all on public.leave_change_requests from anon;
revoke all on public.leave_change_requests from authenticated;
-- بلا سياسات = لا وصول مباشر؛ الكتابة/القراءة عبر definer/RPC فقط.

-- ---------------------------------------------------------------------------
-- 3) جدول السجل التاريخي (Timeline) — إضافة-فقط
-- ---------------------------------------------------------------------------
create table if not exists public.leave_history (
  id          uuid primary key default gen_random_uuid(),
  leave_id    uuid not null,
  event_type  text not null check (event_type in (
                'submitted','edited','cancelled','approved','rejected',
                'cancellation_requested','cancellation_approved','cancellation_rejected')),
  actor_id    uuid,
  actor_role  text,
  created_at  timestamptz not null default now(),
  summary     text check (summary is null or char_length(summary) <= 500),
  old_data    jsonb check (old_data is null or length(old_data::text) <= 4096),
  new_data    jsonb check (new_data is null or length(new_data::text) <= 4096)
);
create index if not exists idx_leave_history_leave on public.leave_history (leave_id, created_at, id);

alter table public.leave_history enable row level security;
revoke all on public.leave_history from anon;
revoke all on public.leave_history from authenticated;

-- تعبئة أساسية خفيفة: حدث واحد لكل إجازة موجودة يعكس حالتها (بلا triggers على leave_history)
insert into public.leave_history(leave_id, event_type, actor_id, actor_role, created_at, new_data)
select l.id,
       case l.status when 'معتمد' then 'approved' when 'مرفوض' then 'rejected'
                     when 'ملغى' then 'cancelled' else 'submitted' end,
       null, null, coalesce(l.submitted_at, l.updated_at, now()),
       jsonb_build_object('type', l.type, 'from', l.from_date, 'to', l.to_date, 'status', l.status)
from public.leaves l
where not exists (select 1 from public.leave_history h where h.leave_id = l.id);

-- ---------------------------------------------------------------------------
-- 4) Trigger السجل التاريخي على leaves (يغطّي كل المسارات)
-- ---------------------------------------------------------------------------
create or replace function public.fn_leave_history_capture()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_event text;
  v_old jsonb;
  v_new jsonb;
  v_reason text := nullif(btrim(coalesce(current_setting('app.leave_hist_reason', true), '')), '');
begin
  if TG_OP = 'INSERT' then
    v_event := case NEW.status
                 when 'قيد الانتظار' then 'submitted'
                 when 'معتمد' then 'approved'
                 when 'مرفوض' then 'rejected'
                 when 'ملغى' then 'cancelled'
                 else 'submitted' end;
    v_new := jsonb_build_object('type', NEW.type, 'from', NEW.from_date, 'to', NEW.to_date, 'status', NEW.status);
  else
    if NEW.status is distinct from OLD.status then
      v_event := case
                   when OLD.status = 'قيد الانتظار' and NEW.status = 'معتمد' then 'approved'
                   when OLD.status = 'قيد الانتظار' and NEW.status = 'مرفوض' then 'rejected'
                   when OLD.status = 'قيد الانتظار' and NEW.status = 'ملغى' then 'cancelled'
                   when OLD.status = 'معتمد' and NEW.status = 'ملغى' then 'cancellation_approved'
                   else null end;
      v_old := jsonb_build_object('status', OLD.status);
      v_new := jsonb_build_object('status', NEW.status);
    elsif (NEW.type, NEW.from_date, NEW.to_date, coalesce(NEW.notes,''))
          is distinct from (OLD.type, OLD.from_date, OLD.to_date, coalesce(OLD.notes,'')) then
      v_event := 'edited';
      v_old := jsonb_build_object('type', OLD.type, 'from', OLD.from_date, 'to', OLD.to_date);
      v_new := jsonb_build_object('type', NEW.type, 'from', NEW.from_date, 'to', NEW.to_date);
    else
      v_event := null;
    end if;
  end if;

  if v_event is null then return NEW; end if;
  if v_reason is not null and v_event in ('cancelled','cancellation_approved','rejected') then
    v_new := coalesce(v_new,'{}'::jsonb) || jsonb_build_object('reason', left(v_reason, 1000));
  end if;

  insert into public.leave_history(leave_id, event_type, actor_id, actor_role, old_data, new_data)
  values (NEW.id, v_event, (select auth.uid()), public.audit_current_user_role(), v_old, v_new);
  return NEW;
end
$fn$;

-- دالة الـtrigger داخلية: لا EXECUTE للعميل (تُستدعى بواسطة نظام الـtrigger فقط)
revoke all on function public.fn_leave_history_capture() from public;
revoke all on function public.fn_leave_history_capture() from anon;
revoke all on function public.fn_leave_history_capture() from authenticated;

drop trigger if exists trg_leave_history_capture on public.leaves;
create trigger trg_leave_history_capture after insert or update on public.leaves
  for each row execute function public.fn_leave_history_capture();

-- ---------------------------------------------------------------------------
-- 5) RPCs
-- ---------------------------------------------------------------------------

-- (أ) تعديل طلب معلّق (صاحبه فقط)
create or replace function public.update_pending_leave_request(
  p_leave_id uuid, p_type text, p_from date, p_to date, p_notes text default '')
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_emp uuid; v_team text; v_lv public.leaves%rowtype; v_types jsonb; v_name text; r record;
begin
  v_emp := public.audit_current_emp_id();
  if v_emp is null then raise exception 'غير مصرح: لا توجد هوية موظف فعّالة' using errcode='42501'; end if;
  select * into v_lv from public.leaves where id = p_leave_id for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if v_lv.emp_id <> v_emp then raise exception 'لا يمكنك تعديل طلب غيرك' using errcode='42501'; end if;
  if v_lv.status <> 'قيد الانتظار' then raise exception 'لا يمكن تعديل الطلب بعد اتخاذ قرار'; end if;
  if p_from is null or p_to is null then raise exception 'حدّد التواريخ'; end if;
  if p_to < p_from then raise exception 'تاريخ النهاية قبل البداية'; end if;
  if coalesce(btrim(p_type),'') = '' then raise exception 'نوع الإجازة مطلوب'; end if;
  if char_length(coalesce(p_notes,'')) > 2000 then raise exception 'الملاحظات تتجاوز الحد المسموح (2000 محرف)'; end if;
  select e.team into v_team from public.employees e where e.id = v_emp;
  select s.data->'leaveTypes' into v_types from public.settings s where s.team = v_team;
  if v_types is not null and jsonb_typeof(v_types)='array' and not (v_types ? p_type) then raise exception 'نوع إجازة غير صالح'; end if;
  if exists (select 1 from public.leaves l where l.emp_id = v_emp and l.id <> p_leave_id
             and l.status not in ('مرفوض','ملغى') and l.from_date <= p_to and l.to_date >= p_from) then
    raise exception 'يوجد طلب متداخل مع هذه الفترة';
  end if;
  update public.leaves set type = p_type, from_date = p_from, to_date = p_to, notes = coalesce(btrim(p_notes),'')
   where id = p_leave_id;   -- trigger: 'edited' history + trg_audit
  select e.name into v_name from public.employees e where e.id = v_emp;
  for r in select uid from public._leave_notify_recipients(v_emp, v_team) loop
    insert into public.notifications(user_id,type,title,body,entity_type,entity_id,created_by,data)
    values (r.uid,'leave_updated','تم تعديل طلب إجازة',
      coalesce(v_name,'موظف')||' — '||p_type||' • '||to_char(p_from,'YYYY-MM-DD')||' ← '||to_char(p_to,'YYYY-MM-DD'),
      'leave', p_leave_id, (select auth.uid()),
      jsonb_build_object('leave_type',p_type,'from',p_from,'to',p_to,'team',v_team));
  end loop;
  return jsonb_build_object('ok',true,'id',p_leave_id);
end $fn$;

-- (ب) إلغاء طلب معلّق (صاحبه فقط) — إلغاء ناعم
create or replace function public.cancel_pending_leave_request(p_leave_id uuid, p_reason text default '')
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_emp uuid; v_team text; v_lv public.leaves%rowtype; v_name text; r record;
begin
  v_emp := public.audit_current_emp_id();
  if v_emp is null then raise exception 'غير مصرح: لا توجد هوية موظف فعّالة' using errcode='42501'; end if;
  if char_length(coalesce(p_reason,'')) > 1000 then raise exception 'السبب يتجاوز الحد المسموح (1000 محرف)'; end if;
  select * into v_lv from public.leaves where id = p_leave_id for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if v_lv.emp_id <> v_emp then raise exception 'لا يمكنك إلغاء طلب غيرك' using errcode='42501'; end if;
  if v_lv.status <> 'قيد الانتظار' then raise exception 'لا يمكن إلغاء الطلب في حالته الحالية'; end if;
  perform set_config('app.leave_hist_reason', coalesce(btrim(p_reason),''), true);
  update public.leaves set status = 'ملغى' where id = p_leave_id;   -- trigger: 'cancelled'; balance unaffected (كان معلّقًا)
  select e.team, e.name into v_team, v_name from public.employees e where e.id = v_emp;
  for r in select uid from public._leave_notify_recipients(v_emp, v_team) loop
    insert into public.notifications(user_id,type,title,body,entity_type,entity_id,created_by,data)
    values (r.uid,'leave_cancelled','تم إلغاء طلب الإجازة من الموظف',
      coalesce(v_name,'موظف')||' — '||v_lv.type||' • '||to_char(v_lv.from_date,'YYYY-MM-DD')||' ← '||to_char(v_lv.to_date,'YYYY-MM-DD'),
      'leave', p_leave_id, (select auth.uid()),
      jsonb_build_object('leave_type',v_lv.type,'from',v_lv.from_date,'to',v_lv.to_date,'team',v_team));
  end loop;
  return jsonb_build_object('ok',true,'id',p_leave_id);
end $fn$;

-- (ج) طلب إلغاء إجازة معتمدة (صاحبها فقط)
create or replace function public.request_approved_leave_cancellation(p_leave_id uuid, p_reason text default '')
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_emp uuid; v_team text; v_lv public.leaves%rowtype; v_name text; v_req uuid; r record; v_today date := current_date;
begin
  v_emp := public.audit_current_emp_id();
  if v_emp is null then raise exception 'غير مصرح: لا توجد هوية موظف فعّالة' using errcode='42501'; end if;
  if coalesce(btrim(p_reason),'') = '' then raise exception 'سبب طلب الإلغاء مطلوب'; end if;
  if char_length(btrim(p_reason)) > 1000 then raise exception 'السبب يتجاوز الحد المسموح (1000 محرف)'; end if;
  select * into v_lv from public.leaves where id = p_leave_id for update;
  if not found then raise exception 'الإجازة غير موجودة'; end if;
  if v_lv.emp_id <> v_emp then raise exception 'لا يمكنك طلب إلغاء إجازة غيرك' using errcode='42501'; end if;
  if v_lv.status <> 'معتمد' then raise exception 'لا يمكن طلب الإلغاء إلا لإجازة معتمدة'; end if;
  if v_lv.to_date < v_today then raise exception 'الإجازة منتهية — لا يمكن طلب إلغائها'; end if;
  if v_lv.from_date <= v_today and not public.is_superadmin() then
    raise exception 'لا يمكن طلب إلغاء إجازة بدأت';
  end if;
  if exists (select 1 from public.leave_change_requests where leave_id = p_leave_id and status = 'pending') then
    raise exception 'يوجد طلب إلغاء معلّق لهذه الإجازة';
  end if;
  insert into public.leave_change_requests(leave_id, request_type, status, requested_by, reason)
  values (p_leave_id, 'cancel_approved_leave', 'pending', (select auth.uid()), btrim(p_reason))
  returning id into v_req;
  select e.team, e.name into v_team, v_name from public.employees e where e.id = v_emp;
  insert into public.leave_history(leave_id, event_type, actor_id, actor_role, new_data)
  values (p_leave_id,'cancellation_requested',(select auth.uid()),public.audit_current_user_role(),
          jsonb_build_object('reason', left(btrim(p_reason),1000)));
  insert into public.audit_log(team, actor_id, actor_role, action, entity, entity_id, summary)
  values (v_team, (select auth.uid()), public.audit_current_user_role(), 'insert', 'leave_change_requests', v_req::text, 'طلب إلغاء إجازة معتمدة');
  for r in select uid from public._leave_notify_recipients(v_emp, v_team) loop
    insert into public.notifications(user_id,type,title,body,entity_type,entity_id,created_by,data)
    values (r.uid,'leave_cancellation_requested','طلب إلغاء إجازة معتمدة',
      coalesce(v_name,'موظف')||' — '||v_lv.type||' • '||to_char(v_lv.from_date,'YYYY-MM-DD')||' ← '||to_char(v_lv.to_date,'YYYY-MM-DD')||' — السبب: '||btrim(p_reason),
      'leave', p_leave_id, (select auth.uid()),
      jsonb_build_object('leave_type',v_lv.type,'from',v_lv.from_date,'to',v_lv.to_date,'team',v_team,'request_id',v_req));
  end loop;
  return jsonb_build_object('ok',true,'request_id',v_req);
end $fn$;

-- (د) قرار طلب الإلغاء (مسؤول مخوّل)
create or replace function public.decide_leave_cancellation(p_request_id uuid, p_decision text, p_reason text default '')
returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare v_req public.leave_change_requests%rowtype; v_lv public.leaves%rowtype; v_uid uuid; v_new_status text;
begin
  if p_decision not in ('approve','reject') then raise exception 'قرار غير صالح'; end if;
  select * into v_req from public.leave_change_requests where id = p_request_id for update;   -- قفل الطلب
  if not found then raise exception 'طلب الإلغاء غير موجود'; end if;
  if v_req.status <> 'pending' then raise exception 'تم اتخاذ قرار بشأن طلب الإلغاء مسبقاً' using errcode='55006'; end if;
  select * into v_lv from public.leaves where id = v_req.leave_id for update;                 -- قفل الإجازة الأصلية
  if not found then raise exception 'الإجازة الأصلية غير موجودة'; end if;
  if not public.can_write_team(v_lv.team) then raise exception 'غير مصرح باتخاذ القرار على هذه الوردية' using errcode='42501'; end if;
  if p_decision = 'reject' then
    if coalesce(btrim(p_reason),'') = '' then raise exception 'سبب رفض طلب الإلغاء مطلوب'; end if;
    if char_length(btrim(p_reason)) > 1000 then raise exception 'السبب يتجاوز الحد المسموح (1000 محرف)'; end if;
  end if;

  update public.leave_change_requests set
    status = case when p_decision='approve' then 'approved' else 'rejected' end,
    decided_by = (select auth.uid()), decided_at = now(), decided_role = public.audit_current_user_role(),
    decision_reason = case when p_decision='reject' then btrim(p_reason) else null end
  where id = p_request_id;

  if p_decision = 'approve' then
    perform set_config('app.leave_hist_reason', coalesce(v_req.reason,''), true);
    update public.leaves set status = 'ملغى' where id = v_lv.id;   -- الرصيد يُستعاد تلقائيًا؛ trigger: cancellation_approved + trg_audit
    v_new_status := 'ملغى';
  else
    insert into public.leave_history(leave_id, event_type, actor_id, actor_role, new_data)
    values (v_lv.id,'cancellation_rejected',(select auth.uid()),public.audit_current_user_role(),
            jsonb_build_object('reason', left(btrim(p_reason),1000)));
    insert into public.audit_log(team, actor_id, actor_role, action, entity, entity_id, summary)
    values (v_lv.team, (select auth.uid()), public.audit_current_user_role(), 'update', 'leave_change_requests', p_request_id::text, 'رفض طلب إلغاء إجازة');
    v_new_status := v_lv.status;
  end if;

  select ea.user_id into v_uid from public.employee_auth ea where ea.emp_id = v_lv.emp_id;
  if v_uid is not null then
    insert into public.notifications(user_id,type,title,body,entity_type,entity_id,created_by,data)
    values (v_uid,
      case when p_decision='approve' then 'leave_cancellation_approved' else 'leave_cancellation_rejected' end,
      case when p_decision='approve' then 'تم اعتماد إلغاء الإجازة' else 'تم رفض طلب إلغاء الإجازة' end,
      v_lv.type||' • '||to_char(v_lv.from_date,'YYYY-MM-DD')||' ← '||to_char(v_lv.to_date,'YYYY-MM-DD')
        || case when p_decision='reject' and coalesce(btrim(p_reason),'')<>'' then ' — سبب الرفض: '||btrim(p_reason) else '' end,
      'leave', v_lv.id, (select auth.uid()),
      jsonb_build_object('leave_type',v_lv.type,'from',v_lv.from_date,'to',v_lv.to_date,'status',v_new_status));
  end if;
  return jsonb_build_object('ok',true,'decision',p_decision,'request_id',p_request_id);
end $fn$;

-- (هـ) عرض الـTimeline (نطاق مقيّد)
create or replace function public.get_leave_timeline(p_leave_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_emp uuid; v_lv public.leaves%rowtype; v_allowed boolean := false; v_items jsonb;
begin
  if not public.audit_current_user_is_active() then raise exception 'غير مصرح' using errcode='42501'; end if;
  select * into v_lv from public.leaves where id = p_leave_id;
  if not found then return jsonb_build_object('items','[]'::jsonb); end if;
  v_emp := public.audit_current_emp_id();
  v_allowed := (v_emp is not null and v_lv.emp_id = v_emp) or public.can_write_team(v_lv.team);  -- viewer: own only
  if not v_allowed then raise exception 'غير مصرح بعرض سجل هذا الطلب' using errcode='42501'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_items from (
    select jsonb_build_object('event', h.event_type, 'role', h.actor_role, 'at', h.created_at,
                              'old', h.old_data, 'new', h.new_data) as x
    from public.leave_history h where h.leave_id = p_leave_id
    order by h.created_at, h.id
  ) t;
  return jsonb_build_object('items', v_items, 'status', v_lv.status);
end $fn$;

-- (و) قائمة طلبات الإلغاء المعلّقة ضمن نطاق المسؤول
create or replace function public.list_pending_leave_cancellations()
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_teams text[]; v_items jsonb;
begin
  v_teams := public._report_scope_teams();   -- superadmin=الكل، owner=قسمه، admin=ورديته؛ يرفع 42501 لغيرهم
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_items from (
    select jsonb_build_object(
             'request_id', cr.id, 'leave_id', cr.leave_id, 'emp_name', e.name, 'team', l.team,
             'leave_type', l.type, 'from', l.from_date, 'to', l.to_date,
             'reason', cr.reason, 'requested_at', cr.requested_at) as x
    from public.leave_change_requests cr
    join public.leaves l on l.id = cr.leave_id
    left join public.employees e on e.id = l.emp_id
    where cr.status = 'pending' and l.team = any(v_teams)
    order by cr.requested_at desc
  ) t;
  return jsonb_build_object('items', v_items);
end $fn$;

-- (ز) طلبات إلغاء الموظف الحالي (لعرض حالتها)
create or replace function public.list_my_cancellation_requests()
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare v_emp uuid; v_items jsonb;
begin
  v_emp := public.audit_current_emp_id();
  if v_emp is null then return jsonb_build_object('items','[]'::jsonb); end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_items from (
    select jsonb_build_object(
             'request_id', cr.id, 'leave_id', cr.leave_id, 'status', cr.status,
             'reason', cr.reason, 'decision_reason', cr.decision_reason,
             'requested_at', cr.requested_at, 'decided_at', cr.decided_at) as x
    from public.leave_change_requests cr
    join public.leaves l on l.id = cr.leave_id
    where l.emp_id = v_emp
    order by cr.requested_at desc
  ) t;
  return jsonb_build_object('items', v_items);
end $fn$;

-- ---------------------------------------------------------------------------
-- 6) المنح: خارجية لـ authenticated فقط؛ حرمان anon/public
-- ---------------------------------------------------------------------------
revoke all on function public.update_pending_leave_request(uuid,text,date,date,text)         from public, anon;
grant  execute on function public.update_pending_leave_request(uuid,text,date,date,text)      to authenticated;
revoke all on function public.cancel_pending_leave_request(uuid,text)                          from public, anon;
grant  execute on function public.cancel_pending_leave_request(uuid,text)                      to authenticated;
revoke all on function public.request_approved_leave_cancellation(uuid,text)                   from public, anon;
grant  execute on function public.request_approved_leave_cancellation(uuid,text)               to authenticated;
revoke all on function public.decide_leave_cancellation(uuid,text,text)                        from public, anon;
grant  execute on function public.decide_leave_cancellation(uuid,text,text)                    to authenticated;
revoke all on function public.get_leave_timeline(uuid)                                         from public, anon;
grant  execute on function public.get_leave_timeline(uuid)                                     to authenticated;
revoke all on function public.list_pending_leave_cancellations()                               from public, anon;
grant  execute on function public.list_pending_leave_cancellations()                           to authenticated;
revoke all on function public.list_my_cancellation_requests()                                  from public, anon;
grant  execute on function public.list_my_cancellation_requests()                              to authenticated;
