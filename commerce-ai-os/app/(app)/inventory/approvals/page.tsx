import Link from "next/link";
import { getStaffMovements } from "../approvals-actions";
import ApprovalsClient from "./ApprovalsClient";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const { rows, pending, error } = await getStaffMovements();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">اعتماد حركات الموظفين</h2>
          <p className="text-sm text-muted">راجِع كل دخول/خروج سجّله الموظفون من صفحة <code className="rounded bg-slate-100 px-1">/staff</code>.</p>
        </div>
        <Link href="/inventory" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">← المخزون</Link>
      </div>
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <ApprovalsClient initialRows={rows} initialPending={pending} />
      )}
    </div>
  );
}
