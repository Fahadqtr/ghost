# المرحلة 8 — جدول العمل المتوقع وسياسة الحضور والتغطية

## 1) فحص النظام الحالي (مُثبَت من الكود والإنتاج)

| السؤال | الإجابة | المصدر |
|---|---|---|
| وردية اليوم؟ | `rotationShift(emp,iso)` + `shiftPattern()` — يبدأ من `startShift` ويتقدّم وردية كل يومَي عمل (`floor(i/2)%3`) | `app.js:80-90` |
| مرساة ثابتة؟ | نعم — `emp.cycle_start` (افتراضي `settings.scheduleStart`)؛ كل موظفي الإنتاج على `2026-06-14` | `app.js:86` + إنتاج |
| أيام الراحة؟ | `cycle=workDays+restDays`؛ `pos≥workDays ⇒ راحة`. الإنتاج: 6 عمل/4 راحة | `app.js:88-89` |
| Overrides والأولوية؟ | `cellValue`: **يدوي > إجازة > دوران**؛ `overrides(emp_id,day,value)` (0 صفوف حاليًا) | `app.js:97-103` |
| ليلية؟ | نعم — `ليل 21:00→06:00`؛ `shiftWindow` يضيف 1440 عند `end≤start` | `app.js:2914-2917` |
| الاسم منفصل عن الوقت؟ | نعم — الدوران يُنتج **الاسم**؛ الوقت من `settings.shiftTimes[name]` (نصّ حرّ) | `app.js:2560-2564` |
| أوقات نصّية عربية؟ | نعم مثل «6:00 ص ← 1:00 م» — 3 ورديات موحّدة عبر كل الفرق | إنتاج |
| minWorkers؟ | **إجمالي يومي** لا لكل وردية | `app.js:111-121,1497` |
| سياسة سماح/تأخير/غياب؟ | **لا شيء**؛ «غياب» مجرّد نوع إجازة يدوي | بحث شامل |
| عطلات رسمية؟ | **مخزّنة** `settings.holidays=[{date,name}]` لكن **غير مُستخدَمة** في أي منطق | إنتاج + `app.js` |
| أيام عمل لكل موظف؟ | عامة فقط؛ الوحيد لكل موظف هو `cycle_start` | `app.js:1445-1446` |
| استثناءات فردية؟ | `cycle_start` + إجازات + overrides — لا غير | — |
| شاشات تعتمد الوردية؟ | `renderSched/renderDash/renderDaily/renderPoint/renderDailyOps` + نظرة المالك + `coverageCheck` | — |
| الحضور يعرض متوقّع/تأخير؟ | **لا** — المرحلة 7 مفصولة تمامًا | `app.js:2116-2220` |
| إعادة بناء تاريخي حتمي؟ | حتمي **بالإعدادات الحالية فقط**؛ الإعدادات الخمس + `cycle_start` + `shiftTimes` **قابلة للتحرير وغير مؤرّخة** ⇒ تعديلها يعيد كتابة الماضي | `app.js:85-90,2561` |
| دوال دوران خادمية موجودة؟ | **لا** — الدوران في الواجهة فقط (`shift_*_user` دوال مصادقة لا دوران) | إنتاج |

## 2) قرار النموذج: **Snapshot يومي** (لا Resolver على الإعدادات الحالية)
لأن إعدادات الدوران الخمس + `cycle_start` + `shiftTimes` **قابلة للتحرير وغير مؤرّخة**، فإن Resolver يقرأ الإعدادات الحالية سيُعيد كتابة التأخير/الغياب التاريخي عند أي تعديل — مرفوض. لذا:
- **`employee_work_schedule`**: سجل واحد لكل `(employee_id, work_date)` يُولَّد مرّة ويُجمَّد (timestamps، مصدر، قفل).
- الأوقات من **`shift_definitions`** المؤرّخة (`effective_from/to`)، والسياسة من **`attendance_policies`** المؤرّخة — فلا يتحرّك الماضي.
- الإجازات **ليست** جزءًا من snapshot؛ تُطبَّق كطبقة عند حساب الغياب فقط (إجازة معتمدة ⇒ غياب معذور).

## 3) خوارزمية الدوران (منقولة حرفيًا إلى SQL)
```
WORK_SHIFTS = [صباح, عصر, ليل]         (ثابت، مطابق app.js:7)
diff = work_date - cycle_start          (بالأيام؛ إن <0 لا يُولَّد سجل)
cycle = workDays + restDays
pos = diff % cycle
إن pos < workDays:  shift = WORK_SHIFTS[(idx(startShift) + floor(pos/2)) % 3]   (يوم عمل)
غير ذلك:            راحة (is_working_day=false)
```
الإنتاج (6/4، بدء=صباح): `[صباح,صباح,عصر,عصر,ليل,ليل]` ثم 4 أيام راحة.
- `override` نصّي: قيمة ضمن (صباح/عصر/ليل) ⇒ يوم عمل بتلك الوردية؛ غيرها ⇒ راحة. `source=override` وإلا `rotation`؛ التعديل اليدوي `manual`.
- `expected_start_at = (work_date + start_local_time) بتوقيت قطر`؛ الليلية: النهاية على `work_date+1`.

## 4) النماذج
- **`shift_definitions`** (كتالوج مؤرّخ): `shift_code, name_ar/en, start/end_local_time, is_overnight(مولّد), is_active, effective_from/to`. Seed صريح مُراجَع للورديات الثلاث النظيفة (`effective_from=2026-06-14`). لا حذف صلب؛ التغيير الزمني = نسخة/نطاق جديد.
- **`attendance_policies`** (مؤرّخة، **بلا Seed** — الحساب معطّل حتى تُضبط): `scope_type∈{global,department,team,shift}, scope_ref, grace_minutes≥0, absence_cutoff_minutes≥grace, early_leave_grace_minutes≥0, max_session_hours(0,48], minimum_staff_required nullable, effective_from/to`. الأولوية: **shift > team > department > global**.
- **`employee_work_schedule`** (snapshot): `employee_id(FK بلا CASCADE), work_date, team, department, shift_definition_id, policy_id, shift_code, is_working_day, expected_start_at/end_at, is_overnight, source∈{rotation,override,manual,import}, source_reference, generated_at/by, locked_at`. فريد `(employee_id,work_date)`؛ CHECK: يوم عمل ⇒ الوقتان مطلوبان و`end>start`؛ غير عمل ⇒ NULL. `work_date` بتوقيت قطر.
- **`work_schedule_history`** (إضافة-فقط): `schedule_id(FK), event_type∈{generated,updated,locked,unlocked,policy_changed,shift_changed,marked_off,marked_working}, actor_*, reason, old/new_data(JSON منقّح)`.

## 5) الدوال
- خارجية (authenticated، نطاق خادمي): `generate_work_schedule(from,to)` (idempotent، 1–90 يومًا، يحترم القفل و`manual`) · `update_employee_work_schedule(...)` (سبب إلزامي، `manual`) · `lock_work_schedule/unlock_work_schedule` · `get_work_schedule(...)` (مرقّم، نطاق) · `get_schedule_timeline(id)` · `list/upsert_shift_definition` · `list/upsert_attendance_policy` · `get_attendance_overview_v2(date)` (متأخر/غائب/مبكر/تغطية مع **availability flags**، بلا كسر المرحلة 7).
- داخلية (بلا منح): `_ws_hist_json` · `_ws_audit` · `_ws_shift_def_at` · `_ws_policy_at` · `resolve_expected_schedule(emp,date)` (من snapshot فقط؛ `schedule_missing` عند الغياب) · `calculate_late_minutes` · `calculate_early_leave_minutes` · `_ws_day_class` (غياب/تغطية قراءة-فقط).

## 6) الحساب (قواعد صارمة)
- **تأخير** = `max(0, floor((first_check_in − expected_start)/60) − grace)`؛ `NULL` عند `schedule_missing`/إجازة معتمدة/راحة؛ قبل الوردية ⇒ 0. القاعدة: **floor بالدقائق، وgrace شامل** (تأخّر ≤ grace ⇒ 0).
- **انصراف مبكر** = `max(0, floor((expected_end − final_check_out)/60) − early_grace)`؛ `NULL` إذا الجلسة مفتوحة/راحة/جلسة مُبطَلة/بلا جدول.
- **غياب مؤكّد** فقط عند: يوم عمل + جدول موجود + لا إجازة معتمدة + لا حضور صالح + تجاوز `absence_cutoff` + اليوم ليس مستقبليًا + سياسة مكتملة. لا غياب قبل cutoff/عند `schedule_missing`/راحة/إجازة معتمدة/عطلة رسمية (من `holidays`). قراءة-فقط — لا materialization.
- **تغطية**: فقط عند `minimum_staff_required` موثوق للوردية/الفريق/التاريخ. `coverage_gap=max(0,required−available)`؛ الليلية حسب تاريخ الوردية لا UTC. لا `minWorkers` الإجمالي. عند غياب `required` ⇒ `coverage_available=false` (لا صفر مضلّل).

## 7) مصفوفة الأدوار
| الدور | كتالوج/سياسة | توليد/تعديل/قفل الجدول | قراءة الجدول/الملخّص |
|---|---|---|---|
| superadmin | ✅ الكل | ✅ الكل | ✅ الكل |
| owner | ✅ قسمه (إن فُصلت) | ✅ قسمه | ✅ قسمه |
| admin | ❌ سياسة عامة | ✅ ورديته (إن سمحت السياسة) | ✅ ورديته |
| employee/viewer/anon/disabled | ❌ | ❌ | ❌ (`forbidden`) |

## 8) الأمن والتوافق
كل الدوال `SECURITY DEFINER + search_path=''`؛ الجداول RLS مفعّل بلا وصول مباشر (RPC فقط)؛ خارجية=authenticated، داخلية=بلا منح؛ لا `GRANT ON ALL FUNCTIONS`. Backend-أولًا: CREATE-only + Seed كتالوج مُراجَع؛ **لا توليد جدول على الإنتاج، لا تصنيف غياب، لا Backfill**؛ الأعمدة المضافة إلى `attendance_sessions` (`schedule_id/policy_id/shift_definition_id`) Nullable؛ المرحلة 7 تستمر بلا جدول (expected/late تبقى NULL). لا Realtime/Service Worker/Edge جديد. حارس CI `work-schedule-schema` داخل `ci-success`.
