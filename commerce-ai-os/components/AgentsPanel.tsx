"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AGENTS } from "@/lib/constants";
import { logAgentCommand } from "@/app/(app)/agents/actions";
import type { Locale } from "@/lib/i18n";

export default function AgentsPanel({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
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
        setMsg(L("تم تسجيل الأمر ✓", "Command logged ✓"));
        setCommand("");
        router.refresh();
      }
    });
  }

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-ink">{L("لوحة الأوامر", "Command panel")}</h3>
      <p className="mb-3 text-xs text-muted">
        {L("المرحلة 1 تسجّل الأمر في", "Phase 1 records the command to")} <code>agent_logs</code> {L("— لا يعمل أي ذكاء اصطناعي ولا يتم استدعاء أي واجهة خارجية.", "— no AI runs and no external API is called.")}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[220px_1fr_auto]">
        <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {AGENTS.map((a) => (<option key={a.key} value={a.name}>{a.name}</option>))}
        </select>
        <input
          className="input"
          placeholder={L("مثال: نظّف وصنّف الوافدات الجديدة", "e.g. Clean and tag new arrivals")}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
        />
        <button className="btn-primary disabled:opacity-60" disabled={pending} onClick={run}>
          {pending ? L("جارٍ التسجيل…", "Logging…") : L("تشغيل", "Run")}
        </button>
      </div>
      {msg ? <p className="mt-2 text-xs text-slate-600">{msg}</p> : null}
    </div>
  );
}
