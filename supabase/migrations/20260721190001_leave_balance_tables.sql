-- =====================================================================
--  المرحلة ٢ — أرصدة الإجازات | 1/8: الجداول والربط الآمن بالهوية
--  (مراجعة فقط — لا يُطبَّق على الإنتاج حتى موافقة منفصلة)
--
--  يضيف:
--   • employee_auth: ربط tamper-proof بين موظف Auth (auth.uid) والموظف.
--   • حقول تجاوز الرصيد على leaves.
--   • leave_policies / leave_ledger / archived_leave_ledger.
--   • فهارس الأداء.
--  RLS تُفعَّل في 2/8. الدوال في 3/8.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- (أ) ربط الهوية الآمن: auth.uid() ← الموظف
--     لا نعتمد على emp_no/team من العميل (قابلة للتلاعب من user_metadata).
--     employee_auth يُملأ من مشغّل التزويد (SECURITY DEFINER) فقط.
-- ---------------------------------------------------------------------
create table if not exists public.employee_auth (
  emp_id  uuid primary key references public.employees(id) on delete cascade,
  user_id uuid not null,
  team    text not null
);
create unique index if not exists employee_auth_user_idx on public.employee_auth(user_id);

-- تعبئة أولية للموظفين الحاليين عبر نمط بريد التزويد e{emp_no}@shift.local
insert into public.employee_auth(emp_id, user_id, team)
select e.id, u.id, e.team
from public.employees e
join auth.users u on u.email = 'e' || e.emp_no || '@shift.local'
where e.emp_no is not null and e.emp_no <> ''
on conflict (emp_id) do nothing;

-- توسيع مشغّل التزويد ليملأ employee_auth (يحافظ على كامل سلوكه السابق)
create or replace function public.shift_provision_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth', 'extensions'
as $function$
declare v_uid uuid; em text := 'e'||NEW.emp_no||'@shift.local';
begin
  if NEW.emp_no is null or NEW.emp_no = '' then return NEW; end if;

  select id into v_uid from auth.users where email = em;
  if v_uid is null then
    v_uid := gen_random_uuid();
    insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token)
     values('00000000-0000-0000-0000-000000000000',v_uid,'authenticated','authenticated',em,crypt(NEW.emp_no,gen_salt('bf')),now(),now(),now(),
       jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'role','viewer','team',coalesce(NEW.team,'w1')),
       jsonb_build_object('username','e'||NEW.emp_no,'full_name',NEW.name,'emp_no',NEW.emp_no),
       '','','','','','');
    insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
     values(v_uid::text,v_uid,jsonb_build_object('sub',v_uid::text,'email',em,'email_verified',true),'email',now(),now(),now());
  end if;

  -- الربط الآمن (لا يعتمد عليه المستخدم؛ يُكتب بصلاحية definer فقط)
  insert into public.employee_auth(emp_id,user_id,team)
    values(NEW.id, v_uid, coalesce(NEW.team,'w1'))
    on conflict (emp_id) do update set user_id = excluded.user_id, team = excluded.team;

  return NEW;
end $function$;

-- ---------------------------------------------------------------------
-- (ب) حقول تجاوز الرصيد على leaves (توثيق التجاوز — لا يمثّل رصيداً)
-- ---------------------------------------------------------------------
alter table public.leaves
  add column if not exists balance_override        boolean not null default false,
  add column if not exists balance_override_reason text,
  add column if not exists balance_override_by      uuid,
  add column if not exists balance_override_at      timestamptz;

-- ---------------------------------------------------------------------
-- (ج) سياسات الرصيد (وردية/سنة/نوع)
-- ---------------------------------------------------------------------
create table if not exists public.leave_policies (
  id             bigint generated always as identity primary key,
  team           text not null,
  year           int  not null,
  type           text not null,
  policy_mode    text not null default 'limited'
                   check (policy_mode in ('limited','unlimited','tracking_only')),
  entitled_days  int  check (entitled_days is null or entitled_days >= 0),
  max_carryover  int  not null default 0 check (max_carryover >= 0),
  day_count_basis text not null default 'calendar'
                   check (day_count_basis in ('calendar','scheduled_workdays')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  unique (team, year, type)
);
create index if not exists leave_policies_lookup_idx on public.leave_policies(team, year);

-- ---------------------------------------------------------------------
-- (د) دفتر قيود الرصيد (إضافة-فقط): initial / adjustment / carryover
--     التصحيح بقيد معاكس؛ لا UPDATE/DELETE من الواجهة.
-- ---------------------------------------------------------------------
create table if not exists public.leave_ledger (
  id          uuid primary key default gen_random_uuid(),   -- مفتاح idempotency يولّده العميل
  team        text not null,
  emp_id      uuid not null,
  year        int  not null,
  type        text not null,
  kind        text not null check (kind in ('initial','adjustment','carryover')),
  days        numeric(5,1) not null check (days <> 0),        -- لا قيد بصفر
  source_year int,                       -- للترحيل: السنة المُرحَّل منها
  reason      text not null default '',
  created_by  uuid,
  created_at  timestamptz not null default now(),
  -- source_year مطلوب للترحيل فقط، وممنوع لغيره
  constraint leave_ledger_source_year_ck check ((kind = 'carryover') = (source_year is not null))
);
create index if not exists leave_ledger_lookup_idx on public.leave_ledger(team, emp_id, year, type);
-- initial idempotent: قيد ابتدائي واحد لكل (موظف، سنة، نوع)
create unique index if not exists leave_ledger_initial_uniq
  on public.leave_ledger(emp_id, year, type)
  where kind = 'initial';
-- ترحيل idempotent: قيد واحد لكل (موظف، من سنة → إلى سنة، نوع)
create unique index if not exists leave_ledger_carryover_uniq
  on public.leave_ledger(emp_id, source_year, year, type)
  where kind = 'carryover';

-- ---------------------------------------------------------------------
-- (هـ) أرشفة قيود الموظف المحذوف (بيانات لازمة فقط، بلا أسرار)
-- ---------------------------------------------------------------------
create table if not exists public.archived_leave_ledger (
  id          uuid,
  team        text,
  emp_id      uuid,
  year        int,
  type        text,
  kind        text,
  days        numeric(5,1),
  source_year int,
  reason      text,
  created_by  uuid,
  created_at  timestamptz,
  archived_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- (و) فهرس اشتقاق «المستخدَم» من الإجازات المعتمدة
-- ---------------------------------------------------------------------
create index if not exists leaves_balance_idx
  on public.leaves(team, emp_id, status, from_date);

commit;
