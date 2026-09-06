// /v2/settings/email — البريد (Email Settings). OWNER-ONLY, read-mostly.
//
// The V2 home for everything about who we send as and where mail goes. It adds
// NO email logic of its own: sender resolution, transport verification, the
// recipient model and the environment diagnostic all come from the modules the
// send path itself uses, so this screen cannot drift from what a send will
// actually do.
//
// Two things it is careful to say plainly:
//
//   • «موثّق» is not decoration. It means the provider authenticated THIS
//     address, checked against the transport's own From. A default identity can
//     be shown as active and still be unusable, and that is the honest state,
//     not a bug.
//   • A saved recipient is a DEFAULT, never a commitment. Every send prefills
//     from it and lets the owner send somewhere else, so the address here is a
//     convenience and no destination is hard-coded anywhere.
//
// No credential is rendered: the diagnostic reports variable NAMES only.

import { isOwner } from "@/lib/malak/authz";
import { OWNER_ONLY_DENIED } from "@/lib/malak/owner-check";
import { getEmailSettings } from "@/lib/talabat/email-send.server";
import RecipientEditor from "./RecipientEditor";

export const dynamic = "force-dynamic";

const VERIFICATION_AR: Record<"verified" | "unverified" | "no_transport", string> = {
  verified: "موثّق لدى مزوّد البريد",
  unverified: "غير موثّق — النقل يرسل من عنوان آخر",
  no_transport: "لم يتم إعداد خدمة البريد بعد",
};

const CHANNELS = [
  { key: "talabat" as const, title: "طلبات — Talabat" },
  { key: "rafeeq" as const, title: "رفيق — Rafeeq" },
];

export default async function V2EmailSettingsPage() {
  if (!(await isOwner())) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {OWNER_ONLY_DENIED}
      </div>
    );
  }

  const data = await getEmailSettings();
  const sendingBlocked = data.senders.every((s) => !s.selectable);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">البريد</h1>
        <p className="text-sm text-slate-500">
          هويات المرسل ومستلمو كل قناة. لا تُعرض هنا أي بيانات اعتماد.
        </p>
      </header>

      <section className="card space-y-3">
        <h2 className="text-base font-semibold text-slate-800">هوية المرسل</h2>
        <p className="text-sm text-slate-600">
          العنوان الموثّق حالياً لدى مزوّد البريد:{" "}
          <span className="font-mono">{data.authenticatedFrom ?? "غير مضبوط"}</span>
        </p>
        <ul className="space-y-2">
          {data.senders.map((s) => (
            <li key={s.address} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-800">{s.displayName}</span>
                <span className="font-mono text-slate-600">{s.address}</span>
                {s.isDefault ? (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">افتراضي</span>
                ) : null}
                <span className={`rounded px-2 py-0.5 text-xs ${s.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                  {s.active ? "مفعّلة" : "غير مفعّلة"}
                </span>
                <span className={`rounded px-2 py-0.5 text-xs ${s.verification === "verified" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
                  {VERIFICATION_AR[s.verification]}
                </span>
              </div>
              {s.blockedReason ? <p className="mt-2 text-xs text-amber-800">{s.blockedReason}</p> : null}
            </li>
          ))}
        </ul>

        {sendingBlocked ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
            <p className="font-medium">الإرسال متوقف — لا توجد هوية مرسل موثّقة.</p>
            {data.guidance.length > 0 ? (
              <ul className="mt-1 list-disc space-y-1 pe-5">
                {data.guidance.map((g) => <li key={g}>{g}</li>)}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
            هوية المرسل موثّقة لدى مزوّد البريد — الإرسال متاح بعد تأكيد المالك.
          </p>
        )}

        {data.blockingEnvNames.length > 0 ? (
          <p className="text-xs text-slate-500">
            متغيّرات ناقصة (أسماء فقط، بلا قيم):{" "}
            <span className="font-mono">{data.blockingEnvNames.join(", ")}</span>
          </p>
        ) : null}
      </section>

      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
        العناوين المحفوظة هنا هي <strong>قيم افتراضية</strong> فقط. عند كل إرسال يظهر المستلم
        في حقل قابل للتعديل، ويمكن للمالك تغييره لتلك الرسالة دون تغيير الافتراضي.
      </p>

      {CHANNELS.map(({ key, title }) => (
        <section key={key} className="card space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-slate-800">{title}</h2>
            <span className={`rounded px-2 py-0.5 text-xs ${data[key].configured ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
              {data[key].configured ? "افتراضي محفوظ" : "لا يوجد افتراضي محفوظ"}
            </span>
          </div>
          {data[key].to.length > 0 ? (
            <p className="text-sm text-slate-600">
              الحالي: <span className="font-mono">{data[key].to.join(", ")}</span>
              {data[key].cc.length > 0 ? (
                <> · نسخة: <span className="font-mono">{data[key].cc.join(", ")}</span></>
              ) : null}
            </p>
          ) : null}
          <RecipientEditor
            channel={key}
            initialTo={data[key].to.join(", ")}
            initialCc={data[key].cc.join(", ")}
            bccSupported={data.bccSupported}
          />
        </section>
      ))}
    </div>
  );
}
