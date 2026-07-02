"use client";

import { useRef, useState, useTransition } from "react";
import type { Locale } from "@/lib/i18n";
import type { TaskComment, CommentAttachment } from "@/lib/tasks/comments";

type LoadFn = (taskId: string) => Promise<{ comments: TaskComment[]; error?: string }>;
type AddFn = (taskId: string, body: string, attachment?: CommentAttachment | null) => Promise<{ ok: true } | { error: string } | any>;

function fileToAttachment(file: File): Promise<CommentAttachment> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ base64: String(r.result || ""), mediaType: file.type || "application/octet-stream", name: file.name });
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// A two-way comment thread on a task. The parent injects the load/add server
// actions so the SAME component works on the manager page and the staff page.
export default function TaskThread({ taskId, locale = "ar", load, add }: {
  taskId: string; locale?: Locale; load: LoadFn; add: AddFn;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState("");
  const [busy, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => start(async () => {
    const r = await load(taskId);
    if (r.error) setErr(r.error);
    setComments(r.comments); setLoaded(true);
  });
  const toggle = () => { const next = !open; setOpen(next); if (next && !loaded) reload(); };

  const send = () => {
    if (!body.trim() && !file) return;
    setErr("");
    start(async () => {
      let att: CommentAttachment | undefined;
      try { if (file) att = await fileToAttachment(file); } catch { setErr(L("تعذّر قراءة الملف.", "Couldn't read the file.")); return; }
      const r = await add(taskId, body, att);
      if (r && "error" in r && r.error) { setErr(r.error); return; }
      setBody(""); setFile(null); if (fileRef.current) fileRef.current.value = "";
      reload();
    });
  };

  const fmt = (s: string | null) => {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="mt-2 border-t border-[#efe3d6] pt-2">
      <button onClick={toggle} className="text-xs font-medium text-brand hover:underline">
        💬 {L("المحادثة", "Comments")} {loaded ? `(${comments.length})` : ""} {open ? "▴" : "▾"}
      </button>

      {open ? (
        <div className="mt-2 space-y-2">
          {busy && !loaded ? <p className="text-xs text-slate-400">…</p> : null}
          {loaded && comments.length === 0 ? <p className="text-xs text-slate-400">{L("ما فيه رسائل بعد — ابدأ المحادثة.", "No messages yet — start the thread.")}</p> : null}

          {comments.map((c) => {
            const mine = c.role === "manager";
            return (
              <div key={c.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? "bg-brand-light text-ink" : "bg-slate-100 text-ink"}`}>
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted">
                    <span className="font-semibold">{mine ? `👤 ${L("المدير", "Manager")}` : `👤 ${c.author}`}</span>
                    <span>· {fmt(c.createdAt)}</span>
                  </div>
                  {c.body ? <p className="whitespace-pre-wrap">{c.body}</p> : null}
                  {c.attachmentUrl && c.attachmentType === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <a href={c.attachmentUrl} target="_blank" rel="noreferrer"><img src={c.attachmentUrl} alt="" className="mt-1 max-h-44 rounded-lg border border-[#efe3d6]" /></a>
                  ) : c.attachmentUrl ? (
                    <a href={c.attachmentUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 rounded-lg border border-[#e7d9c9] bg-white px-2 py-1 text-xs text-brand-dark">📎 {c.attachmentName || L("مرفق", "attachment")}</a>
                  ) : null}
                </div>
              </div>
            );
          })}

          {err ? <p className="text-xs text-red-600">{err}</p> : null}

          {/* composer */}
          <div className="flex items-end gap-2">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={1} className="input flex-1 text-sm" placeholder={L("اكتب رسالة…", "Write a message…")} />
            <button type="button" onClick={() => fileRef.current?.click()} title={L("إرفاق صورة أو ملف", "Attach image or file")} className="rounded-lg border border-[#e7d9c9] bg-white px-3 py-2 text-base">📎</button>
            <input ref={fileRef} type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button disabled={busy || (!body.trim() && !file)} onClick={send} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">{L("إرسال", "Send")}</button>
          </div>
          {file ? <p className="text-[11px] text-muted">📎 {file.name} <button onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }} className="text-red-500">✕</button></p> : null}
        </div>
      ) : null}
    </div>
  );
}
