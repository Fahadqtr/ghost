"use client";

// Error boundary for the /malak segment. Turns the scary white "Application
// error" into a friendly retry — and, crucially, auto-reloads on a stale-chunk
// error (common right after a redeploy: an old tab requests a JS chunk that no
// longer exists), which self-heals the cache problem.
import { useEffect } from "react";

export default function MalakError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const msg = `${error?.name || ""} ${error?.message || ""}`;
    if (/ChunkLoadError|Loading chunk|module script failed|dynamically imported module|Failed to fetch/i.test(msg)) {
      // Old build artifact → fetch the current one.
      window.location.reload();
    }
  }, [error]);

  return (
    <div
      dir="rtl"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#060814] px-6 text-center text-white"
    >
      <p className="text-lg font-bold">صار خطأ مؤقت في تحميل الصفحة</p>
      <p className="text-sm text-white/60">غالبًا نسخة قديمة محفوظة — إعادة التحميل تحلّها.</p>
      <button
        onClick={() => window.location.reload()}
        className="rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 px-5 py-2.5 text-sm font-bold text-white"
      >
        إعادة التحميل
      </button>
    </div>
  );
}
