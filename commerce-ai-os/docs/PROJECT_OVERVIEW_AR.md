# مشروع Malak AI — Commerce AI OS
### توثيق المشروع الكامل (الشرح + البرمجة + كل اللي سويناه)

> متجر: **Malika's Universe Trading** — جمال ومنتجات كورية، قطر.
> المالك: فهد · المساعِدة الذكية: **ملاك**.
> الموقع (إنتاج): `ghost-rho-two.vercel.app`

---

## 1) نظرة عامة

**Malak AI** هو نظام «Commerce AI OS» لإدارة كتالوج متجر منتشر على عدّة منصّات
(Snoonu، Talabat، Shopify، Rafeeq) من مكان واحد، مع مساعِدة ذكية بالصوت والنص اسمها **ملاك**
تتولّى كل المهام: الكتالوج، الصور، الأسعار والمخزون، التقارير، المحتوى التسويقي، والعملاء.

الفكرة الأساسية: **كتالوج رئيسي واحد (مصدر الحقيقة)** في قاعدة بيانات Supabase، ومنه:
- تدير المنتجات والأسعار والصور.
- تصدّر لكل منصّة بصيغتها الحقيقية (مع الصور) عشان كل المنصّات تتطابق.
- تتكلم مع ملاك صوتيًا أو نصيًا لتسوّي أي شي.

---

## 2) التقنيات (Tech Stack)

| الطبقة | التقنية |
|---|---|
| الإطار | **Next.js 14** (App Router) + **React 18** + **TypeScript** |
| التنسيق | **Tailwind CSS** (واجهة RTL عربية) |
| قاعدة البيانات + المصادقة + التخزين | **Supabase** (Postgres + Auth + Storage) |
| عقل ملاك | **Anthropic Claude** (Opus 4.8 افتراضيًا، عبر `@anthropic-ai/sdk`) |
| الصوت (TTS) | **ElevenLabs** + Web Speech (fallback) |
| التعرّف على الصوت (STT) | **Web Speech API** (المتصفح) |
| المشهد 3D | **Three.js** (إجرائي بالكامل، بدون ملفات GLB) |
| الإكسل | مكتبة **xlsx** (SheetJS) |
| الاستضافة | **Vercel** (نشر تلقائي من GitHub) |
| PWA | Web App Manifest + أيقونات + standalone |

---

## 3) المعمارية وتدفّق البيانات

```
المتصفح (واجهة ملاك)
   │  POST /api/malak  { messages, imageUrl? }
   ▼
خادم العقل (Next.js route, nodejs runtime)
   │  - يحمل الأسرار (ANTHROPIC_API_KEY + Supabase service role)
   │  - حلقة أدوات Claude:
   │      • أدوات قراءة (catalog_stats, search_products …) → تجيب بيانات حقيقية
   │      • أدوات كتابة (set_price, update_stock, set_approval, add_product,
   │        set_image, generate_product_image) → تجهّز «كرت تأكيد» موقّع HMAC
   │        ولا تكتب شيئًا مباشرة
   │  - الرد النهائي عبر أداة respond: { agent:"malak", speak, panel }
   ▼
المتصفح يعرض الرد + ينطقه (TTS) + يعرض اللوحة (panel)
   │  عند ضغط [أكّد] على كرت الكتابة:
   ▼
POST /api/malak/commit  { token }  → يتحقق من توقيع HMAC ثم يكتب فعليًا في Supabase
```

**مبدأ أمني محوري:** المتصفح ما يشوف أي مفتاح سري — كل الأسرار على الخادم فقط.
وأي عملية كتابة تمرّ بكرت تأكيد موقّع (signed token) قبل ما تنفّذ.

---

## 4) هيكل المشروع (أهم الملفات)

```
commerce-ai-os/
├─ app/
│  ├─ layout.tsx                 ← الجذر: metadata + viewport + manifest (PWA)
│  ├─ manifest.ts                ← PWA manifest (standalone)
│  ├─ icon.tsx / apple-icon.tsx  ← أيقونات التطبيق (ImageResponse)
│  ├─ page.tsx                   ← يحوّل / → /dashboard
│  ├─ (auth)/login/page.tsx      ← تسجيل الدخول
│  └─ (app)/                     ← الصفحات داخل إطار الداشبورد
│     ├─ layout.tsx              ← AppShell (سايدبار/توببار/تنقل)
│     ├─ dashboard/page.tsx      ← لوحة المدير (KPIs + رسوم)
│     ├─ malak/
│     │  ├─ page.tsx             ← صفحة ملاك (server: يجيب KPIs)
│     │  ├─ MalakClient.tsx      ← قلب واجهة ملاك (شات + صوت + لوحات)
│     │  └─ LabScene.tsx         ← مشهد المختبر 3D (Three.js)
│     ├─ products / platforms / channels / inventory / import-export …
│     └─ ...
│  └─ api/
│     ├─ malak/route.ts          ← عقل ملاك (Claude + الأدوات)
│     ├─ malak/commit/route.ts   ← تنفيذ الكتابة بعد التأكيد
│     ├─ malak/speak/route.ts    ← TTS (ElevenLabs)
│     ├─ malak/briefing/route.ts ← الموجز الصباحي
│     ├─ malak/generate-image, upload  ← توليد/رفع الصور
│     └─ export/[channel]/route.ts ← تصدير الكتالوج لكل منصّة
├─ components/                   ← AppShell, Sidebar, Topbar, BottomNav, ExportButtons …
├─ lib/
│  ├─ exporters.ts               ← بُناة ملفات التصدير (Shopify/Snoonu/Talabat/Rafeeq)
│  ├─ dashboard.ts               ← استعلامات الـKPIs
│  ├─ constants.ts               ← الثوابت + قوائم التنقل + التصنيفات
│  ├─ malak/confirm.ts           ← توقيع/تحقق HMAC لكروت التأكيد
│  ├─ malak/intent.ts            ← كشف نيّة الكتابة (forced tool)
│  ├─ malak/talabat-export.mjs   ← صيغة Talabat
│  └─ supabase/ (server, client, admin, middleware)
└─ scripts/                      ← أدوات صيانة (استيراد، رفع صور، SQL …)
```

---

## 5) ملاك — العقل (`app/api/malak/route.ts`)

- **شخصية واحدة:** ملاك تتولّى كل شي بنفسها (بعد ما شِلنا فكرة الفريق). تتكلم لهجة خليجية قطرية،
  مختصرة ومبادِرة، وتعطي رأيها الحقيقي.
- **مساعِدة عامة:** تسولف عن أي موضوع (معلومات، أفكار، ترجمة، برمجة، دردشة) مو بس المتجر.
- **أدوات حقيقية:** تجيب أرقام المتجر الفعلية من Supabase (ما تخترع أرقام).
- **لوحات (panels):** التقارير تطلع كـ«شاشة» (stats/products/post/tiktok) مب نص.
- **الكتابة الآمنة:** أي تعديل (سعر/مخزون/اعتماد/إضافة منتج/صورة) يجهّز كرت تأكيد موقّع،
  والتنفيذ الفعلي بعد ضغط [أكّد] فقط.
- النموذج: `claude-opus-4-8` (قابل للتغيير عبر `MALAK_MODEL`).

---

## 6) الصوت (تجربة مثل ChatGPT Voice)

كل هذا في `MalakClient.tsx`:
- **TTS:** أصوات ElevenLabs عبر `/api/malak/speak`، مع Web Audio API لتشغيل موثوق،
  وfallback لصوت المتصفح العربي.
- **STT:** Web Speech API.
- **وضع الاستماع الدائم:** تفعّله مرة ويُحفظ (localStorage) فيشتغل تلقائيًا كل زيارة من أول لمسة.
- **كلمة الإيقاظ «ملاك»:** نايم لين تسمع «ملاك»، وبعدها يبقى صاحي نافذة ~15 ثانية لمتابعة الكلام.
- **المقاطعة (barge-in):** تقدر تقاطعها وهي تتكلم؛ صوتها يتفلتر (echo filter) عشان ما يحسب نفسه مقاطعة.
- **بطاقة «يتكلّم الآن»:** تطلع صورة ملاك واسمها + موجات صوت أثناء الكلام.

---

## 7) المختبر 3D (`LabScene.tsx`)

مشهد علمي أبيض مضيء مبني بالكامل بـ Three.js (إجرائي):
- أثاث: طاولات مختبر، زجاجات، أنابيب، مجهر، خزائن، سبورات عربية، نباتات، نافذة.
- **ملاك** روبوت كيوت يتحرّك ويعيش (يمشي، يشتغل، يستريح، يلتفت، يلوّح) مثل The Sims.
- **تفادي الاصطدام:** ما يدخل في الأثاث (ينزلق حوله) ولا في شي.
- **تسمية فوق الرأس** + تكبير لما يتكلم.
- كاميرا تتجاوب مع حجم الشاشة + ملء شاشة + زرّ تشغيل/إيقاف الحركة.

> مرّ المشهد بمراحل: مكتب → مختبر أبيض → مركز قيادة AI → رجعناه مختبر أبيض بأسلوب Sims.

---

## 8) تطابق المنصّات والتصدير (`lib/exporters.ts` + `/api/export/[channel]`)

الهدف: **كل المنصّات تتطابق** من كتالوج رئيسي واحد.
- زر **«⬇ تحميل ملف رفيق»** في صفحة الاستيراد/التصدير → يطلّع الكتالوج الحيّ بصيغة رفيق الحقيقية.
- **صيغة رفيق:** نفس قالب الرفع الفعلي — أعمدة إنجليزية:
  `CATEGORY EN/AR · PRODUCT NAME EN/AR · PRICE · DESCRIPTION EN/AR · IMAGE NAME · BARCODE · RAFEEQ ID`
  (بدون فئة فرعية)، إكسل **منسّق** (رأس مثبّت + فلتر + أعمدة بعرض مناسب)، و«new product» لغير الموجود.
- الصور: عبر بكت Supabase `product-images` (IMAGE NAME = الـSKU).
- منصّات أخرى جاهزة: Shopify CSV، Snoonu masterlist، Talabat split-CSV.
- **معرّفات منفصلة لكل منصّة:** `snoonu_id` و`rafeeq_product_id` كل واحد عموده الخاص، ما يتلخبطون.
  (المطابقة بالـSKU + الاسم لتفادي التكرار؛ غير الموجود = «new product».)

---

## 9) قاعدة البيانات (Supabase)

جداول رئيسية: `products`, `inventory`, `brands`, `product_images`, `channels`,
`channel_products`, `product_variants`, `malak_audit`.

أعمدة منتج مهمة: `sku, barcode, name_en, name_ar, main_category, sub_category,
price, discount_price, image_url, image_filename, snoonu_id, rafeeq_product_id,
description_en/ar, keywords_en/ar`.

ملاحظة: العمود `rafeeq_product_id` أُضيف عبر `scripts/add_rafeeq_product_id.sql`
(تشغيل مرة وحدة في SQL Editor) وعبّأ 708 منتج بمعرّف رفيق.

---

## 10) PWA والجوال

- **PWA:** يُثبّت على الشاشة الرئيسية ويفتح بملء الشاشة بدون شريط متصفح (يحل مشكلة المتصفحات المدمجة).
- **شريط تنقّل سفلي** مثل التطبيقات (الرئيسية · الكتالوج · ملاك · المنصات · المخزون).
- **كشف الجهاز بالـ JS** (لمس + حجم الشاشة الفعلي) عشان الجوال ياخذ الدرج دائمًا مهما كذب المتصفح على العرض.
- **viewport meta** صحيح + تخطيطات تتجاوب (بطاقات تتراصّ عمودي على الجوال).

---

## 11) كل اللي سويناه (سجل العمل — PRs)

**ملاك (العقل + الواجهة)**
- #5 مكتب ملاك الافتراضي + فريق 7 وكلاء (لاحقًا اختصرناه لملاك وحدها).
- #9 تحويل ملاك إلى لوحة Commerce AI OS.
- #13 النتائج تطلع كشاشات هولوغرافية (JARVIS).
- #15 تقرير الكتالوج يطلع كشاشة stats.
- #16 فحص Supabase مبكّر + رسالة ودّية لو القاعدة مو مهيّأة.
- #23 ملاك تسولف عن أي موضوع (مساعِدة عامة).
- #45 **ملاك وحدها تسوي كل شي** (شِلنا الفريق).

**الصوت**
- #21 وضع النداء الصوتي (هاندز-فري).
- #25 كلمة الإيقاظ «ملاك».
- #26 المقاطعة الحيّة (barge-in).
- #27 الاستماع الدائم (يُحفظ بين الزيارات).

**المختبر 3D**
- #11/#12/#17/#18/#19/#20 ملء الشاشة + الكاميرا المتجاوبة + ثبات التخطيط.
- #28/#29 مركز قيادة AI.
- #30 الروبوتات تتحرّك بوضوح.
- #31 مختبر أبيض بأسلوب Sims (تسميات + تفادي اصطدام).

**الجوال / PWA / الثيم**
- #14/#24 إصلاح مقاس الجوال + viewport.
- #22 ملء الشاشة على iOS (CSS fallback).
- #32 الطابع الأبيض لصفحة ملاك.
- #33/#34/#36 كشف الجوال (breakpoint → JS → خصائص الجهاز).
- #37 PWA + شريط تنقّل سفلي.
- #38 الداشبورد عمود واحد على الجوال.

**تطابق المنصّات / رفيق**
- #39 صيغة رفيق (40 عمود + صور).
- #40 صيغة رفيق الحقيقية (قالب الرفع 10 أعمدة).
- #41 عمود `rafeeq_product_id` (منفصل لكل منصّة) + SQL تعبئة.
- #42 زر تحميل ملف رفيق الجاهز في النظام.
- #43 شيل الفئة الفرعية + إضافة BARCODE و RAFEEQ ID.
- #44 عناوين إنجليزي + «new product» + إكسل منسّق.

**ملفات بيانات سُلّمت لك**
- `RAFEEQ_ADD` / `RAFEEQ_UPLOAD` — منتجات للإضافة على رفيق بصيغتهم + الصور.
- `Malikas_Master_with_RafeeqID` — الكتالوج + عمود معرّف رفيق.
- `add_rafeeq_product_id.sql` — سكربت قاعدة البيانات.
- صورة مركز قيادة Malak (دعائية).

---

## 12) التشغيل والنشر

**متغيرات البيئة (Vercel → Environment Variables):**
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...        (سري — خادم فقط)
ANTHROPIC_API_KEY=...                (سري)
ELEVENLABS_API_KEY=...               (اختياري للصوت)
MALAK_SIGNING_SECRET=...             (HMAC لكروت التأكيد)
MALAK_MODEL=claude-opus-4-8          (اختياري)
```

**محليًا:**
```
cd commerce-ai-os
npm install        # أو pnpm install
cp .env.local.example .env.local   # عبّئ المفاتيح
npm run dev        # http://localhost:3000
```

**النشر:** أي دمج إلى `master` ينشر تلقائيًا على Vercel.

---

## 13) ملاحظات أمنية

- لا تُودِع أي مفتاح في الكود أو Git. كل الأسرار في متغيرات البيئة فقط.
- `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ELEVENLABS_API_KEY` خادمية فقط.
- `MALAK_SIGNING_SECRET` يوقّع كروت الكتابة (HMAC) — لا كتابة بدون كرت موقّع.
- أي مفاتيح انكشفت سابقًا: **لازم تُلغى (rotate)** وتُولّد جديدة.

---

_تم إنشاء هذا التوثيق آليًا — Malak AI / Commerce AI OS._
