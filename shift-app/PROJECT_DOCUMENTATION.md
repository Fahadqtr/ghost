# توثيق المشروع الكامل — تطبيق إدارة ورديات وأرصدة الموظفين

> **قسم العمليات الجمركية** — تطبيق ويب تقدّمي (PWA) عربي (RTL) لإدارة الورديات والإجازات وأرصدتها.
> هذه الوثيقة مرجع شامل واحد يصف المشروع من الألف للياء: الهدف، البنية، الواجهة، قاعدة البيانات، الأمان، الترحيلات، والحالة الراهنة للتطبيق (بما فيها آخر عمل: تطبيق سياسات RLS للمرحلة الثانية).

آخر تحديث للوثيقة: 2026-07-21 · الفرع: `claude/leave-balances-v2` · PR: #453 (مسودّة).

---

## 1. نظرة عامة

| العنصر | القيمة |
|---|---|
| الغرض | جدولة ورديات الموظفين، طلبات الإجازات واعتمادها، وتتبّع أرصدة الإجازات سنوياً لكل موظف. |
| المستخدمون | **owner** (المالك/رئيس القسم) · **admin** (مسؤول وردية) · **viewer** (موظف). |
| النشر | GitHub Pages من مجلّد `shift-app/` (الرابط العام لصفحة الموقع). |
| المزامنة | Supabase — مشروع **shift-scheduler** (Project Ref: `fibkwudabuwfjqpyeeng`). |
| التقنية | JavaScript خالص بلا خطوة بناء (no build step)، PWA يعمل دون اتصال، Postgres + RLS. |
| التعدّدية | فِرَق/ورديات متعدّدة عبر عمود `team` (`w1`, `w2`) وعزلها بـ RLS. |

**مبدأ أمني حاكم:** الدور (`role`) والوردية (`team`) يُقرآن دائماً من قاعدة البيانات (`auth.users.raw_app_meta_data`)، ولا يُوثَق أبداً بقيمة يرسلها العميل. الهوية تُشتق من `auth.uid()` عبر الجلسة، لا من `emp_no`/`team` قابلة للتلاعب.

---

## 2. البنية التقنية

### 2.1 الواجهة الأمامية (`shift-app/`)
تطبيق صفحة واحدة (SPA) بلا إطار عمل وبلا حزم بناء — ملفات ثابتة تُخدَم مباشرة:

| الملف | الوصف |
|---|---|
| `index.html` | الهيكل والشاشات (views) وشاشات الدخول. |
| `styles.css` | التنسيق (RTL). |
| `config.js` | عنوان Supabase والمفتاح **publishable** (مُعدّ للعلن؛ الحماية عبر RLS بعد الدخول). |
| `cloud.js` | طبقة السحابة: تسجيل الدخول، السحب (`pull`)، الدفع (`push`/Outbox)، المزامنة اللحظية، قراءة الأرصدة. |
| `app.js` | كل منطق الواجهة والشاشات (نحو ١٥٠ ك.ب). |
| `seed.js` | بيانات ابتدائية/تجريبية للعرض. |
| `qr.js` | توليد QR ورمز/رابط دخول الموظفين. |
| `sw.js` | Service Worker للعمل دون اتصال (offline) والتثبيت كتطبيق. |
| `manifest.webmanifest` | بيان PWA (الأيقونات والاسم). |

### 2.2 الخلفية (Supabase)
- **Auth**: بريد/كلمة مرور. بريد التزويد للموظفين على النمط `e{emp_no}@shift.local`؛ يُنشأ حساب الموظف آلياً عبر مشغّل التزويد.
- **Postgres + RLS**: العزل بالدور والوردية عبر سياسات صف-مستوى.
- **دوال SECURITY DEFINER**: كل المنطق الحسّاس (التزويد، التدقيق، حساب الأرصدة، التحقّق من التجاوز) داخل دوال موثوقة تعمل بصلاحية المالك لا المستخدم.

### 2.3 العمل دون اتصال (Offline / Outbox)
التعديلات تُدفَع إلى «صندوق صادر» (Outbox) محلي؛ عند عودة الاتصال تُرفع بالترتيب عبر `cloud.js`. المزامنة اللحظية تُحدِّث الحالة بين الأجهزة.

---

## 3. الأدوار والصلاحيات

| الدور | النطاق | القدرات |
|---|---|---|
| **owner** | كل الورديات | يرى ويدير كل شيء؛ يعتمد التجاوزات الاستثنائية؛ يضبط سياسات الرصيد لأي وردية. |
| **admin** | ورديته فقط | يدير موظفي ورديته وجداولهم وإجازاتهم وأرصدتهم؛ يعتمد التجاوز داخل ورديته. |
| **viewer** (موظف) | نفسه فقط | يرى جدوله ورصيده (عبر RPC)، ويقدّم طلبات إجازة. لا وصول مباشر لجداول الأرصدة. |

مصدر الدور/الوردية: دوال المرحلة الأولى `is_owner()` · `audit_current_user_role()` · `audit_current_user_team()` — كلّها `SECURITY DEFINER` تقرأ من `auth.users` بحسب `auth.uid()`.

---

## 4. الشاشات (Front-end Views)

من `index.html` و`app.js`:

| المعرّف | الشاشة | الوصف |
|---|---|---|
| `scr-dash` | لوحة المعلومات | ملخّص + رابط/QR دخول الموظفين + لوحة المالك/المسؤول. |
| `scr-emps` | الموظفون | إدارة الموظفين. |
| `scr-sched` | جدول الورديات | الجدول الدوّار والتعديلات اليدوية (overrides). |
| `scr-leaves` | الإجازات | طلبات الإجازة واعتمادها؛ للموظف: عرض رصيده + تقديم طلب. |
| `scr-daily` | كشف يومي | توليد كشف + تصدير `.docx` + مشاركة كصورة. |
| `scr-point` | النقطة الأمنية | ورديات النقطة. |
| `scr-audit` | سجل التعديلات | عرض Audit Log (المرحلة الأولى). |
| `scr-balances` | **أرصدة الإجازات** | عرض/إدارة الأرصدة، سياسات الرصيد، قيود التعديل (المرحلة الثانية). |

---

## 5. قاعدة البيانات

### 5.1 الجداول الأساسية (قائمة سابقاً)
`employees` · `leaves` · `overrides` (تعديلات الجدول اليدوية) · `settings` (إعداد كل وردية: `workDays`/`restDays`…) · `point_shifts` · `audit_log` · جداول الأرشفة `archived_employees` / `archived_leaves`.

### 5.2 المرحلة الأولى — سجل التعديلات (Audit Log) ✅ مُطبَّقة
- `audit_core` + مشغّلات تدقيق على: `leaves`, `overrides`/التجاوزات, `point_shifts`, `settings`, `employees`.
- هوية الفاعل موثوقة (من القاعدة)، Allowlist للأعمدة المسجَّلة، ولا يُسجَّل نصّ السبب في `changed`.
- الدوال المساعدة `is_owner()` / `audit_current_user_role()` / `audit_current_user_team()` أُنشئت هنا.

### 5.3 المرحلة الثانية — أرصدة الإجازات (الجداول الجديدة)

**`employee_auth`** — ربط الهوية الآمن (tamper-proof):
```
emp_id  uuid PK → employees(id) ON DELETE CASCADE
user_id uuid NOT NULL   (فريد عبر فهرس فريد)
team    text NOT NULL
```
يُملأ من مشغّل التزويد فقط؛ يربط `auth.uid()` بالموظف دون الاعتماد على قيم العميل. **لا وصول مباشر لأحد** — يُقرأ عبر الدوال فقط.

**`leave_policies`** — سياسة الرصيد لكل (وردية، سنة، نوع):
```
id bigint identity PK · team · year · type
policy_mode  text  ∈ (limited, unlimited, tracking_only)  default limited
entitled_days int   (NULL أو ≥ 0)
max_carryover int   default 0
day_count_basis text ∈ (calendar, scheduled_workdays) default calendar
created_at/updated_at/updated_by
UNIQUE(team, year, type)
```

**`leave_ledger`** — دفتر قيود الرصيد (**إضافة-فقط**):
```
id uuid PK default gen_random_uuid()   (مفتاح idempotency)
team · emp_id · year · type
kind text ∈ (initial, adjustment, carryover)
days numeric(5,1) NOT NULL check(days <> 0)
source_year int   (مطلوب للترحيل فقط، ممنوع لغيره — قيد check)
reason · created_by · created_at
فهرس فريد جزئي: initial واحد لكل (emp_id, year, type)
فهرس فريد جزئي: carryover واحد لكل (emp_id, source_year, year, type)
```
التصحيح يتم بقيد `adjustment` معاكس — لا `UPDATE`/`DELETE` من الواجهة.

**`archived_leave_ledger`** — نسخة أرشيفية لقيود الموظف المحذوف (نفس الأعمدة + `archived_at`).

**حقول التجاوز على `leaves`**: `balance_override` (bool) · `balance_override_reason` · `balance_override_by` · `balance_override_at` — لتوثيق الاعتماد الاستثنائي (لا تمثّل رصيداً).

**فهارس الأداء**: `leaves_balance_idx(team, emp_id, status, from_date)` لاشتقاق «المستخدَم».

---

## 6. منطق حساب الأرصدة (الدوال وRPC)

المبدأ: **المستخدَم يُشتق دائماً من الإجازات المعتمدة (`status='معتمد'`) — لا يُخزَّن.**

| الدالة | النوع | الوظيفة |
|---|---|---|
| `fn_leave_days_in_range(emp, from, to, year, basis)` | definer | عدد أيام إجازة داخل سنة وفق الأساس: `calendar` (تقويمي شامل الطرفين) أو `scheduled_workdays` (أيام العمل المجدولة فقط بحسب دورة الموظف + التعديلات اليدوية؛ **لا يُقرأ `leaves` إطلاقاً** كي لا تصبح الإجازة المعتمدة صفراً). |
| `fn_leave_used(emp, year, type, exclude?)` | definer | مجموع الأيام المعتمدة لموظف/سنة/نوع، مع إمكان استثناء طلب واحد (لإعادة التحقّق عند التعديل). |
| `fn_leave_balance(emp, year)` | definer | لكل نوع: `available = entitled + initial + carryover + adjustments` و`remaining = available − used` (لِـ `limited` المضبوط فقط؛ وإلا `NULL`). |
| `my_leave_balances(year)` | **RPC (authenticated)** | رصيد الموظف الحالي فقط — يُحدَّد بـ `auth.uid()` عبر `employee_auth` (لا من العميل). |
| `team_leave_balances(year, team)` | **RPC (authenticated)** | أرصدة كل موظفي وردية — owner لأي وردية، admin لورديته فقط (تحقّق داخلي). |

**الصلاحيات**: الدوال المساعِدة (`fn_*`) ممنوعة على `authenticated`؛ الوصول عبر الـ RPC فقط (`my_leave_balances`, `team_leave_balances`).

---

## 7. الحماية والتحقّق (Triggers)

### 7.1 التحقّق من الرصيد وحماية التجاوز — `fn_validate_leave_balance` (BEFORE INSERT/UPDATE على `leaves`)
- **(أ) حماية حقول التجاوز**: غير owner/admin (أي الموظف) تُطهَّر حقول التجاوز لديه دائماً. owner/admin: يضبط السبب فقط، و`by`/`at` من الخادم؛ **التجاوز بلا سبب مرفوض**.
- **(ب) قفل معاملي تصاعدي** `pg_advisory_xact_lock` لكل (`emp_id|type|year`) قبل فحص الرصيد ⇒ تسلسل الاعتمادات المتزامنة (آمن ضد deadlock بترتيب السنوات تصاعدياً).
- **(ج) إعادة الحساب بعد القفل**: إن تجاوز الطلب الرصيد ولم يكن هناك تجاوز موثّق بسبب ⇒ يُرفَض الاعتماد برسالة «يتطلّب موافقة استثنائية…». الموظف يستطيع الإرسال ويرى تنبيهاً، لكن الاعتماد إلى «معتمد» لا يتم إلا بتجاوز موثّق من owner/admin.

### 7.2 الحقول الموثوقة من الخادم — `20260721190008`
مشغّلات `BEFORE` تفرض من الخادم وتتجاهل العميل:
- `leave_ledger`: `team` (من `employees`) · `created_by` (`auth.uid`) · `created_at` (`now`).
- `leave_policies`: `updated_by` (`auth.uid`) · `updated_at` (`now`).
تعمل **قبل** تقييم `RLS WITH CHECK`، فيتّسق `team` مع صلاحية الكاتب (يمنع تزوير وردية أخرى).

### 7.3 الأرشفة عند حذف موظف — `shift_archive_user` (BEFORE DELETE على `employees`)
يؤرشف `archived_employees` + `archived_leaves` + **`archived_leave_ledger`** ثم يحذف قيود الـledger، كلّه داخل نفس المعاملة (فشل الأرشفة يُلغي الحذف). `employee_auth` يُحذف تلقائياً بـ `ON DELETE CASCADE`.

---

## 8. سياسات RLS (المرحلة الثانية — 2/8) ✅ **مُطبَّقة (آخر عمل)**

`owner`: كل الورديات · `admin`: ورديته فقط · `viewer`/`anon`: **لا وصول مباشر**. لا وردية افتراضية (`w1`) عند غياب الـ metadata — تُشترط وردية غير فارغة تطابق الصف تماماً.

| الجدول | صلاحيات `anon` | صلاحيات `authenticated` | السياسات |
|---|---|---|---|
| `employee_auth` | — | — | لا شيء (definer فقط) |
| `leave_policies` | — | INSERT, SELECT, UPDATE | `read` (SELECT) · `write` (ALL) |
| `leave_ledger` | — | INSERT, SELECT | `read` (SELECT) · `insert` (INSERT) — لا UPDATE/DELETE (إضافة-فقط) |
| `archived_leave_ledger` | — | SELECT | `read` (SELECT) |

تعبير مطابقة المسؤول في كل السياسات:
```sql
(select public.is_owner())
or ((select public.audit_current_user_role()) = 'admin'
    and (select public.audit_current_user_team()) is not null
    and (select public.audit_current_user_team()) <> ''
    and team = (select public.audit_current_user_team()))
```

**اختبارات العزل (JWT حقيقي مع تزوير `app_metadata` — أثبتت أن الدوال تتجاهل ادّعاء العميل):**

| الفاعل (الادّعاء المزوّر) | leave_policies | leave_ledger | archived | employee_auth |
|---|---|---|---|---|
| owner (زُوِّر→viewer/w2) | كل الورديات | ✓ | ✓ | مرفوض |
| admin_w1 (زُوِّر→owner/w2) | w1 فقط | w1 | w1 | مرفوض |
| admin_w2 (زُوِّر→owner/w1) | w2 فقط | w2 | w2 | مرفوض |
| viewer (زُوِّر→owner/w1) | **0** | **0** | **0** | مرفوض |
| anon | مرفوض | مرفوض | مرفوض | مرفوض |

كتابات: admin_w1 يُدرج سياسة w1 = مسموح · سياسة **w2** = مرفوض · UPDATE/DELETE على ledger = مرفوض · viewer يُدرج = مرفوض. كل الاختبارات نُفّذت داخل `BEGIN/ROLLBACK` ولم تترك أي بيانات.

---

## 9. تكامل الواجهة الأمامية مع الأرصدة

- **`cloud.js › pullBalances()`**: للموظف (viewer) عبر `rpc('my_leave_balances', {p_year})` فقط؛ للـ owner/admin قراءة مباشرة لـ `leave_policies` + `leave_ledger` لورديتهم (يسمح RLS).
- **`app.js` (قسم أرصدة الإجازات، السطر ~1041)**: شاشة الأرصدة، محرّر السياسات `openPolicyEditor()`، قيد التعديل `openAdjust()`، بطاقات الرصيد، وحساب رصيد owner/admin محلياً (يعمل دون إنترنت). تنبيه تجاوز الرصيد عند التقديم دون منع الإرسال، وتأكيد سبب التجاوز عند الاعتماد الاستثنائي.

---

## 10. سكربتات إصلاح حسابات Auth (خادميّة — Admin API)

ثلاثة موظفين (392 / 5552 / 2306) كانوا بلا حسابات Auth، ما يعيق الربط 1:1. الحل عبر **Supabase Auth Admin API** (لا إدراج مباشر في `auth.users`):

| الملف | الدور |
|---|---|
| `scripts/lib/auth-repair-core.mjs` | المنطق القابل للاختبار (تثبيت المشروع/المفتاح، pagination، بناء الخطة، التحقّق، التعويض الذرّي، تعقيم الأخطاء). |
| `scripts/repair-missing-auth-users.mjs` | CLI للإنشاء — يتطلّب `APPLY_AUTH_REPAIR=YES_CREATE_3_USERS` للكتابة الفعلية. |
| `scripts/rollback-missing-auth-users.mjs` | CLI للتراجع — يتطلّب `APPLY_AUTH_ROLLBACK=YES_DELETE_REPAIR_USERS`. |
| `scripts/test/auth-repair.test.mjs` | ٢٦ اختبار `node:test` بعميل admin وهمي (mock). |

المفاتيح من البيئة فقط (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`) — لا مفاتيح داخل الكود. `DRY_RUN=1` للفحص. التبعية مثبّتة بلا `^` مع `package-lock.json` وتُثبَّت بـ `npm ci`.

> **حالة:** نُفِّذ الإصلاح خارجياً بموافقتك؛ الحسابات الثلاثة أُنشئت (viewer/w1، مؤكَّدة، بهوية). المجموع 11 → 14. `employee_auth` = 9 روابط صحيحة.

---

## 11. الترحيلات (Migrations) وحالة التطبيق

| # | الملف | الوصف | الحالة |
|---|---|---|---|
| P1 | `20260720190001_audit_core` … `_190009` | المرحلة الأولى: Audit Log + الدوال المساعِدة | ✅ **مُطبَّقة** |
| 0 | `20260721190000_leave_balance_preflight` | فحص قراءة-فقط يوقف التطبيق عند الشذوذ | أداة (لا تُطبَّق كتغيير) |
| 1 | `20260721190001_leave_balance_tables` | الجداول + ربط الهوية + حقول التجاوز + الفهارس | ✅ **مُطبَّقة** |
| 2 | `20260721190002_leave_balance_rls` | سياسات RLS + REVOKE/GRANT | ✅ **مُطبَّقة (آخر عمل)** |
| 3 | `20260721190003_leave_balance_functions` | دوال الحساب + RPC | ⏳ لم تُطبَّق |
| 4 | `20260721190004_leave_balance_override_validation` | التحقّق + قفل الاعتماد + حماية التجاوز | ⏳ لم تُطبَّق |
| 5 | `20260721190005_leave_balance_audit` | تمديد التدقيق لجداول الأرصدة | ⏳ لم تُطبَّق |
| 6 | `20260721190006_leave_balance_archive` | أرشفة الـledger عند حذف موظف | ⏳ لم تُطبَّق |
| 7 | `20260721190007_leave_balance_seed_policies` | بذر سياسات 2026 الافتراضية | ⏳ لم تُطبَّق |
| 8 | `20260721190008_leave_balance_server_fields` | الحقول الموثوقة من الخادم | ⏳ لم تُطبَّق |
| 9 | `20260721190009_leave_balance_rollback` | تراجع كامل للمرحلة الثانية | أداة تراجع |
| 10 | `20260721190010_leave_balance_tests` | اختبارات `BEGIN/ROLLBACK` | أداة اختبار |

**السياسات الافتراضية المبذورة (2026)** — بلا أي عدد أيام قانوني (يضبطه رئيس القسم):
`سنوية`=limited · `عارض`=limited · `مرضية`=unlimited · `مرافق مريض`=unlimited · `دورة تدريبية`=unlimited · `غياب`=tracking_only · `day_count_basis=calendar` · `max_carryover=0`.

---

## 12. القيود الأمنية والتشغيلية (ثابتة)

- **المشروع المستهدف حصراً**: `shift-scheduler` (Ref: `fibkwudabuwfjqpyeeng`).
- **ممنوع الدمج (merge PR) أو النشر (GitHub Pages)** دون موافقة صريحة.
- **لا تُعرض** المفاتيح السرّية أو كلمات المرور أو البريد الكامل أو أي Token.
- كل Migration يُطبَّق بموافقة منفصلة؛ **إن فشل أي اختبار، توقّف ولا تطبّق التالي**.
- لا بيانات اختبار دائمة على الإنتاج (كل الاختبارات داخل `BEGIN/ROLLBACK`).
- الدور/الوردية من قاعدة البيانات دائماً، لا من قيم يرسلها العميل.

---

## 13. الخطوات المتبقّية

1. تطبيق **Migration 3** (`leave_balance_functions`) بموافقة منفصلة، ثم التحقّق (RPC، منع الدوال المساعِدة على `authenticated`).
2. تباعاً: Migrations 4 → 8 (كلّ منها بموافقة واختبار مستقلّين).
3. المرحلة الثانية تكتمل على القاعدة عند تطبيق 3–8 بنجاح؛ الواجهة الأمامية جاهزة سلفاً.
4. قرار مستقل بشأن فشل فحص `audit` في CI (ثغرتان في تبعيات `commerce-ai-os` — `brace-expansion`/`sharp` — خارج نطاق فرع الأرصدة).
5. الدمج/النشر يبقى موقوفاً حتى قرارك الصريح.

---

## 14. ملحق — حالة القاعدة الراهنة (مُتحقَّقة)

`employees` النشطون = 9 · `employee_auth` = 9 (روابط صحيحة، 0 يتيمة) · `leaves` = 14 (حقول التجاوز بقيم آمنة افتراضية) · `leave_policies`/`leave_ledger`/`archived_leave_ledger` = 0 · RLS مفعّلة على الجداول الأربعة · الترحيلات المطبَّقة من المرحلة الثانية: `leave_balance_tables`, `leave_balance_rls` فقط.
