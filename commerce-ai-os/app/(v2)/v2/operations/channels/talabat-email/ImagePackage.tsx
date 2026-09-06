"use client";

// Email B's image package: prepare → step → stage.
//
// The work is hundreds of image fetches, so it cannot finish in one request.
// This card drives the same bounded-step loop the certified package generator
// uses, and it is deliberately explicit about progress: a silent five-minute
// spinner is indistinguishable from a hang.
//
// It shows counts it was TOLD, never counts it assumes. `expectedImages` comes
// from the current delta plan on every poll.

import { useCallback, useEffect, useRef, useState } from "react";

type Status = {
  ready: boolean;
  staged: boolean;
  imageCount: number | null;
  expectedImages: number;
  zipBytes: number | null;
  stagedAtIso: string | null;
  blockers: string[];
};

type Job = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: string;
  progressCurrent: number;
  progressTotal: number;
  progressPercent: number;
  error: { code: string; refId: string } | null;
};

const ENDPOINT = "/api/export/talabat/email/images";
const mb = (b: number) => (b / (1024 * 1024)).toFixed(1);

export default function ImagePackage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<{ filename: string; sku: string }[]>([]);
  // A run in flight must not be restarted by a re-render or a second click.
  const running = useRef(false);

  // Fetching and APPLYING are separate: the mount effect below applies only if
  // the component is still alive, so a fast unmount cannot set state on a gone
  // component, and the effect never calls a state-setting function directly.
  const fetchStatus = useCallback(async (): Promise<
    { ok: true; value: Status } | { ok: false; message: string }
  > => {
    try {
      const res = await fetch(ENDPOINT, { cache: "no-store" });
      const body = (await res.json()) as Status & { message_ar?: string };
      return res.ok
        ? { ok: true, value: body }
        : { ok: false, message: body.message_ar ?? "تعذّر قراءة حالة حزمة الصور." };
    } catch {
      return { ok: false, message: "تعذّر الاتصال بالخادم." };
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const got = await fetchStatus();
    if (got.ok) setStatus(got.value); else setError(got.message);
  }, [fetchStatus]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const got = await fetchStatus();
      if (!alive) return;
      if (got.ok) setStatus(got.value); else setError(got.message);
    })();
    return () => { alive = false; };
  }, [fetchStatus]);

  const post = async (payload: Record<string, unknown>) => {
    const res = await fetch(ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const body = (await res.json()) as Record<string, unknown> & { message_ar?: string };
    return { ok: res.ok, body };
  };

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(""); setMissing([]);
    try {
      const started = await post({ action: "start" });
      if (!started.ok) { setError(String(started.body.message_ar ?? "تعذّر بدء التجهيز.")); return; }
      let current = started.body as unknown as Job;
      setJob(current);

      // Bounded-step loop. The cap is a safety net, not a schedule: each step
      // returns real progress, and the loop ends the moment the job does.
      for (let i = 0; i < 2000 && current.status === "running"; i++) {
        const stepped = await post({ action: "step", jobId: current.jobId });
        if (!stepped.ok) { setError(String(stepped.body.message_ar ?? "تعثّر التجهيز.")); return; }
        current = stepped.body as unknown as Job;
        setJob(current);
      }
      if (current.status !== "completed") {
        setError("لم يكتمل تجهيز الصور. يمكنك إعادة المحاولة — سيُستأنف من حيث توقف.");
        return;
      }

      const staged = await post({ action: "stage", jobId: current.jobId });
      if (!staged.ok) {
        setError(String(staged.body.message_ar ?? "تعذّر حفظ حزمة الصور."));
        const miss = staged.body.missing;
        if (Array.isArray(miss)) setMissing(miss as { filename: string; sku: string }[]);
        return;
      }
      await loadStatus();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-800">حزمة صور المنتجات الجديدة</h2>
        <span className={status?.ready ? "text-emerald-700" : "text-amber-800"}>
          {status?.ready ? "جاهزة للاستخدام" : "غير جاهزة"}
        </span>
      </div>

      <p className="text-slate-600">
        صور المنتجات الجديدة تُجهَّز مرة واحدة لكل مقارنة، وتُسلَّم لطلبات برابط تنزيل موقّع —
        لا تُرفق بالبريد إطلاقاً.
      </p>

      {status ? (
        <ul className="space-y-1 text-slate-700">
          <li>الصور المطلوبة للمقارنة الحالية: <span className="font-mono">{status.expectedImages}</span></li>
          {status.staged ? (
            <li>
              المحفوظ حالياً: <span className="font-mono">{status.imageCount}</span> صورة ·{" "}
              <span className="font-mono">{status.zipBytes === null ? "—" : `${mb(status.zipBytes)} م.ب`}</span>
              {status.stagedAtIso ? <> · جُهِّزت {status.stagedAtIso}</> : null}
            </li>
          ) : <li className="text-amber-800">لا توجد حزمة محفوظة بعد.</li>}
          {status.blockers.length > 0 ? (
            <li>
              <ul className="list-disc space-y-1 pe-4 text-amber-900">
                {status.blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </li>
          ) : null}
        </ul>
      ) : null}

      {job && job.status === "running" ? (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
            <div className="h-2 bg-emerald-600" style={{ width: `${job.progressPercent}%` }} />
          </div>
          <p className="text-xs text-slate-600">
            {job.stage} — <span className="font-mono">{job.progressCurrent}</span> /{" "}
            <span className="font-mono">{job.progressTotal}</span> صورة ({job.progressPercent}%)
          </p>
        </div>
      ) : null}

      {error ? <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-700" role="alert">{error}</p> : null}

      {missing.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="mb-1 font-semibold">صور لم تُحمَّل — لم تُحفظ الحزمة:</p>
          <ul className="space-y-0.5">
            {missing.map((m) => (
              <li key={`${m.sku}:${m.filename}`}>
                <span className="font-mono">{m.sku}</span> — <span className="font-mono">{m.filename}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void run()} disabled={busy}
          className="rounded-lg bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-50">
          {busy ? "جارٍ تجهيز الصور…" : status?.ready ? "إعادة تجهيز حزمة الصور" : "تجهيز حزمة الصور"}
        </button>
        <button type="button" onClick={() => void loadStatus()} disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">
          تحديث الحالة
        </button>
      </div>
    </section>
  );
}
