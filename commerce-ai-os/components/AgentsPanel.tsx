"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AGENTS } from "@/lib/constants";
import { logAgentCommand } from "@/app/(app)/agents/actions";

export default function AgentsPanel() {
  const router = useRouter();
  const [agent, setAgent] = useState<string>(AGENTS[0].name);
  const [command, setCommand] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setMsg(null);
    startTransition(async () => {
      const res = await logAgentCommand(agent, command);
      if (res?.error) {
        setMsg(res.error);
      } else {
        setMsg("Command logged ✓");
        setCommand("");
        router.refresh();
      }
    });
  }

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-ink">Command panel</h3>
      <p className="mb-3 text-xs text-muted">
        Phase 1 records the command to <code>agent_logs</code> — no AI runs and no external API is called.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[220px_1fr_auto]">
        <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {AGENTS.map((a) => (<option key={a.key} value={a.name}>{a.name}</option>))}
        </select>
        <input
          className="input"
          placeholder="e.g. Clean and tag new arrivals"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
        />
        <button className="btn-primary disabled:opacity-60" disabled={pending} onClick={run}>
          {pending ? "Logging…" : "Run"}
        </button>
      </div>
      {msg ? <p className="mt-2 text-xs text-slate-600">{msg}</p> : null}
    </div>
  );
}
