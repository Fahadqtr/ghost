"use client";

// Owner-only: put a READY-MADE Rafeeq archive into the private bucket and get
// the 7-day download link for it.
//
// The bytes go from this browser straight to Supabase Storage over a resumable
// upload, using a token the server minted for exactly one object path. Nothing
// large crosses a Next.js route, so the platform's request-size limit is not in
// the path at all, and an interrupted upload resumes from its own offset.

import { useRef, useState } from "react";
import { tusUpload, sha256Of, type TusUploadOptions } from "./tus-upload";

interface Ticket {
  bucket: string; objectPath: string; token: string; endpoint: string;
  apiKey: string; chunkBytes: number; contentType: string;
  expectedBytes: number; expectedSha256: string;
}
interface LinkDTO {
  url: string; expiresAtIso: string; filename: string;
  objectPath: string; bytes: number; sha256: string;
}

const mb = (n: number) => (n / 1048576).toFixed(1);

export default function RafeeqPackageUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [localSha, setLocalSha] = useState("");
  const [phase, setPhase] = useState<"" | "hashing" | "uploading" | "verifying" | "checking">("");
  const [sent, setSent] = useState(0);
  const [link, setLink] = useState<LinkDTO | null>(null);
  const [roundTrip, setRoundTrip] = useState<"" | "match" | "mismatch">("");
  // Resumability is state, not a ref: the button's label depends on it, and a
  // ref changing would not re-render the label that promises it.
  const [canResume, setCanResume] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const resumeRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  function pick(f: File | null) {
    setFile(f); setLocalSha(""); setSent(0); setLink(null);
    setRoundTrip(""); setError(null); setNote(null);
    resumeRef.current = undefined; setCanResume(false);
  }

  async function call(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof json?.message_ar === "string" ? json.message_ar : "تعذّر تنفيذ الطلب.");
    return json;
  }

  async function run() {
    if (!file) return;
    setError(null); setNote(null); setLink(null); setRoundTrip("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      // 1. the archive's own fingerprint, computed HERE — the value every
      //    later check is compared against.
      setPhase("hashing");
      const sha = localSha || (await sha256Of(file));
      setLocalSha(sha);

      // 2. a credential for one path, issued only after the server has
      //    verified the owner.
      setPhase("uploading");
      const ticket = (await call("/api/export/rafeeq/package-upload/ticket", {
        filename: file.name, bytes: file.size, sha256: sha,
      })) as Ticket;

      const opts: TusUploadOptions = {
        endpoint: ticket.endpoint, token: ticket.token, apiKey: ticket.apiKey,
        bucket: ticket.bucket, objectPath: ticket.objectPath,
        contentType: ticket.contentType, chunkBytes: ticket.chunkBytes,
        file, signal: ctrl.signal,
        onProgress: (done) => setSent(done),
        onUploadUrl: (u) => { resumeRef.current = u; setCanResume(true); },
      };
      await tusUpload(opts, resumeRef.current);

      // 3. storage is asked what it actually holds — the browser's word for
      //    "done" is not the evidence.
      setPhase("verifying");
      const issued = (await call("/api/export/rafeeq/package-upload/verify", {
        objectPath: ticket.objectPath, bytes: file.size, sha256: sha,
      })) as LinkDTO;
      setLink(issued);

      // 4. the round trip: download through the link with NO credentials and
      //    hash what comes back. This is the only check that proves the link
      //    a partner will click serves the archive that was prepared.
      setPhase("checking");
      const res = await fetch(issued.url, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تنزيل الملف عبر الرابط للتحقق.");
      const back = await res.blob();
      const backSha = await sha256Of(back);
      setRoundTrip(back.size === file.size && backSha === sha ? "match" : "mismatch");
      setCanResume(false);
      setNote(`تم الرفع والتحقق: ${mb(file.size)} م.ب`);
    } catch (e) {
      if (ctrl.signal.aborted) setNote("أُوقف الرفع — يمكنك الاستئناف من نفس الموضع.");
      else setError(e instanceof Error ? e.message : "تعذّر الرفع.");
    } finally {
      setPhase("");
      abortRef.current = null;
    }
  }

  const pct = file && sent > 0 ? Math.min(100, Math.round((sent / file.size) * 100)) : 0;
  const busy = phase !== "";

  return (
    <section dir="rtl" style={{ display: "grid", gap: 12, maxWidth: 760 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>رفع حزمة رفيق جاهزة</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
        يُرفع الملف من متصفحك مباشرة إلى التخزين الخاص، ولا يمر عبر الخادم. الرفع
        قابل للاستئناف، والرابط الناتج صالح 7 أيام ويعمل دون تسجيل دخول.
      </p>

      <input
        type="file" accept=".zip,application/zip" disabled={busy}
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
      />

      {file && (
        <div style={{ fontSize: 13 }}>
          <div>{file.name} — {mb(file.size)} م.ب ({file.size.toLocaleString("en-US")} بايت)</div>
          {localSha && <div style={{ direction: "ltr", textAlign: "right", wordBreak: "break-all" }}>SHA-256: {localSha}</div>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={run} disabled={!file || busy}>
          {phase === "hashing" ? "يحسب البصمة…"
            : phase === "uploading" ? `يرفع… ${pct}%`
            : phase === "verifying" ? "يتحقق…"
            : phase === "checking" ? "يختبر الرابط…"
            : canResume ? "استئناف الرفع" : "رفع وإصدار الرابط"}
        </button>
        {busy && <button onClick={() => abortRef.current?.abort()}>إيقاف</button>}
      </div>

      {phase === "uploading" && file && (
        <div>
          <progress value={sent} max={file.size} style={{ width: "100%" }} />
          <div style={{ fontSize: 12 }}>{mb(sent)} / {mb(file.size)} م.ب</div>
        </div>
      )}

      {note && <div style={{ fontSize: 13 }}>{note}</div>}
      {error && <div style={{ fontSize: 13, color: "#b00" }}>{error}</div>}

      {link && (
        <div style={{ display: "grid", gap: 6, fontSize: 13, borderTop: "1px solid #ddd", paddingTop: 10 }}>
          <div><strong>الرابط:</strong></div>
          <div style={{ direction: "ltr", textAlign: "right", wordBreak: "break-all" }}>{link.url}</div>
          <div>ينتهي في: {new Date(link.expiresAtIso).toLocaleString("en-GB", { timeZone: "Asia/Qatar" })} (توقيت قطر)</div>
          <div>المسار: {link.objectPath}</div>
          <div>
            تحقق التنزيل:{" "}
            {roundTrip === "match" ? "✅ الحجم وSHA-256 مطابقان للأصل"
              : roundTrip === "mismatch" ? "❌ لا يطابق الأصل — لا ترسل هذا الرابط"
              : "…"}
          </div>
        </div>
      )}
    </section>
  );
}
