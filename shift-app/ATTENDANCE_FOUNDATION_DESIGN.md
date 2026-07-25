# المرحلة 7 — أساس الحضور والانصراف الفعلي

## 1) فحص النظام الحالي (مُثبَت من الإنتاج والكود، لا افتراض)

| السؤال | الإجابة الفعلية | المصدر |
|---|---|---|
| جداول حضور حالية؟ | **لا** — لا `attendance`/`check_in`/`punch`/`clock`. الوحيد المطابق لنمط «shift» هو `point_shifts` (توزيع النقطة الأمنية، لا حضور) | `information_schema` |
| سجلات check-in/out قديمة؟ | **لا** | — |
| جدول عمل يومي دقيق لكل موظف؟ | **الوردية المتوقّعة (اسمها) قابلة للاشتقاق حتميًا** من الدوران: `employees.cycle_start`/`settings.scheduleStart` + `workDays/restDays` + `startShift` + `overrides` + الإجازات المعتمدة (`app.js:85-103, 757-768`). لكن **الأوقات الفعلية** غير موثوقة (انظر أدناه) | كود + `settings` |
| وقت بداية/نهاية كل وردية؟ | موجود كـ**نصّ حرّ عربي** في `settings.data->shiftTimes` مثل «6:00 ص ← 1:00 م»، «9:00 م ← 6:00 ص» (ليلية تعبر منتصف الليل). يُحلَّل عبر `parseArTime`/`shiftWindow` (`app.js:2712-2715`) — **قابل للتحرير، غير هيكلي** | `settings` + كود |
| الوردية مرتبطة بتاريخ؟ | لا — تُشتق من الدوران لكل تاريخ | كود |
| هل يمكن معرفة أن موظفًا كان متوقعًا العمل في يوم؟ | نعم (اسم الوردية/راحة) — لكن ليس بوقت رسمي مضمون | كود |
| حساب التأخير بدقة؟ | **لا** — يتطلّب أوقاتًا هيكلية + سياسة سماح، وكلاهما غير موجود | مُثبَت |
| حساب الغياب بدقة؟ | **لا** — لنفس السبب | مُثبَت |
| حد سماح للتأخير (grace)؟ | **لا يوجد أي إعداد** (`graceMinutes`/`lateGrace`/`attendance` غائبة في كل `settings`) | استعلام إنتاج |
| حد أدنى للتغطية؟ | `settings.minWorkers=3` موجود، لكنه **إجمالي يومي** لا لكل وردية (`app.js:757-774`) | استعلام إنتاج |
| نقص تغطية قابل للحساب؟ | جزئيًا (إجمالي فقط)، ويتطلّب حضورًا فعليًا — **مؤجّل** | — |
| مناوبات تعبر منتصف الليل؟ | نعم (ليل 9م←6ص) — يُعالَج في الجلسة بحفظ تاريخ البدء | — |
| إجازات معتمدة تُستبعد من الغياب؟ | نعم (لكن الغياب نفسه مؤجّل) | `leaves` |
| موظفون بلا `employee_auth`؟ | الإنتاج حاليًا **0** (كل الموظفين مرتبطون بحسابات؛ يدخلون بـ`e<رقم>@shift.local`) | استعلام إنتاج |

## 2) قرار النطاق
**مُنفَّذ حتمًا:** check-in/out فعلي · حالة الموظف · سجل الحضور · الجلسات المفتوحة · التصحيح الإداري · سجل تاريخي (إضافة-فقط) · نطاق إداري خادمي · تقارير الحضور الفعلي · الإبطال الموثّق.

**مؤجّل صراحةً (لا بيانات دقيقة):** التأخير · الانصراف المبكر · الغياب · الساعات المتوقعة · نقص تغطية الوردية.
**السبب:** أوقات الورديات نصّ حرّ عربي قابل للتحرير + لا سياسة سماح موثّقة → تصنيف «متأخر/غائب» يتطلّب محلّل وقت هشًّا وعتبة مخترعة (ممنوعان). الأعمدة `expected_start_at/expected_end_at/late_minutes/early_leave_minutes` موجودة لكنها **تبقى NULL**؛ الدوال تعيدها `null` لا رقمًا مضلّلًا. **بناء جدول متوقّع هيكلي + سياسة سماح = مرحلة مستقلّة لاحقة.**

## 3) نموذج البيانات
- **`public.attendance_sessions`**: `id, employee_id (FK بلا CASCADE), attendance_date, team, department, check_in_at, check_out_at, status∈{open,closed,corrected,voided}, check_in_source/check_out_source∈{self,admin,import}, work_seconds, correction_count, expected_*/late_*/early_* (NULL مؤجّل), created_by, closed_by, created_at, updated_at`. قيود: `check_out_at>check_in_at`، status/source مقيّدة. **فهرس فريد جزئي `uq_attendance_one_open (employee_id) where status='open'`** = ضمان الجلسة المفتوحة الواحدة. فهارس: `(employee_id,attendance_date)`, `(team,attendance_date,status)`, `(team,check_in_at) where open`, `(attendance_date)`.
- **`public.attendance_history`** (إضافة-فقط): `id, session_id (FK), event_type∈{checked_in,checked_out,corrected,voided}, actor_id, actor_role, reason, old_data, new_data (JSON منقّح ≤4096B، بلا email/uuid/metadata), created_at`.

## 4) سياسة الوقت واليوم
- كل الأوقات من الخادم (`now()`); **لا timestamp من العميل**. الواجهة تعرض ساعة الجهاز بصريًا فقط مع تنويه أن وقت الخادم هو المعتمد.
- **`attendance_date` = `(check_in_at at time zone 'Asia/Qatar')::date`** — تاريخ بدء الجلسة (المناوبة الليلية تبقى على يوم بدايتها). موثّق ومختبَر (23:00 قطر→اليوم، 00:30→اليوم التالي، ليلية 22:00→06:00 = 8س على يوم البدء).

## 5) الأمن ومنع التزوير
- كل RPC خارجية **SECURITY DEFINER + search_path='' + بوّابة نطاق خادمية**. الجداول **RLS مفعّل + بلا وصول مباشر** (كل شيء عبر RPC).
- check-in/out/status **بلا أي معامل** — `employee_id/team/department/time` تُشتق من `auth.uid()`→`employee_auth`. correct/void لا تقبلان `employee_id/team` (لا نقل الجلسة لموظّف/نطاق آخر).
- المنح: 9 خارجية `authenticated` فقط (anon/PUBLIC محظوران)؛ 4 داخلية بلا EXECUTE لأي دور. لا `GRANT ON ALL FUNCTIONS`.

## 6) RPCs
`attendance_check_in()` (idempotent، قفل advisory لكل موظف، يعيد الجلسة المفتوحة إن وُجدت) · `attendance_check_out()` (يقفل الجلسة `FOR UPDATE`، يحسب `work_seconds`) · `get_my_attendance_status()` (حالة + إجمالي اليوم + `recent[14]` لبيانات الموظّف نفسه فقط) · `list_attendance_sessions(date,status,page,size)` (نطاق `_report_scope_teams`، ترقيم مقيّد [1..100]) · `get_attendance_summary(date)` (مؤشرات مثبتة؛ late/absence/coverage=null) · `list_attendance_anomalies(page,size)` · `get_attendance_timeline(session_id)` (نطاق) · `correct_attendance_session(id,ci,co,reason)` (نطاق كتابة `can_write_team`، سبب إلزامي ≤1000، منع تداخل، `correction_count++`) · `void_attendance_session(id,reason)` (لا حذف؛ status=voided، لا إبطال مزدوج).

## 7) مصفوفة الأدوار
| الدور | check-in/out + حالتي | قائمة/ملخّص/تنبيهات | تصحيح/إبطال |
|---|---|---|---|
| موظف (viewer، مرتبط) | ✅ نفسه | ❌ | ❌ |
| admin | ✅ إن كان مرتبطًا | وردِيته | ورديته |
| owner | ✅ إن مرتبطًا | قسمه | قسمه |
| superadmin | ✅ إن مرتبطًا | الكل | الكل |
| غير مرتبط/anon/معطّل | ❌ (`no_employee`/`forbidden`/منع منح) | ❌ | ❌ |

## 8) الجلسات غير الطبيعية (قراءة فقط، مثبتة)
`open_over_16h` · `open_prev_day` · `attendance_during_approved_leave` · `excessive_corrections (≥3)` · `disabled_with_open`. لا إغلاق تلقائي، ولا كتابة عند العرض.

## 9) الواجهة
- **الموظف** (`scr-attend`): بطاقة حالة (داخل/خارج الدوام، دخول/خروج، مدة الجلسة، إجمالي اليوم) + زر واحد حسب الحالة (منع ضغط مكرر) + آخر 14 يومًا + تنويه وقت الخادم.
- **المشرف** (`scr-attadmin`): مؤشرات (الآن/مفتوحة/+16س/أُغلقت/سجّلوا/تنبيهات) + فلتر حالة + قائمة مرقّمة + تصحيح/إبطال/سجل + تنبيهات.
- **لوحة التشغيل**: شريط حضور موثوق (الآن/مفتوحة/+16س/سجّلوا) + زر «إدارة الحضور» — **دون تغيير المؤشرات القديمة**، وفتحها **لا يُنشئ** أي سجل حضور.
- Polling 60ث لكل شاشة (interval واحد، يتوقف عند الإخفاء/الإغلاق/عدم الاتصال/الخروج). كل القيم عبر `esc()` (XSS كنص). لا Realtime/Service Worker جديد.

## 10) التوافق
Backend-أولًا آمن: جداول/دوال جديدة فقط، CREATE-only، لا تعديل كائن قائم، لا Realtime/SW، لا إشعارات عند التطبيق. حارس CI `attendance-schema` ضمن `ci-success` الإلزامي.
