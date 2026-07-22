#!/usr/bin/env bash
# =====================================================================
#  اختبار تزامن حقيقي (جلستان منفصلتان) لقفل اعتماد الرصيد.
#  يُشغَّل بعد تطبيق migrations 0..8 على بيئة اختبار/staging (لا الإنتاج).
#  يثبت أنّ اعتمادين متزامنين لنفس (emp,type,year) يتسلسلان عبر
#  pg_advisory_xact_lock، فيمنع تجاوز الرصيد (double-spend).
#
#  الاستخدام:  DATABASE_URL=postgres://... ./leave_balance_concurrency.sh
#  المتطلّب:   psql. لا يُشغَّل هنا آلياً (القاعدة غير مُهاجَرة بعد).
# =====================================================================
set -euo pipefail
: "${DATABASE_URL:?ضع DATABASE_URL لبيئة اختبار (ليست الإنتاج)}"

PSQL="psql -X -q -v ON_ERROR_STOP=0 $DATABASE_URL"

# --- تهيئة: موظف w1، سياسة سنوية limited=1، لا استخدام سابق ---
EMP=$($PSQL -tA -c "select id from public.employees where team='w1' order by sort_order limit 1")
$PSQL -c "update public.leave_policies set entitled_days=1, day_count_basis='calendar' where team='w1' and year=2026 and type='سنوية'"
# نظّف أي بقايا اختبار
$PSQL -c "delete from public.leaves where notes like '__CC_%'"

echo "EMP=$EMP — الرصيد المستحق=1 يوم"

# --- الجلسة A: تبدأ معاملة، تعتمد يوماً واحداً، وتُبقيها مفتوحة ---
COORD=$(mktemp -u)
mkfifo "$COORD"
(
  $PSQL <<SQL
begin;
insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team)
  values (gen_random_uuid(), '$EMP', 'سنوية', '2026-09-01','2026-09-01','معتمد','__CC_A__','w1');
\! echo A_APPROVED > $COORD
select pg_sleep(3);   -- تُبقي القفل والمعاملة مفتوحين بينما تحاول B
commit;
SQL
) &

read LINE < "$COORD"   # انتظر حتى تعتمد A (وتمسك القفل)
echo ">> الجلسة A اعتمدت وتمسك القفل ($LINE)"

# --- الجلسة B: تحاول اعتماد يوم آخر لنفس (emp,type,year) → يجب أن تنتظر ثم تفشل ---
echo ">> الجلسة B تحاول الاعتماد (ستنتظر قفل A ثم تُعيد الحساب)..."
START=$(date +%s)
set +e
OUT=$($PSQL 2>&1 <<SQL
begin;
insert into public.leaves(id,emp_id,type,from_date,to_date,status,notes,team)
  values (gen_random_uuid(), '$EMP', 'سنوية', '2026-09-02','2026-09-02','معتمد','__CC_B__','w1');
commit;
SQL
)
set -e
END=$(date +%s)
WAITED=$((END-START))

wait   # انتظر انتهاء A

echo "----- ناتج الجلسة B -----"
echo "$OUT"
echo "-------------------------"
echo "زمن انتظار B ≈ ${WAITED}s (يجب أن ينتظر ~قفل A)"

# --- التحقّق: B رُفضت (تجاوز)، ولم يُعتمد سوى يوم واحد ---
APPROVED=$($PSQL -tA -c "select count(*) from public.leaves where team='w1' and emp_id='$EMP' and type='سنوية' and status='معتمد' and notes like '__CC_%'")
$PSQL -c "delete from public.leaves where notes like '__CC_%'"   # تنظيف
rm -f "$COORD"

if echo "$OUT" | grep -q 'موافقة استثنائية'; then
  echo "PASS: الجلسة B رُفضت بسبب التجاوز بعد إعادة الحساب خلف القفل."
else
  echo "WARN: راجع الناتج — لم يظهر رفض التجاوز المتوقّع."
fi
echo "عدد الاعتمادات الباقية = $APPROVED (المتوقّع 1 فقط ⇒ لا double-spend)"
[ "$APPROVED" = "1" ] && echo "PASS: لا تجاوز للرصيد (اعتماد واحد فقط)." || echo "FAIL: عدد الاعتمادات ليس 1."
