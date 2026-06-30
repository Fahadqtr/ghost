import { createClient } from "@/lib/supabase/server";
import { AGENTS } from "@/lib/constants";
import { getT } from "@/lib/i18n-server";
import AgentsPanel from "@/components/AgentsPanel";
import type { AgentLog } from "@/lib/types";

export const dynamic = "force-dynamic";

// Arabic translations for the agent names + blurbs (keyed by the locked
// constant key in lib/constants).
const AGENT_AR: Record<string, { name: string; blurb: string }> = {
  product: { name: "وكيل المنتجات", blurb: "ينظّف ويُهيكل بيانات المنتجات." },
  image: { name: "وكيل الصور", blurb: "ينظّم ويُصنّف صور المنتجات." },
  inventory: { name: "وكيل المخزون", blurb: "يراقب مستويات المخزون والحدود." },
  channel_sync: { name: "وكيل مزامنة القنوات", blurb: "يبقي قوائم القنوات متطابقة." },
  variant_splitter: { name: "وكيل تقسيم المتغيرات", blurb: "يقسّم المنتجات الأم إلى أبناء لطلبات." },
  snoonu: { name: "وكيل سنونو", blurb: "يجهّز تصديرات قائمة سنونو الرئيسية." },
  talabat: { name: "وكيل طلبات", blurb: "يجهّز تصديرات طلبات المقسّمة CSV." },
  rafeeq: { name: "وكيل رفيق", blurb: "يجهّز تصديرات رفيق." },
  shopify: { name: "وكيل Shopify", blurb: "يجهّز تصديرات Shopify CSV." },
  marketing: { name: "وكيل التسويق", blurb: "يصيغ منشورات التسويق." },
  customer_service: { name: "وكيل خدمة العملاء", blurb: "يتعامل مع استفسارات العملاء." },
  finance: { name: "وكيل المالية", blurb: "يتابع المصروفات والهوامش." },
  ceo: { name: "وكيل المدير التنفيذي", blurb: "يلخّص العمل بالكامل." },
};

export default async function AgentsPage() {
  const supabase = createClient();
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const { data: logs } = await supabase
    .from("agent_logs")
    .select("id, agent_name, command, result, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className="space-y-6">
      <AgentsPanel locale={locale} />

      {/* Agent cards */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">{L("الوكلاء", "Agents")} ({AGENTS.length})</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AGENTS.map((a) => (
            <div key={a.key} className="card">
              <div className="flex items-center justify-between">
                <h4 className="font-medium text-ink">{en ? a.name : (AGENT_AR[a.key]?.name ?? a.name)}</h4>
                <span className="badge bg-slate-100 text-slate-500">{L("خامل", "Idle")}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{en ? a.blurb : (AGENT_AR[a.key]?.blurb ?? a.blurb)}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Recent logs */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">{L("الأوامر الأخيرة", "Recent commands")}</h3>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
                <th className="px-4 py-3 font-medium">{L("الوقت", "When")}</th>
                <th className="px-4 py-3 font-medium">{L("الوكيل", "Agent")}</th>
                <th className="px-4 py-3 font-medium">{L("الأمر", "Command")}</th>
                <th className="px-4 py-3 font-medium">{L("النتيجة", "Result")}</th>
              </tr>
            </thead>
            <tbody>
              {(logs ?? []).length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">{L("لا توجد أوامر مسجّلة بعد.", "No commands logged yet.")}</td></tr>
              ) : (
                (logs as AgentLog[]).map((l) => (
                  <tr key={l.id} className="border-b border-slate-100">
                    <td className="px-4 py-3 text-slate-500">{new Date(l.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 text-slate-700">{l.agent_name ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-700">{l.command ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-500">{l.result ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
