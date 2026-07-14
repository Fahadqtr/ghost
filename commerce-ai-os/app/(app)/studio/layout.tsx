import Link from "next/link";
import { getT } from "@/lib/i18n-server";
import { STUDIO_MODULES } from "@/lib/studio/modules";

// Malika AI Studio shell — a persistent module rail + the active module page.
export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">🎨 {L("Malika AI Studio · استوديو ماليكا", "Malika AI Studio")}</h1>
        <p className="text-sm text-muted">{L("منصّة توليد المحتوى الإعلاني — الهيكل الأساسي.", "The ad-content generation platform — foundation.")}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        {/* Module rail */}
        <nav className="card h-fit space-y-1">
          <Link href="/studio" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-semibold text-ink hover:bg-slate-50">
            <span>🏠</span> {L("لوحة الاستوديو", "Studio dashboard")}
          </Link>
          <div className="my-1 border-t border-[#efe3d6]" />
          {STUDIO_MODULES.map((m) => (
            <Link key={m.slug} href={`/studio/${m.slug}`}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50">
              <span>{m.icon}</span> {en ? m.labelEn : m.labelAr}
            </Link>
          ))}
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
