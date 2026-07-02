"use client";

import type { Locale } from "@/lib/i18n";

// Employee how-to guide, shown as a tab on /staff. Bilingual, printable to PDF,
// and shows a walkthrough video if NEXT_PUBLIC_STAFF_GUIDE_VIDEO_URL is set.

const VIDEO_URL = process.env.NEXT_PUBLIC_STAFF_GUIDE_VIDEO_URL || "";

function VideoEmbed({ url }: { url: string }) {
  const u = url.trim();
  const yt = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
  const loom = u.match(/loom\.com\/(?:share|embed)\/([\w-]+)/);
  const src = yt ? `https://www.youtube.com/embed/${yt[1]}` : loom ? `https://www.loom.com/embed/${loom[1]}` : "";
  if (src) {
    return (
      <div className="relative w-full overflow-hidden rounded-xl border border-[#efe3d6]" style={{ paddingTop: "56.25%" }}>
        <iframe className="absolute inset-0 h-full w-full" src={src} allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen />
      </div>
    );
  }
  // Direct video file
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <video src={u} controls className="w-full rounded-xl border border-[#efe3d6]" />;
}

export default function StaffGuide({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const Section = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
    <div className="rounded-2xl border border-[#efe3d6] bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">{n}</span>
        <h3 className="font-serif text-base font-bold text-ink">{title}</h3>
      </div>
      <div className="space-y-1.5 text-sm text-ink">{children}</div>
    </div>
  );
  const Tip = ({ children }: { children: React.ReactNode }) => (
    <div className="mt-2 rounded-lg border border-[#ecd9c4] bg-brand-light px-3 py-2 text-xs text-brand-dark">{children}</div>
  );
  const Warn = ({ children }: { children: React.ReactNode }) => (
    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{children}</div>
  );
  const Steps = ({ items }: { items: string[] }) => (
    <ol className="list-decimal space-y-1 ps-5 text-sm">{items.map((t, i) => <li key={i}>{t}</li>)}</ol>
  );

  return (
    <div className="staff-guide mx-auto w-full max-w-2xl space-y-4">
      {/* header + actions */}
      <div className="flex items-center justify-between gap-2" data-no-print>
        <div>
          <h2 className="font-serif text-lg font-bold text-ink">{L("دليل استخدام صفحة الموظفين", "Employee page — how-to guide")}</h2>
          <p className="text-xs text-muted">Malika&apos;s Universe</p>
        </div>
        <button onClick={() => window.print()} className="btn-primary px-3 py-2 text-xs">🖨️ {L("تنزيل PDF", "Download PDF")}</button>
      </div>

      {VIDEO_URL ? (
        <div className="rounded-2xl border border-[#efe3d6] bg-white p-4">
          <h3 className="mb-2 font-serif text-base font-bold text-ink">🎬 {L("فيديو توضيحي", "Walkthrough video")}</h3>
          <VideoEmbed url={VIDEO_URL} />
        </div>
      ) : null}

      <Section n={1} title={L("الدخول وتثبيت التطبيق", "Open & install the app")}>
        <Steps items={[
          L("افتح رابط النظام على جوالك ثم اذهب لصفحة /staff.", "Open the system link on your phone and go to /staff."),
          L("أندرويد (كروم): يطلع بانر «تثبيت» — اضغطه فتصير أيقونة على شاشتك.", "Android (Chrome): tap the “Install” banner — it becomes an icon on your home screen."),
          L("آيفون (سفاري): زر المشاركة ⬆️ ← «أضف إلى الشاشة الرئيسية».", "iPhone (Safari): Share ⬆️ → “Add to Home Screen”."),
        ]} />
        <Tip>{L("التطبيق منفصل عن تطبيق المدير — يفتح على صفحتك فقط.", "The app is separate from the admin app — it opens to your page only.")}</Tip>
      </Section>

      <Section n={2} title={L("تسجيل الدخول بالرمز", "Sign in with your code")}>
        <Steps items={[
          L("اكتب رمزك (4–8 أرقام) اللي أعطاك إياه المدير.", "Enter your code (4–8 digits) given by the manager."),
          L("الاسم يُملأ تلقائيًا من رمزك.", "Your name is filled automatically from your code."),
          L("اضغط «دخول» — تفتح صفحتك حسب صلاحياتك.", "Tap “Sign in” — your page opens per your permissions."),
        ]} />
        <Warn>{L("إذا طلع «الرمز غير صحيح» أو «الحساب معطّل» راجِع المدير.", "If you see “wrong code” or “account disabled”, check with the manager.")}</Warn>
      </Section>

      <Section n={3} title={L("التبويبات — حسب صلاحياتك", "Tabs — based on your permissions")}>
        <p>{L("تظهر لك فقط التبويبات اللي أعطاك إياها المدير:", "You only see the tabs the manager granted you:")}</p>
        <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
          {["📦 " + L("المخزون", "Stock"), "➕ " + L("منتج جديد", "Add"), "🔎 " + L("المنتجات", "Products"), "📋 " + L("المهام", "Tasks"), "✨ " + L("ملاك", "Malak"), "📊 " + L("تقاريري", "Reports")].map((t) => (
            <span key={t} className="rounded-full bg-brand-light px-2.5 py-1 text-brand-dark">{t}</span>
          ))}
        </div>
      </Section>

      <Section n={4} title={"📦 " + L("المخزون — إدخال/إخراج", "Stock — in / out")}>
        <Steps items={[
          L("امسح الباركود بماسح USB، أو اضغط 📷 للكاميرا، أو اكتب الاسم/الكود ثم بحث.", "Scan with a USB scanner, tap 📷 for the camera, or type the name/SKU then Search."),
          L("اختر ➕ إدخال أو ➖ إخراج.", "Choose ➕ In or ➖ Out."),
          L("حدّد الكمية بالأزرار − / +.", "Set the quantity with − / +."),
          L("اختر السبب (بيع/تالف/مرتجع…) ثم «تأكيد».", "Pick a reason (sale/damaged/return…) then Confirm."),
        ]} />
        <Tip>{L("تقدر تعدّل الكمية أو تحذف حركتك ما دامت «قيد المراجعة» (قبل اعتماد المدير).", "You can edit the quantity or delete your movement while it’s still pending (before the manager approves).")}</Tip>
      </Section>

      <Section n={5} title={"➕ " + L("منتج جديد — بالصورة", "Add a product — from a photo")}>
        <Steps items={[
          L("اضغط منطقة الصورة → التقاط صورة / المعرض / الملفات.", "Tap the image area → Take Photo / Gallery / Files."),
          L("ينتظر لحظات ويكتب العنوان والوصف والكلمات المفتاحية بأسلوب المتجر.", "It drafts the title, description and keywords in the store’s style."),
          L("راجِع وعدّل، اختر الفئة واكتب السعر والمخزون.", "Review/edit, choose the category, enter price and stock."),
          L("اضغط «أضِف» — الكود والباركود يتولّدان تلقائيًا.", "Tap Add — the SKU and barcode are generated automatically."),
          L("بعد الإضافة تطلع لوحة نسخ الخانات لإضافتها يدويًا في المنصّات.", "After adding, a copy panel lets you copy each field for the platforms."),
        ]} />
        <Warn>{L("المنتج الجديد يظهر عند المدير بانتظار الاعتماد — ما ينشر إلا بموافقته.", "New products land pending the manager’s approval — nothing goes live until approved.")}</Warn>
      </Section>

      <Section n={6} title={"🔎 " + L("المنتجات — بحث وتفاصيل", "Products — search & details")}>
        <Steps items={[
          L("ابحث بالاسم أو الباركود أو الكود (يلقى حتى بباركود الخيار).", "Search by name, barcode or SKU (finds by option barcode too)."),
          L("فلتر حسب الفئة والحالة (متوفّر/منخفض/نافد).", "Filter by category and status (in stock / low / out)."),
          L("المنتج اللي له خيارات فيه شارة 🎚️ — اضغطها تشوف القائمة.", "Products with variants show a 🎚️ chip — tap it to see the options."),
          L("اضغط صورة المنتج → تفتح بطاقة كبيرة بالتفاصيل والمخزون.", "Tap the product image → a big detail card opens."),
        ]} />
        <Tip>{L("الأسعار تظهر فقط إذا أعطاك المدير صلاحية «عرض الأسعار».", "Prices show only if the manager granted you the “View prices” permission.")}</Tip>
      </Section>

      <Section n={7} title={"📋 " + L("المهام", "Tasks")}>
        <Steps items={[
          L("فوق: ملخّص مهامك (مفتوحة/متأخّرة/منجزة).", "Top: your task summary (open / overdue / done)."),
          L("كل مهمة فيها الأولوية (🔴🟡⚪) وتاريخ الاستحقاق.", "Each task shows priority (🔴🟡⚪) and a due date."),
          L("اضغط ▶ جاري لما تبدأ، و✓ تم لما تخلص.", "Tap ▶ In progress when you start, ✓ Done when finished."),
        ]} />
      </Section>

      <Section n={8} title={"✨ " + L("ملاك — المساعد الذكي", "Malak — the assistant")}>
        <ul className="list-disc space-y-1 ps-5 text-sm">
          <li>{L("اسأله عن منتج، مخزون، أو أي سؤال عام — يناديك باسمك.", "Ask about a product, stock, or anything — it greets you by name.")}</li>
          <li>{L("للقراءة والمساعدة فقط — ما يعدّل بيانات ولا أسعار.", "Read-only help — it never changes data or prices.")}</li>
        </ul>
      </Section>

      <Section n={9} title={"📊 " + L("تقاريري", "My reports")}>
        <ul className="list-disc space-y-1 ps-5 text-sm">
          <li>{L("ملخّص إدخالك وإخراجك لليوم + قائمة حركاتك بالوقت.", "Your in/out totals for today + a timed list of your movements.")}</li>
        </ul>
        <Tip>{L("كل حركاتك يراجعها المدير في لوحة الاعتماد — احرص على الدقّة.", "The manager reviews all your movements — please be accurate.")}</Tip>
      </Section>

      <p className="pb-4 text-center text-xs text-muted">Malika&apos;s Universe · Commerce AI OS</p>
    </div>
  );
}
