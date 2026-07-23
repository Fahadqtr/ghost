-- =====================================================================
--  الإفادات المتقدّمة — محادثات (threads) + رسائل + مرفقات
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة صريحة)
--
--  الجداول:
--    report_threads   : رأس المحادثة (تخصّ وردية) — يبدؤها المسؤول أو رئيس القسم
--    report_messages  : رسائل المحادثة (إفادة/ردّ)
--    report_files     : مرفقات الرسائل (المسار في Storage — البكت في migration منفصل)
--
--  الأمان: RLS بالدوال الموثوقة is_owner()/audit_current_user_role()/audit_current_user_team()
--  (تقرأ الدور/الوردية من auth.users — غير قابلة للتزوير عبر JWT).
--  حقول موثوقة تُفرَض بمشغّلات BEFORE (author_uid/role, team, created_at) لمنع الانتحال.
-- =====================================================================
begin;

create table if not exists public.report_threads (
  id              uuid primary key default gen_random_uuid(),
  team            text not null,
  created_by      uuid,
  created_by_name text,
  created_role    text not null default '',      -- 'admin' | 'owner' (يُفرَض بالخادم)
  subject         text,
  status          text not null default 'open',  -- 'open' | 'handled'
  created_at      timestamptz not null default now(),
  last_msg_at     timestamptz not null default now()
);

create table if not exists public.report_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.report_threads(id) on delete cascade,
  author_uid  uuid,
  author_role text not null default '',          -- يُفرَض بالخادم
  author_name text,
  body        text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.report_files (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.report_messages(id) on delete cascade,
  team        text not null,
  path        text not null,
  file_name   text,
  mime_type   text,
  size_bytes  int,
  created_at  timestamptz not null default now()
);

create index if not exists idx_report_threads_team    on public.report_threads(team, last_msg_at desc);
create index if not exists idx_report_messages_thread on public.report_messages(thread_id, created_at);
create index if not exists idx_report_files_message   on public.report_files(message_id);

alter table public.report_threads  enable row level security;
alter table public.report_messages enable row level security;
alter table public.report_files    enable row level security;

-- ---------------------------------------------------------------------
-- حقول موثوقة: رأس المحادثة
--   المسؤول: الوردية تُفرَض من ورديته الموثوقة.
--   رئيس القسم: يحدّد الوردية، ويجب أن تكون وردية معروفة (موجودة في settings).
-- ---------------------------------------------------------------------
create or replace function public.fn_report_thread_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_role text; v_team text;
begin
  v_role := public.audit_current_user_role();
  v_team := public.audit_current_user_team();
  NEW.created_by  := (select auth.uid());
  NEW.created_role := coalesce(v_role,'');
  NEW.created_at  := now();
  NEW.last_msg_at := now();
  if NEW.status is null or NEW.status not in ('open','handled') then NEW.status := 'open'; end if;

  if public.is_owner() then
    if NEW.team is null or btrim(NEW.team) = '' then
      raise exception 'report_threads: يجب تحديد الوردية';
    end if;
    if not exists (select 1 from public.settings s where s.team = NEW.team) then
      raise exception 'report_threads: وردية غير معروفة';
    end if;
  else
    if v_role <> 'admin' or v_team is null or btrim(v_team) = '' then
      raise exception 'report_threads: غير مصرّح';
    end if;
    NEW.team := v_team;                          -- من ورديته لا من العميل
  end if;
  return NEW;
end $$;

drop trigger if exists trg_report_thread_fields on public.report_threads;
create trigger trg_report_thread_fields before insert on public.report_threads
  for each row execute function public.fn_report_thread_fields();

-- ---------------------------------------------------------------------
-- حقول موثوقة: الرسائل (يتحقّق من صلاحية الكتابة في المحادثة)
-- ---------------------------------------------------------------------
create or replace function public.fn_report_message_fields()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_role text; v_team text; t_team text;
begin
  v_role := public.audit_current_user_role();
  v_team := public.audit_current_user_team();
  select team into t_team from public.report_threads where id = NEW.thread_id;
  if t_team is null then raise exception 'report_messages: محادثة غير موجودة'; end if;
  if not (public.is_owner() or (v_role = 'admin' and v_team = t_team)) then
    raise exception 'report_messages: غير مصرّح';
  end if;
  NEW.author_uid  := (select auth.uid());
  NEW.author_role := coalesce(v_role,'');
  NEW.created_at  := now();
  return NEW;
end $$;

drop trigger if exists trg_report_message_fields on public.report_messages;
create trigger trg_report_message_fields before insert on public.report_messages
  for each row execute function public.fn_report_message_fields();

-- تحديث آخر نشاط للمحادثة عند وصول رسالة
create or replace function public.fn_report_touch_thread()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.report_threads set last_msg_at = now() where id = NEW.thread_id;
  return NEW;
end $$;

drop trigger if exists trg_report_touch on public.report_messages;
create trigger trg_report_touch after insert on public.report_messages
  for each row execute function public.fn_report_touch_thread();

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
-- المحادثات
drop policy if exists report_threads_read   on public.report_threads;
drop policy if exists report_threads_insert on public.report_threads;
drop policy if exists report_threads_update on public.report_threads;
drop policy if exists report_threads_delete on public.report_threads;
create policy report_threads_read on public.report_threads for select
  using ( public.is_owner() or team = public.audit_current_user_team() );
create policy report_threads_insert on public.report_threads for insert
  with check ( public.is_owner()
            or (public.audit_current_user_role() = 'admin' and team = public.audit_current_user_team()) );
create policy report_threads_update on public.report_threads for update
  using ( public.is_owner() ) with check ( public.is_owner() );
-- الحذف: رئيس القسم لأي محادثة، والمسؤول لمحادثات ورديته فقط (يتتالى على الرسائل والمرفقات)
create policy report_threads_delete on public.report_threads for delete
  using ( public.is_owner()
       or (public.audit_current_user_role() = 'admin' and team = public.audit_current_user_team()) );

-- الرسائل
drop policy if exists report_messages_read   on public.report_messages;
drop policy if exists report_messages_insert on public.report_messages;
create policy report_messages_read on public.report_messages for select
  using ( exists (select 1 from public.report_threads t where t.id = thread_id
            and (public.is_owner() or t.team = public.audit_current_user_team())) );
create policy report_messages_insert on public.report_messages for insert
  with check ( exists (select 1 from public.report_threads t where t.id = thread_id
            and (public.is_owner()
                 or (public.audit_current_user_role() = 'admin' and t.team = public.audit_current_user_team()))) );

-- المرفقات
drop policy if exists report_files_read   on public.report_files;
drop policy if exists report_files_insert on public.report_files;
create policy report_files_read on public.report_files for select
  using ( exists (select 1 from public.report_messages m
                  join public.report_threads t on t.id = m.thread_id
                  where m.id = message_id
                    and (public.is_owner() or t.team = public.audit_current_user_team())) );
create policy report_files_insert on public.report_files for insert
  with check ( exists (select 1 from public.report_messages m
                  join public.report_threads t on t.id = m.thread_id
                  where m.id = message_id
                    and (public.is_owner()
                         or (public.audit_current_user_role() = 'admin' and t.team = public.audit_current_user_team()))) );

-- الدوال تعمل عبر المشغّلات فقط
revoke all on function public.fn_report_thread_fields()  from public, anon, authenticated;
revoke all on function public.fn_report_message_fields() from public, anon, authenticated;
revoke all on function public.fn_report_touch_thread()   from public, anon, authenticated;

commit;
