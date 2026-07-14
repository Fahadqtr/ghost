import Link from "next/link";
import { studioModule, STUDIO_STATUS_LABEL } from "@/lib/studio/modules";
import type { Locale } from "@/lib/i18n";

// Placeholder body for a studio module page. Renders the module's identity, its
// status, and a clearly-marked "wiring seam" note describing where the real
// engine will connect later. No generation logic yet — scaffold only.
export default function ModuleScaffold({ slug, locale = "ar" }: { slug: string; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const m = studioModule(slug);
  if (!m) {
    return <div className="card text-sm text-muted">{L("وحدة غير معروفة.", "Unknown module.")}</div>;
  }
  const st = STUDIO_STATUS_LABEL[m.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/studio" className="btn-ghost px-2 py-1 text-xs">← {L("الاستوديو", "Studio")}</Link>
        <span className="text-2xl">{m.icon}</span>
        <h2 className="text-lg font-semibold text-ink">{en ? m.labelEn : m.labelAr}</h2>
        <span className={`badge ${st.badge}`}>{en ? st.en : st.ar}</span>
      </div>

      <p className="text-sm text-muted">{m.descAr}</p>

      {/* Wiring seam — where the real engine connects in a later step. */}
      <div className="card space-y-2 border-violet-200 bg-violet-50/40">
        <p className="text-sm font-bold text-violet-800">🔌 {L("نقطة الربط (لاحقًا)", "Wiring point (later)")}</p>
        <p className="text-xs leading-relaxed text-violet-900" dir="ltr">{m.wiring}</p>
      </div>

      {/* Placeholder work area — intentionally inert in this scaffold. */}
      <div className="card flex flex-col items-center justify-center gap-2 border-dashed py-10 text-center">
        <span className="text-3xl opacity-60">{m.icon}</span>
        <p className="text-sm font-semibold text-ink">{L("الهيكل جاهز — التنفيذ في خطوة قادمة", "Scaffold ready — implementation in a next step")}</p>
        <p className="text-xs text-muted">{L("هذي الصفحة مكان مخصّص، بيتربط بالمحرك الفعلي لاحقًا.", "This page is a placeholder; the real engine connects here later.")}</p>
      </div>
    </div>
  );
}
