# المرحلة الرابعة — الإشعارات وسير اعتماد الإجازات

## 1. ما هو موجود فعلاً (مستخرَج من الكود والقاعدة، لا افتراض)

| السؤال | الإجابة الفعلية | المصدر |
|---|---|---|
| مسار الاعتماد الحالي | الموظف يُدرج طلبًا `status='قيد الانتظار'` عبر RLS، ثم مسؤول/رئيس قسم/مدير يغيّر الحالة إلى `معتمد`/`مرفوض` بـ **upsert مباشر** | `leaves` RLS: `staff_insert_own_leave`, `write_leaves`؛ `app.js:1715,1785 setLeaveStatus` |
| مرحلة واحدة أم مرحلتان | **مرحلة واحدة** نهائية مباشرة. لا أعمدة ولا واجهة لمرحلتين | لا أعمدة قرار؛ `approveLeave/rejectLeave` فعل واحد `app.js:1965-1966` |
| رئيس القسم يعتمد؟ | نعم — رئيس القسم = دور `owner` (نطاق `dept`). يعتمد كل ورديات قسمه | `can_write_team`, `is_owner`, `superadmin_promote_department_head` |
| admin يعتمد حسب الوردية فقط؟ | نعم — `role='admin'` مقيّد بـ `team` واحدة | `can_write_team` فرع admin |
| owner يعتمد حسب القسم؟ | نعم — كل ورديات `dept` الخاص به | `can_write_team` فرع owner |
| لا رئيس للقسم؟ | القسم بلا owner (مثل d3/d4). الاعتماد يبقى لـ admin الوردية أو superadmin | القاعدة: d3/d4 بلا owner |
| تغيّر رئيس القسم أثناء طلب معلّق؟ | القرار التاريخي محفوظ بمنفّذه؛ الطلب المعلّق يظهر للمخوّلين **الحاليين** حسب النطاق (RLS لحظي) | RLS يعتمد الدور الحالي |
| الموظف يرى سبب الرفض؟ | **لا حاليًا** — الرفض يضبط الحالة فقط بلا سبب | `rejectLeave→setLeaveStatus(id,'مرفوض')` |
| سجل القرار محفوظ؟ | جزئيًا: `audit_log` يلتقط تعديل الحالة (trigger)، لكن لا سجل قرار مخصّص ولا سبب/منفّذ ظاهر للموظف | `trg_audit`→`audit_capture` |
| وقت واسم متخذ القرار؟ | **لا** أعمدة `decided_by/decided_at` | مخطط `leaves` |
| نظام إشعارات؟ | **لا يوجد** أي جدول/دالة إشعارات | فحص كل الجداول والدوال |
| Realtime؟ | مُفعّل على `employees, leaves, overrides, settings, point_shifts`. العميل يشترك في **كل** تغييرات `public` ثم يعيد السحب | `pg_publication_tables`; `cloud.js:288 subscribe` |

**القيم الفعلية للحالة:** `معتمد` (approved)، `قيد الانتظار` (pending)، `مرفوض` (rejected). الافتراضي `معتمد`. الأنواع والحالات قابلة للضبط في `settings.data`.

**نموذج الأدوار:** `auth.users.raw_app_meta_data` → `role` (superadmin/owner/admin/viewer) + `team` + `dept`. الموظف: حساب خاص `e{رقم}@shift.local` مربوط في `employee_auth(emp_id,user_id,team)`. تعطيل الحساب = `banned_until`.

## 2. قرار التصميم

- **سير مرحلة واحدة** (بدليل أعلاه): لا مبرر في الكود أو الأعمدة لمرحلتين. `leave_decisions` مصمَّم بحقول `decision/previous_status/new_status` تسمح بإضافة مراحل لاحقًا بلا كسر مخطط.
- **من يقرّر = `can_write_team(leave.team)`** (موجود وغير مُعدّل): superadmin=الكل، owner=ورديات قسمه، admin=ورديته، viewer/موظف/anon/معطّل=لا.
- **الإشعارات تُنشأ حصريًا داخل triggers** على `leaves` — مصدر واحد يغطّي مسار RPC والمسار المباشر (upsert) معًا، بلا ازدواج.
- **الموظف يرى السبب/الوقت** عبر أعمدة جديدة على `leaves` (صفّه مقروء له أصلًا) — لا حاجة لكشف `leave_decisions` للموظف.
- **`leave_decisions`**: سجل قرارات مستقل **إضافة-فقط** (يوازي نمطي `leave_ledger`/`audit_log` في المشروع). أُنشئ لأن التاريخ المخصّص للقرار (منفّذ/سبب/حالة سابقة) غير محفوظ حاليًا بشكل نظيف؛ `audit_log` يبقى كتدقيق أمني موازٍ.
- **سبب الرفض إجباري**، الاعتماد يمسح السبب.

## 3. نموذج البيانات

**`leaves` (أعمدة مضافة فقط):** `submitted_at, decided_at, decided_by, decided_role, reject_reason`. (تعبئة سجلّية للصفوف المعتمدة الموجودة، بتعطيل مؤقّت للـtriggers لتفادي آثار جانبية.)

**`public.notifications` (جديد):** `id, user_id, type, title, body, entity_type, entity_id, is_read, read_at, created_at, created_by, data jsonb`.
- `type ∈ {leave_submitted, leave_approved, leave_rejected, leave_cancelled, account_changed, department_changed}` — تُنفَّذ أنواع الإجازات فقط الآن، والباقي موثّق للمستقبل.
- فهارس: `(user_id, created_at desc)`، وجزئي `(user_id) where not is_read` لعدّاد غير المقروء.
- `entity_id` مرجع **غير مقيّد بـ FK** (يحفظ التاريخ ولا يُسقِط بـ CASCADE). لا يُعرض UUID في الواجهة؛ فتح الطلب يخضع لـ RLS.
- `data` معلومات غير حساسة فقط (نوع/فترة/وردية/اسم للموظف للمسؤول). لا Token/Email/Authorization/كلمات مرور.
- RLS: `SELECT` للمالك فقط + حساب فعّال. لا إدراج/تعديل/حذف مباشر — كله عبر RPCs موثوقة.

**`public.leave_decisions` (جديد، إضافة-فقط):** `id, leave_id, decision, decided_by, decided_at, reason, previous_status, new_status, actor_role, team, dept`. RLS يمنع كل وصول مباشر (تُكتب عبر trigger/definer فقط). لا UPDATE/DELETE أبدًا.

## 4. المستلمون (بلا تكرار)

عند طلب معلّق للموظف E في وردية T (قسم D):
1. رؤساء القسم (owners بـ `dept=D`) الفعّالون.
2. admins الفعّالون بـ `team=T`.
3. superadmin **فقط عند غياب 1 و2** (احتياطي تشغيلي).
- إزالة التكرار بـ `DISTINCT`/`UNION`؛ استبعاد مقدّم الطلب؛ استبعاد المعطّلين؛ من هو رئيس+admin يحصل على إشعار واحد.
- عند القرار: إشعار واحد للموظف صاحب الطلب. إن لم يوجد حساب مرتبط، **لا يفشل القرار** — يُتخطّى الإشعار.

## 5. RPCs (كلها SECURITY DEFINER، الهوية من `auth.uid()`)

- `submit_leave_request(type,from,to,notes)` — هوية/وردية من القاعدة (`audit_current_emp_id`, `employees.team`)، تحقّق تواريخ/نوع/تداخل، قفل استشاري لكل موظف يمنع الإرسال المزدوج، إدراج معلّق ضمن معاملة (triggers تُنشئ إشعارات المخوّلين).
- `decide_leave_request(leave_id, decision, reason, override, override_reason)` — `SELECT … FOR UPDATE` (قرار-مرة-واحدة تحت التزامن)، `can_write_team`، رفض إن لم تعد الحالة معلّقة، سبب إجباري للرفض، دعم تجاوز الرصيد، القرار+السجل+الإشعار+التدقيق في معاملة واحدة.
- `list_my_notifications(page,page_size≤50)` / `notification_unread_count()` / `mark_notification_read(id)` / `mark_all_notifications_read()` — للمستخدم الحالي فقط، لا يقبل `user_id` من العميل.

المنح: `EXECUTE` للأدوار الخارجية الستّ لـ `authenticated` فقط؛ حرمان `anon/public`. الدوال الداخلية (`_leave_notify_recipients`, دوال الـtriggers) بلا منح. `notifications`: `SELECT` لـ`authenticated` (RLS ذاتي)؛ لا كتابة مباشرة. `leave_decisions`: بلا منح.

## 6. Realtime

- المصدر الأساسي = **polling خفيف** عبر `notification_unread_count()` (كل ~60ث + عند الرجوع للواجهة + زر تحديث). يعمل قبل/بدون Realtime.
- إضافيًا: الجدول مُضاف إلى `supabase_realtime` في الـmigration (لا يُطبَّق على الإنتاج الآن)، والاشتراك في الواجهة مُقيَّد بـ `user_id=eq.<uid>` فقط. لا يُعتمد عليه أمنيًا؛ RPC هو المصدر. عند الانقطاع يعمل زر التحديث. يُنظَّف الاشتراك عند الخروج/تبديل المستخدم.

## 7. التدقيق

تقديم/اعتماد/رفض ملتقَط عبر `trg_audit`→`audit_capture` (insert/update) + `leave_decisions`. لا يُسجَّل في التدقيق: كلمات مرور/Token/Authorization/Metadata كاملة؛ التنقيح الحالي (`_audit_sanitize_json`) مطبَّق على أي JSON. تعليم الإشعار كمقروء لا يحتاج تدقيقًا كاملًا.
