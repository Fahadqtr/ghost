# المرحلة 6 — لوحة التشغيل اليومية للمشرفين

## 1) فحص النظام الحالي (من المخطط الفعلي على الإنتاج — لا افتراض)

| السؤال | الإجابة الفعلية | المصدر |
|---|---|---|
| هل توجد لوحة يومية حاليًا؟ | **لا** — توجد فقط `superadmin_dashboard_summary` (مدير النظام فقط، ملخّص عام لا يومي ولا مقيّد بالنطاق للأدوار الأخرى) | `pg_proc` |
| دالة تحسب الغائبين اليوم؟ | **لا** — تُشتق «في إجازة اليوم» من `leaves` المعتمدة التي تشمل اليوم | — |
| سجل حضور فعلي؟ | **لا** — النظام يعتمد على الإجازات و`overrides` (تعديلات الجدول) و`point_shifts` (توزيع النقطة). لا جدول `attendance` ولا Check-in | `information_schema` (لا `attendance`) |
| نقص التغطية قابل للحساب؟ | **لا** — لا يوجد جدول حدّ أدنى للتغطية لكل وردية. **مستبعد** (لا نخترع بيانات) | — |
| ساعات/ورديات يومية للتحليل؟ | `point_shifts`/`overrides` موجودة لكن بلا حضور فعلي؛ نكتفي بحالة «في إجازة/عائد اليوم» | — |
| طلبات قديمة معلّقة؟ | قابل للحساب: `status='قيد الانتظار'` مع `submitted_at`/`updated_at` | `leaves` |
| موظفون بلا `employee_auth`؟ | قابل للحساب (LEFT JOIN)؛ الإنتاج حاليًا 0 | `employees`⋈`employee_auth` |
| حساب معطّل مرتبط بموظف فعّال؟ | قابل للحساب: `auth.users.banned_until` مستقبلي عبر `employee_auth` | `auth.users` |
| تداخل إجازات لنفس الموظف؟ | قابل للحساب (self-join مع تقاطع الفترات، بلا تكرار الزوج) | `leaves` |
| إجازة معتمدة بلا Timeline؟ | نادر بعد المرحلة الخامسة (Backfill غطّى الكل)؛ يُفحص مع مراعاة Backfill | `leave_history` |

**مؤشرات دقيقة قابلة للحساب:** المعلّقة · طلبات الإلغاء المعلّقة · في إجازة اليوم · تبدأ خلال N يوم · معلّقة >24 ساعة · تنتهي اليوم · الموظفون الفعّالون في النطاق · الحسابات المعطّلة · موظفون بلا حساب · تنبيهات حرجة.
**مؤشرات مستبعدة (لا بيانات):** نقص تغطية الوردية · الحضور الفعلي/الغياب خارج الإجازات · ساعات العمل.

## 2) التوقيت واليوم
- توقيت قاعدة البيانات = **UTC**؛ لذا «اليوم» = `(now() at time zone 'Asia/Qatar')::date` داخل الدوال — **لا `CURRENT_DATE` الخام**.
- بداية/نهاية اليوم والأيام القادمة وعمر الطلب تُحسب من تاريخ قطر.
- `p_date` اختياري لاختبار يوم محدّد؛ إن كان NULL يُحسب من قطر.

## 3) الأدوار والنطاق (خادميًا، لا من JWT)
تُستخدم `_report_scope_teams()` (الموجودة): superadmin=كل الورديات · owner=ورديات قسمه · admin=ورديته · **viewer/employee/anon/معطّل → forbidden 42501**. في هذا النظام «viewer» = مستوى الموظف بلا وصول تقارير؛ فاللوحة **للـsuperadmin/owner/admin فقط** (متوافق مع تقارير المرحلة 3/4). `can_write_team(team)` يحدّد ظهور أزرار القرار لكل عنصر.

## 4) تصميم Backend (محسوب عند الطلب — لا Snapshot)
Migration مستقلّة `daily_operations_dashboard`: RPCs SECURITY DEFINER + `search_path=''` + بوّابة النطاق + فهارس. لا جداول/أعمدة جديدة، لا تعديل بيانات، لا إشعارات، لا Snapshot.

**RPC رئيسية:** `get_daily_operations_dashboard(p_date date default null, p_upcoming_days int default 7)` → JSON: `generated_at, timezone, scope{role,teams_count}, summary{...عدّادات...}, action_items[≤20], today_leaves[≤50], upcoming_leaves[≤50], alerts[≤50]` (صفحة أولى صغيرة).

**RPCs قوائم مرقّمة** (للتحميل الإضافي): `list_daily_action_items`, `list_today_leaves`, `list_upcoming_leaves`, `list_operational_alerts` — كلها `(p_page, p_page_size)` مع `p_page_size∈[1,100]`, `p_page≥1`, بلا OFFSET عميق غير موثّق.

**دوال داخلية** (revoke من الجميع): `_ops_action_items(teams,today,now)`, `_ops_alerts(teams,today)` تُستدعى بنطاق موثوق فقط — تمنع تكرار المنطق بين الرئيسية والقوائم.

## 5) أنواع العناصر والتنبيهات
`item_type ∈ {pending_leave, pending_leave_cancellation, stale_pending_leave, account_link_issue}` — يعيد `priority, title, description, employee_name, team_name, department_name, from_date, to_date, created_at, age_hours, can_decide, action_kind` + معرّف داخلي (`leave_id`/`request_id`) للاستدعاء (لا يُعرض بصريًا).

**شدّة التنبيه:**
- `critical`: طلب إجازة يبدأ اليوم وما زال معلّقًا · طلب إلغاء معلّق وإجازته تبدأ اليوم · تناقض حالة (طلب إلغاء pending لإجازة ليست «معتمد») · حساب معطّل مرتبط بموظف فعّال (يمنعه من النظام).
- `warning`: طلب معلّق >24 ساعة · إجازة تبدأ غدًا وما زالت معلّقة · موظف فعّال بلا `employee_auth`.
- `info`: إجازة تبدأ خلال 7 أيام · إجازة تنتهي اليوم.

## 6) الترتيب والقِدم
Action items مرتّبة: الأقدم `created_at`/`submitted_at` ثم الأقرب `from_date`. العمر بالساعات في البيانات؛ الواجهة تحوّله «منذ ساعتين/يوم/3 أيام». تُعالَج التواريخ المفقودة (coalesce على `submitted_at→updated_at→created_at`).

## 7) الأمن والمنح
كل RPC خارجية: `authenticated=EXECUTE`, `anon/PUBLIC=false`. الدوال الداخلية بلا EXECUTE لأي دور. لا `GRANT EXECUTE ON ALL FUNCTIONS`. لا UUID/بريد/Metadata غير ضرورية (فقط معرّفات الاستدعاء غير المعروضة). القراءة لا تُنشئ Audit/Notification/History.

## 8) الفهارس (Migration)
- `idx_leaves_ops_status_team_dates (status, team, from_date, to_date)` — النطاق+الحالة+المدى.
- `idx_leaves_pending_submitted (submitted_at) where status='قيد الانتظار'` — الطلبات القديمة.
- `idx_leaves_emp_overlap (emp_id, from_date, to_date)` — كشف التداخل.
(طلبات الإلغاء مفهرسة مسبقًا: `idx_lcr_status_leave` + الفهرس الفريد الجزئي.)

## 9) الواجهة
قسم/تبويب جديد «لوحة التشغيل اليومية» (الرئيسية للمستخدم الإداري): عنوان + تاريخ اليوم + آخر تحديث + زر تحديث + فلتر اليوم/القادم (لا اختيار قسم/وردية يوسّع النطاق). بطاقات مؤشرات قابلة للنقر، وأقسام قابلة للطي (تحتاج إجراء/اليوم/القادم/التنبيهات)، مع Loading/Empty/Error وفشل جزئي لا يُسقط الصفحة. Polling كل 60 ثانية ونمط المرحلة الرابعة (interval واحد، يتوقف عند الإخفاء/الخروج). الأزرار تستدعي RPCs المرحلة 4/5 القائمة (لا إعادة بناء منطق القرار)، مع منع الضغط المكرر وتحديث جزئي.

## 10) التوافق (Backend-أولًا)
لا جداول/أعمدة جديدة؛ لا إعادة تعريف RPCs قائمة؛ القراءة فقط. آمن للنشر Backend-أولًا: الواجهة القديمة لا تتأثر، والواجهة الجديدة تتحمّل غياب الـRPC (fallback) حتى نشرها.
