# آخر تحديثات Ghost / Commerce-AI-OS

ملخّص لكل اللي سوّيناه في هالجلسة — جاهز تعطيه لكلود كـ "آخر التحديثات".

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
