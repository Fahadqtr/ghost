"use client";

// MEDIA.1A-P4 — Snoonu session capture helper form (CLIENT-ONLY, owner page).
//
// Everything entered here stays in THIS component's memory: the form imports no
// server module and calls no server action, performs no fetch, writes no
// storage/cookie, and puts nothing in the URL. The generated JSON is built by
// the pure builder (which round-trips the adapter's own parser) and leaves the
// browser only via the operator's clipboard, destined for the Vercel env var.
// Sensitive fields are masked password inputs with autofill disabled and are
// never echoed anywhere else in the UI.

import { useRef, useState } from "react";
import Link from "next/link";
import { SNOONU_STOREFRONT_KEYS } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import type { SnoonuStorefrontKey } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import {
  SNOONU_SESSION_ENV_KEYS,
  buildSnoonuSessionEnvJson,
} from "@/lib/adapters/snoonu/merchant/session-helper";

const STOREFRONT_LABEL: Record<SnoonuStorefrontKey, string> = {
  "snoonu:malikas": "Snoonu — Malikas",
  "snoonu:pure_seoul": "Snoonu — Pure Seoul",
};

const FIELD =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none";

export default function SessionHelperForm() {
  const [storefront, setStorefront] = useState<SnoonuStorefrontKey>("snoonu:malikas");
  const [businessUnitId, setBusinessUnitId] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [cookie, setCookie] = useState("");
  const [extraHeaderName, setExtraHeaderName] = useState("");
  const [extraHeaderValue, setExtraHeaderValue] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const outputRef = useRef<HTMLTextAreaElement | null>(null);

  const envKey = SNOONU_SESSION_ENV_KEYS[storefront];

  const generate = () => {
    setCopied(false);
    setCopyError(false);
    setShowJson(false);
    const r = buildSnoonuSessionEnvJson({ businessUnitId, authorization, cookie, extraHeaderName, extraHeaderValue });
    if (r.ok) { setGenerated(r.json); setError(null); }
    else { setGenerated(null); setError(r.error); }
  };

  const markCopied = () => {
    setCopyError(false);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  // Copy must NEVER be a silent no-op: clipboard API first; if it is
  // unavailable/denied (insecure context, webview, permissions policy), fall
  // back to selecting the visible textarea + execCommand; if that also fails,
  // reveal the JSON and say so — the operator can always select it manually.
  const copy = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated);
      markCopied();
      return;
    } catch {
      // clipboard API unavailable — try the selection fallback below
    }
    try {
      const el = outputRef.current;
      if (el) {
        setShowJson(true);
        el.focus();
        el.select();
        if (document.execCommand("copy")) {
          markCopied();
          return;
        }
      }
    } catch {
      // fall through to the explicit error
    }
    setShowJson(true);
    setCopyError(true);
  };

  // Switching storefront invalidates the generated JSON on purpose: a session
  // is never carried from one storefront to the other (isolation).
  const pickStorefront = (key: SnoonuStorefrontKey) => {
    setStorefront(key);
    setGenerated(null);
    setCopied(false);
  };

  return (
    <div className="space-y-4">
      {/* 1 — storefront (isolated destinations) */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold text-slate-700">١ · المتجر</h2>
        <div className="flex flex-wrap gap-2">
          {SNOONU_STOREFRONT_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => pickStorefront(key)}
              className={`rounded-xl border px-3 py-2 text-sm font-semibold ${
                storefront === key ? "border-brand bg-brand/10 text-brand" : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
              dir="ltr"
            >
              {STOREFRONT_LABEL[key]}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400" dir="ltr">
          → {envKey}
        </p>
        <p className="text-[11px] text-amber-600">
          جلسة كل متجر منفصلة تمامًا — لا تُعاد قيمة متجر في مفتاح المتجر الآخر أبدًا.
        </p>
      </section>

      {/* 2 — what to copy from DevTools */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold text-slate-700">٢ · ما الذي تنسخه من المتصفح؟</h2>
        <ol className="list-inside list-decimal space-y-1 text-xs text-slate-600">
          <li>سجّل الدخول إلى بوابة تاجر Snoonu في متصفحك كالمعتاد (لا نطلب اسم المستخدم أو كلمة المرور هنا أبدًا).</li>
          <li>افتح DevTools ← تبويب Network، ثم ابحث عن أي منتج داخل Catalog.</li>
          <li dir="ltr" className="text-right">اختر طلب <span className="font-mono">CatalogManagement/Products</span> الموثّق.</li>
          <li>من Request Payload انسخ قيمة <span className="font-mono" dir="ltr">businessUnitId</span>.</li>
          <li>من Request Headers انسخ قيمة <span className="font-mono" dir="ltr">Authorization</span> و/أو <span className="font-mono" dir="ltr">Cookie</span> كما هي (ما يظهر منهما فقط).</li>
        </ol>
      </section>

      {/* 3 — inputs (secrets masked, never autofilled) */}
      <section className="card space-y-3">
        <h2 className="text-sm font-bold text-slate-700">٣ · القيم</h2>
        <div>
          <label htmlFor="sh-bu" className="mb-1 block text-xs font-semibold text-slate-500" dir="ltr">businessUnitId</label>
          <input
            id="sh-bu"
            type="text"
            dir="ltr"
            className={FIELD}
            value={businessUnitId}
            onChange={(e) => setBusinessUnitId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor="sh-auth" className="mb-1 block text-xs font-semibold text-slate-500" dir="ltr">Authorization (حسّاس — اختياري)</label>
          <input
            id="sh-auth"
            type="password"
            dir="ltr"
            className={FIELD}
            value={authorization}
            onChange={(e) => setAuthorization(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor="sh-cookie" className="mb-1 block text-xs font-semibold text-slate-500" dir="ltr">Cookie (حسّاس — اختياري)</label>
          <input
            id="sh-cookie"
            type="password"
            dir="ltr"
            className={FIELD}
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="sh-xh-name" className="mb-1 block text-xs font-semibold text-slate-500">ترويسة إضافية مؤكّدة (اسم — اختياري)</label>
            <input
              id="sh-xh-name"
              type="text"
              dir="ltr"
              className={FIELD}
              value={extraHeaderName}
              onChange={(e) => setExtraHeaderName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor="sh-xh-value" className="mb-1 block text-xs font-semibold text-slate-500">قيمتها (حسّاس)</label>
            <input
              id="sh-xh-value"
              type="password"
              dir="ltr"
              className={FIELD}
              value={extraHeaderValue}
              onChange={(e) => setExtraHeaderValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <button type="button" onClick={generate} className="btn-primary text-sm">
          توليد Session JSON (محليًا في المتصفح)
        </button>
        {error ? <p className="text-xs text-rose-600" role="alert">{error}</p> : null}
      </section>

      {/* 4 — output + copy (client memory only) */}
      {generated ? (
        <section className="card space-y-3 border-amber-300">
          <h2 className="text-sm font-bold text-slate-700">٤ · النسخ ثم الإعداد في Vercel</h2>
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700" role="alert">
            هذه القيمة تمنح الوصول إلى جلسة تاجر Snoonu. تعامل معها ككلمة مرور.
            لا تلصقها في ChatGPT أو GitHub أو Slack أو البريد أو التذاكر أو السجلات.
          </div>
          <p className="text-xs text-slate-500">
            الـ JSON مُولّد في ذاكرة المتصفح فقط — لم يُرسل ولن يُرسل إلى أي خادم أو قاعدة بيانات من هذه الصفحة.
          </p>
          {/* The JSON is VISIBLE here (read-only), blurred until revealed, so the
              operator can always select and copy it manually even when the
              clipboard API is unavailable. */}
          <textarea
            ref={outputRef}
            readOnly
            value={generated}
            rows={8}
            dir="ltr"
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            className={`w-full rounded-xl border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] text-ink ${showJson ? "" : "blur-sm select-all"}`}
            aria-label="Session JSON"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={copy} className="btn-primary text-sm">
              {copied ? "تم النسخ ✓" : "نسخ Session JSON"}
            </button>
            <button
              type="button"
              onClick={() => setShowJson((v) => !v)}
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              {showJson ? "إخفاء JSON" : "إظهار JSON"}
            </button>
          </div>
          {copyError ? (
            <p className="text-xs text-rose-600" role="alert">
              تعذّر النسخ التلقائي في هذا المتصفح — ظُهر الـ JSON أعلاه؛ حدّده وانسخه يدويًا (Ctrl/Cmd+C).
            </p>
          ) : null}
          <ol className="list-inside list-decimal space-y-1 text-xs text-slate-600">
            <li dir="ltr" className="text-right">
              Vercel ← Project ← Settings ← Environment Variables ← Add:
              {" "}<span className="font-mono font-bold">{envKey}</span>
            </li>
            <li>البيئة: Production (وPreview فقط إذا رغبت صراحةً).</li>
            <li dir="ltr" className="text-right">Sensitive: ON.</li>
            <li>الصق القيمة المنسوخة ثم احفظ، وبعدها أعد النشر (Redeploy).</li>
          </ol>
        </section>
      ) : null}

      {/* 5 — verify via the existing Connection Manager (never reads the secret back) */}
      <section className="card space-y-2">
        <h2 className="text-sm font-bold text-slate-700">٥ · التحقق من الاتصال</h2>
        <p className="text-xs text-slate-500">
          بعد الحفظ في Vercel وإعادة النشر، افتح مدير الاتصال واضغط «اختبار الاتصال». الحالة تظهر فقط
          (متصل / الجلسة مطلوبة / منتهية / قديمة / خطأ / غير معروف) — القيمة السرّية لا تُقرأ ولا تُعرض أبدًا.
        </p>
        <Link href="/v2/operations/media/discovery" className="btn-ghost inline-block text-sm text-brand">
          فتح مدير اتصال Snoonu ←
        </Link>
      </section>
    </div>
  );
}
