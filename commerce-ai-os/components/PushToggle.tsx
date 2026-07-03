"use client";

import { useEffect, useState } from "react";
import type { Locale } from "@/lib/i18n";

// "Enable notifications on this device" — lives in the bell dropdown. Registers
// the existing /sw.js, asks Notification permission, subscribes with the VAPID
// public key, and stores the subscription via /api/push/subscribe. Hidden when
// the server has no VAPID key or the browser can't do push (e.g. iOS Safari
// outside an installed PWA).

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

// PushManager.subscribe wants the VAPID key as a Uint8Array, not base64url.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = "unsupported" | "idle" | "busy" | "on" | "denied";

export default function PushToggle({ locale = "ar" }: { locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [state, setState] = useState<State>("unsupported");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!VAPID_PUBLIC || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
    let alive = true;
    // Reflect the real browser state (permission + existing subscription) so
    // the button reads "مفعّلة" on revisit. All setState calls happen after an
    // await — async external-system sync, not a render-cascading effect.
    (async () => {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js").catch(() => null);
      if (!alive) return;
      if (Notification.permission === "denied") { setState("denied"); return; }
      const sub = await reg?.pushManager.getSubscription().catch(() => null);
      if (alive) setState(sub ? "on" : "idle");
    })();
    return () => { alive = false; };
  }, []);

  const enable = async () => {
    setErr(null);
    setState("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "idle"); return; }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
        }));
      const r = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setState("on");
    } catch (e) {
      setErr(e instanceof Error ? e.message : L("فشل التفعيل.", "Failed to enable."));
      setState("idle");
    }
  };

  const disable = async () => {
    setErr(null);
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => { /* best-effort server cleanup */ });
        await sub.unsubscribe();
      }
      setState("idle");
    } catch {
      setState("on");
    }
  };

  if (state === "unsupported") return null;

  return (
    <div className="border-t border-[#efe3d6] px-3 py-2.5">
      {state === "denied" ? (
        <p className="text-[11px] text-muted">
          🔕 {L("الإشعارات محظورة من إعدادات المتصفح لهذا الموقع.", "Notifications are blocked in the browser settings for this site.")}
        </p>
      ) : (
        <button
          type="button"
          disabled={state === "busy"}
          onClick={state === "on" ? disable : enable}
          className="w-full rounded-xl border border-[#efe3d6] bg-white px-3 py-2 text-sm text-ink hover:brightness-[0.98] disabled:opacity-60"
        >
          {state === "on"
            ? `✅ ${L("إشعارات الجوال مفعّلة — اضغط للإيقاف", "Push notifications ON — tap to disable")}`
            : state === "busy"
              ? L("لحظة…", "One moment…")
              : `🔔 ${L("فعّل إشعارات الجوال على هذا الجهاز", "Enable push notifications on this device")}`}
        </button>
      )}
      {err ? <p className="mt-1.5 text-[11px] text-red-600">{err}</p> : null}
    </div>
  );
}
