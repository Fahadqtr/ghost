# المرحلة 5 — تعديل وإلغاء طلبات الإجازة + سجل تاريخي وإشعارات

## 1. فحص النظام الحالي (من الكود والمخطط — لا افتراض)

| السؤال | الإجابة الفعلية | المصدر |
|---|---|---|
| تعديل الطلب المعلّق ممكن؟ | نعم عبر RLS `staff_update_own_pending` (UPDATE مباشر) للموظف على طلبه المعلّق؛ والمسؤول عبر `write_leaves`/editLeave | `pg_policies`؛ `app.js` |
| حذف/إلغاء ممكن؟ | نعم — **حذف صلب** عبر RLS `staff_delete_own_pending` (الواجهة: `cancelMyLeave`→`Data.delLeave`) — **يفقد التاريخ** | `app.js:1695`, `cancelMyLeave` |
| حذف الصف يمحو تاريخ القرار/التدقيق؟ | `leave_decisions`/`audit_log` مرجعهما `leave_id` **بلا FK/CASCADE** → لا يُمحى عند حذف الإجازة، لكن الصف نفسه يختفي فيصعب ربط التاريخ | مخطط المرحلة 4 |
| الرصيد يُعاد تلقائيًا عند إلغاء معتمدة؟ | **نعم تلقائيًا** — الرصيد **مُشتَق** لا مخزون: `fn_leave_used` يجمع `leaves` بحالة `='معتمد'` فقط؛ تغيير الحالة إلى `ملغى` يُخرجها من الحساب فيُستعاد الرصيد **دون قيد Ledger** | `fn_leave_used`, `fn_leave_balance` |
| قيمة حالة للإلغاء؟ | **لا** — القيم الحالية: `قيد الانتظار`/`معتمد`/`مرفوض` فقط (لا `ملغى`)، بلا CHECK على `status` | `leaves.status` distinct |
| `leave_ledger` يسجّل الاستخدام عند الاعتماد؟ | **لا** — Ledger يحمل `initial/carryover/adjustment` فقط؛ «المُستخدَم» مُشتَق من `leaves` | `ledger kind CHECK`, `fn_leave_balance` |
| الإلغاء يتطلّب قيد عكسي في Ledger؟ | **لا** — إنشاء قيد عكسي سيُضاعف الاستعادة (خطأ). الاستعادة تلقائية من تغيير الحالة | (أعلاه) |
| إلغاء إجازة بدأت/قديمة؟ | لا سياسة حالية → تُضاف (انظر §3) | — |
| الموظف يرى تاريخ التعديلات؟ | **لا** timeline مخصّص؛ `audit_log` مقروء بالوردية (RLS) لكنه غير مُهيكل كأحداث آمنة للموظف | — |
| Audit كافٍ لـ timeline آمن؟ | غير كافٍ نظيفًا → يُنشأ `leave_history` مخصّص | — |
| الواجهة تعتمد قائمة حالات ثابتة؟ | نعم `settings.statuses` + منطق ثابت في `app.js` | `seed.js`, `app.js` |

**قرار التصميم الأهم:** الرصيد مُشتَق؛ **الإلغاء = تغيير الحالة إلى `ملغى` فقط**، والرصيد يُستعاد تلقائيًا. **لا قيد Ledger عكسي** (يمنع المضاعفة). Ledger يبقى إضافة-فقط دون تغيير.

## 2. الحالات
`قيد الانتظار` · `معتمد` · `مرفوض` · **`ملغى` (جديد)**. لا CHECK على `leaves.status` (قابلة للضبط) — لا نضيف قيدًا يكسر المخصّص. حالة الإجازة الأصلية **لا تتغيّر** إلى `ملغى` إلا بعد **اعتماد** طلب الإلغاء. طلب الإلغاء له حالته الفرعية المقيّدة: `pending`/`approved`/`rejected`.

## 3. قواعد التعديل والإلغاء
- **المعلّق (صاحبه فقط):** تعديل النوع/من/إلى/الملاحظات؛ إلغاء (ناعم → `ملغى`). ممنوع تغيير `emp_id/user_id/team/dept/الحالة يدويًا/الرصيد/بيانات القرار` (الهوية من الخادم).
- **المعتمد:** لا تعديل مباشر؛ يقدّم **طلب إلغاء** يحتاج قرار مسؤول مخوّل.
- **الإجازة التي بدأت:** الموظف **لا** يطلب إلغاءها بعد `from_date`؛ **superadmin فقط** (استثناء بسبب إلزامي + تدقيق). مسؤول عادي لا يلغي إجازة بدأت دون سياسة صريحة.
- **الإجازة المنتهية (`to_date < اليوم`):** لا تعديل ولا إلغاء (التصحيح الإداري مرحلة لاحقة).
- **المرفوض/الملغى:** غير قابل للتعديل/الإلغاء ثانيةً، **يبقى محفوظًا (لا حذف صف)**.

## 4. الجداول الجديدة
- **`public.leave_change_requests`** (لإلغاء المعتمدة): `id, leave_id, request_type∈{cancel_approved_leave}, status∈{pending,approved,rejected}, requested_by, requested_at, reason(≤1000), decided_by, decided_at, decided_role, decision_reason(≤1000), created_at`. **فهرس فريد جزئي: طلب `pending` واحد لكل إجازة**. RLS يمنع كل وصول مباشر (تُكتب/تُقرأ عبر definer/RPC).
- **`public.leave_history`** (Timeline إضافة-فقط): `id, leave_id, event_type∈{submitted,edited,cancelled,approved,rejected,cancellation_requested,cancellation_approved,cancellation_rejected}, actor_id, actor_role, created_at, summary(≤500), old_data jsonb(≤4KB), new_data jsonb(≤4KB)`. RLS يمنع كل وصول مباشر؛ القراءة عبر `get_leave_timeline`.

## 5. السجل التاريخي
`leave_history` يُملأ:
- **Trigger على `leaves`** (يغطّي كل المسارات): إدراج→`submitted`؛ `قيد الانتظار→معتمد`=`approved`؛ `→مرفوض`=`rejected`؛ `→ملغى`=`cancelled`؛ `معتمد→ملغى`=`cancellation_approved`؛ تغيير النوع/التواريخ/الملاحظات بلا تغيير حالة=`edited`.
- **RPCs** (أحداث لا تُغيّر صفّ الإجازة): `cancellation_requested`, `cancellation_rejected`.
تعبئة أساسية خفيفة لصفوف الإجازات الموجودة (حدث واحد يعكس الحالة الحالية) دون إطلاق triggers.

## 6. RPCs (كلها SECURITY DEFINER، الهوية من `auth.uid()`)
- `update_pending_leave_request(id,type,from,to,notes)` — صاحبه، قفل الصف، حالة معلّقة، تحقّق تواريخ/نوع/تداخل/ملاحظات≤2000، تحديث الحقول المسموحة فقط، تاريخ `edited`، إشعار `leave_updated` للمخوّلين، تدقيق. ذرّي.
- `cancel_pending_leave_request(id,reason≤1000)` — صاحبه، قفل، معلّقة، `status='ملغى'`، تاريخ `cancelled`، إشعار `leave_cancelled` للمخوّلين، لا `leave_decisions`، لا أثر على الرصيد، لا إلغاء مزدوج.
- `request_approved_leave_cancellation(id,reason)` — صاحبه، قفل، معتمدة، يمنع المنتهية، يمنع التي بدأت (إلا superadmin)، سبب إلزامي≤1000، طلب `pending` واحد فقط، إدراج `leave_change_requests`، تاريخ `cancellation_requested`، إشعار `leave_cancellation_requested` للمخوّلين، تدقيق. **لا يغيّر حالة الإجازة**.
- `decide_leave_cancellation(request_id,decision,reason)` — قفل الطلب + الإجازة (`FOR UPDATE`)، `can_write_team` نطاق، قائمة بيضاء approve/reject، سبب رفض إلزامي≤1000، قرار-مرّة-واحدة، حقول القرار من الخادم. اعتماد→`leaves.status='ملغى'` (الرصيد يُستعاد تلقائيًا، **لا Ledger**)+تاريخ `cancellation_approved`+إشعار `leave_cancellation_approved`. رفض→إغلاق الطلب `rejected`+الإجازة تبقى معتمدة+تاريخ `cancellation_rejected`+إشعار `leave_cancellation_rejected`.
- `get_leave_timeline(id)` — نطاق: الموظف طلبه فقط، superadmin الكل، owner قسمه، admin ورديته؛ أحداث مرتّبة منقّحة (لا UUID/بريد؛ دور+ملخّص+قبل/بعد).
- `list_pending_leave_cancellations()` — طلبات الإلغاء المعلّقة ضمن نطاق المسؤول (superadmin/owner/admin).
- `list_my_cancellation_requests()` — طلبات إلغاء الموظف الحالي (لعرض حالتها على البطاقة).

## 7. عكس الرصيد
**لا عكس Ledger.** الرصيد مُشتَق؛ اعتماد الإلغاء يضبط `leaves.status='ملغى'` فيتوقّف `fn_leave_used` عن عدّها → الرصيد يُستعاد مرّة واحدة حتميًا. لا UPDATE/DELETE على `leave_ledger`. لا عكس عند: رفض طلب الإلغاء، إلغاء طلب معلّق، غياب خصم أصلي (لم تُعتمد). التقارير والأرصدة (`fn_leave_balance`/`my_leave_balances`/`team_leave_balances`/تقارير المرحلة 3) تعكس الإلغاء تلقائيًا لأنها كلها تستدعي `fn_leave_used`.

## 8. أنواع الإشعارات الجديدة
تُضاف لقيد `notifications.type`: `leave_updated, leave_cancellation_requested, leave_cancellation_approved, leave_cancellation_rejected` (و`leave_cancelled` موجود). المحتوى بلا UUID/بريد/بيانات حساسة.

## 9. RLS/المنح
`leave_change_requests` و`leave_history`: RLS مفعّل، بلا سياسات (منع مباشر)، حرمان anon/authenticated. RPCs الخارجية السبع: `authenticated=EXECUTE`، `anon/PUBLIC=false`. الدوال الداخلية بلا EXECUTE. `notifications` قراءة-فقط (كما المرحلة 4).

## 10. التوافق (Backend-أولًا)
لا أعمدة إلزامية جديدة على `leaves` (لا أعمدة جديدة أصلًا)؛ الجداول الجديدة مستقلّة؛ RPCs المرحلة 4 دون تغيير؛ المسارات القديمة (تقديم/اعتماد/رفض/حذف معلّق) تبقى تعمل. تغيير قيد `notifications.type` **إضافي** (توسيع القائمة) لا يكسر القيم القائمة. آمن للنشر Backend-أولًا.

## 11. Realtime/Polling
نظام المرحلة 4: polling أساسي، Realtime إضافي على `notifications` فقط (لا Publication جديدة). الإشعارات الجديدة تكفي للإبلاغ.
