import Link from "next/link";
import { getT } from "@/lib/i18n-server";
import { STUDIO_MODULES, STUDIO_QUICK_ACTIONS, STUDIO_STATUS_LABEL } from "@/lib/studio/modules";

export const dynamic = "force-dynamic";

// Studio dashboard — quick actions + the module grid. Scaffold only.
export default async function StudioDashboard() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STUDIO_QUICK_ACTIONS.map((a) => (
          <Link key={a.href} href={a.href}
            className="card flex flex-col items-center justify-center gap-1 py-4 text-center hover:border-violet-300">
            <span className="text-2xl">{a.icon}</span>
            <span className="text-xs font-semibold text-ink">{en ? a.labelEn : a.labelAr}</span>
          </Link>
        ))}
      </div>

      {/* Modules grid */}
      <div>
        <h3 className="mb-2 text-sm font-bold text-ink">{L("الوحدات", "Modules")}</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STUDIO_MODULES.map((m) => {
            const st = STUDIO_STATUS_LABEL[m.status];
            return (
              <Link key={m.slug} href={`/studio/${m.slug}`}
                className="card space-y-1 hover:border-violet-300">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{m.icon}</span>
                  <span className="text-sm font-semibold text-ink">{en ? m.labelEn : m.labelAr}</span>
                  <span className={`badge ms-auto ${st.badge}`}>{en ? st.en : st.ar}</span>
                </div>
                <p className="text-[11px] leading-relaxed text-muted">{m.descAr}</p>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
