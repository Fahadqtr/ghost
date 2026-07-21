-- =====================================================================
--  إصلاح حسابات Auth الناقصة — الإنشاء (الأرقام 392 / 5552 / 2306 فقط)
--  المشروع المستهدف حصراً: shift-scheduler (fibkwudabuwfjqpyeeng)
--  (مراجعة فقط — لا يُطبَّق حتى موافقة منفصلة. شغّل Preflight أولاً.)
--
--  يعيد استخدام منطق public.shift_provision_user حرفياً (نفس الأعمدة، نفس
--  crypt(emp_no)، نفس app_metadata: role=viewer + الوردية، ونفس auth.identities)
--  فيبقى دخول الموظف بالرقم الوظيفي متوافقاً مع التطبيق تماماً.
--
--  خصائص: idempotent (يتخطّى أي بريد موجود)، لا يعدّل أي حساب قائم، وينشئ
--  auth.users + auth.identities داخل معاملة واحدة. يسجّل ما أنشأه في
--  public.auth_repair_batch ليحذفه الـRollback بدقّة (دون مساس بالموجود).
--  لا يُنشئ employee_auth ولا يربط user_id — ذلك يُترك للمرحلة الثانية.
-- =====================================================================
begin;
set local search_path to public, auth, extensions;   -- كما في الدالة الأصلية (crypt/gen_salt/auth)

-- جدول تتبّع ما أنشأه هذا الإصلاح (للـRollback الدقيق فقط)
create table if not exists public.auth_repair_batch (
  user_id    uuid primary key,
  emp_no     text not null,
  team       text,
  created_at timestamptz not null default now()
);

do $$
declare r record; v_uid uuid; em text;
begin
  for r in
    select id, name, emp_no, coalesce(team,'w1') as team
      from public.employees
     where emp_no in ('392','5552','2306')     -- الأرقام الثلاثة فقط، لا كل الموظفين
     order by emp_no
  loop
    em := 'e' || r.emp_no || '@shift.local';

    -- idempotent + عدم المساس بأي حساب موجود
    if exists (select 1 from auth.users where email = em) then
      raise notice 'تخطٍّ (البريد موجود مسبقاً) — emp_no=%', r.emp_no;
      continue;
    end if;

    v_uid := gen_random_uuid();

    -- === نفس منطق shift_provision_user حرفياً ===
    insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,email_change_token_current,reauthentication_token)
     values('00000000-0000-0000-0000-000000000000',v_uid,'authenticated','authenticated',em,crypt(r.emp_no,gen_salt('bf')),now(),now(),now(),
       jsonb_build_object('provider','email','providers',jsonb_build_array('email'),'role','viewer','team',coalesce(r.team,'w1')),
       jsonb_build_object('username','e'||r.emp_no,'full_name',r.name,'emp_no',r.emp_no),
       '','','','','','');
    insert into auth.identities(provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
     values(v_uid::text,v_uid,jsonb_build_object('sub',v_uid::text,'email',em,'email_verified',true),'email',now(),now(),now());
    -- === نهاية منطق provision ===

    insert into public.auth_repair_batch(user_id,emp_no,team) values (v_uid, r.emp_no, coalesce(r.team,'w1'));
    raise notice 'أُنشئ حساب viewer — emp_no=% الوردية=%', r.emp_no, coalesce(r.team,'w1');
  end loop;
end $$;

commit;
