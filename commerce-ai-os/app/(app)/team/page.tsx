import Link from "next/link";
import { listStaff } from "./actions";
import TeamClient from "./TeamClient";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const { members, ready, error } = await listStaff();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">الموظفون</h2>
          <p className="text-sm text-muted">سجّل موظفيك — لكل واحد رمز خاص يدخل به صفحة <code className="rounded bg-slate-100 px-1">/staff</code> ويُنسب له شغله.</p>
        </div>
        <Link href="/inventory/approvals" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">حركاتهم ←</Link>
      </div>

      {!ready ? (
        <div className="card space-y-2 border-amber-200 bg-amber-50 text-sm text-amber-800">
          <div className="font-medium">إعداد لمرة واحدة</div>
          <p>شغّل <code className="rounded bg-white px-1">supabase/staff_members.sql</code> مرة وحدة في Supabase SQL editor، ثم حدّث الصفحة.</p>
        </div>
      ) : error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <TeamClient initialMembers={members} />
      )}
    </div>
  );
}
