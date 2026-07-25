#!/usr/bin/env bash
# =====================================================================
#  حارس تطابق مخطط: لوحة التشغيل اليومية (المرحلة السادسة)
#  يمنع رجوع خطأ scaffold-fidelity الذي أفشل التطبيق الأول على الإنتاج:
#  الهجرة كانت تشير إلى public.leaves.created_at وهو عمود غير موجود في
#  الإنتاج، فرفعت 42703 وأُلغيت المعاملة ذرّيًا.
#
#  الفكرة: نبني جدول leaves (والجداول المرجعية) من قائمة أعمدة الإنتاج
#  الفعلية — بلا created_at — ثم نطبّق ملف الهجرة. إن عاد أي مرجع لعمود
#  غير موجود على leaves، يفشل التطبيق ويفشل هذا الاختبار.
#
#  الاستخدام:  DATABASE_URL=postgres://... ./daily_operations_dashboard_schema.sh
#  المتطلّب:   psql وقاعدة اختبار قابلة للحذف (ليست الإنتاج). يُنشئ ويُسقط
#              مخططًا مؤقتًا خاصًّا به فلا يمسّ بيانات قائمة.
# =====================================================================
set -euo pipefail
: "${DATABASE_URL:?ضع DATABASE_URL لقاعدة اختبار (ليست الإنتاج)}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../migrations/20260726120000_daily_operations_dashboard.sql"
[ -f "$MIGRATION" ] || { echo "لم يُعثر على ملف الهجرة: $MIGRATION"; exit 1; }

SCHEMA="ops_schema_test_$$"
PSQL="psql -X -q -v ON_ERROR_STOP=1 $DATABASE_URL"

cleanup() { $PSQL -c "drop schema if exists $SCHEMA cascade;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== بناء مخطط مؤقت مطابق للإنتاج ($SCHEMA) — leaves بلا created_at =="
$PSQL <<SQL
create schema $SCHEMA;
set search_path to $SCHEMA, public;
-- auth.uid()/auth.users بديل خفيف داخل نفس المخطط للاختبار المعزول
create table $SCHEMA.users (id uuid primary key default gen_random_uuid(),
  raw_app_meta_data jsonb not null default '{}'::jsonb, banned_until timestamptz);

-- leaves: أعمدة الإنتاج الفعلية بالضبط (لا created_at)
create table $SCHEMA.leaves (
  id uuid primary key default gen_random_uuid(), emp_id uuid, type text not null,
  from_date date not null, to_date date not null, status text not null default 'معتمد',
  notes text default '', updated_at timestamptz default now(), team text not null default 'w1',
  balance_override boolean not null default false, balance_override_reason text,
  balance_override_by uuid, balance_override_at timestamptz, submitted_at timestamptz,
  decided_at timestamptz, decided_by uuid, decided_role text, reject_reason text,
  cancelled_via_request_id uuid);
create table $SCHEMA.employees (id uuid primary key default gen_random_uuid(), name text,
  emp_no text default '', cycle_start date, sort_order int default 0,
  updated_at timestamptz default now(), team text not null default 'w1');
create table $SCHEMA.settings (id int generated always as identity primary key,
  data jsonb not null default '{}', team text not null unique, dept text not null default 'd1');
create table $SCHEMA.departments (id text primary key, name text not null,
  created_at timestamptz not null default now());
create table $SCHEMA.employee_auth (emp_id uuid primary key, user_id uuid not null, team text not null);
create table $SCHEMA.leave_change_requests (id uuid primary key default gen_random_uuid(),
  leave_id uuid not null, request_type text not null, status text not null default 'pending',
  requested_by uuid, requested_at timestamptz not null default now(), reason text,
  created_at timestamptz not null default now());
SQL

echo "== توليد نسخة الهجرة معزولة داخل المخطط المؤقت =="
# نعيد كتابة public. و auth. إلى المخطط المؤقت + دوال البوّابة كي يطبَّق الملف بلا اعتماد على الإنتاج.
TMP_SQL="$(mktemp)"
trap 'rm -f "$TMP_SQL"; cleanup' EXIT
{
  echo "set search_path to $SCHEMA, public;"
  echo "create or replace function $SCHEMA._report_scope_teams() returns text[] language sql stable as \$\$ select array(select team from $SCHEMA.settings) \$\$;"
  echo "create or replace function $SCHEMA.audit_current_user_role() returns text language sql stable as \$\$ select 'superadmin'::text \$\$;"
  # وجّه مراجع public.* و auth.users إلى المخطط المؤقت
  sed -e "s/public\./$SCHEMA./g" -e "s/auth\.users/$SCHEMA.users/g" "$MIGRATION"
} > "$TMP_SQL"

echo "== تطبيق الهجرة — يجب أن ينجح دون 42703 =="
if $PSQL -f "$TMP_SQL"; then
  echo "PASS: تطبيق الهجرة نجح على مخطط مطابق للإنتاج (لا مرجع لعمود مفقود)."
else
  echo "FAIL: فشل تطبيق الهجرة — على الأرجح مرجع لعمود غير موجود في leaves (مثل created_at)."; exit 1
fi

echo "== تأكيد: leaves ما زال بلا created_at بعد التطبيق =="
HAS=$($PSQL -tA -c "select exists(select 1 from information_schema.columns where table_schema='$SCHEMA' and table_name='leaves' and column_name='created_at');")
[ "$HAS" = "f" ] && echo "PASS: leaves بلا created_at." || { echo "FAIL: ظهر عمود created_at على leaves."; exit 1; }

echo "ALL CHECKS PASSED"
