#!/usr/bin/env bash
# =====================================================================
#  حارس الهجرة التصحيحية: تنظيف جداول العمل الزائدة (المرحلة 8)
#
#  يبني حالة تركيبية مطابقة لعطل الإنتاج (333 جدولًا للنطاق 2026-07-26..08-31،
#  9 موظفين يوميًا = 8 في w1 + 1 في w2، سياستان، بلا جلسات/قفل/manual) عبر
#  استدعاء generate_work_schedule الحقيقي، ثم يؤكّد:
#   • المسار الإيجابي: الهجرة تحذف 207/207 وتُبقي 126/126 (08-01..08-14).
#   • Rollback كامل (RAISE) وبقاء البيانات دون تغيير عند:
#       - صف out-of-range مقفول.
#       - صف out-of-range بمصدر manual.
#       - جلسة حضور مرتبطة بصف out-of-range.
#       - عدد out-of-range ≠ 207 (206).
#       - تاريخ out-of-range بغير event_type='generated'.
#   • No-op آمن على قاعدة نظيفة (0 خارج النطاق) — دون تغيير.
#
#  الاستخدام:  DATABASE_URL=postgres://user:pass@host:port/db ./work_schedule_cleanup_schema.sh
# =====================================================================
set -euo pipefail
: "${DATABASE_URL:?ضع DATABASE_URL لقاعدة اختبار (ليست الإنتاج)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
M7="$HERE/../migrations/20260727120000_attendance_foundation.sql"
M8="$HERE/../migrations/20260728120000_work_schedule_policy.sql"
M8FIX="$HERE/../migrations/20260728130000_work_schedule_policy_audit_fix.sql"
MCLEAN="$HERE/../migrations/20260728140000_cleanup_unintended_work_schedules.sql"
for f in "$M7" "$M8" "$M8FIX" "$MCLEAN"; do [ -f "$f" ] || { echo "لم يُعثر على: $f"; exit 1; }; done

PID=$$
PSQL="psql -X -q -v ON_ERROR_STOP=1 $DATABASE_URL"
A="psql -X -tA -q -v ON_ERROR_STOP=1 $DATABASE_URL"
SCHEMAS=()
cleanup(){ local c=$?; for s in "${SCHEMAS[@]:-}"; do psql -X -q "$DATABASE_URL" -c "drop schema if exists $s cascade;" >/dev/null 2>&1 || true; done; exit $c; }
trap cleanup EXIT INT TERM
fail(){ echo "FAIL: $*"; exit 1; }; ok(){ echo "PASS: $*"; }
render(){ sed -e "s/public\./$1./g" -e "s/auth\.users/$1.users/g" -e "s/auth\.uid()/$1.uid()/g" "$2"; }

# يبني مخطّطًا يحوي 333 جدولًا (9 موظفين × 37 يومًا) + 333 تاريخ + سياستين، بلا جلسات
build333(){ local S="$1"; SCHEMAS+=("$S")
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
-- فريقان: w1 (8 موظفين) + w2 (1 موظف)، نفس إعداد الدوران
insert into $S.settings(data,team,dept)
 select jsonb_build_object('scheduleStart','2026-06-14','workDays',6,'restDays',4,'startShift','صباح','minWorkers',3,
   'shiftTimes', jsonb_build_object('صباح','6:00 ص ← 1:00 م','عصر','1:00 م ← 9:00 م','ليل','9:00 م ← 6:00 ص')), t, 'd1'
 from (values ('w1'),('w2')) v(t);
insert into $S.departments(id,name) values ('d1','Q1');
insert into $S.users(id,email,raw_app_meta_data) values ('11111111-1111-1111-1111-111111111111','a@x','{"role":"superadmin"}');
insert into $S.employees(id,name,team,cycle_start,sort_order)
 select gen_random_uuid(), 'E'||g, 'w1', '2026-06-14', g from generate_series(1,8) g;
insert into $S.employees(id,name,team,cycle_start,sort_order) values (gen_random_uuid(),'W2','w2','2026-06-14',9);
SQL
render "$S" "$M7"    | $PSQL -f - >/dev/null
render "$S" "$M8"    | $PSQL -f - >/dev/null
render "$S" "$M8FIX" | $PSQL -f - >/dev/null
# سياستان (versioning صالح غير متداخل) — العدد فقط يهمّ التنظيف
$PSQL -c "insert into $S.attendance_policies(name,scope_type,grace_minutes,absence_cutoff_minutes,early_leave_grace_minutes,max_session_hours,effective_from,effective_to) values
  ('P','global',10,180,10,12,'2026-08-01','2026-08-13'),('P','global',10,180,10,12,'2026-08-14',null);" >/dev/null
# توليد النطاق الزائد الحقيقي 07-26..08-31 ⇒ 333 جدول + 333 تاريخ
$PSQL -c "select $S.generate_work_schedule('2026-07-26','2026-08-31');" >/dev/null
}

apply_clean(){ render "$1" "$MCLEAN" | psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f - 2>&1; }
cnt(){ $A -c "select count(*) from $1.$2;"; }

echo "== 1) بناء الحالة التركيبية (333/333/سياستان) =="
S="wsc_pos_$PID"; build333 "$S"
[ "$(cnt "$S" employee_work_schedule)" = "333" ] || fail "الجداول != 333 (=$(cnt "$S" employee_work_schedule))"
[ "$(cnt "$S" work_schedule_history)" = "333" ] || fail "التاريخ != 333"
[ "$(cnt "$S" attendance_policies)" = "2" ] || fail "السياسات != 2"
[ "$(cnt "$S" attendance_sessions)" = "0" ] || fail "توجد جلسات"
[ "$($A -c "select count(*) from $S.employee_work_schedule where work_date<'2026-08-01' or work_date>'2026-08-14';")" = "207" ] || fail "خارج النطاق != 207"
ok "الحالة التركيبية: 333/333، سياستان، 207 خارج النطاق."

echo "== 2) المسار الإيجابي: الهجرة تحذف 207 وتُبقي 126 =="
out="$(apply_clean "$S")" || { echo "$out"; fail "الهجرة الإيجابية فشلت"; }
[ "$(cnt "$S" employee_work_schedule)" = "126" ] || fail "بعد التنظيف الجداول != 126 (=$(cnt "$S" employee_work_schedule))"
[ "$(cnt "$S" work_schedule_history)" = "126" ] || fail "بعد التنظيف التاريخ != 126"
[ "$(cnt "$S" attendance_policies)" = "2" ] || fail "السياسات تغيّرت"
[ "$($A -c "select min(work_date)||'|'||max(work_date)||'|'||count(distinct work_date) from $S.employee_work_schedule;")" = "2026-08-01|2026-08-14|14" ] || fail "النطاق بعد التنظيف خطأ"
[ "$($A -c "select count(*) filter (where is_working_day)||'|'||count(*) filter (where not is_working_day) from $S.employee_work_schedule;")" = "72|54" ] || fail "working/off != 72/54"
[ "$($A -c "select count(*) filter (where team='w1')||'|'||count(*) filter (where team='w2') from $S.employee_work_schedule;")" = "112|14" ] || fail "توزيع الفرق != 112/14"
[ "$($A -c "select count(*) from (select 1 from $S.employee_work_schedule group by employee_id,work_date having count(*)>1) d;")" = "0" ] || fail "تكرارات بعد التنظيف"
ok "الإيجابي: 207 محذوف، 126 مُبقى (08-01..08-14، 72/54، w1=112/w2=14، بلا تكرار)."

# مُساعد rollback: يحقن شرطًا سيّئًا، يطبّق الهجرة (يجب أن تفشل)، ويؤكّد بقاء العدد
rollback_case(){ local name="$1" inject="$2" expect_sched="$3"; local Z="wsc_${4}_$PID"
  build333 "$Z"
  $PSQL -c "$(echo "$inject" | sed "s/@S@/$Z/g")" >/dev/null
  local before_s before_h res
  before_s="$(cnt "$Z" employee_work_schedule)"; before_h="$(cnt "$Z" work_schedule_history)"
  res="$(apply_clean "$Z" || true)"
  echo "$res" | grep -qiE 'CLEANUP_ABORT|ERROR' || fail "$name: الهجرة لم تفشل كما هو متوقّع"
  [ "$(cnt "$Z" employee_work_schedule)" = "$before_s" ] || fail "$name: تغيّر عدد الجداول رغم الفشل ($before_s -> $(cnt "$Z" employee_work_schedule))"
  [ "$(cnt "$Z" work_schedule_history)" = "$before_h" ] || fail "$name: تغيّر عدد التاريخ رغم الفشل"
  ok "$name: RAISE + Rollback كامل (بقي $before_s/$before_h)."
}

echo "== 3) Rollback: صف out-of-range مقفول =="
rollback_case "locked" "update @S@.employee_work_schedule set locked_at=now() where id=(select id from @S@.employee_work_schedule where work_date='2026-07-27' limit 1);" 333 lock

echo "== 4) Rollback: صف out-of-range بمصدر manual =="
rollback_case "manual" "update @S@.employee_work_schedule set source='manual' where id=(select id from @S@.employee_work_schedule where work_date='2026-08-20' limit 1);" 333 man

echo "== 5) Rollback: جلسة حضور مرتبطة بصف out-of-range =="
rollback_case "session" "insert into @S@.attendance_sessions(employee_id,attendance_date,team,check_in_at,status,schedule_id) select employee_id,work_date,team,now(),'open',id from @S@.employee_work_schedule where work_date='2026-07-28' limit 1;" 333 sess

echo "== 6) Rollback: عدد out-of-range = 206 (≠207) =="
rollback_case "count206" "delete from @S@.work_schedule_history where schedule_id=(select id from @S@.employee_work_schedule where work_date='2026-07-29' limit 1); delete from @S@.employee_work_schedule where id=(select id from @S@.employee_work_schedule where work_date='2026-07-29' limit 1);" 331 c206

echo "== 7) Rollback: تاريخ out-of-range بغير 'generated' =="
rollback_case "nongen-history" "update @S@.work_schedule_history set event_type='updated' where schedule_id=(select id from @S@.employee_work_schedule where work_date='2026-08-25' limit 1);" 333 nong

echo "== 8) No-op آمن على قاعدة نظيفة (0 خارج النطاق) =="
N="wsc_noop_$PID"; build333 "$N"
$PSQL -c "delete from $N.work_schedule_history h using $N.employee_work_schedule s where h.schedule_id=s.id and (s.work_date<'2026-08-01' or s.work_date>'2026-08-14'); delete from $N.employee_work_schedule where work_date<'2026-08-01' or work_date>'2026-08-14';" >/dev/null
[ "$(cnt "$N" employee_work_schedule)" = "126" ] || fail "تحضير no-op != 126"
noop="$(apply_clean "$N")" || { echo "$noop"; fail "No-op فشل (يجب أن ينجح دون تغيير)"; }
[ "$(cnt "$N" employee_work_schedule)" = "126" ] || fail "No-op غيّر الجداول"
[ "$(cnt "$N" work_schedule_history)" = "126" ] || fail "No-op غيّر التاريخ"
ok "No-op: قاعدة نظيفة تبقى 126/126 دون تغيير."

echo ""; echo "ALL CHECKS PASSED"
