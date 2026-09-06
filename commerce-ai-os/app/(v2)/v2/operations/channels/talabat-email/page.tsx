// /v2/operations/channels/talabat-email — إرسال تحديثات طلبات
//
// The Talabat email workflow: Generate → Preview → Test Send. V2 only.
//
// The screen is deliberately honest about three things it would be easy to
// paper over:
//
//   • The OFFICIAL send is not here. It is shown, disabled, with the reason —
//     because hiding it would leave the owner wondering where it went, and
//     enabling it is a reviewed code change, not a toggle.
//   • The recipient is typed for every send. The saved contact appears as a
//     suggestion the owner can accept or replace; nothing is hard-coded.
//   • Email B's attachments are far larger than any mail provider accepts. The
//     card says so with the real numbers rather than letting the owner discover
//     it at send time.

import { isOwner } from "@/lib/malak/authz";
import { OWNER_ONLY_DENIED } from "@/lib/malak/owner-check";
import { getEmailSettings } from "@/lib/talabat/email-send.server";
import { deliveryLogSupportsMode } from "@/lib/talabat/email-workflow.server";
import { OFFICIAL_SEND_DISABLED_AR } from "@/lib/export/talabat/email-workflow";
import TalabatEmailWorkflow from "./TalabatEmailWorkflow";

export const dynamic = "force-dynamic";

export default async function TalabatEmailPage() {
  if (!(await isOwner())) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {OWNER_ONLY_DENIED}
      </div>
    );
  }

  const settings = await getEmailSettings();
  const sender = settings.senders.find((s) => s.isDefault) ?? settings.senders[0] ?? null;
  const senderVerified = sender?.verification === "verified";
  const deliveryLogReady = await deliveryLogSupportsMode();

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">إرسال تحديثات طلبات</h1>
        <p className="text-sm text-slate-500">
          توليد الملفات، ثم معاينة الرسالة، ثم إرسال اختباري. الإرسال الرسمي غير مفعّل بعد.
        </p>
      </header>

      <section className="card space-y-2 text-sm">
        <h2 className="text-base font-semibold text-slate-800">الحالة</h2>
        <ul className="space-y-1">
          <li>
            المرسل:{" "}
            <span className="font-mono">{sender?.address ?? "غير مضبوط"}</span>{" "}
            <span className={senderVerified ? "text-emerald-700" : "text-amber-800"}>
              {senderVerified ? "— موثّق لدى مزوّد البريد" : "— غير موثّق، الإرسال متوقف"}
            </span>
          </li>
          <li>
            المستلم: يُكتب يدوياً عند كل إرسال
            {settings.talabat.to.length > 0 ? (
              <> — الاقتراح المحفوظ: <span className="font-mono">{settings.talabat.to.join(", ")}</span></>
            ) : <> — لا يوجد اقتراح محفوظ</>}
          </li>
          <li>مراجعة الباركود: ٢٧٠ صفاً — غير قابلة للإرسال، وخارج الرسالتين تماماً.</li>
          <li className="text-amber-800">الإرسال الرسمي: معطّل — {OFFICIAL_SEND_DISABLED_AR}</li>
          {!deliveryLogReady ? (
            <li className="text-amber-800">
              سجل الإرسال لا يميّز رسائل الاختبار بعد — مطلوب تطبيق ترحيل
              <span className="font-mono"> delivery_mode</span> قبل الإرسال الاختباري.
            </li>
          ) : null}
        </ul>
      </section>

      <TalabatEmailWorkflow
        senderVerified={senderVerified}
        senderAddress={sender?.address ?? null}
        savedTo={settings.talabat.to.join(", ")}
        savedCc={settings.talabat.cc.join(", ")}
        deliveryLogReady={deliveryLogReady}
        officialSendDisabledReason={OFFICIAL_SEND_DISABLED_AR}
      />
    </div>
  );
}
