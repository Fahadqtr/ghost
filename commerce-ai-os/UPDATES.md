# آخر تحديثات Ghost / Commerce-AI-OS

ملخّص لكل اللي سوّيناه في هالجلسة — جاهز تعطيه لكلود كـ "آخر التحديثات".

---

## جلسة الميزات والتغطية (2026-07-02/03) — PRs #172–#187

**ميزات جديدة (شغّالة بالإنتاج):**
- **البريفينج الصباحي (#174):** ملاك يجهّز موجز أولويات يومي (كرت مرئي + قراءة صوتية مرة باليوم) من `/api/malak/scan` — مبيعات الأمس، النافد، المشاكل مرتّبة بالأهمية.
- **تقارير أعمق (#177):** صفحة `/inventory/reports` — الهوامش والربحية، المخزون الميت، قيمة المخزون، والفاقد (shrinkage) من سجلّ الحركات.
- **مزامنة التوفّر المجدولة (#179 + #180):** Vercel Cron يومي (٣:٠٠ UTC = ٦ صباحًا قطر) على `/api/cron/availability-sync` — يمشّي حقيقة مخزون ماليكاس لكل المنصّات (يكتب الفرق فقط). محمي بـ `CRON_SECRET` (Bearer). ⚠️ درسان: (١) مسار الكرون لازم يكون ضمن `PUBLIC_PATHS` في `lib/supabase/middleware.ts` وإلا يرجّع 307؛ (٢) زر Run اليدوي في Vercel ما يرسل السر — التشغيل المجدول فقط. **مفعّلة ومتحقَّق منها (200) في الإنتاج.**
- **محدّد معدّل على بوابة PIN (#187):** `lib/ratelimit.ts` — نافذة ثابتة عبر Upstash Redis REST (بدون SDK). ١٠ محاولات/٥ دقائق لكل IP على `staffLogin`. **خامل** بدون `UPSTASH_REDIS_REST_URL/TOKEN`، وfail-open لو Redis واقع.

**إصلاح الديون التقنية:**
- **`malak_audit.product_id` (#175):** كان bigint قديم مقابل uuid — الترحيل `supabase/malak_audit_product_id_uuid.sql` **نُفّذ بالإنتاج بنجاح 2026-07-02** (uuid، 48 backfilled، 539 صف). `lib/audit.ts` يكتب `product_id` مباشرة.
- **Dependabot (#176):** تحديثات أسبوعية (npm + GitHub Actions) تصل كل اثنين، ووظيفة `audit` أسبوعية على master.

**ESLint (#178):**
- flat config لـ ESLint 9 + eslint-config-next 16 (استيراد مباشر — FlatCompat يكسر مع next 16). قواعد الصحّة أخطاء؛ قواعد الأنماط المقصودة تحذيرات.
- `pnpm lint` بمزلاج `--max-warnings 74` — أي تحذير جديد يفشّل الفحص.
- **`lint` فحص مطلوب على master** (ضمن ruleset `protect-master` مع typecheck/test/build).

**تغطية اختبارات — 156 → 228 (نمط compute/wrapper):**
- المنطق النقي انفصل عن الـ I/O في وحدات `*-compute.ts` (بدون استيرادات `@/` أو server-only عشان تشتغل مع Node test runner) والغلاف صار رفيعًا:
  `availability-sync` (10)، `shrinkage` (12)، `lowStock` (8)، `staff/stats` (5)، `sales` (8)، `tasks/routines` (8)، `movements` — محرّك كتابة الستوك نفسه (14)، `ratelimit` (7).
- قاعدة موثّقة بالاختبارات: الحركة الجديدة تُحسب بيعًا **بدون حساسية أحرف**، بينما تعديل/حذف حركة يطابقان `"sale"` **حرفيًا** (السبب يتطبّع وقت التسجيل).

**متغيّرات بيئة جديدة:** `CRON_SECRET` (مطلوب للكرون — مضاف بالإنتاج ✅)، `UPSTASH_REDIS_REST_URL/TOKEN` (اختياري)، `STAFF_LOGIN_RATE_LIMIT/WINDOW_SEC` (اختياري). راجع `.env.local.example`.

---

## جلسة التحصين والترقية (2026-07-02) — PRs #164–#171

**البنية التحتية والأمان (بدون تغيير سلوك المنتج):**
- **ترقيات كبرى:** Next.js 15→**16** (اصطلاح `middleware.ts`→`proxy.ts`)، Tailwind 3→**4** (تهيئة CSS-first، حذف `tailwind.config.ts`)، TypeScript 5→**6** (أُضيف `css.d.ts`)، `@supabase/ssr` 0.5→**0.12**، `@types/node`→**22**.
- **أمان:** إصلاح تجاوز حارس SSRF (ترميزات IP رقمية + IPv6 + إعادة تحقّق من التحويلات في `safeFetchImage`)، حارس مصادقة لـ `computeSnoonuDiff`، إصلاح تحذير `postcss`، توحيد 12 حارس مصادقة عبر `isSignedIn()`.
- **RLS:** تأكّد أن كل جداول `public` عليها RLS مفعّل + فاحص Supabase نظيف (أمان + أداء). ⚠️ راجع تحذير قاعدة الإنتاج في `SOURCE_OF_TRUTH.md`.
- **اختبارات:** من 50 → **138** اختبار وحدة (توكنات HMAC، تجزئة الرمز، تحليل الصلاحيات، تمييز Snoonu، بُناة التصدير، محدّد المعدل، بوابة النشر، الموجّه، الرفوف، i18n، تنظيم الحلقات). التشغيل: `pnpm test` (يستخدم `--conditions=react-server`).
- **CI + حماية الفرع:** أُضيف `.github/workflows/ci.yml` (وظائف `typecheck`/`test`/`build` على كل PR)، وruleset `protect-master` يمنع الدمج ما لم تعبر الثلاثة.

---

## 1) ترقية عقل ملاك (Malak) لأقوى موديل
- **قبل:** كان يشتغل بموديل Sonnet (`claude-sonnet-4-6`).
- **بعد:** صار الافتراضي **Claude Opus 4.8** (`claude-opus-4-8`) — أذكى وأعمق في الاستدلال.
- **قابل للتبديل:** يقدر يتغيّر من غير كود عبر متغيّر بيئة `MALAK_MODEL`
  (مثال: `MALAK_MODEL=claude-sonnet-4-6` يرجّعه للأرخص/الأسرع).
- **ما تغيّر:** الأمان، تدفّق التأكيد (confirmation flow)، والأدوات (tools) — كلها زي ما هي.
- الملف: `app/api/malak/route.ts` (سطر `MODEL`).
- ملاحظة تكلفة: Opus أغلى من Sonnet (~٥ أضعاف للتوكِن). يشتغل بنفس `ANTHROPIC_API_KEY`.

## 2) منصّات المنتجات (Product Hubs لكل منصّة)
- إضافة **Product Hubs منفصلة لكل منصّة** مع master مشترك اسمه Malika.
- **صفحة الفهرس (Platforms index):** تعرض عدّادات لكل منصّة → كم منتج
  approved / rejected / none.
- **حذف Snoonu** من قائمة المنصّات لأنه كان تكرار — متجر Malika هو نفسه متجر Snoonu.

## 3) Pure Seoul — منصّة كاملة
- **مطابقة المنتجات (matching):**
  - كشف تلقائي للصيغتين من ملف التصدير: `NonFoodProducts` و `AllExportData`.
  - مطابقة بطبقات: "ناقص بثقة" (confident-missing) مقابل "يحتاج مراجعة" (review).
  - مطابقة تلقائية للمنتجات اللي اسمها subset بدل ما توقفها للمراجعة.
- **قائمة النشر (publish list):** تنسيق يدوي بـ checkboxes لكل عنصر.
- **رفض المنتجات (reject):**
  - أداة رفض بالـ screenshot/لصق (paste) — نفس فكرة Malika.
  - حالة الرفض تتخزّن في **جدول خاص فيها**، وما تلمس بيانات Malika أبدًا.
  - قائمة بالمنتجات المرفوضة على PS مع زر "إلغاء الرفض" (un-reject).
- **التوفّر/المخزون (availability):**
  - قراءة عمود المخزون → عرض المتوفّر مقابل "مخلّصة" (sold-out).
  - "نفد المخزون = منتجات مخفية" (ما فيه نظام كميات).
  - **تعبئة تلقائية** لعمود `availability` داخل النظام (نفس أسلوب Malika).
  - عرض أخطاء التعبئة بدل ما يطلع نجاح كاذب (surface errors).

> ⚠️ **خطوة مطلوبة على Supabase** عشان التعبئة التلقائية تشتغل:
> ```sql
> alter table platform_status add column if not exists availability text;
> ```

---

### سجلّ الكوميتات (الأحدث أولاً)
```
d0db687 Malak: upgrade brain to Opus 4.8 (MALAK_MODEL override)
db395c3 Pure Seoul: surface apply-availability errors instead of false success
3a1972d Pure Seoul: auto-fill availability into the system (like Malika)
b221f35 Pure Seoul: out-of-stock = hidden products (no quantity system)
dbad711 Pure Seoul: read stock column → show present vs sold-out
11af8e3 Platforms: drop Snoonu (Malika is the Snoonu store, was a duplicate)
887ceea Platforms index: show approved/rejected/none counts per platform
aad721f Add per-platform Product Hubs with shared Malika master
0b9d396 Pure Seoul: show rejected-on-PS list with un-reject
2576a00 Pure Seoul: store reject status in its own table, never touch Malika
5cb7b8c Pure Seoul: add screenshot/paste reject tool (same as Malika)
0b19509 Pure Seoul: auto-match name-subset products instead of flagging review
f3fc4f9 Pure Seoul: curate publish list with per-item checkboxes
1226310 pure seoul: auto-detect both export formats
b8fbfee pure seoul: layered matching — confident-missing vs review buckets
```
