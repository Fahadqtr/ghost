import { createClient } from "@/lib/supabase/server";
import { AGENTS } from "@/lib/constants";
import AgentsPanel from "@/components/AgentsPanel";
import type { AgentLog } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const supabase = createClient();
  const { data: logs } = await supabase
    .from("agent_logs")
    .select("id, agent_name, command, result, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className="space-y-6">
      <AgentsPanel />

      {/* Agent cards */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">Agents ({AGENTS.length})</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AGENTS.map((a) => (
            <div key={a.key} className="card">
              <div className="flex items-center justify-between">
                <h4 className="font-medium text-ink">{a.name}</h4>
                <span className="badge bg-slate-100 text-slate-500">Idle</span>
              </div>
              <p className="mt-1 text-sm text-muted">{a.blurb}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Recent logs */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">Recent commands</h3>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Agent</th>
                <th className="px-4 py-3 font-medium">Command</th>
                <th className="px-4 py-3 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {(logs ?? []).length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No commands logged yet.</td></tr>
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
