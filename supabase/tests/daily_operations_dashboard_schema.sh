#!/usr/bin/env bash
# =====================================================================
#  حارس توافق مخطط: لوحة التشغيل اليومية (المرحلة السادسة)
#
#  يمنع تكرار خطأ scaffold-fidelity الذي أفشل التطبيق الأول على الإنتاج:
#  الهجرة كانت تشير إلى public.leaves.created_at (عمود غير موجود على
#  الإنتاج) فرفعت 42703 وأُلغيت المعاملة ذرّيًا.
#
#  ماذا يفعل هذا الحارس (كله على Postgres محلي/خدمة، لا اتصال بالإنتاج):
#   1) يبني leaves + الجداول المرجعية من قائمة أعمدة الإنتاج الفعلية
#      (بلا created_at) داخل Schema مؤقتة فريدة.
#   2) يطبّق ملف الهجرة نفسه من مسار Git (لا نسخة داخل السكربت).
#   3) يؤكّد: 5 RPCs خارجية + 6 دوال داخلية (=11) بالاسم، و3 فهارس بالاسم،
#      وعدم إنشاء أي جدول/عمود/Trigger/View/MatView/Sequence/Policy إضافي،
#      وصفر DML، والمنح (خارجية=authenticated فقط، داخلية=لا أحد)،
#      وSECURITY DEFINER + search_path=''، وأن leaves بلا created_at وبكل
#      أعمدته الـ19.
#   4) يثبت الذرّية: خطأ مصطنع أثناء التطبيق يترك صفر كائنات.
#   5) اختبار سلبي: نسخة مؤقتة من الهجرة يُعاد فيها مرجع created_at يجب أن
#      يفشل تطبيقها؛ إن نجح يفشل الحارس.
#
#  الاستخدام:  DATABASE_URL=postgres://user:pass@host:port/db ./daily_operations_dashboard_schema.sh
#  المتطلّب:   psql وقاعدة اختبار قابلة للكتابة (ليست الإنتاج). يُنشئ Schemas
#              مؤقتة فريدة باسم يحوي PID ويحذفها عبر trap حتى عند الفشل.
# =====================================================================
set -euo pipefail
: "${DATABASE_URL:?ضع DATABASE_URL لقاعدة اختبار (ليست الإنتاج)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20260726120000_daily_operations_dashboard.sql"
[ -f "$MIGRATION" ] || { echo "لم يُعثر على ملف الهجرة: $MIGRATION"; exit 1; }

PID=$$
POS="ops_pos_$PID"      # مخطط التطبيق الإيجابي
NEG="ops_neg_$PID"      # مخطط الاختبار السلبي
ATOM="ops_atom_$PID"    # مخطط اختبار الذرّية
TMP_POS="$(mktemp --suffix=.sql)"
TMP_NEG="$(mktemp --suffix=.sql)"
TMP_ATOM="$(mktemp --suffix=.sql)"

PSQL="psql -X -q -v ON_ERROR_STOP=1 $DATABASE_URL"
PSQLA="psql -X -tA -q -v ON_ERROR_STOP=1 $DATABASE_URL"

cleanup() {
  local code=$?
  psql -X -q "$DATABASE_URL" -c "drop schema if exists $POS cascade;"  >/dev/null 2>&1 || true
  psql -X -q "$DATABASE_URL" -c "drop schema if exists $NEG cascade;"  >/dev/null 2>&1 || true
  psql -X -q "$DATABASE_URL" -c "drop schema if exists $ATOM cascade;" >/dev/null 2>&1 || true
  rm -f "$TMP_POS" "$TMP_NEG" "$TMP_ATOM" 2>/dev/null || true
  exit $code
}
trap cleanup EXIT INT TERM

fail() { echo "FAIL: $*"; exit 1; }
ok()   { echo "PASS: $*"; }

# أسماء الكائنات المتوقعة (من الهجرة نفسها، لا عدّ عام)
EXT_FNS=(get_daily_operations_dashboard list_daily_action_items list_today_leaves list_upcoming_leaves list_operational_alerts)
INT_FNS=(_ops_action_items _ops_alerts _ops_today_leaves _ops_upcoming_leaves _ops_ai_json _ops_alerts_json)
IDXS=(idx_leaves_ops_status_team_dates idx_leaves_pending_submitted idx_leaves_emp_overlap)
# أعمدة leaves الـ19 على الإنتاج (بلا created_at)
PROD_LEAVES_COLS="balance_override,balance_override_at,balance_override_by,balance_override_reason,cancelled_via_request_id,decided_at,decided_by,decided_role,emp_id,from_date,id,notes,reject_reason,status,submitted_at,team,to_date,type,updated_at"

# يبني مخطط أساس مطابق للإنتاج (بلا الهجرة) في المخطط المُمرّر
build_base() {
  local S="$1"
  $PSQL <<SQL
-- أدوار Supabase (Cluster-global؛ إنشاء إن غابت)
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;
create schema $S;
-- بديل auth.users داخل المخطط
create table $S.users (id uuid primary key default gen_random_uuid(),
  raw_app_meta_data jsonb not null default '{}'::jsonb, banned_until timestamptz);
-- leaves: أعمدة الإنتاج الـ19 بالضبط (لا created_at)
create table $S.leaves (
  id uuid primary key default gen_random_uuid(), emp_id uuid, type text not null,
  from_date date not null, to_date date not null, status text not null default 'معتمد',
  notes text default '', updated_at timestamptz default now(), team text not null default 'w1',
  balance_override boolean not null default false, balance_override_reason text,
  balance_override_by uuid, balance_override_at timestamptz, submitted_at timestamptz,
  decided_at timestamptz, decided_by uuid, decided_role text, reject_reason text,
  cancelled_via_request_id uuid);
create table $S.employees (id uuid primary key default gen_random_uuid(), name text,
  emp_no text default '', cycle_start date, sort_order int default 0,
  updated_at timestamptz default now(), team text not null default 'w1');
create table $S.settings (id int generated always as identity primary key,
  data jsonb not null default '{}', team text not null unique, dept text not null default 'd1');
create table $S.departments (id text primary key, name text not null,
  created_at timestamptz not null default now());
create table $S.employee_auth (emp_id uuid primary key, user_id uuid not null, team text not null);
create table $S.leave_change_requests (id uuid primary key default gen_random_uuid(),
  leave_id uuid not null, request_type text not null, status text not null default 'pending',
  requested_by uuid, requested_at timestamptz not null default now(), reason text,
  created_at timestamptz not null default now());
-- جداول تشغيلية لفحص صفر DML
create table $S.leave_history (id uuid primary key default gen_random_uuid(), leave_id uuid, event_type text, created_at timestamptz default now());
create table $S.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, created_at timestamptz default now());
create table $S.leave_decisions (id uuid primary key default gen_random_uuid(), leave_id uuid, created_at timestamptz default now());
create table $S.audit_log (id bigint generated always as identity primary key, at timestamptz default now());
create table $S.leave_ledger (id uuid primary key default gen_random_uuid(), created_at timestamptz default now());
-- دوال بوّابة مصغّرة (بديل _report_scope_teams / audit_current_user_role)
create or replace function $S._report_scope_teams() returns text[] language sql stable as \$fn\$ select array(select team from $S.settings) \$fn\$;
create or replace function $S.audit_current_user_role() returns text language sql stable as \$fn\$ select 'superadmin'::text \$fn\$;
SQL
}

# يحوّل الهجرة إلى المخطط المُمرّر (public.->S. و auth.users->S.users)
render_migration() { local S="$1" out="$2"; sed -e "s/public\./$S./g" -e "s/auth\.users/$S.users/g" "$MIGRATION" > "$out"; }

echo "==================== 1) بناء مخطط إيجابي مطابق للإنتاج ($POS) ===================="
build_base "$POS"
# لقطة كائنات قبل التطبيق
before_fns=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS';")
before_idx=$($PSQLA -c "select count(*) from pg_indexes where schemaname='$POS';")
before_tbl=$($PSQLA -c "select count(*) from information_schema.tables where table_schema='$POS' and table_type='BASE TABLE';")
before_trg=$($PSQLA -c "select count(*) from information_schema.triggers where trigger_schema='$POS';")
before_view=$($PSQLA -c "select count(*) from information_schema.views where table_schema='$POS';")
before_mv=$($PSQLA -c "select count(*) from pg_matviews where schemaname='$POS';")
before_seq=$($PSQLA -c "select count(*) from information_schema.sequences where sequence_schema='$POS';")
before_pol=$($PSQLA -c "select count(*) from pg_policies where schemaname='$POS';")
before_leavecols=$($PSQLA -c "select count(*) from information_schema.columns where table_schema='$POS' and table_name='leaves';")

echo "==================== 2) تطبيق الهجرة (من مسار Git) ===================="
render_migration "$POS" "$TMP_POS"
$PSQL -f "$TMP_POS" >/dev/null && ok "تطبيق الهجرة نجح دون 42703."

echo "==================== 3) تأكيدات ما بعد التطبيق ===================="
# 3.a أسماء الدوال الخارجية (5)
for f in "${EXT_FNS[@]}"; do
  c=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f';")
  [ "$c" -ge 1 ] || fail "دالة خارجية مفقودة: $f"
done
ext_count=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname in ('get_daily_operations_dashboard','list_daily_action_items','list_today_leaves','list_upcoming_leaves','list_operational_alerts');")
[ "$ext_count" = "5" ] || fail "عدد الدوال الخارجية = $ext_count (المتوقع 5)"; ok "5 دوال خارجية بالاسم."
# 3.b أسماء الدوال الداخلية (6)
for f in "${INT_FNS[@]}"; do
  c=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f';")
  [ "$c" -ge 1 ] || fail "دالة داخلية مفقودة: $f"
done
int_count=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname in ('_ops_action_items','_ops_alerts','_ops_today_leaves','_ops_upcoming_leaves','_ops_ai_json','_ops_alerts_json');")
[ "$int_count" = "6" ] || fail "عدد الدوال الداخلية = $int_count (المتوقع 6)"; ok "6 دوال داخلية بالاسم."
# 3.c مجموع دوال المرحلة 6 = 11 (زيادة صافية)
after_fns=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS';")
[ "$((after_fns - before_fns))" = "11" ] || fail "زيادة الدوال = $((after_fns-before_fns)) (المتوقع 11)"; ok "زيادة الدوال الصافية = 11."
# 3.d الفهارس الثلاثة بالاسم + زيادة صافية = 3
for i in "${IDXS[@]}"; do
  c=$($PSQLA -c "select count(*) from pg_indexes where schemaname='$POS' and indexname='$i';")
  [ "$c" = "1" ] || fail "فهرس مفقود: $i"
done
after_idx=$($PSQLA -c "select count(*) from pg_indexes where schemaname='$POS';")
[ "$((after_idx - before_idx))" = "3" ] || fail "زيادة الفهارس = $((after_idx-before_idx)) (المتوقع 3)"; ok "3 فهارس بالاسم + زيادة صافية = 3."
# 3.e لا كائنات إضافية (جدول/عمود/Trigger/View/MatView/Sequence/Policy)
after_tbl=$($PSQLA -c "select count(*) from information_schema.tables where table_schema='$POS' and table_type='BASE TABLE';")
after_trg=$($PSQLA -c "select count(*) from information_schema.triggers where trigger_schema='$POS';")
after_view=$($PSQLA -c "select count(*) from information_schema.views where table_schema='$POS';")
after_mv=$($PSQLA -c "select count(*) from pg_matviews where schemaname='$POS';")
after_seq=$($PSQLA -c "select count(*) from information_schema.sequences where sequence_schema='$POS';")
after_pol=$($PSQLA -c "select count(*) from pg_policies where schemaname='$POS';")
after_leavecols=$($PSQLA -c "select count(*) from information_schema.columns where table_schema='$POS' and table_name='leaves';")
[ "$before_tbl" = "$after_tbl" ]   || fail "أُنشئ جدول جديد ($before_tbl -> $after_tbl)"
[ "$before_trg" = "$after_trg" ]   || fail "أُنشئ Trigger جديد ($before_trg -> $after_trg)"
[ "$before_view" = "$after_view" ] || fail "أُنشئ View جديد ($before_view -> $after_view)"
[ "$before_mv" = "$after_mv" ]     || fail "أُنشئ Materialized View جديد ($before_mv -> $after_mv)"
[ "$before_seq" = "$after_seq" ]   || fail "أُنشئ Sequence جديد ($before_seq -> $after_seq)"
[ "$before_pol" = "$after_pol" ]   || fail "أُنشئت Policy جديدة ($before_pol -> $after_pol)"
[ "$before_leavecols" = "$after_leavecols" ] || fail "تغيّر عدد أعمدة leaves ($before_leavecols -> $after_leavecols)"
ok "لا كائنات إضافية (جداول/أعمدة/Triggers/Views/MatViews/Sequences/Policies)."
# 3.f leaves بلا created_at + كل الأعمدة الـ19
has_ca=$($PSQLA -c "select exists(select 1 from information_schema.columns where table_schema='$POS' and table_name='leaves' and column_name='created_at');")
[ "$has_ca" = "f" ] || fail "ظهر عمود created_at على leaves."
cols=$($PSQLA -c "select string_agg(column_name,',' order by column_name) from information_schema.columns where table_schema='$POS' and table_name='leaves';")
[ "$cols" = "$PROD_LEAVES_COLS" ] || fail "أعمدة leaves لا تطابق الإنتاج:\n  فعلي=$cols\n  متوقع=$PROD_LEAVES_COLS"
ok "leaves بلا created_at، وأعمدته الـ19 تطابق الإنتاج."
# 3.g المنح: خارجية=authenticated فقط؛ داخلية=لا أحد؛ الكل SECURITY DEFINER + search_path=''
for f in "${EXT_FNS[@]}"; do
  read -r ae aa ap <<<"$($PSQLA -F' ' -c "select has_function_privilege('authenticated',p.oid,'EXECUTE'), has_function_privilege('anon',p.oid,'EXECUTE'), has_function_privilege('public',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f' limit 1;")"
  [ "$ae" = "t" ] && [ "$aa" = "f" ] && [ "$ap" = "f" ] || fail "منح خاطئة لـ$f (auth=$ae anon=$aa public=$ap)"
done
ok "المنح الخارجية: authenticated فقط، anon/PUBLIC محظوران."
for f in "${INT_FNS[@]}"; do
  read -r ae aa ap <<<"$($PSQLA -F' ' -c "select has_function_privilege('authenticated',p.oid,'EXECUTE'), has_function_privilege('anon',p.oid,'EXECUTE'), has_function_privilege('public',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f' limit 1;")"
  [ "$ae" = "f" ] && [ "$aa" = "f" ] && [ "$ap" = "f" ] || fail "الدالة الداخلية $f ممنوحة لدور (auth=$ae anon=$aa public=$ap)"
done
ok "الدوال الداخلية محرومة من كل الأدوار."
# SECURITY DEFINER + search_path مثبّت وفارغ (المخزّن: search_path="")؛ نتحقق أنه مثبّت وبلا أي schema فعلي
secdef=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname in ('get_daily_operations_dashboard','list_daily_action_items','list_today_leaves','list_upcoming_leaves','list_operational_alerts','_ops_action_items','_ops_alerts','_ops_today_leaves','_ops_upcoming_leaves','_ops_ai_json','_ops_alerts_json') and p.prosecdef and exists(select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%') and not exists(select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where c ~ 'search_path=.*[[:alnum:]]');")
[ "$secdef" = "11" ] || fail "SECURITY DEFINER + search_path='' على $secdef/11 دالة فقط"
ok "11/11 SECURITY DEFINER + search_path=''."

echo "==================== 4) صفر DML بعد تشغيل كل RPCs ===================="
$PSQL <<SQL >/dev/null
insert into $POS.settings(data,team,dept) values ('{}','w1','d1');
insert into $POS.employees(id,name,team) values ('a0000000-0000-0000-0000-0000000000a1','E1','w1');
insert into $POS.leaves(id,emp_id,type,from_date,to_date,status,team,submitted_at,updated_at)
 values (gen_random_uuid(),'a0000000-0000-0000-0000-0000000000a1','سنوية',current_date,current_date+2,'قيد الانتظار','w1',now()-interval '2 hours',now()-interval '2 hours');
SQL
dml_before=$($PSQLA -c "select (select count(*) from $POS.leaves)||'|'||(select count(*) from $POS.leave_change_requests)||'|'||(select count(*) from $POS.leave_history)||'|'||(select count(*) from $POS.notifications)||'|'||(select count(*) from $POS.leave_decisions)||'|'||(select count(*) from $POS.audit_log)||'|'||(select count(*) from $POS.leave_ledger)||'|'||coalesce((select max(updated_at) from $POS.leaves)::text,'x');")
$PSQL <<SQL >/dev/null
do \$\$ begin perform set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111"}',false); end \$\$;
select $POS.get_daily_operations_dashboard();
select $POS.list_daily_action_items(1,50);
select $POS.list_today_leaves(null,1,50);
select $POS.list_upcoming_leaves(30,1,50);
select $POS.list_operational_alerts(1,50);
SQL
dml_after=$($PSQLA -c "select (select count(*) from $POS.leaves)||'|'||(select count(*) from $POS.leave_change_requests)||'|'||(select count(*) from $POS.leave_history)||'|'||(select count(*) from $POS.notifications)||'|'||(select count(*) from $POS.leave_decisions)||'|'||(select count(*) from $POS.audit_log)||'|'||(select count(*) from $POS.leave_ledger)||'|'||coalesce((select max(updated_at) from $POS.leaves)::text,'x');")
[ "$dml_before" = "$dml_after" ] || fail "تغيّرت البيانات بعد RPCs:\n  قبل=$dml_before\n  بعد=$dml_after"
ok "صفر DML بعد تشغيل كل RPCs (max(updated_at) ثابت)."

echo "==================== 5) الذرّية: خطأ مصطنع يترك صفر كائنات ===================="
build_base "$ATOM"
render_migration "$ATOM" "$TMP_ATOM"
printf '\nDO $$ BEGIN RAISE EXCEPTION %sinjected-atomicity-error%s; END $$;\n' "'" "'" >> "$TMP_ATOM"
# --single-transaction: أول خطأ يُلغي كل ما قبله
if psql -X -q -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" -f "$TMP_ATOM" >/dev/null 2>&1; then
  fail "التطبيق مع الخطأ المصطنع لم يفشل (متوقع فشل)."
fi
atom_fns=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$ATOM' and p.proname in ('get_daily_operations_dashboard','_ops_action_items','_ops_ai_json','_ops_alerts','list_operational_alerts');")
atom_idx=$($PSQLA -c "select count(*) from pg_indexes where schemaname='$ATOM' and indexname in ('idx_leaves_ops_status_team_dates','idx_leaves_pending_submitted','idx_leaves_emp_overlap');")
[ "$atom_fns" = "0" ] && [ "$atom_idx" = "0" ] || fail "بقيت كائنات بعد rollback (fns=$atom_fns idx=$atom_idx)"
ok "الذرّية مؤكّدة: rollback كامل (صفر دوال/فهارس)."

echo "==================== 6) اختبار سلبي: إعادة created_at يجب أن تفشل ===================="
build_base "$NEG"
render_migration "$NEG" "$TMP_NEG"
# إعادة مرجع created_at داخل تعبير coalesce (بحثًا بالنمط لا بالسطر) — النسخة المؤقتة فقط
sed -i 's/coalesce(l.submitted_at,l.updated_at)/coalesce(l.submitted_at,l.updated_at,l.created_at)/g' "$TMP_NEG"
grep -q 'l.created_at' "$TMP_NEG" || fail "تعذّر حقن created_at في النسخة السلبية (تغيّر نمط coalesce؟)."
neg_out="$(psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$TMP_NEG" 2>&1 || true)"
if echo "$neg_out" | grep -qiE 'column .*created_at.* does not exist|42703'; then
  ok "الاختبار السلبي فشل كما هو متوقع (عمود created_at غير موجود)."
else
  fail "الاختبار السلبي لم يفشل بخطأ العمود المفقود؛ الحارس لا يكتشف الرجوع.\n$neg_out"
fi

echo ""
echo "ALL CHECKS PASSED"
