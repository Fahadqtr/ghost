// /v2/settings/connections/snoonu/session-helper — Snoonu Session Capture
// Helper (MEDIA.1A-P4, OWNER-ONLY administrative setup page).
//
// Guides the operator — who is already logged into the Snoonu merchant portal
// in their own browser — to copy the authenticated values of ONE Products
// request from DevTools and turn them into the exact env JSON the merged live
// adapter expects. Passwords are NEVER requested; the generated JSON exists
// only in the operator's browser memory and leaves via their clipboard to the
// Vercel env var. This page has no server action, performs no DB/Snoonu call,
// and never reads a provisioned secret back.

import { requireOwner } from "@/lib/malak/authz";
import { OWNER_ONLY_DENIED } from "@/lib/malak/owner-check";
import Link from "next/link";
import SessionHelperForm from "./SessionHelperForm";

export const dynamic = "force-dynamic";

export default async function SnoonuSessionHelperPage() {
  // Owner-only: signed-out visitors are already redirected by the /v2 layout;
  // signed-in non-owners get a fixed denial and the form never renders.
  const owner = await requireOwner();
  if (!owner.ok) {
    return (
      <div className="card border-rose-200 bg-rose-50 text-sm text-rose-700" role="alert">
        {OWNER_ONLY_DENIED}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-ink">مساعد جلسة Snoonu</h1>
          <p className="text-sm text-slate-500">
            إعداد إداري لمرة واحدة: توليد Session JSON للصقه في متغيرات بيئة Vercel — بدون كلمات مرور،
            وبدون حفظ أي قيمة في النظام.
          </p>
        </div>
        <Link href="/v2/operations/media/discovery" className="text-xs font-semibold text-brand hover:underline">
          مدير الاتصال ←
        </Link>
      </header>
      <SessionHelperForm />
    </div>
  );
}
