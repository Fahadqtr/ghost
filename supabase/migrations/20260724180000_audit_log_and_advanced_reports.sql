-- ============================================================================
-- Phase 3 — Security/operational audit log search + advanced admin reports.
--
-- Scope of this migration (additive & read-oriented only):
--   * Widen the audit action whitelist (never remove existing values).
--   * Central, recursive sanitizer for values displayed from audit JSON.
--   * Minimal, safe audit coverage for gaps: departments (trigger) and the
--     account lifecycle RPCs (create owner / rename / delete) — bodies are
--     preserved verbatim, only an audit write is added.
--   * An internal denied-access logger helper (NOT client-callable; reliable
--     denial logging is deferred to an out-of-transaction caller — see note).
--   * A superadmin-only, paginated, sanitized audit-search RPC.
--   * Read-only, role-scoped advanced report RPCs.
--   * Supporting indexes and least-privilege grants.
--
-- Does NOT: change operational data, delete audit rows, alter identity /
-- disabled-account / RLS / last-superadmin-guard hardening, or weaken any
-- existing policy. All new functions: SECURITY DEFINER, SET search_path=''.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Widen the audit action whitelist (additive only).
--    Departments reuse insert/update/delete (already allowed) via a trigger.
-- ----------------------------------------------------------------------------
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check
  check (action = any (array[
    'insert', 'update', 'delete',
    'account_disabled', 'account_enabled', 'account_scope_update',
    'head_promote', 'head_remove', 'head_replace',
    'account_create', 'account_rename', 'account_delete',
    'access_denied'
  ]));

-- ----------------------------------------------------------------------------
-- 2) Central sensitive-key sanitizer for displayed audit JSON (recursive).
--    Redacts sensitive keys at every nesting depth (objects + arrays).
--    Internal: not granted to anon/authenticated.
-- ----------------------------------------------------------------------------
-- Sensitive keys are matched on a NORMALIZED form of the key (lowercased and
-- stripped of every non-alphanumeric char) so snake_case, camelCase and mixed
-- casing all collapse to the same token. Membership is tested against an exact
-- denylist set — NOT a broad '%key%'/'%session%' pattern — so safe fields like
-- keyboard_layout, monkey_count, token_count, keynote_title and sessional_report
-- are never redacted. Recurses through objects and arrays, with a depth guard.
create or replace function public._audit_sanitize_json(p jsonb, p_depth integer default 0)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $function$
declare
  k    text;
  v    jsonb;
  nk   text;
  out  jsonb;
  deny constant text[] := array[
    'password','passwd','pass','token','accesstoken','refreshtoken','idtoken','sessiontoken',
    'authorization','bearer','cookie','cookies','session','sessionid','secret','secrets',
    'clientsecret','apikey','apisecret','servicerole','servicerolekey','servicekey','privatekey',
    'credential','credentials','rawappmetadata','rawusermetadata','appmetadata','usermetadata',
    'encrypted','encryptedpassword','banneduntil'
  ];
begin
  if p is null then
    return null;
  end if;
  if p_depth > 40 then                     -- guard against pathologically deep JSON
    return to_jsonb('[عمق مفرط]'::text);
  end if;

  if jsonb_typeof(p) = 'object' then
    out := '{}'::jsonb;
    for k, v in select key, value from jsonb_each(p) loop
      nk := regexp_replace(lower(k), '[^a-z0-9]', '', 'g');
      if nk = any(deny) then
        out := out || jsonb_build_object(k, to_jsonb('[محجوب]'::text));
      else
        out := out || jsonb_build_object(k, public._audit_sanitize_json(v, p_depth + 1));
      end if;
    end loop;
    return out;
  elsif jsonb_typeof(p) = 'array' then
    return (
      select coalesce(jsonb_agg(public._audit_sanitize_json(e, p_depth + 1)), '[]'::jsonb)
      from jsonb_array_elements(p) e
    );
  else
    return p;
  end if;
end
$function$;

-- internal helper: never client-callable (anon + authenticated + PUBLIC all denied)
revoke all on function public._audit_sanitize_json(jsonb, integer) from public, anon, authenticated;

-- Mask a UUID-looking entity id for display (keep composite keys readable).
create or replace function public._audit_mask_id(p text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select case
    when p is null then null
    when p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then '…' || right(p, 6)
    else p
  end
$function$;

-- internal helper: never client-callable
revoke all on function public._audit_mask_id(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3) Departments audit trigger — covers create / rename / delete of a
--    department (the departments table previously had no audit trigger).
--    departments holds only (id, name, created_at) — no sensitive data.
-- ----------------------------------------------------------------------------
create or replace function public._audit_departments()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_name  text;
  v_role  text;
  v_id    text;
  v_sum   text;
  v_chg   jsonb;
begin
  if v_actor is not null then
    select coalesce(u.raw_app_meta_data->>'name', split_part(u.email, '@', 1)),
           coalesce(u.raw_app_meta_data->>'role', 'unknown')
      into v_name, v_role
      from auth.users u where u.id = v_actor;
  end if;
  v_role := coalesce(v_role, case when v_actor is null then 'system' else 'unknown' end);
  v_name := coalesce(v_name, case when v_actor is null then 'system' else 'unknown' end);

  if tg_op = 'INSERT' then
    v_id  := new.id;
    v_sum := 'أنشأ قسماً: ' || coalesce(new.name, '');
  elsif tg_op = 'DELETE' then
    v_id  := old.id;
    v_sum := 'حذف قسماً: ' || coalesce(old.name, '');
  else
    v_id  := new.id;
    v_sum := 'عدّل اسم قسم: ' || coalesce(new.name, '');
    if (new.name is distinct from old.name) then
      v_chg := jsonb_build_object('name', jsonb_build_object('old', to_jsonb(old.name), 'new', to_jsonb(new.name)));
    end if;
  end if;

  insert into public.audit_log(team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  values (null, v_actor, v_name, v_role, lower(tg_op), 'departments', v_id, v_sum, v_chg);

  return null;
exception when others then
  raise warning 'audit_departments failed [%]: %', sqlstate, sqlerrm;
  return null;
end
$function$;

drop trigger if exists trg_audit_departments on public.departments;
create trigger trg_audit_departments
  after insert or update or delete on public.departments
  for each row execute function public._audit_departments();

-- internal trigger function: never client-callable
revoke all on function public._audit_departments() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Denied-access logger — INTERNAL ONLY, and a DEFERRED feature.
--    Rejected administrative attempts require out-of-transaction logging through
--    an Edge Function or external logging service: a denial written inside an
--    RPC that then RAISEs is rolled back with that transaction, and exposing
--    this writer to the client would allow flooding the audit log. It is
--    therefore NOT granted to anon/authenticated and has no caller yet. The UI
--    does NOT claim rejected attempts are logged. Kept here so the out-of-band
--    caller can be added later without a new migration. It never stores request
--    bodies; detail is a bounded label only, actor is taken from auth.uid().
-- ----------------------------------------------------------------------------
create or replace function public.log_admin_access_denied(p_action text, p_detail text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_name  text;
  v_role  text;
begin
  if v_actor is not null then
    select coalesce(u.raw_user_meta_data->>'full_name', u.raw_app_meta_data->>'name', split_part(u.email, '@', 1)),
           coalesce(u.raw_app_meta_data->>'role', 'unknown')
      into v_name, v_role
      from auth.users u where u.id = v_actor;
  end if;

  insert into public.audit_log(team, actor_id, actor_name, actor_role, action, entity, entity_id, summary, changed)
  values (
    null, v_actor,
    coalesce(v_name, 'unknown'), coalesce(v_role, 'anonymous'),
    'access_denied', 'account', null,
    'محاولة وصول إداري مرفوضة: ' || left(coalesce(p_action, '—'), 60),
    case when p_detail is null then null
         else jsonb_build_object('detail', left(p_detail, 120)) end
  );
end
$function$;

-- internal / deferred: not client-callable (anon + authenticated + PUBLIC denied)
revoke all on function public.log_admin_access_denied(text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5) Account-lifecycle audit coverage.
--    Bodies below are the existing definitions, PRESERVED VERBATIM, with a
--    single _sa_audit(...) call added on the successful path. No logic change.
-- ----------------------------------------------------------------------------

-- 5a) create owner account -> account_create
create or replace function public.admin_create_owner(p_dept text, p_user text, p_pass text, p_name text)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth', 'extensions'
as $function$
declare uid uuid := gen_random_uuid(); em text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  if not exists (select 1 from public.departments where id = p_dept) then raise exception 'قسم غير موجود'; end if;
  if coalesce(p_user,'')='' or coalesce(p_pass,'')='' then raise exception 'الحقول مطلوبة'; end if;
  em := lower(p_user)||'@shift.local';
  if exists (select 1 from auth.users where email = em) then raise exception 'اسم المستخدم موجود مسبقاً'; end if;
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token)
   values('00000000-0000-0000-0000-000000000000',uid,'authenticated','authenticated',em,crypt(p_pass,gen_salt('bf')),now(),now(),now(),
     jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'role','owner','dept',p_dept),
     jsonb_build_object('username',p_user,'full_name',coalesce(p_name,'')),'','','','','','');
  insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
   values(uid::text,uid,jsonb_build_object('sub',uid::text,'email',em,'email_verified',true),'email',now(),now(),now());
  update public.settings set data = coalesce(data,'{}'::jsonb) || jsonb_build_object('deptHead', coalesce(p_name,''))
    where dept = p_dept;
  -- audit (added): record account creation without secrets
  perform public._sa_audit('account_create', 'account', public._audit_mask_id(uid::text),
    'أنشأ حساب رئيس قسم: ' || coalesce(p_name, p_user), jsonb_build_object('role','owner','dept',p_dept), null);
end $function$;

-- 5b) rename account -> account_rename
create or replace function public.admin_rename_account(p_user text, p_name text)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare em text; v_uid uuid;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  em := lower(p_user)||'@shift.local';
  update auth.users
    set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || jsonb_build_object('full_name', coalesce(p_name,'')),
        updated_at = now()
    where email = em
    returning id into v_uid;
  if not found then raise exception 'حساب غير موجود'; end if;
  -- audit (added)
  perform public._sa_audit('account_rename', 'account', public._audit_mask_id(v_uid::text),
    'غيّر اسم حساب إلى: ' || coalesce(p_name, ''), null, null);
end $function$;

-- 5c) delete account -> account_delete
create or replace function public.admin_delete_account(p_user text)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare em text; v_role text; v_uid uuid; v_disp text;
begin
  if not public.is_superadmin() then raise exception 'لمدير النظام فقط'; end if;
  em := lower(p_user)||'@shift.local';
  select id, raw_app_meta_data->>'role', coalesce(raw_user_meta_data->>'full_name', split_part(email,'@',1))
    into v_uid, v_role, v_disp
    from auth.users where email = em;
  if v_role is null then raise exception 'حساب غير موجود'; end if;
  if v_role = 'superadmin' then raise exception 'لا يمكن حذف مدير نظام من هنا'; end if;
  delete from auth.identities where user_id in (select id from auth.users where email = em);
  delete from auth.users where email = em;
  -- audit (added): record deletion (masked id, no email/secrets)
  perform public._sa_audit('account_delete', 'account', public._audit_mask_id(v_uid::text),
    'حذف حساب: ' || coalesce(v_disp, '') || ' (' || coalesce(v_role,'') || ')',
    jsonb_build_object('role', v_role), null);
end $function$;

-- ----------------------------------------------------------------------------
-- 6) Supporting index for audit search (action filter + newest-first order).
--    Existing indexes already cover at DESC, entity, actor, team.
-- ----------------------------------------------------------------------------
create index if not exists audit_log_action_id_idx on public.audit_log (action, id desc);

-- ----------------------------------------------------------------------------
-- 7) Superadmin audit search — paginated, filtered, sanitized. Superadmin only.
--    Returns { items, total, page, page_size, total_pages }. No raw metadata,
--    no email, no full UUID, no banned_until (shown as active label instead).
-- ----------------------------------------------------------------------------
create or replace function public.superadmin_search_audit_log(
  p_page      integer default 1,
  p_page_size integer default 30,
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_action    text default null,
  p_entity    text default null,
  p_team      text default null,
  p_search    text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_page      integer := greatest(coalesce(p_page, 1), 1);
  v_size      integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_offset    integer;
  v_total     bigint;
  v_search    text := nullif(btrim(coalesce(p_search, '')), '');
  v_items     jsonb;
begin
  if not public.is_superadmin() then
    raise exception 'forbidden: superadmin only' using errcode = '42501';
  end if;

  v_offset := (v_page - 1) * v_size;

  -- Total (same predicate as the page; all filters parameterized — no dynamic SQL)
  select count(*)
    into v_total
    from public.audit_log a
   where (p_from   is null or a.at >= p_from)
     and (p_to     is null or a.at <= p_to)
     and (p_action is null or a.action = p_action)
     and (p_entity is null or a.entity = p_entity)
     and (p_team   is null or a.team = p_team)
     and (v_search is null or a.summary ilike '%'||v_search||'%' or a.actor_name ilike '%'||v_search||'%');

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.id desc), '[]'::jsonb)
    into v_items
    from (
      select a.id,
             a.at,
             a.action,
             a.entity,
             public._audit_mask_id(a.entity_id) as entity_id,
             a.actor_name,
             a.actor_role,
             a.team,
             a.summary,
             public._audit_sanitize_json(a.changed) as changed
        from public.audit_log a
       where (p_from   is null or a.at >= p_from)
         and (p_to     is null or a.at <= p_to)
         and (p_action is null or a.action = p_action)
         and (p_entity is null or a.entity = p_entity)
         and (p_team   is null or a.team = p_team)
         and (v_search is null or a.summary ilike '%'||v_search||'%' or a.actor_name ilike '%'||v_search||'%')
       order by a.id desc
       limit v_size offset v_offset
    ) t;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'page', v_page,
    'page_size', v_size,
    'total_pages', case when v_total = 0 then 0 else ((v_total + v_size - 1) / v_size) end
  );
end
$function$;

-- external RPC: authenticated only (anon + PUBLIC denied); self-gated to superadmin
revoke all on function public.superadmin_search_audit_log(integer,integer,timestamptz,timestamptz,text,text,text,text) from public, anon, authenticated;
grant execute on function public.superadmin_search_audit_log(integer,integer,timestamptz,timestamptz,text,text,text,text) to authenticated;

-- ----------------------------------------------------------------------------
-- 8) Scope resolver (internal): returns the caller's allowed team list from the
--    trusted DB identity. superadmin -> all teams; owner -> teams in dept;
--    admin -> own team; anyone else / disabled -> forbidden.
-- ----------------------------------------------------------------------------
create or replace function public._report_scope_teams()
returns text[]
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role  text := public.audit_current_user_role();  -- null if disabled/anon
  v_dept  text;
  v_team  text;
  v_teams text[];
begin
  if v_role is null then
    raise exception 'forbidden' using errcode = '42501';
  elsif v_role = 'superadmin' then
    select array_agg(team) into v_teams from public.settings;
  elsif v_role = 'owner' then
    v_dept := public.audit_current_user_dept();
    if v_dept is null or btrim(v_dept) = '' then raise exception 'forbidden' using errcode = '42501'; end if;
    select array_agg(team) into v_teams from public.settings where dept = v_dept;
  elsif v_role = 'admin' then
    v_team := public.audit_current_user_team();
    if v_team is null or btrim(v_team) = '' then raise exception 'forbidden' using errcode = '42501'; end if;
    v_teams := array[v_team];
  else
    raise exception 'forbidden' using errcode = '42501';  -- viewer / employee / unknown
  end if;
  return coalesce(v_teams, array[]::text[]);
end
$function$;

-- internal helper: never client-callable (external report RPCs call it as definer)
revoke all on function public._report_scope_teams() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9) Report: employees + accounts/roles summary (role-scoped).
-- ----------------------------------------------------------------------------
create or replace function public.admin_reports_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_teams text[] := public._report_scope_teams();
  v_super boolean := public.is_superadmin();
  v jsonb;
begin
  select jsonb_build_object(
    'employees', jsonb_build_object(
      'total',            (select count(*) from public.employees e where e.team = any(v_teams)),
      -- archived rows are not team-tagged; expose the global count to superadmin only
      'archived',         case when v_super then (select count(*) from public.archived_employees) else null end,
      'without_account',  (select count(*) from public.employees e
                             where e.team = any(v_teams)
                               and not exists (select 1 from public.employee_auth ea where ea.emp_id = e.id)),
      'without_shift',    (select count(*) from public.employees e
                             where e.team = any(v_teams)
                               and (e.team is null or btrim(e.team) = ''
                                    or not exists (select 1 from public.settings s where s.team = e.team))),
      'by_shift', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'team', s.team,
                 'name', coalesce(s.data->>'teamName', s.team),
                 'dept', s.dept,
                 'count', (select count(*) from public.employees e where e.team = s.team)
               ) order by s.team)
        from public.settings s where s.team = any(v_teams)), '[]'::jsonb),
      'by_dept', coalesce((
        select jsonb_agg(x) from (
          select jsonb_build_object(
                   'dept', d.id, 'name', d.name,
                   'count', (select count(*) from public.employees e
                              join public.settings s on s.team = e.team
                              where s.dept = d.id and e.team = any(v_teams))
                 ) as x
          from public.departments d
          where exists (select 1 from public.settings s2 where s2.dept = d.id and s2.team = any(v_teams))
          order by d.id
        ) q), '[]'::jsonb)
    ),
    'accounts', jsonb_build_object(
      -- accounts scoped: superadmin=all; owner=dept; admin=team
      'without_employee', (select count(*) from auth.users u
                             where coalesce(u.raw_app_meta_data->>'role','viewer') = 'viewer'
                               and (v_super or u.raw_app_meta_data->>'team' = any(v_teams))
                               and not exists (select 1 from public.employee_auth ea where ea.user_id = u.id)),
      'disabled', (select count(*) from auth.users u
                     where u.banned_until is not null and u.banned_until > now()
                       and (v_super or u.raw_app_meta_data->>'team' = any(v_teams))),
      'missing_scope', (select count(*) from auth.users u
                          where (v_super or u.raw_app_meta_data->>'team' = any(v_teams))
                            and (u.raw_app_meta_data->>'role' is null or btrim(u.raw_app_meta_data->>'role') = ''
                                 or (coalesce(u.raw_app_meta_data->>'role','') in ('viewer','admin')
                                     and coalesce(u.raw_app_meta_data->>'team','') = ''))),
      'by_role', case when v_super then jsonb_build_object(
                     'superadmin', (select count(*) from auth.users where raw_app_meta_data->>'role'='superadmin'),
                     'owner',      (select count(*) from auth.users where raw_app_meta_data->>'role'='owner'),
                     'admin',      (select count(*) from auth.users where raw_app_meta_data->>'role'='admin'),
                     'viewer',     (select count(*) from auth.users where coalesce(raw_app_meta_data->>'role','viewer')='viewer'))
                   else jsonb_build_object(
                     'admin',  (select count(*) from auth.users where raw_app_meta_data->>'role'='admin' and raw_app_meta_data->>'team'=any(v_teams)),
                     'viewer', (select count(*) from auth.users where coalesce(raw_app_meta_data->>'role','viewer')='viewer' and raw_app_meta_data->>'team'=any(v_teams)))
                   end,
      'heads', case when v_super then coalesce((
                   select jsonb_agg(jsonb_build_object('dept', d.id, 'name', d.name,
                            'has_head', exists (select 1 from auth.users u where u.raw_app_meta_data->>'role'='owner' and u.raw_app_meta_data->>'dept'=d.id))
                          order by d.id)
                   from public.departments d), '[]'::jsonb)
                 else '[]'::jsonb end
    ),
    'scope', jsonb_build_object('role', public.audit_current_user_role(), 'teams', to_jsonb(v_teams))
  ) into v;
  return v;
end
$function$;

-- external RPC: authenticated only (anon + PUBLIC denied); self-gated by scope
revoke all on function public.admin_reports_summary() from public, anon, authenticated;
grant execute on function public.admin_reports_summary() to authenticated;

-- ----------------------------------------------------------------------------
-- 10) Report: leaves within a period (role-scoped).
-- ----------------------------------------------------------------------------
create or replace function public.admin_leave_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_teams text[] := public._report_scope_teams();
  v_from date := coalesce(p_from, (now() at time zone 'utc')::date - 365);
  v_to   date := coalesce(p_to,   (now() at time zone 'utc')::date);
  v jsonb;
begin
  if v_to < v_from then raise exception 'نطاق تاريخ غير صالح' using errcode = '22007'; end if;
  if v_to - v_from > 1100 then raise exception 'المدة كبيرة جداً' using errcode = '22003'; end if;

  with scoped as (
    select l.* from public.leaves l
    where l.team = any(v_teams) and l.from_date <= v_to and l.to_date >= v_from
  )
  select jsonb_build_object(
    'total',    (select count(*) from scoped),
    'pending',  (select count(*) from scoped where status = 'قيد الانتظار'),
    'approved', (select count(*) from scoped where status = 'معتمد'),
    'rejected', (select count(*) from scoped where status = 'مرفوض'),
    'avg_days', coalesce((select round(avg((to_date - from_date) + 1)::numeric, 1) from scoped), 0),
    'by_type', coalesce((
      select jsonb_agg(jsonb_build_object('type', type, 'count', c) order by c desc)
      from (select type, count(*) c from scoped group by type) q), '[]'::jsonb),
    'by_shift', coalesce((
      select jsonb_agg(jsonb_build_object('team', s.team, 'name', coalesce(s.data->>'teamName', s.team),
               'count', (select count(*) from scoped sc where sc.team = s.team)) order by s.team)
      from public.settings s where s.team = any(v_teams)), '[]'::jsonb),
    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', m, 'count', c) order by m)
      from (select to_char(from_date, 'YYYY-MM') m, count(*) c from scoped group by 1) q), '[]'::jsonb),
    'range', jsonb_build_object('from', v_from, 'to', v_to)
  ) into v;
  return v;
end
$function$;

-- external RPC: authenticated only (anon + PUBLIC denied); self-gated by scope
revoke all on function public.admin_leave_report(date, date) from public, anon, authenticated;
grant execute on function public.admin_leave_report(date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- 11) Report: leave balances for a year (role-scoped). Reuses fn_leave_balance;
--     does NOT reimplement balance logic. Aggregates + low/negative lists.
-- ----------------------------------------------------------------------------
create or replace function public.admin_balance_report(p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_teams text[] := public._report_scope_teams();
  v_year  integer := coalesce(p_year, extract(year from (now() at time zone 'utc'))::int);
  v jsonb;
begin
  with bal as (
    select e.id as emp_id, e.name, e.team, b.type, b.entitled_days,
           b.initial, b.carryover, b.adjustments, b.used, b.available, b.remaining
    from public.employees e
    cross join lateral public.fn_leave_balance(e.id, v_year) b
    where e.team = any(v_teams)
  )
  select jsonb_build_object(
    'year', v_year,
    'totals', jsonb_build_object(
      'entitled',    coalesce((select sum(entitled_days) from bal), 0),
      'used',        coalesce((select sum(used) from bal), 0),
      'adjustments', coalesce((select sum(adjustments) from bal), 0),
      'remaining',   coalesce((select sum(remaining) from bal), 0)
    ),
    'negative', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'team', team, 'type', type, 'remaining', remaining) order by remaining asc)
      from bal where remaining < 0), '[]'::jsonb),
    'low', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'team', team, 'type', type, 'remaining', remaining) order by remaining asc)
      from bal where remaining >= 0 and remaining <= 3), '[]'::jsonb),
    'by_shift', coalesce((
      select jsonb_agg(jsonb_build_object('team', t, 'used', u, 'remaining', r) order by t)
      from (select team t, sum(used) u, sum(remaining) r from bal group by team) q), '[]'::jsonb)
  ) into v;
  return v;
end
$function$;

-- external RPC: authenticated only (anon + PUBLIC denied); self-gated by scope
revoke all on function public.admin_balance_report(integer) from public, anon, authenticated;
grant execute on function public.admin_balance_report(integer) to authenticated;

-- ----------------------------------------------------------------------------
-- 12) Report: administrative activity from the audit log (role-scoped).
--     superadmin -> all rows; owner/admin -> rows for their team scope only.
--     Aggregate counts only (not the raw security log).
-- ----------------------------------------------------------------------------
create or replace function public.admin_activity_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_teams text[] := public._report_scope_teams();
  v_super boolean := public.is_superadmin();
  v_from date := coalesce(p_from, (now() at time zone 'utc')::date - 90);
  v_to   date := coalesce(p_to,   (now() at time zone 'utc')::date);
  v jsonb;
begin
  if v_to < v_from then raise exception 'نطاق تاريخ غير صالح' using errcode = '22007'; end if;

  with scoped as (
    select a.* from public.audit_log a
    where a.at::date between v_from and v_to
      and (v_super or a.team = any(v_teams))
  )
  select jsonb_build_object(
    'total', (select count(*) from scoped),
    'by_action', coalesce((
      select jsonb_agg(jsonb_build_object('action', action, 'count', c) order by c desc)
      from (select action, count(*) c from scoped group by action) q), '[]'::jsonb),
    'by_actor', coalesce((
      select jsonb_agg(jsonb_build_object('actor', actor_name, 'role', actor_role, 'count', c) order by c desc)
      from (select actor_name, actor_role, count(*) c from scoped group by actor_name, actor_role order by count(*) desc limit 15) q), '[]'::jsonb),
    'by_entity', coalesce((
      select jsonb_agg(jsonb_build_object('entity', entity, 'count', c) order by c desc)
      from (select entity, count(*) c from scoped group by entity) q), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'count', c) order by d)
      from (select at::date d, count(*) c from scoped group by 1) q), '[]'::jsonb),
    'account_changes', jsonb_build_object(
      'disabled', (select count(*) from scoped where action = 'account_disabled'),
      'enabled',  (select count(*) from scoped where action = 'account_enabled'),
      'scope',    (select count(*) from scoped where action = 'account_scope_update'),
      'heads',    (select count(*) from scoped where action in ('head_promote','head_remove','head_replace'))
    ),
    'range', jsonb_build_object('from', v_from, 'to', v_to)
  ) into v;
  return v;
end
$function$;

-- external RPC: authenticated only (anon + PUBLIC denied); self-gated by scope
revoke all on function public.admin_activity_report(date, date) from public, anon, authenticated;
grant execute on function public.admin_activity_report(date, date) to authenticated;
