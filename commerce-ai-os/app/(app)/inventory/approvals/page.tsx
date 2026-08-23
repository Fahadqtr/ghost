import Link from "next/link";
import { getStaffMovements } from "../approvals-actions";
import ApprovalsClient from "./ApprovalsClient";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  let rows: Awaited<ReturnType<typeof getStaffMovements>>["rows"] = [];
  let pending = 0;
  let error: string | undefined;
  try {
    ({ rows, pending, error } = await getStaffMovements());
  } catch (e: any) {
    error = e?.message || L("تعذّر تحميل الحركات.", "Couldn't load movements.");
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{L("اعتماد حركات الموظفين", "Approve staff movements")}</h2>
          <p className="text-sm text-muted">{L("راجِع كل دخول/خروج سجّله الموظفون من صفحة", "Review every stock in/out the employees logged on")} <code className="rounded-sm bg-slate-100 px-1">/staff</code>.</p>
        </div>
        <Link href="/v2/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">{L("← المخزون", "Inventory →")}</Link>
      </div>
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <ApprovalsClient initialRows={rows} initialPending={pending} locale={locale} />
      )}
    </div>
  );
}
