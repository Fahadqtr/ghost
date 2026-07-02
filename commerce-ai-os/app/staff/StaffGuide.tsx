"use client";

import type { Locale } from "@/lib/i18n";
import GuideDemo from "./GuideDemo";

// Employee how-to guide, shown as a tab on /staff. Bilingual, printable to PDF,
// with a self-running demo up top and a small illustration for every step.

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
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <video src={u} controls className="w-full rounded-xl border border-[#efe3d6]" />;
}

/* ── tiny illustration primitives ─────────────────────────────────────── */
function Illo({ children }: { children: React.ReactNode }) {
  return <div className="shrink-0 space-y-1.5 rounded-xl border border-[#efe3d6] bg-[#fffdfb] p-2.5 sm:w-[190px]">{children}</div>;
}
function Fld({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-[#e7d9c9] px-2 py-1.5 text-[10px] text-muted">{children}</div>;
}
function Btn({ children, tone = "gold" }: { children: React.ReactNode; tone?: "gold" | "green" | "amber" }) {
  const c = tone === "green" ? "bg-emerald-600" : tone === "amber" ? "bg-amber-500" : "bg-brand";
  return <div className={`rounded-lg ${c} py-1.5 text-center text-[10px] font-bold text-white`}>{children}</div>;
}
function Row({ icon, title, sub, chip }: { icon: string; title: string; sub?: string; chip?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[#efe3d6] bg-white p-1.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-light text-xs">{icon}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-[10px] font-semibold text-ink">{title}</span>{sub ? <span className="block text-[8px] text-muted">{sub}</span> : null}</span>
      {chip}
    </div>
  );
}
function Chip({ children, tone }: { children: React.ReactNode; tone: "g" | "a" | "r" }) {
  const c = tone === "g" ? "bg-emerald-50 text-emerald-700" : tone === "a" ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-600";
  return <span className={`rounded-full px-1.5 py-0.5 text-[8px] font-bold ${c}`}>{children}</span>;
}

export default function StaffGuide({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const Section = ({ n, title, illo, children }: { n: number; title: string; illo: React.ReactNode; children: React.ReactNode }) => (
    <div className="rounded-2xl border border-[#efe3d6] bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">{n}</span>
        <h3 className="font-serif text-base font-bold text-ink">{title}</h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-[190px_1fr] sm:items-start">
        <Illo>{illo}</Illo>
        <div className="space-y-1.5 text-sm text-ink">{children}</div>
      </div>
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
      <div className="flex items-center justify-between gap-2" data-no-print>
        <div>
          <h2 className="font-serif text-lg font-bold text-ink">{L("دليل استخدام صفحة الموظفين", "Employee page — how-to guide")}</h2>
          <p className="text-xs text-muted">Malika&apos;s Universe</p>
        </div>
        <button onClick={() => window.print()} className="btn-primary px-3 py-2 text-xs">🖨️ {L("تنزيل PDF", "Download PDF")}</button>
      </div>

      {/* walkthrough */}
      <div className="rounded-2xl border border-[#efe3d6] bg-white p-4">
        <h3 className="mb-3 font-serif text-base font-bold text-ink">🎬 {L("شاهد الطريقة", "See how it works")}</h3>
        {VIDEO_URL ? <VideoEmbed url={VIDEO_URL} /> : <GuideDemo locale={locale} />}
      </div>

      <Section n={1} title={L("الدخول وتثبيت التطبيق", "Open & install the app")}
        illo={<><Row icon="📦" title={L("ثبّت تطبيق الموظفين", "Install the app")} sub={L("على الشاشة الرئيسية", "to home screen")} /><Btn>{L("تثبيت", "Install")}</Btn></>}>
        <Steps items={[
          L("افتح رابط النظام على جوالك ثم اذهب لصفحة /staff.", "Open the system link on your phone and go to /staff."),
          L("أندرويد (كروم): اضغط بانر «تثبيت».", "Android (Chrome): tap the “Install” banner."),
          L("آيفون (سفاري): مشاركة ⬆️ ← «أضف إلى الشاشة الرئيسية».", "iPhone (Safari): Share ⬆️ → “Add to Home Screen”."),
        ]} />
        <Tip>{L("التطبيق منفصل عن تطبيق المدير — يفتح على صفحتك فقط.", "Separate from the admin app — opens to your page only.")}</Tip>
      </Section>

      <Section n={2} title={L("تسجيل الدخول بالرمز", "Sign in with your code")}
        illo={<><div className="text-center text-lg">📦</div><Fld>{L("رمزك", "Your code")} ••••</Fld><Fld>{L("اسمك (اختياري)", "Name (optional)")}</Fld><Btn>{L("دخول", "Sign in")}</Btn></>}>
        <Steps items={[
          L("اكتب رمزك (4–8 أرقام) من المدير.", "Enter your 4–8 digit code from the manager."),
          L("الاسم يُملأ تلقائيًا من رمزك.", "Your name is filled automatically."),
          L("اضغط «دخول».", "Tap “Sign in”."),
        ]} />
        <Warn>{L("«الرمز غير صحيح» أو «معطّل»؟ راجِع المدير.", "“Wrong code” or “disabled”? Check with the manager.")}</Warn>
      </Section>

      <Section n={3} title={L("التبويبات — حسب صلاحياتك", "Tabs — per your permissions")}
        illo={<div className="flex flex-wrap gap-1">{["📦","➕","🔎","📋","✨","📊"].map((c)=><span key={c} className="rounded-md bg-brand-light px-1.5 py-1 text-[11px]">{c}</span>)}</div>}>
        <p>{L("تظهر لك فقط التبويبات اللي أعطاك إياها المدير: المخزون، منتج جديد، المنتجات، المهام، ملاك، تقاريري.", "You only see the tabs the manager granted: Stock, Add, Products, Tasks, Malak, Reports.")}</p>
      </Section>

      <Section n={4} title={"📦 " + L("المخزون — إدخال/إخراج", "Stock — in / out")}
        illo={<><Fld>{L("امسح الباركود… 📷", "Scan barcode… 📷")}</Fld><Row icon="🧴" title={L("سيروم جلو", "Glow serum")} sub="mk1204 · 12" /><div className="grid grid-cols-2 gap-1.5"><Btn tone="green">➕ {L("إدخال","In")}</Btn><Btn tone="amber">➖ {L("إخراج","Out")}</Btn></div><Btn tone="green">✓ {L("تأكيد", "Confirm")}</Btn></>}>
        <Steps items={[
          L("امسح الباركود (USB أو 📷) أو اكتب الاسم/الكود.", "Scan (USB or 📷) or type name/SKU."),
          L("اختر ➕ إدخال أو ➖ إخراج، وحدّد الكمية.", "Choose ➕ In or ➖ Out, set quantity."),
          L("اختر السبب ثم «تأكيد».", "Pick a reason then Confirm."),
        ]} />
        <Tip>{L("تقدر تعدّل أو تحذف حركتك ما دامت «قيد المراجعة».", "You can edit/delete your movement while it’s pending.")}</Tip>
      </Section>

      <Section n={5} title={"➕ " + L("منتج جديد — بالصورة", "Add a product — from a photo")}
        illo={<><div className="rounded-lg border-2 border-dashed border-brand/40 bg-brand-light/40 py-3 text-center text-[10px] text-brand-dark">📸 {L("صوّر المنتج", "Photograph")}</div><Fld>{L("الاسم ✨", "Name ✨")}</Fld><Fld>{L("الوصف ✨", "Description ✨")}</Fld><Btn>{L("أضِف", "Add")}</Btn></>}>
        <Steps items={[
          L("اضغط منطقة الصورة → التقاط/معرض/ملفات.", "Tap the image area → Take/Gallery/Files."),
          L("يتولّد العنوان والوصف بأسلوب المتجر.", "Title & description are drafted in the store style."),
          L("راجِع، اختر الفئة، اكتب السعر والمخزون، ثم «أضِف».", "Review, pick category, price & stock, then Add."),
          L("بعدها لوحة نسخ الخانات للمنصّات.", "Then a copy panel for the platforms."),
        ]} />
        <Warn>{L("المنتج الجديد بانتظار اعتماد المدير قبل النشر.", "New products await the manager’s approval.")}</Warn>
      </Section>

      <Section n={6} title={"🔎 " + L("المنتجات — بحث وتفاصيل", "Products — search & details")}
        illo={<><Fld>{L("ابحث…", "Search…")}</Fld><Row icon="💄" title={L("تينت شفاه","Lip tint")} sub="mk1004" chip={<Chip tone="g">10</Chip>} /><Row icon="🧴" title={L("مزيل طلاء","Remover")} sub="mk1386" chip={<Chip tone="r">{L("نافد","Out")}</Chip>} /></>}>
        <Steps items={[
          L("ابحث بالاسم/الباركود/الكود، وفلتر بالفئة والحالة.", "Search by name/barcode/SKU; filter by category & status."),
          L("المنتج اللي له خيارات فيه شارة 🎚️ — اضغطها.", "Products with variants show a 🎚️ chip — tap it."),
          L("اضغط صورة المنتج → بطاقة تفاصيل كبيرة.", "Tap the image → a big detail card."),
        ]} />
        <Tip>{L("الأسعار تظهر فقط بصلاحية «عرض الأسعار».", "Prices show only with the “View prices” permission.")}</Tip>
      </Section>

      <Section n={7} title={"📋 " + L("المهام", "Tasks")}
        illo={<><div className="relative overflow-hidden rounded-lg border border-red-200 bg-red-50 p-1.5 ps-2.5"><span className="absolute inset-y-0 start-0 w-1 bg-red-500" /><span className="block text-[10px] font-bold text-ink">🔴 {L("رتّبي الرف","Tidy shelf")}</span><span className="text-[8px] text-red-600">⏰ {L("متأخّرة","overdue")}</span></div><div className="grid grid-cols-2 gap-1.5"><Btn tone="amber">▶ {L("جاري","Doing")}</Btn><Btn tone="green">✓ {L("تم","Done")}</Btn></div></>}>
        <Steps items={[
          L("فوق: ملخّص مهامك (مفتوحة/متأخّرة/منجزة).", "Top: summary (open/overdue/done)."),
          L("اضغط ▶ جاري لما تبدأ، و✓ تم لما تخلص.", "Tap ▶ when you start, ✓ when done."),
          L("اضغط 💬 المحادثة على المهمة لتكتب تعليقًا أو ترفق صورة/ملف للمدير — والمدير يرد عليك.", "Tap 💬 Comments on a task to write a note or attach an image/file for the manager — and they reply back."),
        ]} />
      </Section>

      <Section n={8} title={"✨ " + L("ملاك — المساعد", "Malak — the assistant")}
        illo={<><div className="text-center text-lg">✨</div><div className="rounded-xl bg-brand-light px-2 py-1.5 text-[9px] text-brand-dark">{L("هلا! عندنا 10 من تينت الشفاه 👍","Hi! we have 10 lip tints 👍")}</div><Fld>{L("اكتب رسالتك…","Type…")}</Fld></>}>
        <ul className="list-disc space-y-1 ps-5 text-sm">
          <li>{L("اسأله عن منتج أو مخزون أو أي سؤال — يناديك باسمك.", "Ask about a product, stock, or anything — greets you by name.")}</li>
          <li>{L("للمساعدة فقط — ما يعدّل بيانات ولا أسعار.", "Read-only help — never changes data or prices.")}</li>
        </ul>
      </Section>

      <Section n={9} title={"📊 " + L("تقاريري", "My reports")}
        illo={<><div className="grid grid-cols-2 gap-1.5 text-center"><div className="rounded-lg border border-[#efe3d6] py-1.5 text-[9px] text-muted">{L("أدخلت","In")}<b className="block text-emerald-600">18</b></div><div className="rounded-lg border border-[#efe3d6] py-1.5 text-[9px] text-muted">{L("أخرجت","Out")}<b className="block text-amber-600">7</b></div></div><Row icon="➕" title="mk1204" sub="10:22" /></>}>
        <ul className="list-disc space-y-1 ps-5 text-sm">
          <li>{L("ملخّص إدخالك وإخراجك اليوم + قائمة حركاتك بالوقت.", "Your in/out totals today + a timed list of movements.")}</li>
        </ul>
        <Tip>{L("كل حركاتك يراجعها المدير — احرص على الدقّة.", "The manager reviews everything — be accurate.")}</Tip>
      </Section>

      <p className="pb-4 text-center text-xs text-muted">Malika&apos;s Universe · Commerce AI OS</p>
    </div>
  );
}
