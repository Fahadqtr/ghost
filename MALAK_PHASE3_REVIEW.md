# 🚀 مراجعة Malak — Phase 3

> مراجعة لما أُضيف بعد Phase 2 (الكتابة بتأكيد) — في repo **Fahadqtr/ghost**، فرع `master`، آخر commit `d305c77`.
> توثيق وتحليل لما هو مبنيّ فعلًا. لا يغيّر أي كود.

---

## 1) نظرة عامة — ماذا أضافت Phase 3

| المحور | الميزة |
|---|---|
| 🖼️ توليد الصور | ريم تولّد صورة إعلانية لمنتج عبر OpenAI Images (تأكيد مزدوج + مقاس انستجرام). |
| 🧭 موجّه الأدوات | Tool Router قسري يمنع «هروب» الأدوات (يجبر الأداة المطابقة + شبكة أمان + Logging). |
| ✍️ البوست الإعلاني | قالب بوست احترافي لبيان (هوك/فوائد/مكونات/CTA + إنجليزي + 10 هاشتاقات + منصّات). |
| 🤝 الشخصية | ملاك شريكة صريحة + تنبيهات على الأرقام الشاذّة في كرت التأكيد. |
| 📋 السجل | إظهار حالة `malak_audit` في الواجهة + منع التنفيذ المزدوج (idempotency). |
| 🛡️ المرونة | Error Boundary داخل الواجهة + صفحة ديناميكية + `no-store` (حلّ الكاش جذريًا). |

---

## 2) الملفات (الحالة الحالية)

| الملف | السطور | الوظيفة |
|---|---|---|
| `app/malak/page.tsx` | 11 | غلاف خادمي `force-dynamic` يعرض `<MalakClient/>`. |
| `app/malak/MalakClient.tsx` | 1190 | كل الواجهة + Error Boundary + لوحات: products/stats/post/tiktok/**confirm**/**image_request**. |
| `app/malak/error.tsx` | 39 | شبكة أمان: شاشة خطأ ودودة + إعادة تحميل تلقائية عند خطأ chunk. |
| `app/malak/layout.tsx` | 22 | غلاف RTL + خط Tajawal. |
| `app/api/malak/route.ts` | 900 | العقل: البرومبت، الأدوات، **موجّه الأدوات القسري**، حلقة الأدوات، `prepareWrite`. |
| `app/api/malak/commit/route.ts` | 216 | المنفّذ الوحيد للكتابة (HMAC) + `malak_audit` + منع التكرار. |
| `app/api/malak/generate-image/route.ts` | 163 | توليد الصورة عبر OpenAI ورفعها لـStorage (لا يكتب في DB). |
| `app/api/malak/speak/route.ts` | 128 | النطق (ElevenLabs) صوت لكل وكيل. |
| `app/api/malak/upload/route.ts` | 60 | رفع صورة مرفقة لـStorage (بدون ربط). |
| `lib/malak/confirm.ts` | 90 | توقيع/تحقّق توكن HMAC (15 دقيقة). |
| `lib/malak/intent.ts` | 40 | **موجّه النية** `detectForcedTool`. |
| `supabase/malak_audit.sql` | 29 | سكيمة جدول التدقيق (مرجعية). |

---

## 3) توليد الصور (ريم) — المعمارية

تدفّق **بثلاث خطوات وتأكيد مزدوج**، بنفس آلية HMAC:

```
"ولّد صورة إعلانية لـ mk1215"
  └─ generate_product_image (route.ts) → كرت image_request + توكن A (نوع generate_image)
       └─ [✨ ولّد] → /api/malak/generate-image
            • يتحقق من توكن A
            • يقرأ المنتج + صورته الحالية
            • OpenAI Images: edit (إن وُجدت صورة، يحافظ على العلبة) أو generate من الاسم
            • يرفع لـ product-images/{sku}-ad-{ts}.jpg
            • يرجّع كرت confirm + توكن B (نوع set_image)
                 └─ [✓ اعتمدها] → /api/malak/commit (الموجود) → image_url + product_images + malak_audit
```

- **النموذج:** `OPENAI_IMAGE_MODEL` (افتراضي `gpt-image-1-mini`).
- **المقاس:** `square` (1024×1024) أو `portrait` (1024×1536 لانستجرام/ستوري) — يُختار حسب الطلب.
- **البرومبت:** K-beauty فاخر، إضاءة استوديو، dewy، مساحة للنص، تشديد على الحفاظ على الليبل.
- **الأمان:** لا كتابة في قاعدة البيانات داخل `/generate-image` — الربط يمرّ عبر `/commit` بعد الاعتماد فقط.

---

## 4) موجّه الأدوات القسري (Tool Router) — `intent.ts` + `route.ts`

`detectForcedTool(message)` يُشغَّل **قبل** Claude ويُرجِع الأداة الواجب إجبارها:

| النية | يُجبر |
|---|---|
| صورة/بوستر/بوست/إعلان/تصميم/كريتف/poster/creative/ad image/product image | `generate_product_image` |
| منتج جديد / add product | `add_product` |
| اعتمد/ارفض/approve/reject | `set_approval` |
| مخزون/stock + فعل تغيير | `update_stock` |
| سعر/price + فعل تغيير | `set_price` |

**حواجز ضد الالتباس:** «بدون/ناقص صورة» = قراءة (لا يجبر)، و«اكتب بوست» = نص (لوحة post).

- **الإجبار:** `tool_choice:{type:"tool",name:forcedTool}` على أول نداء — الموديل لا يقدر يرد بنص.
- **شبكة أمان:** لو أُجبرت أداة ولم يستدعها الموديل → رسالة محكومة: «الأداة موجودة لكن لم يتم استدعاؤها…» (لا هلوسة).
- **Logging:** `[malak][router] msg=… | forcedTool=…` ، `forcedTool=X called=… tool_use=[…]` ، `round=N stop_reason=… tool_use=[…]`.
- **قاعدة البرومبت:** «عند مطابقة النية لأداة متاحة يجب استدعاؤها؛ ممنوع ادعاء أنها غير مربوطة؛ اسألي فقط عن الحقول الناقصة».

---

## 5) البوست الإعلاني (بيان) + بيانات أغنى

- `search_products` صار يرجّع: `name_ar, discount_price, size, description_ar/en, keywords_ar/en` → الفوائد/المكونات من المنتج الحقيقي.
- قالب البرومبت يكتب `caption_ar` بهذا الترتيب: عنوان → Hook → 3-5 فوائد → المكونات/التقنية → طريقة الاستخدام → النتيجة → CTA (+السعر/العرض)، بأسلوب خليجي أنيق غير مبالغ.
- `caption_en` مختصرة + **10 هاشتاقات** + المنصّات: Instagram/TikTok/Snapchat/Snoonu/Talabat/Rafeeq.

---

## 6) الأدوات الكاملة (Registry)

**قراءة (5):** `search_products` · `catalog_stats` · `list_rejected` · `list_missing_images` · `low_stock`.
**كتابة (6 — كلها تحضير فقط ثم تأكيد):** `update_stock`(سالم) · `set_price`(رزان) · `set_approval`(نور) · `add_product`(نور+بيان) · `set_image`(ريم) · `generate_product_image`(ريم).
**خاصة:** `respond` (الرد النهائي).

---

## 7) متغيّرات البيئة (أسماء فقط)

`ANTHROPIC_API_KEY` · `SUPABASE_SERVICE_ROLE_KEY` (+ سرّ التوقيع) · `MALAK_SIGNING_SECRET` (اختياري) · `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` · `ELEVENLABS_API_KEY` · `ELEVENLABS_VOICE_ID` · `ELEVENLABS_MODEL_ID` (اختياري) · `ELEVENLABS_VOICE_<AGENT>` (اختياري) · **`OPENAI_API_KEY`** (جديد — توليد الصور) · **`OPENAI_IMAGE_MODEL`** (اختياري، افتراضي gpt-image-1-mini).

---

## 8) الأمان — لا يزال سليمًا

- **لا مسار كتابة يتجاوز التأكيد:** الكتابة فقط في `/commit` خلف توكن HMAC موقّع. `route.ts` و`/generate-image` و`/upload` لا تكتب في DB (الرفع للـStorage فقط).
- توقيع HMAC-SHA256 (سرّ = مفتاح الخدمة)، صلاحية 15 دقيقة، مقارنة ثابتة الزمن.
- **منع التنفيذ المزدوج:** `/commit` يرفض كتابة مطابقة (sku+field+new_value) خلال 30 ثانية (fail-open لو الجدول غير متاح).
- توليد الصور يحترم نفس المبدأ: لا ربط بالمنتج إلا بعد اعتماد صريح.

---

## 9) القيود المعروفة / TODO

1. ⚠️ **النص العربي في صور الـAI:** `gpt-image-1` قد يخربط نص الليبل (PDRN→PORN). راجع المعاينة قبل الاعتماد. البوستر الكامل بنص عربي دقيق = يحتاج Canva (انظر 10) أو قالب HTML.
2. **بوستر Canva (نص عربي مظبوط):** يحتاج **Canva Enterprise** + قالب Autofill + مفتاح Connect API — لم يُبنَ بعد (مكلف لمتجر واحد).
3. **سجل التدقيق اليدوي:** تأكّد أن أعمدة `malak_audit` تطابق `supabase/malak_audit.sql` (الواجهة تنبّه عند فشل التسجيل).
4. **الملفات اليتيمة:** الصور المرفوعة/المولّدة غير المعتمدة تبقى في الـbucket (تنظيف مستقبلي).
5. **أمر واحد لكل رسالة** (لا دفعات).
6. تعليقات قديمة في ترويسة `route.ts` («Phase 1 — read-only»).

---

## 10) الاختبارات

- موجّه النية: **14/14** حالة (بما فيها حالاتك الخمس + 9 حواجز).
- توقيع/تحقّق التوكن: round-trip + رفض التلاعب/الانتهاء/الفساد — نجحت.
- توليد الصور وكتابة DB: تتطلّب بيئة حيّة + اعتماد المستخدم (اختبار يدوي).

---

## الخلاصة

Phase 3 أضافت **الإبداع (صور + بوستات)** و**موثوقية الأدوات (Tool Router + شبكة أمان)** و**المرونة (Error Boundary + إصلاح الكاش)** — مع الحفاظ التام على نموذج الأمان والتأكيد. أهم بند مفتوح: **نص عربي دقيق في البوسترات** (Canva Enterprise أو قالب HTML).
