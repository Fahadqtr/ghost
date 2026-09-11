"use client";

// Owner-only: put a READY-MADE Rafeeq archive into the private bucket and get
// the 7-day download link for it.
//
// The bytes go from this browser straight to Supabase Storage using a signed
// upload token the server minted for exactly one object path. Nothing large
// crosses a Next.js route, so the platform's request-size limit is not in the
// path at all.
//
// STEP RAFEEQ 06 — this is a SINGLE upload. The first implementation used the
// resumable (TUS) protocol with the token in x-signature and it was refused
// 403 on create every time: @supabase/storage-js 2.110.0 implements no
// resumable protocol, and the deployed storage does not honour a signed token
// on that endpoint — so the request authorised as anon, which storage.objects
// grants nothing. The page now says plainly that the upload cannot resume
// rather than offering a button that silently restarts from zero.

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Ticket {
  bucket: string;
  objectPath: string;
  token: string;
  contentType: string;
  expectedBytes: number;
  expectedSha256: string;
}
interface LinkDTO {
  url: string; expiresAtIso: string; filename: string;
  objectPath: string; bytes: number; sha256: string;
}

const mb = (n: number) => (n / 1048576).toFixed(1);

/** SHA-256 of a file, via the browser's own crypto. */
async function sha256Of(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function RafeeqPackageUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [localSha, setLocalSha] = useState("");
  const [phase, setPhase] = useState<"" | "hashing" | "uploading" | "verifying" | "checking">("");
  const [link, setLink] = useState<LinkDTO | null>(null);
  const [verified, setVerified] = useState<"" | "match" | "mismatch">("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function pick(f: File | null) {
    setFile(f); setLocalSha(""); setLink(null);
    setVerified(""); setError(null); setNote(null);
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
    setError(null); setNote(null); setLink(null); setVerified("");
    try {
      // 1. the archive's own fingerprint, computed HERE — the value every
      //    later check is compared against.
      setPhase("hashing");
      const sha = localSha || (await sha256Of(file));
      setLocalSha(sha);

      // 2. a credential for one path, issued only after the server has
      //    verified the owner.
      const ticket = (await call("/api/export/rafeeq/package-upload/ticket", {
        filename: file.name, bytes: file.size, sha256: sha,
      })) as Ticket;

      // 3. the official signed upload: one PUT, straight to storage. The
      //    page's client carries only the public key; the ticket's token is
      //    what authorises this one object path.
      setPhase("uploading");
      const supabase = createClient();
      const up = await supabase.storage.from(ticket.bucket).uploadToSignedUrl(
        ticket.objectPath, ticket.token, file,
        { contentType: ticket.contentType, upsert: true },
      );
      if (up.error) throw new Error(`تعذّر الرفع: ${up.error.message}`);

      // 4. storage is asked what it actually holds — the browser's word for
      //    "done" is not the evidence. A short object issues no link.
      setPhase("verifying");
      const issued = (await call("/api/export/rafeeq/package-upload/verify", {
        objectPath: ticket.objectPath, bytes: file.size, sha256: sha,
      })) as LinkDTO;

      // 5. the round trip: download through the link with NO credentials and
      //    hash what comes back. This is the only check that proves the link
      //    a partner will click serves the archive that was prepared.
      setPhase("checking");
      const res = await fetch(issued.url, { cache: "no-store" });
      if (!res.ok) throw new Error("تعذّر تنزيل الملف عبر الرابط للتحقق.");
      const back = await res.blob();
      const ok = back.size === file.size && (await sha256Of(back)) === sha;
      setVerified(ok ? "match" : "mismatch");
      // The link is shown only once BOTH checks pass — a mismatch must not
      // leave a link on screen that looks ready to send.
      if (ok) { setLink(issued); setNote(`تم الرفع والتحقق: ${mb(file.size)} م.ب`); }
      else setError("الملف المرفوع لا يطابق الأصل — لا ترسل أي رابط. أعد الرفع.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الرفع.");
    } finally {
      setPhase("");
    }
  }

  const busy = phase !== "";

  return (
    <section dir="rtl" style={{ display: "grid", gap: 12, maxWidth: 760 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>رفع حزمة رفيق جاهزة</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
        يُرفع الملف من متصفحك مباشرة إلى التخزين الخاص، ولا يمر عبر الخادم.
        الرابط الناتج صالح 7 أيام ويعمل دون تسجيل دخول.
      </p>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
        رفعة واحدة غير قابلة للاستئناف — أبقِ هذه الصفحة مفتوحة حتى الانتهاء.
        إن انقطع الاتصال، يبدأ الرفع من جديد.
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

      <div>
        <button onClick={run} disabled={!file || busy}>
          {phase === "hashing" ? "يحسب البصمة…"
            : phase === "uploading" ? "يرفع… (قد يستغرق عدة دقائق)"
            : phase === "verifying" ? "يتحقق…"
            : phase === "checking" ? "يختبر الرابط…"
            : "رفع وإصدار الرابط"}
        </button>
      </div>

      {busy && <progress style={{ width: "100%" }} />}
      {note && <div style={{ fontSize: 13 }}>{note}</div>}
      {error && <div style={{ fontSize: 13, color: "#b00" }}>{error}</div>}

      {link && verified === "match" && (
        <div style={{ display: "grid", gap: 6, fontSize: 13, borderTop: "1px solid #ddd", paddingTop: 10 }}>
          <div><strong>الرابط:</strong></div>
          <div style={{ direction: "ltr", textAlign: "right", wordBreak: "break-all" }}>{link.url}</div>
          <div>ينتهي في: {new Date(link.expiresAtIso).toLocaleString("en-GB", { timeZone: "Asia/Qatar" })} (توقيت قطر)</div>
          <div>المسار: {link.objectPath}</div>
          <div>تحقق التنزيل: ✅ الحجم وSHA-256 مطابقان للأصل</div>
        </div>
      )}
    </section>
  );
}
