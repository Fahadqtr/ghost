// /v2/settings/integrations/ticktick — TickTick Project Browser (read-only,
// OWNER-ONLY). Lists the owner's existing TickTick lists (projects) so their
// Project IDs can be read and copied into the TICKTICK_PROJECT_*_ID env config.
//
// Safety: this page NEVER writes to TickTick (no create/update/delete — only
// GET /project via the server-only client), touches no database, and runs no
// SQL/RPC. The access token is read server-side only and never crosses to the
// browser; every failure shows one fixed Arabic message (never a raw API error).

import { isOwner } from "@/lib/malak/authz";
import { OWNER_ONLY_DENIED } from "@/lib/malak/owner-check";
import { loadTickTickProjectBrowser } from "@/lib/integrations/ticktick/client";
import CopyProjectId from "./CopyProjectId";

export const dynamic = "force-dynamic";

export default async function TickTickProjectsPage() {
  // Owner-only: non-owners (and signed-out visitors, already redirected by the
  // /v2 layout) get a fixed denial and NO API call is made.
  if (!(await isOwner())) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {OWNER_ONLY_DENIED}
      </div>
    );
  }

  const result = await loadTickTickProjectBrowser();

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">قوائم TickTick</h1>
        <p className="text-sm text-slate-500">
          اعرض قوائم TickTick الحالية وانسخ معرّف كل قائمة (Project ID) لضبط الربط.
        </p>
      </header>

      {result.state === "not_connected" ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-700" role="status">
          TickTick غير مربوط.
        </div>
      ) : result.state === "error" ? (
        <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
          {result.message}
        </div>
      ) : result.projects.length === 0 ? (
        <div className="card text-sm text-slate-500" role="status">
          لا توجد قوائم في TickTick.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full text-right text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">اسم القائمة</th>
                <th className="px-4 py-3 font-semibold">Project ID</th>
                <th className="px-4 py-3 font-semibold">الحالة</th>
                <th className="px-4 py-3 font-semibold">نمط العرض</th>
                <th className="px-4 py-3 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {result.projects.map((p) => (
                <tr key={p.id} className="border-b border-slate-50 last:border-0 align-middle">
                  <td className="px-4 py-3 font-semibold text-slate-800">{p.name}</td>
                  <td dir="ltr" className="px-4 py-3 text-right font-mono text-xs text-slate-500">
                    {p.id}
                  </td>
                  <td className="px-4 py-3">
                    {p.closed ? (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                        مغلقة
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                        مفتوحة
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{p.viewMode ?? "—"}</td>
                  <td className="px-4 py-3">
                    <CopyProjectId projectId={p.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
