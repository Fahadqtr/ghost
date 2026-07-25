#!/usr/bin/env bash
# =====================================================================
#  حارس توافق مخطط: أساس الحضور والانصراف (المرحلة السابعة)
#
#  يبني مخططًا مطابقًا للإنتاج (بلا جداول حضور مسبقة) على Postgres محلي/خدمة،
#  ثم يطبّق ملف الهجرة نفسه من مسار Git ويؤكّد:
#   • جدولان جديدان (attendance_sessions, attendance_history) وRLS مفعّل عليهما.
#   • 9 RPCs خارجية + 4 دوال داخلية بالاسم (=13).
#   • الفهارس المطلوبة ومنها الفهرس الفريد الجزئي للجلسة المفتوحة.
#   • المنح: خارجية=authenticated فقط؛ داخلية=لا أحد؛ الجداول بلا وصول مباشر.
#   • كل الدوال SECURITY DEFINER + search_path=''.
#   • صفر DML على الجداول التشغيلية بعد استدعاء دوال القراءة.
#   • الذرّية (خطأ مصطنع يترك صفر كائنات).
#   • اختبار سلبي (مرجع لعمود غير موجود يجب أن يفشل التطبيق).
#
#  الاستخدام:  DATABASE_URL=postgres://user:pass@host:port/db ./attendance_foundation_schema.sh
#  المتطلّب:   psql وقاعدة اختبار قابلة للكتابة (ليست الإنتاج). Schemas مؤقتة
#              فريدة لكل PID، وtrap تنظيف على أي خروج.
# =====================================================================
set -euo pipefail
: "${DATABASE_URL:?ضع DATABASE_URL لقاعدة اختبار (ليست الإنتاج)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20260727120000_attendance_foundation.sql"
[ -f "$MIGRATION" ] || { echo "لم يُعثر على ملف الهجرة: $MIGRATION"; exit 1; }

PID=$$
POS="att_pos_$PID"; NEG="att_neg_$PID"; ATOM="att_atom_$PID"
TMP_POS="$(mktemp --suffix=.sql)"; TMP_NEG="$(mktemp --suffix=.sql)"; TMP_ATOM="$(mktemp --suffix=.sql)"
PSQL="psql -X -q -v ON_ERROR_STOP=1 $DATABASE_URL"
PSQLA="psql -X -tA -q -v ON_ERROR_STOP=1 $DATABASE_URL"

cleanup() { local c=$?; for s in "$POS" "$NEG" "$ATOM"; do psql -X -q "$DATABASE_URL" -c "drop schema if exists $s cascade;" >/dev/null 2>&1 || true; done
  rm -f "$TMP_POS" "$TMP_NEG" "$TMP_ATOM" 2>/dev/null || true; exit $c; }
trap cleanup EXIT INT TERM
fail(){ echo "FAIL: $*"; exit 1; }; ok(){ echo "PASS: $*"; }

EXT_FNS=(attendance_check_in attendance_check_out get_my_attendance_status list_attendance_sessions get_attendance_summary list_attendance_anomalies get_attendance_timeline correct_attendance_session void_attendance_session)
INT_FNS=(_att_hist_json _att_audit _att_sessions_json _att_anomalies)
IDXS=(uq_attendance_one_open idx_attendance_emp_date idx_attendance_team_date_status idx_attendance_open idx_attendance_date idx_attendance_hist_session)

build_base() {
  local S="$1"
  $PSQL <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;
create schema $S;
create table $S.users (id uuid primary key default gen_random_uuid(), email text,
  raw_app_meta_data jsonb not null default '{}'::jsonb, banned_until timestamptz);
create table $S.employees (id uuid primary key default gen_random_uuid(), name text, emp_no text default '',
  cycle_start date, sort_order int default 0, updated_at timestamptz default now(), team text not null default 'w1');
create table $S.employee_auth (emp_id uuid primary key, user_id uuid not null, team text not null);
create table $S.settings (id int generated always as identity primary key, data jsonb not null default '{}',
  team text not null unique, dept text not null default 'd1');
create table $S.departments (id text primary key, name text not null, created_at timestamptz not null default now());
create table $S.leaves (id uuid primary key default gen_random_uuid(), emp_id uuid, type text, from_date date,
  to_date date, status text, team text, submitted_at timestamptz, updated_at timestamptz);
create table $S.audit_log (id bigint generated always as identity primary key, at timestamptz default now(),
  team text, actor_id uuid, actor_name text, actor_role text, action text, entity text, entity_id text, summary text, changed jsonb);
create table $S.notifications (id uuid primary key default gen_random_uuid(), user_id uuid, created_at timestamptz default now());
-- دوال بوّابة/هوية مصغّرة يستدعيها ملف الهجرة
create or replace function $S.audit_current_user_role() returns text language sql stable as \$f\$ select 'superadmin'::text \$f\$;
create or replace function $S.audit_current_emp_id() returns uuid language sql stable as \$f\$ select (select id from $S.employees limit 1) \$f\$;
create or replace function $S.audit_current_emp_team() returns text language sql stable as \$f\$ select (select team from $S.employees limit 1) \$f\$;
create or replace function $S._report_scope_teams() returns text[] language sql stable as \$f\$ select array(select team from $S.settings) \$f\$;
create or replace function $S.can_write_team(t text) returns boolean language sql stable as \$f\$ select true \$f\$;
create or replace function $S.uid() returns uuid language sql stable as \$f\$ select null::uuid \$f\$;
insert into $S.settings(data,team,dept) values ('{}','w1','d1');
insert into $S.employees(id,name,team) values ('a0000000-0000-0000-0000-0000000000a1','E1','w1');
insert into $S.departments(id,name) values ('d1','Q1');
SQL
}
render() { local S="$1" out="$2"; sed -e "s/public\./$S./g" -e "s/auth\.users/$S.users/g" -e "s/auth\.uid()/$S.uid()/g" "$MIGRATION" > "$out"; }

echo "== 1) بناء مخطط أساس مطابق للإنتاج ($POS) =="
build_base "$POS"
bf(){ $PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS';"; }
bi(){ $PSQLA -c "select count(*) from pg_indexes where schemaname='$POS';"; }
bt(){ $PSQLA -c "select count(*) from information_schema.tables where table_schema='$POS' and table_type='BASE TABLE';"; }
btr(){ $PSQLA -c "select count(*) from information_schema.triggers where trigger_schema='$POS';"; }
before_fns=$(bf); before_idx=$(bi); before_tbl=$(bt); before_trg=$(btr)

echo "== 2) تطبيق الهجرة (من مسار Git) =="
render "$POS" "$TMP_POS"
$PSQL -f "$TMP_POS" >/dev/null && ok "تطبيق الهجرة نجح."

echo "== 3) تأكيدات ما بعد التطبيق =="
# جدولان جديدان + RLS
for t in attendance_sessions attendance_history; do
  r=$($PSQLA -c "select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='$POS' and c.relname='$t';")
  [ "$r" = "t" ] || fail "RLS غير مفعّل على $t"; done
ok "الجدولان موجودان وRLS مفعّل."
for f in "${EXT_FNS[@]}"; do c=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f';"); [ "$c" -ge 1 ] || fail "دالة خارجية مفقودة: $f"; done
ok "9 دوال خارجية بالاسم."
for f in "${INT_FNS[@]}"; do c=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f';"); [ "$c" -ge 1 ] || fail "دالة داخلية مفقودة: $f"; done
ok "4 دوال داخلية بالاسم."
[ "$(( $(bf) - before_fns ))" = "13" ] || fail "زيادة الدوال != 13 (=$(( $(bf) - before_fns )))"; ok "زيادة الدوال الصافية = 13."
for i in "${IDXS[@]}"; do c=$($PSQLA -c "select count(*) from pg_indexes where schemaname='$POS' and indexname='$i';"); [ "$c" = "1" ] || fail "فهرس مفقود: $i"; done
ok "الفهارس الستة موجودة (ومنها الفريد الجزئي uq_attendance_one_open)."
# الفهرس الفريد الجزئي فعلاً partial + unique
pu=$($PSQLA -c "select indexdef from pg_indexes where schemaname='$POS' and indexname='uq_attendance_one_open';")
echo "$pu" | grep -qi "unique" && echo "$pu" | grep -qi "where (status = 'open" || fail "uq_attendance_one_open ليس فريدًا جزئيًا صحيحًا"
ok "الفهرس الفريد الجزئي للجلسة المفتوحة صحيح."
# لا جداول/Triggers إضافية غير المتوقّعة (نتوقّع +2 جدول، +0 trigger)
[ "$(( $(bt) - before_tbl ))" = "2" ] || fail "عدد الجداول الجديدة != 2"
[ "$(( $(btr) - before_trg ))" = "0" ] || fail "أُنشئ Trigger غير متوقّع"
ok "جدولان جديدان فقط، بلا Triggers."
# المنح
for f in "${EXT_FNS[@]}"; do
  read -r ae aa ap <<<"$($PSQLA -F' ' -c "select has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('public',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f' limit 1;")"
  [ "$ae" = "t" ] && [ "$aa" = "f" ] && [ "$ap" = "f" ] || fail "منح خاطئة لـ$f (a=$ae n=$aa p=$ap)"; done
ok "الخارجية: authenticated فقط."
for f in "${INT_FNS[@]}"; do
  read -r ae aa ap <<<"$($PSQLA -F' ' -c "select has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('public',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname='$f' limit 1;")"
  [ "$ae" = "f" ] && [ "$aa" = "f" ] && [ "$ap" = "f" ] || fail "الداخلية $f ممنوحة"; done
ok "الداخلية محرومة من كل الأدوار."
# لا وصول مباشر للجداول
for t in attendance_sessions attendance_history; do
  g=$($PSQLA -c "select count(*) from information_schema.role_table_grants where table_schema='$POS' and table_name='$t' and grantee in ('authenticated','anon');")
  [ "$g" = "0" ] || fail "وصول مباشر للجدول $t"; done
ok "الجداول بلا وصول مباشر للعميل (RPC فقط)."
# SECURITY DEFINER + search_path
sd=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$POS' and p.proname = any(array['attendance_check_in','attendance_check_out','get_my_attendance_status','list_attendance_sessions','get_attendance_summary','list_attendance_anomalies','get_attendance_timeline','correct_attendance_session','void_attendance_session','_att_hist_json','_att_audit','_att_sessions_json','_att_anomalies']) and p.prosecdef and exists(select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%') and not exists(select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c where c ~ 'search_path=.*[[:alnum:]]');")
[ "$sd" = "13" ] || fail "SECURITY DEFINER + search_path='' على $sd/13"; ok "13/13 SECURITY DEFINER + search_path=''."

echo "== 4) صفر DML بعد استدعاء دوال القراءة =="
$PSQL <<SQL >/dev/null
insert into $POS.attendance_sessions(employee_id,attendance_date,team,check_in_at,status)
  values ('a0000000-0000-0000-0000-0000000000a1', current_date, 'w1', now()-interval '1h', 'open');
SQL
d0=$($PSQLA -c "select (select count(*) from $POS.attendance_sessions)||'|'||(select count(*) from $POS.attendance_history)||'|'||(select count(*) from $POS.audit_log)||'|'||(select count(*) from $POS.notifications)||'|'||coalesce((select max(updated_at) from $POS.attendance_sessions)::text,'x');")
$PSQL <<SQL >/dev/null
select $POS.get_my_attendance_status();
select $POS.list_attendance_sessions(null,null,1,50);
select $POS.get_attendance_summary();
select $POS.list_attendance_anomalies(1,50);
SQL
d1=$($PSQLA -c "select (select count(*) from $POS.attendance_sessions)||'|'||(select count(*) from $POS.attendance_history)||'|'||(select count(*) from $POS.audit_log)||'|'||(select count(*) from $POS.notifications)||'|'||coalesce((select max(updated_at) from $POS.attendance_sessions)::text,'x');")
[ "$d0" = "$d1" ] || fail "تغيّرت البيانات بعد القراءة: $d0 -> $d1"; ok "صفر DML بعد دوال القراءة."

echo "== 5) الذرّية =="
build_base "$ATOM"; render "$ATOM" "$TMP_ATOM"
printf '\nDO $$ BEGIN RAISE EXCEPTION %sinjected%s; END $$;\n' "'" "'" >> "$TMP_ATOM"
if psql -X -q -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" -f "$TMP_ATOM" >/dev/null 2>&1; then fail "التطبيق مع الخطأ لم يفشل"; fi
af=$($PSQLA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='$ATOM' and p.proname like '%attendance%';")
at=$($PSQLA -c "select count(*) from information_schema.tables where table_schema='$ATOM' and table_name in ('attendance_sessions','attendance_history');")
[ "$af" = "0" ] && [ "$at" = "0" ] || fail "بقيت كائنات بعد rollback (fns=$af tbls=$at)"; ok "الذرّية: rollback كامل."

echo "== 6) اختبار سلبي: مرجع عمود غير موجود يجب أن يفشل =="
build_base "$NEG"; render "$NEG" "$TMP_NEG"
# احقن مرجعًا لعمود غير موجود على attendance_sessions داخل النسخة المؤقتة
sed -i "s/a.correction_count >= 3/a.nonexistent_col >= 3/" "$TMP_NEG"
grep -q "nonexistent_col" "$TMP_NEG" || fail "تعذّر حقن العمود المفقود"
neg="$(psql -X -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$TMP_NEG" 2>&1 || true)"
echo "$neg" | grep -qiE 'column .*nonexistent_col.* does not exist|42703' \
  && ok "الاختبار السلبي فشل كما هو متوقع." || fail "الاختبار السلبي لم يكتشف العمود المفقود"

echo ""; echo "ALL CHECKS PASSED"
