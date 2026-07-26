#!/usr/bin/env bash
# =====================================================================
#  حارس توافق مخطط: جدول العمل المتوقع + سياسة الحضور (المرحلة الثامنة)
#
#  يبني مخطّطًا مطابقًا للإنتاج (سكافولد المراحل ≤6) ثم يطبّق هجرة المرحلة 7
#  (أساس الحضور) ثم هجرة المرحلة 8، ويؤكّد:
#   • 4 جداول جديدة + RLS مفعّل، بلا وصول مباشر للعميل.
#   • كل الدوال الخارجية/الداخلية بالاسم؛ خارجية=authenticated فقط،
#     داخلية=بلا أحد؛ كلها SECURITY DEFINER + search_path=''.
#   • Seed: 3 تعريفات ورديات (ومنها ليل ليلية)؛ 0 سياسات؛ 0 صفوف جدول.
#   • سلوك NULL الآمن: resolve=schedule_missing، وcheck-in بلا جدول يترك
#     expected/late = NULL (المرحلة 7 دون تغيير).
#   • رياضيات التأخير/الانصراف المبكر النقيّة.
#   • التوقيت والمناوبة الليلية.
#   • الذرّية (خطأ مصطنع يترك صفر كائنات جديدة).
#   • اختبار سلبي (مرجع عمود غير موجود يفشل التطبيق).
#   • صفر DML على الجداول بعد دوال القراءة.
#
#  الاستخدام:  DATABASE_URL=postgres://user:pass@host:port/db ./work_schedule_policy_schema.sh
# =====================================================================
set -euo pipefail
: "${DATABASE_URL:?ضع DATABASE_URL لقاعدة اختبار (ليست الإنتاج)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
M7="$HERE/../migrations/20260727120000_attendance_foundation.sql"
M8="$HERE/../migrations/20260728120000_work_schedule_policy.sql"
M8FIX="$HERE/../migrations/20260728130000_work_schedule_policy_audit_fix.sql"
for f in "$M7" "$M8" "$M8FIX"; do [ -f "$f" ] || { echo "لم يُعثر على: $f"; exit 1; }; done

PID=$$
POS="ws_pos_$PID"; NEG="ws_neg_$PID"; ATOM="ws_atom_$PID"
PSQL="psql -X -q -v ON_ERROR_STOP=1 $DATABASE_URL"
PSQLA="psql -X -tA -q -v ON_ERROR_STOP=1 $DATABASE_URL"
cleanup(){ local c=$?; for s in "$POS" "$NEG" "$ATOM"; do psql -X -q "$DATABASE_URL" -c "drop schema if exists $s cascade;" >/dev/null 2>&1 || true; done; exit $c; }
trap cleanup EXIT INT TERM
fail(){ echo "FAIL: $*"; exit 1; }; ok(){ echo "PASS: $*"; }

EXT_FNS=(generate_work_schedule update_employee_work_schedule lock_work_schedule get_work_schedule get_schedule_timeline list_shift_definitions upsert_shift_definition list_attendance_policies upsert_attendance_policy get_attendance_overview_v2)
INT_FNS=(_ws_hist_json _ws_audit _ws_rotation_code _ws_shift_def_at _ws_policy_at resolve_expected_schedule calculate_late_minutes calculate_early_leave_minutes)
NEW_TABLES=(shift_definitions attendance_policies employee_work_schedule work_schedule_history)

render(){ sed -e "s/public\./$1./g" -e "s/auth\.users/$1.users/g" -e "s/auth\.uid()/$1.uid()/g" "$2"; }

build_base(){ local S="$1"
$PSQL -c "drop schema if exists $S cascade; create schema $S;"
$PSQL <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;
create table $S.users (id uuid primary key default gen_random_uuid(), email text, raw_app_meta_data jsonb not null default '{}', banned_until timestamptz);
create table $S.employees (id uuid primary key default gen_random_uuid(), name text, emp_no text default '', cycle_start date, sort_order int default 0, updated_at timestamptz default now(), team text not null default 'w1');
create table $S.employee_auth (emp_id uuid primary key, user_id uuid not null, team text not null);
create table $S.settings (id int generated always as identity primary key, data jsonb not null default '{}', team text not null unique, dept text not null default 'd1');
create table $S.departments (id text primary key, name text not null, created_at timestamptz default now());
create table $S.overrides (emp_id uuid, day date, value text, team text, primary key(emp_id,day));
create table $S.leaves (id uuid primary key default gen_random_uuid(), emp_id uuid, type text, from_date date, to_date date, status text, team text, submitted_at timestamptz, updated_at timestamptz);
create table $S.audit_log (id bigint generated always as identity primary key, at timestamptz default now(), team text, actor_id uuid, actor_name text, actor_role text, action text, entity text, entity_id text, summary text, changed jsonb,
  constraint audit_log_action_check check (action = any (array['insert','update','delete','account_disabled','account_enabled','account_scope_update','head_promote','head_remove','head_replace','account_create','account_rename','account_delete','access_denied'])));
create table $S.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, created_at timestamptz default now());
create or replace function $S.audit_current_user_role() returns text language sql stable as \$f\$ select 'superadmin'::text \$f\$;
create or replace function $S.audit_current_user_dept() returns text language sql stable as \$f\$ select 'd1'::text \$f\$;
create or replace function $S.audit_current_user_team() returns text language sql stable as \$f\$ select 'w1'::text \$f\$;
create or replace function $S.audit_current_user_is_active() returns boolean language sql stable as \$f\$ select true \$f\$;
create or replace function $S.audit_current_emp_id() returns uuid language sql stable as \$f\$ select (select id from $S.employees order by sort_order limit 1) \$f\$;
create or replace function $S.audit_current_emp_team() returns text language sql stable as \$f\$ select (select team from $S.employees order by sort_order limit 1) \$f\$;
create or replace function $S._report_scope_teams() returns text[] language sql stable as \$f\$ select array(select team from $S.settings) \$f\$;
create or replace function $S.can_write_team(t text) returns boolean language sql stable as \$f\$ select true \$f\$;
create or replace function $S.is_superadmin() returns boolean language sql stable as \$f\$ select true \$f\$;
create or replace function $S.is_owner() returns boolean language sql stable as \$f\$ select false \$f\$;
create or replace function $S.audit_team_dept(t text) returns text language sql stable as \$f\$ select 'd1'::text \$f\$;
create or replace function $S.uid() returns uuid language sql stable as \$f\$ select (select id from $S.users limit 1) \$f\$;
insert into $S.settings(data,team,dept) values (
 jsonb_build_object('scheduleStart','2026-06-14','workDays',6,'restDays',4,'startShift','صباح','minWorkers',3,
   'shiftTimes', jsonb_build_object('صباح','6:00 ص ← 1:00 م','عصر','1:00 م ← 9:00 م','ليل','9:00 م ← 6:00 ص'),
   'holidays', jsonb_build_array(jsonb_build_object('date','2026-12-18','name','اليوم الوطني'))), 'w1','d1');
insert into $S.departments(id,name) values ('d1','Q1');
insert into $S.users(id,email,raw_app_meta_data) values ('11111111-1111-1111-1111-111111111111','a@x','{"role":"superadmin"}');
insert into $S.employees(id,name,team,cycle_start,sort_order) values ('a0000000-0000-0000-0000-0000000000a1','E1','w1','2026-06-14',1),('a0000000-0000-0000-0000-0000000000a2','E2','w1','2026-06-14',2);
insert into $S.employee_auth(emp_id,user_id,team) values ('a0000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','w1');
SQL
render "$S" "$M7" | $PSQL -f - >/dev/null   # المرحلة 7 (أساس الحضور)
}

echo "== 1) بناء الأساس + المرحلة 7 ($POS) =="
build_base "$POS"
bt(){ $PSQLA -c "select count(*) from information_schema.tables where table_schema='$POS' and table_type='BASE TABLE';"; }
btr(){ $PSQLA -c "select count(*) from information_schema.triggers where trigger_schema='$POS';"; }
before_tbl=$(bt); before_trg=$(btr)

echo "== 2) تطبيق هجرة المرحلة 8 =="
render "$POS" "$M8" | $PSQL -f - >/dev/null && ok "تطبيق الهجرة نجح."

echo "== 2b) قيد audit_log_action_check (مطابق للإنتاج) + الهجرة التصحيحية =="
# السكافولد يجب أن يرفض action='generate' (كالإنتاج) ويقبل 'insert' — لولا هذا لما اكتُشف العيب قبل التطبيق
if $PSQL -c "insert into $POS.audit_log(action,summary) values ('generate','probe');" >/dev/null 2>&1; then fail "السكافولد قَبِل action='generate' (قيد audit مفقود/ضعيف)"; fi
$PSQL -c "begin; insert into $POS.audit_log(action,summary) values ('insert','probe'); rollback;" >/dev/null || fail "السكافولد رفض action='insert' (قيد audit خاطئ)"
ok "قيد audit_log_action_check: يرفض 'generate' ويقبل 'insert'."
# قبل الإصلاح: الهجرة الأصلية تستدعي _ws_audit(...,'generate') (سيُخالف القيد على الإنتاج)
$PSQLA -c "select pg_get_functiondef('$POS.generate_work_schedule'::regproc);" | grep -qi "_ws_audit(t.team, 'generate'" \
  || fail "الهجرة الأصلية لا تستدعي _ws_audit(...,'generate') كما هو متوقّع للبرهنة"
ok "قبل الإصلاح: generate يستدعي _ws_audit(...,'generate') (مخالف للقيد)."
# تطبيق الهجرة التصحيحية (CREATE OR REPLACE فقط)
render "$POS" "$M8FIX" | $PSQL -f - >/dev/null && ok "تطبيق الهجرة التصحيحية نجح."
# بعد الإصلاح: generate يستدعي _ws_audit(...,'insert') ولا يستدعي 'generate' في نداء التدقيق
fdef="$($PSQLA -c "select pg_get_functiondef('$POS.generate_work_schedule'::regproc);")"
echo "$fdef" | grep -qi "_ws_audit(t.team, 'insert'" || fail "بعد الإصلاح: generate لا يستدعي _ws_audit(...,'insert')"
echo "$fdef" | grep -qi "_ws_audit(t.team, 'generate'" && fail "بعد الإصلاح: ما زال يستدعي _ws_audit(...,'generate')"
ok "بعد الإصلاح: نداء التدقيق يستخدم action='insert' فقط."

echo "== 3) الجداول الأربعة + RLS =="
for t in "${NEW_TABLES[@]}"; do
  r=$($PSQLA -c "select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='$POS' and c.relname='$t';")
  [ "$r" = "t" ] || fail "RLS غير مفعّل على $t"; done
[ "$(( $(bt) - before_tbl ))" = "4" ] || fail "عدد الجداول الجديدة != 4 (=$(( $(bt) - before_tbl )))"
[ "$(( $(btr) - before_trg ))" = "0" ] || fail "Trigger غير متوقّع"
ok "4 جداول جديدة + RLS، بلا Triggers."

echo "== 4) الدوال بالاسم =="
for f in "${EXT_FNS[@]}" "${INT_FNS[@]}"; do c=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f';"); [ "$c" -ge 1 ] || fail "دالة مفقودة: $f"; done
ok "10 خارجية + 8 داخلية بالاسم."

echo "== 5) المنح + SECURITY DEFINER =="
for f in "${EXT_FNS[@]}"; do
  read -r ae aa ap <<<"$($PSQLA -F' ' -c "select has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('public',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f' order by p.oid limit 1;")"
  [ "$ae" = "t" ] && [ "$aa" = "f" ] && [ "$ap" = "f" ] || fail "منح خاطئة لـ$f (a=$ae n=$aa p=$ap)"; done
ok "الخارجية: authenticated فقط."
for f in "${INT_FNS[@]}"; do
  read -r ae aa ap <<<"$($PSQLA -F' ' -c "select has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('public',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f' order by p.oid limit 1;")"
  [ "$ae" = "f" ] && [ "$aa" = "f" ] && [ "$ap" = "f" ] || fail "الداخلية $f ممنوحة"; done
ok "الداخلية محرومة من كل الأدوار."
allf="$(printf "'%s'," "${EXT_FNS[@]}" "${INT_FNS[@]}" | sed 's/,$//')"
sd=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname in ($allf) and p.prosecdef and exists(select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%' and c !~ 'search_path=.*[[:alnum:]]');")
[ "$sd" = "18" ] || fail "SECURITY DEFINER + search_path='' على $sd/18"; ok "18/18 SECURITY DEFINER + search_path=''."
for t in "${NEW_TABLES[@]}"; do g=$($PSQLA -c "select count(*) from information_schema.role_table_grants where table_schema='$POS' and table_name='$t' and grantee in ('authenticated','anon');"); [ "$g" = "0" ] || fail "وصول مباشر للجدول $t"; done
ok "الجداول بلا وصول مباشر للعميل."

echo "== 6) Seed: 3 تعريفات (ليل ليلية) + 0 سياسات + 0 صفوف جدول =="
[ "$($PSQLA -c "select count(*) from $POS.shift_definitions;")" = "3" ] || fail "تعريفات الورديات != 3"
[ "$($PSQLA -c "select is_overnight from $POS.shift_definitions where shift_code='ليل';")" = "t" ] || fail "ليل ليست ليلية"
[ "$($PSQLA -c "select is_overnight from $POS.shift_definitions where shift_code='صباح';")" = "f" ] || fail "صباح ليلية خطأً"
[ "$($PSQLA -c "select count(*) from $POS.attendance_policies;")" = "0" ] || fail "أُنشئت سياسة (يجب 0 — الحساب معطّل)"
[ "$($PSQLA -c "select count(*) from $POS.employee_work_schedule;")" = "0" ] || fail "أُنشئ جدول (يجب 0 — لا توليد)"
[ "$($PSQLA -c "select count(*) from $POS.work_schedule_history;")" = "0" ] || fail "أُنشئ سجل تاريخ"
ok "Seed كتالوج فقط؛ لا سياسات ولا جدول ولا Backfill."

echo "== 7) الفهرس الفريد + قيد يوم العمل + رياضيات التأخير =="
$PSQLA -c "select indexdef from pg_indexes where schemaname='$POS' and indexname='uq_ews_emp_date';" | grep -qi unique || fail "uq_ews_emp_date ليس فريدًا"
# قيد: يوم عمل بلا أوقات يجب أن يفشل
if $PSQL -c "insert into $POS.employee_work_schedule(employee_id,work_date,team,is_working_day,source) values ('a0000000-0000-0000-0000-0000000000a1',date '2026-06-14','w1',true,'rotation');" >/dev/null 2>&1; then fail "قُبل يوم عمل بلا أوقات"; fi
ok "قيد يوم-العمل-يتطلّب-أوقاتًا فعّال."
lm=$($PSQLA -c "select $POS.calculate_late_minutes('2026-06-16 06:00:00+03','2026-06-16 06:11:00+03',10)||','||$POS.calculate_late_minutes('2026-06-16 06:00:00+03','2026-06-16 06:09:00+03',10)||','||coalesce($POS.calculate_late_minutes(null,'2026-06-16 06:11:00+03',10)::text,'NULL')||','||$POS.calculate_early_leave_minutes('2026-06-16 13:00:00+03','2026-06-16 12:40:00+03',5);")
[ "$lm" = "1,0,NULL,15" ] || fail "رياضيات التأخير/المبكر خاطئة: $lm"; ok "التأخير(1/0/NULL) والانصراف المبكر(15) صحيحة."

echo "== 8) سلوك NULL الآمن + التوقيت/الليلية عبر التوليد =="
[ "$($PSQLA -c "select $POS.resolve_expected_schedule('a0000000-0000-0000-0000-0000000000a1','2026-06-14')->>'status';")" = "schedule_missing" ] || fail "resolve بلا snapshot != schedule_missing"
audit0=$($PSQLA -c "select count(*) from $POS.audit_log;")
$PSQL -c "select $POS.generate_work_schedule('2026-06-14','2026-06-19');" >/dev/null
# تدقيق التوليد: نجح بلا 23514 مع القيد المطابق للإنتاج؛ سطر واحد action='insert' (لا 'generate')
[ "$($PSQLA -c "select count(*) from $POS.audit_log where action='generate';")" = "0" ] || fail "audit يحوي action='generate' (القيد كان يجب أن يمنعه)"
ga=$($PSQLA -c "select count(*) from $POS.audit_log where action='insert' and summary like 'توليد جدول%';")
[ "$ga" = "1" ] || fail "سطر audit التوليد != 1 (=$ga) أو action != 'insert'"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - audit0 ))" = "1" ] || fail "التوليد أضاف != 1 سطر audit"
ok "التوليد: نجح بلا 23514، سطر audit واحد action='insert'."
# ليل 2026-06-18: نهاية على اليوم التالي 06:00 قطر
nq=$($PSQLA -c "select to_char(expected_start_at at time zone 'Asia/Qatar','HH24:MI')||'|'||to_char(expected_end_at at time zone 'Asia/Qatar','MM-DD HH24:MI')||'|'||is_overnight from $POS.employee_work_schedule where employee_id='a0000000-0000-0000-0000-0000000000a1' and work_date='2026-06-18';")
[ "$nq" = "21:00|06-19 06:00|true" ] || fail "الليلية/التوقيت خطأ: $nq"; ok "ليل 21:00→اليوم التالي 06:00 (ليلية)."
# check-in بلا سياسة: expected يُملأ لكن late يبقى NULL (لا سياسة)
$PSQL -c "update $POS.employee_work_schedule set work_date=(now() at time zone 'Asia/Qatar')::date where employee_id='a0000000-0000-0000-0000-0000000000a1' and work_date='2026-06-14';" >/dev/null
$PSQL -c "select $POS.attendance_check_in();" >/dev/null
lateNull=$($PSQLA -c "select late_minutes is null from $POS.attendance_sessions where employee_id='a0000000-0000-0000-0000-0000000000a1' order by check_in_at desc limit 1;")
[ "$lateNull" = "t" ] || fail "late محسوب رغم غياب السياسة"; ok "بلا سياسة: expected يُملأ وlate يبقى NULL."

echo "== 9) صفر DML بعد دوال القراءة =="
d0=$($PSQLA -c "select (select count(*) from $POS.employee_work_schedule)||'|'||(select count(*) from $POS.work_schedule_history)||'|'||(select count(*) from $POS.audit_log)||'|'||(select count(*) from $POS.attendance_sessions);")
$PSQL <<SQL >/dev/null
select $POS.get_work_schedule('2026-06-14','2026-06-19',null,1,50);
select $POS.get_attendance_overview_v2(null);
select $POS.list_shift_definitions(true);
select $POS.list_attendance_policies(true);
SQL
d1=$($PSQLA -c "select (select count(*) from $POS.employee_work_schedule)||'|'||(select count(*) from $POS.work_schedule_history)||'|'||(select count(*) from $POS.audit_log)||'|'||(select count(*) from $POS.attendance_sessions);")
[ "$d0" = "$d1" ] || fail "تغيّرت البيانات بعد القراءة: $d0 -> $d1"; ok "صفر DML بعد دوال القراءة."

echo "== 9b) حماية سباق الإنشاء + استجابة early_leave_minutes =="
A1='a0000000-0000-0000-0000-0000000000a1'; A2='a0000000-0000-0000-0000-0000000000a2'
# ثابت: فرع الإنشاء في update يستخدم on conflict do nothing (يمنع رجوع 23505)
$PSQLA -c "select pg_get_functiondef('$POS.update_employee_work_schedule'::regproc);" | grep -qi "on conflict (employee_id, work_date) do nothing" \
  || fail "update_employee_work_schedule بلا on-conflict (احتمال رجوع 23505)"
ok "update يستخدم on conflict do nothing."
SDID=$($PSQLA -c "select id from $POS.shift_definitions where shift_code='صباح' limit 1;")
# وظيفي: صف أنشأه طرف آخر مسبقًا (محاكاة فوز generate) ثم update لنفس (emp,date) -> بلا 23505، يصبح manual، صف واحد
$PSQL -c "insert into $POS.employee_work_schedule(employee_id,work_date,team,department,shift_definition_id,shift_code,is_working_day,expected_start_at,expected_end_at,source) values ('$A2','2026-07-15','w1','d1','$SDID','صباح',true, ('2026-07-15'::date+time '06:00') at time zone 'Asia/Qatar', ('2026-07-15'::date+time '13:00') at time zone 'Asia/Qatar','rotation');" >/dev/null
race_out="$($PSQL -c "select ($POS.update_employee_work_schedule('$A2','2026-07-15','$SDID',true,'race-followup'))->>'ok';" 2>&1)"
echo "$race_out" | grep -qiE '23505|duplicate key' && fail "update رفع 23505 خامًا على صف موجود (create-race)"
[ "$($PSQLA -c "select source from $POS.employee_work_schedule where employee_id='$A2' and work_date='2026-07-15';")" = "manual" ] || fail "update لم يطبّق manual على صف موجود"
[ "$($PSQLA -c "select count(*) from $POS.employee_work_schedule where employee_id='$A2' and work_date='2026-07-15';")" = "1" ] || fail "أكثر من صف لنفس (emp,date)"
ok "create-race: update على صف موجود -> بلا 23505، manual، صف واحد."
# استجابة check_out تتضمّن مفتاح early_leave_minutes (null بلا سياسة) — a1 لديه جلسة مفتوحة من القسم 8
$PSQL -c "update $POS.attendance_sessions set check_in_at=now()-interval '2 hours' where employee_id='$A1' and status='open';" >/dev/null
[ "$($PSQLA -c "select (($POS.attendance_check_out())::jsonb ? 'early_leave_minutes');")" = "t" ] \
  || fail "استجابة check_out لا تتضمّن مفتاح early_leave_minutes"
ok "check_out يتضمّن early_leave_minutes (null بلا سياسة)."
# مع سياسة+جدول: JSON == العمود وغير null
$PSQL -c "select $POS.upsert_attendance_policy('A','global',null,10,180,5,12,3,'2026-06-01');" >/dev/null
tday="$($PSQLA -c "select (now() at time zone 'Asia/Qatar')::date;")"
$PSQL -c "delete from $POS.attendance_history; delete from $POS.attendance_sessions;" >/dev/null
# صف جدول a1 لليوم مع سياسة+أوقات (on conflict do update — لا حذف: FK يمنع مسح جدول له تاريخ)
$PSQL -c "insert into $POS.employee_work_schedule(employee_id,work_date,team,department,shift_definition_id,policy_id,shift_code,is_working_day,expected_start_at,expected_end_at,source) select '$A1','$tday','w1','d1','$SDID',(select id from $POS.attendance_policies where scope_type='global' and effective_to is null limit 1),'صباح',true, now()-interval '1 hour', now()+interval '30 minutes','rotation' on conflict (employee_id,work_date) do update set policy_id=excluded.policy_id, shift_definition_id=excluded.shift_definition_id, shift_code='صباح', is_working_day=true, expected_start_at=excluded.expected_start_at, expected_end_at=excluded.expected_end_at;" >/dev/null
$PSQL -c "select $POS.attendance_check_in();" >/dev/null
$PSQL -c "update $POS.attendance_sessions set check_in_at=now()-interval '2 hours' where employee_id='$A1' and status='open';" >/dev/null
jval="$($PSQLA -c "select ($POS.attendance_check_out())->>'early_leave_minutes';")"
cval="$($PSQLA -c "select early_leave_minutes from $POS.attendance_sessions where employee_id='$A1' order by check_out_at desc limit 1;")"
[ -n "$jval" ] && [ "$jval" = "$cval" ] || fail "early_leave_minutes: JSON($jval) != column($cval) أو null"
ok "check_out: early_leave_minutes في JSON يطابق العمود ($jval)."

echo "== 10) الذرّية =="
build_base "$ATOM"; { render "$ATOM" "$M8"; printf '\nDO $$ BEGIN RAISE EXCEPTION %sinjected%s; END $$;\n' "'" "'"; } > /tmp/ws_atom_$PID.sql
if psql -X -q -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" -f /tmp/ws_atom_$PID.sql >/dev/null 2>&1; then fail "التطبيق مع الخطأ لم يفشل"; fi
at=$($PSQLA -c "select count(*) from information_schema.tables where table_schema='$ATOM' and table_name in ('shift_definitions','attendance_policies','employee_work_schedule','work_schedule_history');")
[ "$at" = "0" ] || fail "بقيت جداول بعد rollback ($at)"; rm -f /tmp/ws_atom_$PID.sql; ok "الذرّية: rollback كامل."

echo "== 11) اختبار سلبي (عمود غير موجود) =="
build_base "$NEG"; render "$NEG" "$M8" | sed "s/d.effective_from <= p_date/d.nonexistent_col <= p_date/" > /tmp/ws_neg_$PID.sql
grep -q nonexistent_col /tmp/ws_neg_$PID.sql || fail "تعذّر حقن العمود"
neg="$(psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f /tmp/ws_neg_$PID.sql 2>&1 || true)"; rm -f /tmp/ws_neg_$PID.sql
echo "$neg" | grep -qiE 'nonexistent_col.*does not exist|42703' && ok "الاختبار السلبي فشل كما هو متوقع." || fail "لم يُكتشف العمود المفقود"

echo ""; echo "ALL CHECKS PASSED"
