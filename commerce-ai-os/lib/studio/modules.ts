// Malika AI Studio — module registry (scaffold only).
//
// This is the SKELETON of the studio: the list of engines/modules, their route
// slugs, and a note on where each one will be wired to real code later. No
// generation happens here yet — pages render a placeholder that points at the
// wiring seam. DB/API-free so it can be unit-tested.

export type ModuleStatus = "planned" | "partial" | "live";

export interface StudioModule {
  slug: string;        // route under /studio/<slug>
  labelAr: string;
  labelEn: string;
  icon: string;        // emoji
  descAr: string;
  status: ModuleStatus;
  /** Where this module will connect to real code (the future wiring seam). */
  wiring: string;
}

export const STUDIO_MODULES: StudioModule[] = [
  {
    slug: "ai-manager", labelAr: "مدير الذكاء", labelEn: "AI Manager", icon: "🧠",
    descAr: "يوجّه كل المحركات: يختار المزوّد والموديل والبرومبت المناسب لكل مهمة.",
    status: "planned",
    wiring: "lib/video/provider-router.ts (resolveProvider) + Anthropic (Claude) لاختيار الموديل/البرومبت.",
  },
  {
    slug: "products", labelAr: "مكتبة المنتجات", labelEn: "Product Library", icon: "📦",
    descAr: "اختر منتجًا وصورته الأصلية كمصدر للتوليد (مرجع المنتج الأساسي).",
    status: "partial",
    wiring: "جدول products + resolveProductImageUrl (app/(app)/content/actions.ts).",
  },
  {
    slug: "script-writer", labelAr: "كاتب السكربت", labelEn: "Script Writer", icon: "✍️",
    descAr: "الذكاء يكتب سيناريو الريل (٤ مشاهد) بصيغة إعلانية.",
    status: "partial",
    wiring: "draftReelScript (app/(app)/content/reel-request-actions.ts) — Claude.",
  },
  {
    slug: "dialect", labelAr: "محوّل اللهجة الخليجية", labelEn: "Gulf Dialect Converter", icon: "🗣️",
    descAr: "يحوّل أي نص للهجة خليجية بيضاء طبيعية، مع مراجعة النطق.",
    status: "planned",
    wiring: "buildScriptPrompt (lib/social/reel-request-compute.ts) + Claude.",
  },
  {
    slug: "prompts", labelAr: "منشئ البرومبتات", labelEn: "Prompt Builder", icon: "🧩",
    descAr: "يبني برومبت الفيديو + الـ negative prompt وضوابط ثبات المنتج والشخصية.",
    status: "partial",
    wiring: "reel-request-compute: buildReelBrief + REEL_NEGATIVE_PROMPT + REEL_MASTER_REFERENCE.",
  },
  {
    slug: "templates", labelAr: "محرك التمبلتات", labelEn: "Template Engine", icon: "🎛️",
    descAr: "قوالب إعلانية قابلة لإعادة الاستخدام (صيغ الريلز + تقنيات FLORA).",
    status: "partial",
    wiring: "REEL_FORMATS (lib/social/reels-plan.ts) + FLORA technique (FLORA_TECHNIQUE_SLUG).",
  },
  {
    slug: "video", labelAr: "محرك الفيديو", labelEn: "Video Engine", icon: "🎬",
    descAr: "يولّد فيديو المنتج — FLORA للمنتجات، Higgsfield للـ UGC/المتكلّم. (معاينة تعمل الآن).",
    status: "live",
    wiring: "lib/video/providers.ts (FloraProvider) عبر provider-router + templates.ts.",
  },
  {
    slug: "voice", labelAr: "محرك الصوت", labelEn: "Voice Engine", icon: "🔊",
    descAr: "تعليق صوتي عربي (ElevenLabs) أو رفع صوت خليجي حقيقي.",
    status: "partial",
    wiring: "lib/social/voiceover.ts (synthArabicVoice) + uploadReelVoice.",
  },
  {
    slug: "translate", labelAr: "محرك الترجمة", labelEn: "Translation Engine", icon: "🌐",
    descAr: "يترجم الكابشن والنصوص بين العربية والإنجليزية.",
    status: "planned",
    wiring: "Anthropic (Claude) — عبر action جديد في الاستوديو.",
  },
  {
    slug: "logo", labelAr: "محرك الشعار", labelEn: "Logo Engine", icon: "🏷️",
    descAr: "يضيف شعار ماليكا على الفيديو (وإنشاء شعارات لاحقًا).",
    status: "planned",
    wiring: "compose (malikaLogoUrl / MALIKA_LOGO_URL) + توليد صور مستقبلًا.",
  },
  {
    slug: "queue", labelAr: "قائمة انتظار التوليد", labelEn: "Generation Queue", icon: "⏳",
    descAr: "طلبات التوليد المعلّقة وحالتها (قيد التوليد / جاهز / مجدول).",
    status: "partial",
    wiring: "جدول reel_requests + listReelRequests (reel-request-actions.ts).",
  },
  {
    slug: "quality", labelAr: "مراقبة الجودة", labelEn: "Quality Monitor", icon: "🔍",
    descAr: "يفحص ثبات المنتج والشخصية ويرفض/يعيد التوليد عند الخلل.",
    status: "planned",
    wiring: "طبقة تحقّق بصرية مستقبلية (Claude vision) بعد كل توليد.",
  },
  {
    slug: "settings", labelAr: "الإعدادات", labelEn: "Settings", icon: "⚙️",
    descAr: "حالة المحركات وطريقة تفعيل FLORA (المفتاح في Vercel لأمانه).",
    status: "live",
    wiring: "videoEngineStatus (studio/actions.ts) + متغيرات البيئة.",
  },
];

/** Quick actions shown on the studio dashboard. */
export const STUDIO_QUICK_ACTIONS = [
  { href: "/studio/video", labelAr: "ريل جديد", labelEn: "New reel", icon: "✨" },
  { href: "/studio/products", labelAr: "المنتجات", labelEn: "Products", icon: "📦" },
  { href: "/studio/templates", labelAr: "التمبلتات", labelEn: "Templates", icon: "🎛️" },
  { href: "/studio/queue", labelAr: "قائمة الانتظار", labelEn: "Queue", icon: "⏳" },
  { href: "/studio/settings", labelAr: "الإعدادات", labelEn: "Settings", icon: "⚙️" },
] as const;

export function studioModule(slug: string | null | undefined): StudioModule | undefined {
  return STUDIO_MODULES.find((m) => m.slug === slug);
}

export const STUDIO_STATUS_LABEL: Record<ModuleStatus, { ar: string; en: string; badge: string }> = {
  planned: { ar: "مخطّط", en: "Planned", badge: "bg-slate-100 text-slate-600" },
  partial: { ar: "جزئي", en: "Partial", badge: "bg-amber-100 text-amber-700" },
  live: { ar: "فعّال", en: "Live", badge: "bg-emerald-100 text-emerald-700" },
};
