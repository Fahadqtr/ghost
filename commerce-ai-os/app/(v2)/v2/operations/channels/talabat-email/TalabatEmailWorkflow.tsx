"use client";

// The two email cards: Generate → Preview → Test Send.
//
// The confirmation is bound to a TOKEN the preview returns for the exact
// message it showed. Typing in the To or CC field clears the held token, so a
// confirmation can never survive an edit — the server checks the same thing
// again, and this is only the honest version of it in the UI.

import { useState } from "react";

type Preview = {
  kind: string;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string;
  /** the exact HTML the transport will send. null ⇒ plain text only. */
  bodyHtml: string | null;
  bodyText: string;
  attachments: { filename: string; bytes: number }[];
  size: { rawAttachmentBytes: number; estimatedMessageBytes: number; limitBytes: number; withinLimit: boolean };
  oversizeGuidance: string[];
  artifactPresent: boolean;
  artifactFresh: boolean;
  artifactRunFingerprint: string | null;
  artifactGeneratedAtIso: string | null;
  confirmationToken: string;
  blockers: string[];
  sendable: boolean;
};

// The counts are NOT written here. Every figure the owner reads comes from the
// generated artifact's own scope, shown in the preview below — a number typed
// into the UI is a number that goes stale the first time the delta changes.
const KINDS = [
  { kind: "existing_updates", title: "تحديث المنتجات الحالية", note: "الاسم والسعر فقط — لا باركود" },
  { kind: "new_products", title: "إضافة المنتجات الجديدة", note: "منتجات غير مدرجة على طلبات + الصور برابط آمن" },
] as const;

const mb = (b: number) => (b / (1024 * 1024)).toFixed(1);

export default function TalabatEmailWorkflow(props: {
  senderVerified: boolean;
  senderAddress: string | null;
  savedTo: string;
  savedCc: string;
  deliveryLogReady: boolean;
  officialSendDisabledReason: string;
}) {
  return (
    <div className="space-y-4">
      {KINDS.map((k) => (
        <EmailCard key={k.kind} kindId={k.kind} title={k.title} note={k.note} {...props} />
      ))}
    </div>
  );
}

function EmailCard({
  kindId, title, note, savedTo, savedCc, officialSendDisabledReason,
}: {
  kindId: string; title: string; note: string;
  senderVerified: boolean; senderAddress: string | null;
  savedTo: string; savedCc: string; deliveryLogReady: boolean; officialSendDisabledReason: string;
}) {
  const [to, setTo] = useState(savedTo);
  const [cc, setCc] = useState(savedCc);
  const [run, setRun] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmedToken, setConfirmedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "generate" | "preview" | "send">("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ANY edit to the message invalidates a held confirmation — the server
  // enforces this too; doing it here keeps the button from lying.
  function edit(setter: (v: string) => void) {
    return (v: string) => { setter(v); setConfirmedToken(null); setPreview(null); };
  }

  async function call(url: string, init?: RequestInit) {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body?.message_ar === "string" ? body.message_ar : "تعذّر تنفيذ الطلب.");
    return body;
  }

  async function generate() {
    setBusy("generate"); setError(null); setMessage(null); setConfirmedToken(null);
    try {
      const body = await call(`/api/export/talabat/email/generate/${kindId}`, { method: "POST" });
      setRun(typeof body?.runFingerprint === "string" ? body.runFingerprint : "");
      const files = Array.isArray(body?.files) ? body.files : [];
      setMessage(
        `تم التوليد: ${files.map((f: { filename: string; bytes: number }) => `${f.filename} (${mb(f.bytes)} م.ب)`).join("، ")}` +
        ` · صفوف: ${body?.workbookRows ?? "?"} · بصمة التشغيل: ${body?.runFingerprint ?? "?"}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر التوليد.");
    } finally { setBusy(""); }
  }

  async function loadPreview() {
    setBusy("preview"); setError(null); setMessage(null); setConfirmedToken(null);
    try {
      const q = new URLSearchParams({ mode: "test", to, cc, ...(run ? { run } : {}) });
      setPreview(await call(`/api/export/talabat/email/workflow/${kindId}?${q}`) as Preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّرت المعاينة.");
    } finally { setBusy(""); }
  }

  async function testSend() {
    if (!preview || confirmedToken !== preview.confirmationToken) return;
    setBusy("send"); setError(null); setMessage(null);
    try {
      const body = await call(`/api/export/talabat/email/workflow/${kindId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, cc, run, confirmationToken: confirmedToken }),
      });
      setMessage(`تم إرسال رسالة اختبار إلى ${(body?.to ?? []).join("، ")} — معرّف المزوّد: ${body?.messageId ?? "—"}`);
      setConfirmedToken(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الإرسال الاختباري.");
    } finally { setBusy(""); }
  }

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold text-slate-800">{title}</h2>
        <span className="text-xs text-slate-500">{note}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void generate()} disabled={busy !== ""}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50">
          {busy === "generate" ? "جارٍ التوليد…" : "توليد الملفات"}
        </button>
        <button type="button" onClick={() => void loadPreview()} disabled={busy !== ""}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">
          {busy === "preview" ? "جارٍ التحضير…" : "معاينة الرسالة"}
        </button>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-slate-600">إلى (To) — يُكتب لكل إرسال</span>
        <input type="text" dir="ltr" value={to} onChange={(e) => edit(setTo)(e.target.value)}
          placeholder="اكتب عنوان المستلم"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-600">نسخة (CC) — اختياري</span>
        <input type="text" dir="ltr" value={cc} onChange={(e) => edit(setCc)(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm" />
      </label>

      {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700" role="alert">{error}</p> : null}
      {message ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800" role="status">{message}</p> : null}

      {preview ? (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
          <p><span className="text-slate-500">من:</span> <span className="font-mono">{preview.from ?? "—"}</span></p>
          <p><span className="text-slate-500">إلى:</span> <span className="font-mono">{preview.to.join("، ") || "—"}</span></p>
          {preview.cc.length > 0 ? <p><span className="text-slate-500">نسخة:</span> <span className="font-mono">{preview.cc.join("، ")}</span></p> : null}
          <p><span className="text-slate-500">الموضوع:</span> {preview.subject}</p>
          <BodyPreview bodyHtml={preview.bodyHtml} bodyText={preview.bodyText} />
          <ul className="text-xs text-slate-600">
            {preview.attachments.map((a) => <li key={a.filename}><span className="font-mono">{a.filename}</span> — {mb(a.bytes)} م.ب</li>)}
          </ul>
          <p className="text-xs text-slate-600">
            حجم المرفقات {mb(preview.size.rawAttachmentBytes)} م.ب · الرسالة المقدّرة {mb(preview.size.estimatedMessageBytes)} م.ب ·
            الحد {mb(preview.size.limitBytes)} م.ب
          </p>
          {preview.artifactRunFingerprint ? (
            <p className="text-xs text-slate-500">
              بصمة التشغيل: <span className="font-mono">{preview.artifactRunFingerprint}</span>
              {preview.artifactGeneratedAtIso ? ` · وُلّدت ${preview.artifactGeneratedAtIso}` : ""}
              {preview.artifactFresh ? " · مطابقة" : " · غير مطابقة للمقارنة الحالية"}
            </p>
          ) : null}
          {preview.oversizeGuidance.length > 0 ? (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <ul className="list-disc space-y-1 pe-4">{preview.oversizeGuidance.map((g) => <li key={g}>{g}</li>)}</ul>
            </div>
          ) : null}
          {preview.blockers.length > 0 ? (
            <ul className="list-disc space-y-1 pe-4 text-xs text-amber-900">
              {preview.blockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          ) : null}

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1"
              checked={confirmedToken === preview.confirmationToken}
              onChange={(e) => setConfirmedToken(e.target.checked ? preview.confirmationToken : null)} />
            <span>أؤكد إرسال رسالة اختبار بهذه البيانات بالضبط.</span>
          </label>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void testSend()}
              disabled={busy !== "" || !preview.sendable || confirmedToken !== preview.confirmationToken}
              className="rounded-lg bg-amber-600 px-3 py-2 text-sm text-white disabled:opacity-50">
              {busy === "send" ? "جارٍ الإرسال…" : "إرسال اختباري"}
            </button>
            <button type="button" disabled title={officialSendDisabledReason}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm opacity-50">
              الإرسال الرسمي (معطّل)
            </button>
          </div>
          <p className="text-xs text-slate-500">{officialSendDisabledReason}</p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The message body, exactly as it will arrive.
 *
 * The HTML is rendered inside a sandboxed iframe, not injected into the page:
 * an iframe is the only way to show the email in its OWN styles instead of the
 * app's, and sandboxing means the preview can never run anything. The plain-text
 * alternative is one click away because that is what some recipients will read.
 */
function BodyPreview({ bodyHtml, bodyText }: { bodyHtml: string | null; bodyText: string }) {
  const [tab, setTab] = useState<"html" | "text">(bodyHtml === null ? "text" : "html");
  const showHtml = tab === "html" && bodyHtml !== null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <button type="button" onClick={() => setTab("html")} disabled={bodyHtml === null}
          className={`rounded px-2 py-1 ${showHtml ? "bg-slate-800 text-white" : "border border-slate-300"} disabled:opacity-40`}>
          الرسالة كما ستصل
        </button>
        <button type="button" onClick={() => setTab("text")}
          className={`rounded px-2 py-1 ${showHtml ? "border border-slate-300" : "bg-slate-800 text-white"}`}>
          النص العادي
        </button>
        {bodyHtml === null ? <span className="text-amber-700">التوقيع المعتمد غير مثبّت — ستُرسل كنص عادي.</span> : null}
      </div>
      {showHtml ? (
        <iframe title="معاينة البريد" sandbox="" srcDoc={bodyHtml as string} dir="ltr"
          className="h-96 w-full rounded border border-slate-200 bg-white" />
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{bodyText}</pre>
      )}
    </div>
  );
}
