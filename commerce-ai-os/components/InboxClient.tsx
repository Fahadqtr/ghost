"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  listDmConversations, dmThread, sendDmReply, toggleDmAuto, resolveDmHuman, connectDmSubscription,
  type DmConversationRow, type DmMessageRow,
} from "@/app/(app)/inbox/actions";
import { type Locale } from "@/lib/i18n";

// DM inbox: the conversations «ملاك» handles on Instagram. List → thread with
// a manual reply box (jumping in clears the needs-human flag) and a
// per-conversation auto-reply switch.

export default function InboxClient({ initial, ready, locale = "ar" }: {
  initial: DmConversationRow[]; ready: boolean; locale?: Locale;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [convos, setConvos] = useState<DmConversationRow[]>(initial);
  const [sel, setSel] = useState<DmConversationRow | null>(null);
  const [thread, setThread] = useState<DmMessageRow[]>([]);
  const [input, setInput] = useState("");
  const [err, setErr] = useState("");
  const [connectLog, setConnectLog] = useState<string[]>([]);
  const [busy, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread]);

  const refresh = () => start(async () => {
    const r = await listDmConversations();
    if (!r.ok) { setErr(r.error ?? ""); return; }
    setConvos(r.items);
    if (sel) {
      const t = await dmThread(sel.id);
      if (t.ok) setThread(t.items);
    }
  });

  const open = (c: DmConversationRow) => {
    setSel(c); setThread([]); setErr("");
    start(async () => {
      const t = await dmThread(c.id);
      if (!t.ok) { setErr(t.error ?? ""); return; }
      setThread(t.items);
    });
  };

  const send = () => {
    if (!sel || !input.trim()) return;
    setErr("");
    start(async () => {
      const r = await sendDmReply(sel.id, input);
      if ("error" in r) { setErr(r.error); return; }
      setInput("");
      setConvos((cs) => cs.map((c) => (c.id === sel.id ? { ...c, needs_human: false } : c)));
      const t = await dmThread(sel.id);
      if (t.ok) setThread(t.items);
    });
  };

  const flipAuto = (c: DmConversationRow) => start(async () => {
    const r = await toggleDmAuto(c.id, !c.auto_reply);
    if ("error" in r) { setErr(r.error); return; }
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, auto_reply: !c.auto_reply } : x)));
    setSel((s) => (s && s.id === c.id ? { ...s, auto_reply: !c.auto_reply } : s));
  });

  const connect = () => start(async () => {
    setConnectLog([L("⏳ جاري ربط الصفحة…", "⏳ Connecting the page…")]);
    const r = await connectDmSubscription();
    setConnectLog(r.log.length ? r.log : [r.ok ? "✅" : "❌"]);
  });

  const resolve = (c: DmConversationRow) => start(async () => {
    const r = await resolveDmHuman(c.id);
    if ("error" in r) { setErr(r.error); return; }
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, needs_human: false } : x)));
    setSel((s) => (s && s.id === c.id ? { ...s, needs_human: false } : s));
  });

  const fmt = (s: string | null) => {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  if (!ready) {
    return (
      <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
        ⚙️ {L("شغّل", "Run")} <code className="rounded-sm bg-white px-1">supabase/dm_inbox.sql</code> {L("مرة وحدة في Supabase SQL editor، ثم حدّث الصفحة.", "once in the Supabase SQL editor, then refresh.")}
      </div>
    );
  }

  // Thread view
  if (sel) {
    return (
      <div className="card flex h-[calc(100dvh-14rem)] flex-col p-0">
        <div className="flex items-center justify-between gap-2 border-b border-[#efe3d6] p-3">
          <button onClick={() => setSel(null)} className="btn-ghost px-2 py-1 text-xs">← {L("الوارد", "Inbox")}</button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-bold text-ink">{sel.username || `IG ${sel.external_id.slice(-6)}`}</p>
            <p className="text-[10px] text-muted">📸 Instagram</p>
          </div>
          <button onClick={() => flipAuto(sel)} disabled={busy}
            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${sel.auto_reply ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-500"}`}>
            {sel.auto_reply ? L("🤖 تلقائي", "🤖 Auto") : L("✋ يدوي", "✋ Manual")}
          </button>
        </div>

        {sel.needs_human ? (
          <div className="flex items-center justify-between gap-2 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            🙋 {L("تحتاج رد بشري", "Needs a human reply")}
            <button onClick={() => resolve(sel)} disabled={busy} className="rounded-md bg-white px-2 py-0.5 font-bold ring-1 ring-amber-300">{L("✓ تم التعامل", "✓ Resolved")}</button>
          </div>
        ) : null}

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {thread.length === 0 && busy ? <p className="text-center text-xs text-slate-400">{L("جاري التحميل…", "Loading…")}</p> : null}
          {thread.map((m) => (
            <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.direction === "out" ? "bg-violet-600 text-white" : "bg-slate-100 text-ink"}`}>
                {m.body}
                <div className={`mt-0.5 text-[9px] ${m.direction === "out" ? "text-violet-100" : "text-slate-400"}`}>
                  {m.direction === "out" ? (m.ai ? "🤖 ملاك" : L("👤 أنت", "👤 you")) : ""} {fmt(m.created_at)}
                </div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {err ? <p className="px-3 pb-1 text-xs text-red-600">{err}</p> : null}
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2 border-t border-[#efe3d6] p-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} className="input flex-1"
            placeholder={L("اكتب ردك…", "Type your reply…")} />
          <button type="submit" className="btn-primary px-4 disabled:opacity-50" disabled={busy || !input.trim()}>{L("إرسال", "Send")}</button>
        </form>
      </div>
    );
  }

  // List view
  const needing = convos.filter((c) => c.needs_human).length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {convos.length} {L("محادثة", "conversations")}
          {needing ? <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">🙋 {needing} {L("تحتاج رد", "need a human")}</span> : null}
        </p>
        <div className="flex items-center gap-1">
          <button onClick={connect} disabled={busy} className="btn-ghost px-3 py-1 text-xs disabled:opacity-50">🔌 {L("فعّل الاستقبال", "Connect")}</button>
          <button onClick={refresh} disabled={busy} className="btn-ghost px-3 py-1 text-xs disabled:opacity-50">↻ {L("حدّث", "Refresh")}</button>
        </div>
      </div>
      {connectLog.length ? (
        <div className="space-y-1 rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-xs text-ink">
          {connectLog.map((line, i) => <p key={i} className="break-words">{line}</p>)}
        </div>
      ) : null}
      {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p> : null}
      {convos.length === 0 ? (
        <div className="card py-8 text-center text-sm text-muted">
          {L("ما وصلت رسائل بعد — أول دايركت يوصل بيظهر هنا وترد عليه ملاك تلقائيًا.", "No messages yet — the first DM will appear here and ملاك replies automatically.")}
          <br />
          <span className="text-xs">{L("أرسلت رسالة تجريبية وما ظهرت؟ اضغط «🔌 فعّل الاستقبال» فوق مرة وحدة.", "Sent a test DM and nothing showed? Tap “🔌 Connect” above once.")}</span>
        </div>
      ) : (
        <div className="space-y-2">
          {convos.map((c) => (
            <button key={c.id} onClick={() => open(c)}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-start transition hover:bg-violet-50 ${c.needs_human ? "border-amber-300 bg-amber-50/60" : "border-[#efe3d6] bg-white"}`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100 text-lg">📸</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <b className="truncate text-sm text-ink">{c.username || `IG ${c.external_id.slice(-6)}`}</b>
                  {c.needs_human ? <span className="rounded-full bg-amber-200 px-1.5 text-[10px] font-bold text-amber-900">🙋</span> : null}
                  {!c.auto_reply ? <span className="rounded-full bg-slate-200 px-1.5 text-[10px] text-slate-600">✋</span> : null}
                </span>
                <span className="block truncate text-xs text-muted">{c.last_preview ?? ""}</span>
              </span>
              <span className="shrink-0 text-[10px] text-slate-400">{fmt(c.last_message_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
