"use client";

import { useEffect, useState } from "react";
import { dirOf, type Locale } from "@/lib/i18n";

// A dismissible "install to home screen" banner for the staff PWA. On Android/
// Chrome it uses the native beforeinstallprompt; on iOS Safari (which has no
// such event) it shows the manual Share → Add to Home Screen hint.
export default function StaffInstallPrompt({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [deferred, setDeferred] = useState<any>(null);
  const [ios, setIos] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Register the minimal SW so Chrome will offer "Install". Harmless passthrough.
    try { navigator.serviceWorker?.register("/sw.js").catch(() => {}); } catch { /* ignore */ }

    const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone;
    if (standalone) return; // already installed
    try { if (localStorage.getItem("staff_pwa_dismissed") === "1") return; } catch { /* ignore */ }

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) { setIos(true); setShow(true); return; }

    const onBIP = (e: any) => { e.preventDefault(); setDeferred(e); setShow(true); };
    window.addEventListener("beforeinstallprompt", onBIP);
    return () => window.removeEventListener("beforeinstallprompt", onBIP);
  }, []);

  const dismiss = () => { setShow(false); try { localStorage.setItem("staff_pwa_dismissed", "1"); } catch { /* ignore */ } };
  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    setDeferred(null);
    dismiss();
  };

  if (!show) return null;
  return (
    <div dir={dirOf(locale)} className="fixed inset-x-0 bottom-0 z-40 p-3">
      <div className="mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-violet-200 bg-white p-3 shadow-lg">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-xl">📦</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{L("ثبّت تطبيق الموظفين", "Install the staff app")}</p>
          {ios ? (
            <p className="text-[11px] text-muted">{L("اضغط زر المشاركة ⬆️ ثم «أضف إلى الشاشة الرئيسية».", "Tap Share ⬆️ then “Add to Home Screen”.")}</p>
          ) : (
            <p className="text-[11px] text-muted">{L("افتحه كتطبيق على شاشتك الرئيسية.", "Open it as an app on your home screen.")}</p>
          )}
        </div>
        {!ios ? (
          <button onClick={install} className="shrink-0 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white">{L("تثبيت", "Install")}</button>
        ) : null}
        <button onClick={dismiss} aria-label={L("إغلاق", "Dismiss")} className="shrink-0 rounded-lg px-2 py-1 text-slate-400 hover:text-slate-700">✕</button>
      </div>
    </div>
  );
}
