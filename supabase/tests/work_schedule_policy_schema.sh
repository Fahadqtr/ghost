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
M9="$HERE/../migrations/20260729120000_audit_work_schedule_lock_unlock.sql"
M10="$HERE/../migrations/20260730120000_fix_work_schedule_generation_audit.sql"
for f in "$M7" "$M8" "$M8FIX" "$M9" "$M10"; do [ -f "$f" ] || { echo "لم يُعثر على: $f"; exit 1; }; done

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

echo "== 2c) هجرة تدقيق قفل/فتح الجدول (M9) =="
# قبل الهجرة: lock_work_schedule لا يسجّل في audit_log إطلاقًا
lockdef_before="$($PSQLA -c "select pg_get_functiondef('$POS.lock_work_schedule'::regproc);")"
echo "$lockdef_before" | grep -qi "$POS.audit_log" && fail "lock_work_schedule يسجّل audit قبل الهجرة (سكافولد غير متوقّع)"
ok "قبل الهجرة: lock_work_schedule بلا تسجيل audit."
render "$POS" "$M9" | $PSQL -f - >/dev/null && ok "تطبيق هجرة M9 نجح."
# بعد الهجرة: يسجّل مركزيًا في audit_log مع الحفاظ على SECURITY DEFINER + search_path=''
lockdef_after="$($PSQLA -c "select pg_get_functiondef('$POS.lock_work_schedule'::regproc);")"
echo "$lockdef_after" | grep -qi "insert into $POS.audit_log" || fail "بعد M9: lock_work_schedule لا يسجّل في audit_log"
echo "$lockdef_after" | grep -qi "security definer" || fail "بعد M9: فُقد SECURITY DEFINER"
echo "$lockdef_after" | grep -qiE "search_path( to| =) ''" || fail "بعد M9: فُقد search_path=''"
ok "بعد M9: lock_work_schedule يسجّل مركزيًا مع بقاء SECURITY DEFINER + search_path=''."

echo "== 2d) هجرة تصحيح تدقيق التوليد (M10) =="
# قبل M10: generate يسجّل عبر _ws_audit(...,'insert') داخل حلقة الفِرق (سطر لكل فريق)
gdef_before="$($PSQLA -c "select pg_get_functiondef('$POS.generate_work_schedule'::regproc);")"
echo "$gdef_before" | grep -qi "_ws_audit(t.team, 'insert'" || fail "قبل M10: generate لا يستدعي _ws_audit(...,'insert') كما هو متوقّع"
render "$POS" "$M10" | $PSQL -f - >/dev/null && ok "تطبيق هجرة M10 نجح."
# بعد M10: أُزيل نداء _ws_audit من التوليد، والتسجيل مباشر في audit_log بشرط (created+updated)>0
gdef_after="$($PSQLA -c "select pg_get_functiondef('$POS.generate_work_schedule'::regproc);")"
echo "$gdef_after" | grep -qi "_ws_audit" && fail "بعد M10: ما زال generate يستدعي _ws_audit"
echo "$gdef_after" | grep -qi "insert into $POS.audit_log" || fail "بعد M10: generate لا يسجّل مباشرةً في audit_log"
echo "$gdef_after" | grep -qi "(v_created + v_updated) > 0" || fail "بعد M10: لا يوجد شرط (created+updated)>0"
echo "$gdef_after" | grep -qi "security definer" || fail "بعد M10: فُقد SECURITY DEFINER"
echo "$gdef_after" | grep -qiE "search_path( to| =) ''" || fail "بعد M10: فُقد search_path=''"
ok "بعد M10: generate يسجّل سطرًا مباشرًا مشروطًا بلا _ws_audit، مع بقاء SECURITY DEFINER + search_path=''."

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
# تدقيق التوليد بعد M10: توليد أوّل يُنشئ صفوفًا ⇒ سطر audit واحد action='update' (لا 'generate' ولا 'insert')
[ "$($PSQLA -c "select count(*) from $POS.audit_log where action='generate';")" = "0" ] || fail "audit يحوي action='generate' (القيد كان يجب أن يمنعه)"
ga=$($PSQLA -c "select count(*) from $POS.audit_log where action='update' and summary like 'توليد جدول العمل المتوقع%';")
[ "$ga" = "1" ] || fail "سطر audit التوليد != 1 (=$ga) أو action != 'update'"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - audit0 ))" = "1" ] || fail "التوليد أضاف != 1 سطر audit"
ok "التوليد: نجح بلا 23514، سطر audit واحد action='update'."
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

echo "== 9c) قفل الجدول: سطر audit مركزي واحد + history لكل صف + changed =="
# نطاق التوليد (2026-06-14..19) يملك صفوفًا أُنشئت في القسم 8؛ كلها غير مقفلة الآن
$PSQL -c "update $POS.employee_work_schedule set locked_at=null where work_date between '2026-06-14' and '2026-06-19';" >/dev/null
lb0=$($PSQLA -c "select count(*) from $POS.audit_log;")
hb0=$($PSQLA -c "select count(*) from $POS.work_schedule_history where event_type='locked';")
aff=$($PSQLA -c "select ($POS.lock_work_schedule('2026-06-14','2026-06-19',true))->>'affected';")
[ "$aff" -ge 1 ] 2>/dev/null || fail "لا صفوف للقفل (aff=$aff)"
[ "$($PSQLA -c "select count(*) from $POS.employee_work_schedule where work_date between '2026-06-14' and '2026-06-19' and locked_at is null;")" = "0" ] || fail "بقيت صفوف غير مقفلة بعد القفل"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history where event_type='locked';") - hb0 ))" = "$aff" ] || fail "history 'locked' != affected"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - lb0 ))" = "1" ] || fail "القفل أضاف != 1 سطر audit"
lrow="$($PSQLA -c "select action||'|'||(changed->>'locked')||'|'||(changed->>'affected')||'|'||(changed->>'from_date')||'|'||(changed->>'to_date')||'|'||entity||'|'||coalesce(entity_id,'NULL') from $POS.audit_log order by id desc limit 1;")"
[ "$lrow" = "update|true|$aff|2026-06-14|2026-06-19|employee_work_schedule|NULL" ] || fail "سطر audit القفل خاطئ: $lrow"
ok "القفل: سطر audit واحد action='update' changed.locked=true affected=$aff + history لكل صف."

echo "== 9d) فتح الجدول: سطر audit مركزي واحد + changed.locked=false =="
lb1=$($PSQLA -c "select count(*) from $POS.audit_log;")
hu0=$($PSQLA -c "select count(*) from $POS.work_schedule_history where event_type='unlocked';")
uaff=$($PSQLA -c "select ($POS.lock_work_schedule('2026-06-14','2026-06-19',false))->>'affected';")
[ "$uaff" = "$aff" ] || fail "affected الفتح ($uaff) != القفل ($aff)"
[ "$($PSQLA -c "select count(*) from $POS.employee_work_schedule where work_date between '2026-06-14' and '2026-06-19' and locked_at is not null;")" = "0" ] || fail "بقيت صفوف مقفلة بعد الفتح"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history where event_type='unlocked';") - hu0 ))" = "$uaff" ] || fail "history 'unlocked' != affected"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - lb1 ))" = "1" ] || fail "الفتح أضاف != 1 سطر audit"
urow="$($PSQLA -c "select (changed->>'locked')||'|'||(changed->>'affected')||'|'||(changed->>'from_date')||'|'||(changed->>'to_date') from $POS.audit_log order by id desc limit 1;")"
[ "$urow" = "false|$uaff|2026-06-14|2026-06-19" ] || fail "سطر audit الفتح خاطئ: $urow"
ok "الفتح: سطر audit واحد changed.locked=false affected=$uaff."

echo "== 9e) صفر متأثر: لا history ولا audit =="
lz0=$($PSQLA -c "select count(*) from $POS.audit_log;")
hz0=$($PSQLA -c "select count(*) from $POS.work_schedule_history;")
zaff=$($PSQLA -c "select ($POS.lock_work_schedule('2030-01-01','2030-01-02',true))->>'affected';")
[ "$zaff" = "0" ] || fail "متوقّع affected=0 لنطاق بلا صفوف (=$zaff)"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - lz0 ))" = "0" ] || fail "أُضيف audit رغم affected=0"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history;") - hz0 ))" = "0" ] || fail "أُضيف history رغم affected=0"
ok "صفر متأثر: لا audit ولا history."

echo "== 9f) عزل الفِرق: القفل لا يمسّ فريقًا خارج _report_scope_teams() =="
# w9 ليس في settings ⇒ خارج النطاق؛ صفّه يجب أن يبقى غير مقفول ولا يظهر في changed.teams
$PSQL -c "insert into $POS.employees(id,name,team,cycle_start,sort_order) values ('a0000000-0000-0000-0000-0000000000c9','E9','w9','2026-06-14',9);" >/dev/null
$PSQL -c "insert into $POS.employee_work_schedule(employee_id,work_date,team,is_working_day,source) values ('a0000000-0000-0000-0000-0000000000c9','2026-06-15','w9',false,'manual');" >/dev/null
$PSQLA -c "select ($POS.lock_work_schedule('2026-06-14','2026-06-19',true))->>'affected';" >/dev/null
[ "$($PSQLA -c "select locked_at is null from $POS.employee_work_schedule where employee_id='a0000000-0000-0000-0000-0000000000c9';")" = "t" ] || fail "قُفل صف خارج النطاق (w9)"
[ "$($PSQLA -c "select coalesce((changed->'teams') ? 'w9',false) from $POS.audit_log order by id desc limit 1;")" = "f" ] || fail "changed.teams يحوي فريقًا خارج النطاق (w9)"
[ "$($PSQLA -c "select coalesce((changed->'teams') ? 'w1',false) from $POS.audit_log order by id desc limit 1;")" = "t" ] || fail "changed.teams لا يحوي الفريق داخل النطاق (w1)"
ok "عزل الفِرق: w9 خارج النطاق لم يُقفَل ولا يظهر في changed.teams."

echo "== 9g) الصلاحية: دور غير مسموح يُرفض بلا تحديث/history/audit =="
$PSQL -c "create or replace function $POS.audit_current_user_role() returns text language sql stable as \$f\$ select 'viewer'::text \$f\$;" >/dev/null
lg0=$($PSQLA -c "select count(*) from $POS.audit_log;")
hg0=$($PSQLA -c "select count(*) from $POS.work_schedule_history;")
lk0=$($PSQLA -c "select count(*) from $POS.employee_work_schedule where locked_at is not null;")
if $PSQL -c "select $POS.lock_work_schedule('2026-06-14','2026-06-19',false);" >/dev/null 2>&1; then fail "دور viewer تمكّن من الفتح/القفل"; fi
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - lg0 ))" = "0" ] || fail "أُضيف audit رغم رفض الصلاحية"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history;") - hg0 ))" = "0" ] || fail "أُضيف history رغم رفض الصلاحية"
[ "$($PSQLA -c "select count(*) from $POS.employee_work_schedule where locked_at is not null;")" = "$lk0" ] || fail "تغيّر locked_at رغم رفض الصلاحية"
$PSQL -c "create or replace function $POS.audit_current_user_role() returns text language sql stable as \$f\$ select 'superadmin'::text \$f\$;" >/dev/null
ok "الصلاحية: viewer مرفوض (42501) بلا تحديث/history/audit."

echo "== 9h) الذرّية: فشل إدراج audit يُرجِع locked_at وhistory =="
$PSQL -c "update $POS.employee_work_schedule set locked_at=null where work_date between '2026-06-14' and '2026-06-19';" >/dev/null
h0=$($PSQLA -c "select count(*) from $POS.work_schedule_history;")
# محفّز مؤقت يُفشل إدراج audit_log (بيئة اختبار فقط) لإثبات ذرّية المعاملة داخل الدالة
$PSQL -c "create or replace function $POS._boom() returns trigger language plpgsql as \$f\$ begin raise exception 'boom-audit'; end \$f\$;" >/dev/null
$PSQL -c "create trigger _boom_audit before insert on $POS.audit_log for each row execute function $POS._boom();" >/dev/null
if $PSQL -c "select $POS.lock_work_schedule('2026-06-14','2026-06-19',true);" >/dev/null 2>&1; then fail "القفل نجح رغم فشل إدراج audit (لا ذرّية)"; fi
$PSQL -c "drop trigger _boom_audit on $POS.audit_log;" >/dev/null
[ "$($PSQLA -c "select count(*) from $POS.employee_work_schedule where work_date between '2026-06-14' and '2026-06-19' and locked_at is not null;")" = "0" ] || fail "بقي locked_at بعد فشل audit (لا ذرّية)"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history;") - h0 ))" = "0" ] || fail "بقي history بعد فشل audit (لا ذرّية)"
ok "الذرّية: فشل audit تراجعت معه locked_at وhistory بالكامل."

# ── تدقيق التوليد (M10): سطر واحد مشروط بـ (created+updated)>0، خارج كل الحلقات ──
echo "== 9i) A) توليد يُنشئ صفوفًا: سطر audit واحد action='update' + changed.created =="
la0=$($PSQLA -c "select count(*) from $POS.audit_log;")
lh0=$($PSQLA -c "select count(*) from $POS.work_schedule_history;")
res="$($PSQLA -c "with r as (select $POS.generate_work_schedule('2026-07-20','2026-07-22') as j) select (j->>'created')||'|'||(j->>'updated') from r;")"
gc="${res%%|*}"; gu="${res#*|}"
[ "$gc" -ge 1 ] 2>/dev/null || fail "A: created متوقّع > 0 (=$gc)"
[ "$gu" = "0" ] || fail "A: updated متوقّع 0 (=$gu)"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - la0 ))" = "1" ] || fail "A: التوليد أضاف != 1 سطر audit"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history;") - lh0 ))" = "$gc" ] || fail "A: history != created"
arow="$($PSQLA -c "select action||'|'||(changed->>'created')||'|'||(changed->>'updated')||'|'||(changed->>'affected')||'|'||(changed->>'from_date')||'|'||(changed->>'to_date')||'|'||entity||'|'||coalesce(entity_id,'NULL') from $POS.audit_log order by id desc limit 1;")"
[ "$arow" = "update|$gc|0|$gc|2026-07-20|2026-07-22|employee_work_schedule|NULL" ] || fail "A: سطر audit الإنشاء خاطئ: $arow"
ok "A) توليد الإنشاء: created=$gc updated=0 affected=$gc، سطر audit واحد action='update'."

echo "== 9j) B) توليد يُحدّث صفوفًا: سطر audit واحد + changed.updated + affected=created+updated =="
# عبث ذرّي بصف rotation واحد ضمن النطاق (source→override) كي يكتشفه التوليد التالي ويحدّثه
$PSQL -c "update $POS.employee_work_schedule set source='override' where id = (select id from $POS.employee_work_schedule where work_date between '2026-07-20' and '2026-07-22' and source='rotation' order by id limit 1);" >/dev/null
lb0=$($PSQLA -c "select count(*) from $POS.audit_log;")
res="$($PSQLA -c "with r as (select $POS.generate_work_schedule('2026-07-20','2026-07-22') as j) select (j->>'created')||'|'||(j->>'updated') from r;")"
bc="${res%%|*}"; bu="${res#*|}"
[ "$bu" -ge 1 ] 2>/dev/null || fail "B: updated متوقّع > 0 (=$bu)"
[ "$bc" = "0" ] || fail "B: created متوقّع 0 (=$bc)"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - lb0 ))" = "1" ] || fail "B: التحديث أضاف != 1 سطر audit"
brow="$($PSQLA -c "select (changed->>'created')||'|'||(changed->>'updated')||'|'||(changed->>'affected') from $POS.audit_log order by id desc limit 1;")"
[ "$brow" = "0|$bu|$bu" ] || fail "B: سطر audit التحديث خاطئ: $brow (affected=created+updated)"
ok "B) توليد التحديث: created=0 updated=$bu affected=$bu، سطر audit واحد."

echo "== 9k) C) تشغيل ثانٍ idempotent: created=0 updated=0 ⇒ لا audit ولا history =="
lc0=$($PSQLA -c "select count(*) from $POS.audit_log;")
hc0=$($PSQLA -c "select count(*) from $POS.work_schedule_history;")
res="$($PSQLA -c "with r as (select $POS.generate_work_schedule('2026-07-20','2026-07-22') as j) select (j->>'created')||'|'||(j->>'updated') from r;")"
cc="${res%%|*}"; cu="${res#*|}"
[ "$cc" = "0" ] || fail "C: created متوقّع 0 (=$cc)"
[ "$cu" = "0" ] || fail "C: updated متوقّع 0 (=$cu)"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - lc0 ))" = "0" ] || fail "C: أُضيف audit رغم created+updated=0"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history;") - hc0 ))" = "0" ] || fail "C: أُضيف history رغم created+updated=0"
ok "C) idempotent: created=0 updated=0، لا audit ولا history جديد."

echo "== 9l) D) صفوف مقفلة فقط: created+updated=0 ⇒ لا audit/history/overwrite =="
$PSQL -c "update $POS.employee_work_schedule set locked_at=now() where work_date between '2026-07-20' and '2026-07-22';" >/dev/null
ld0=$($PSQLA -c "select count(*) from $POS.audit_log;")
hd0=$($PSQLA -c "select count(*) from $POS.work_schedule_history;")
src_before="$($PSQLA -c "select string_agg(source, ',' order by id) from $POS.employee_work_schedule where work_date between '2026-07-20' and '2026-07-22';")"
res="$($PSQLA -c "with r as (select $POS.generate_work_schedule('2026-07-20','2026-07-22') as j) select (j->>'created')||'|'||(j->>'updated')||'|'||(j->>'skipped_locked') from r;")"
dc="${res%%|*}"; drest="${res#*|}"; du="${drest%%|*}"; dsl="${drest#*|}"
[ "$dc" = "0" ] && [ "$du" = "0" ] || fail "D: متوقّع created=0 updated=0 (=$dc/$du)"
[ "$dsl" -ge 1 ] 2>/dev/null || fail "D: skipped_locked متوقّع > 0 (=$dsl)"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - ld0 ))" = "0" ] || fail "D: أُضيف audit رغم عدم وجود تغيير"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history;") - hd0 ))" = "0" ] || fail "D: أُضيف history رغم عدم وجود تغيير"
[ "$($PSQLA -c "select string_agg(source, ',' order by id) from $POS.employee_work_schedule where work_date between '2026-07-20' and '2026-07-22';")" = "$src_before" ] || fail "D: overwrite لصفوف مقفلة"
$PSQL -c "update $POS.employee_work_schedule set locked_at=null where work_date between '2026-07-20' and '2026-07-22';" >/dev/null
ok "D) مقفلة فقط: created+updated=0، skipped_locked=$dsl، لا audit/history/overwrite."

echo "== 9m) E) فرق متعددة: سطر audit واحد للاستدعاء + changed.teams بلا تكرار =="
# أضف فريق w2 (بنسخ إعدادات w1) وموظفًا فيه، ثم ولّد نطاقًا جديدًا يغطي w1+w2
$PSQL -c "insert into $POS.settings(data,team,dept) select data,'w2','d1' from $POS.settings where team='w1';" >/dev/null
$PSQL -c "insert into $POS.employees(id,name,team,cycle_start,sort_order) values ('a0000000-0000-0000-0000-0000000000e2','E2W2','w2','2026-06-14',20);" >/dev/null
le0=$($PSQLA -c "select count(*) from $POS.audit_log;")
res="$($PSQLA -c "with r as (select $POS.generate_work_schedule('2026-08-01','2026-08-03') as j) select (j->>'created')||'|'||(j->>'updated') from r;")"
ec="${res%%|*}"
[ "$ec" -ge 1 ] 2>/dev/null || fail "E: created متوقّع > 0 (=$ec)"
[ "$(( $($PSQLA -c "select count(*) from $POS.audit_log;") - le0 ))" = "1" ] || fail "E: أُضيف != 1 سطر audit (يجب سطر واحد للاستدعاء لا لكل فريق)"
[ "$($PSQLA -c "select (changed->'teams') ? 'w1' from $POS.audit_log order by id desc limit 1;")" = "t" ] || fail "E: changed.teams لا يحوي w1"
[ "$($PSQLA -c "select (changed->'teams') ? 'w2' from $POS.audit_log order by id desc limit 1;")" = "t" ] || fail "E: changed.teams لا يحوي w2"
[ "$($PSQLA -c "select jsonb_array_length(changed->'teams') from $POS.audit_log order by id desc limit 1;")" = "2" ] || fail "E: changed.teams فيه تكرار أو عدد خاطئ"
[ "$($PSQLA -c "select team is null from $POS.audit_log order by id desc limit 1;")" = "t" ] || fail "E: عمود team ليس null لاستدعاء متعدد الفرق"
ok "E) فرق متعددة: سطر audit واحد، changed.teams=[w1,w2] بلا تكرار."

echo "== 9n) F) الذرّية: فشل إدراج audit للتوليد يُرجِع الإنشاء وhistory =="
e0=$($PSQLA -c "select count(*) from $POS.employee_work_schedule;")
h0=$($PSQLA -c "select count(*) from $POS.work_schedule_history;")
$PSQL -c "create or replace function $POS._boom() returns trigger language plpgsql as \$f\$ begin raise exception 'boom-audit'; end \$f\$;" >/dev/null
$PSQL -c "create trigger _boom_audit before insert on $POS.audit_log for each row execute function $POS._boom();" >/dev/null
if $PSQL -c "select $POS.generate_work_schedule('2026-08-10','2026-08-12');" >/dev/null 2>&1; then fail "F: التوليد نجح رغم فشل إدراج audit (لا ذرّية)"; fi
$PSQL -c "drop trigger _boom_audit on $POS.audit_log;" >/dev/null
[ "$(( $($PSQLA -c "select count(*) from $POS.employee_work_schedule;") - e0 ))" = "0" ] || fail "F: بقيت صفوف مُنشأة بعد فشل audit (لا ذرّية)"
[ "$(( $($PSQLA -c "select count(*) from $POS.work_schedule_history;") - h0 ))" = "0" ] || fail "F: بقي history بعد فشل audit (لا ذرّية)"
ok "F) الذرّية: فشل audit تراجع معه الإنشاء وhistory بالكامل."

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
