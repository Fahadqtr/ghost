import Link from "next/link";
import { listStaff } from "./actions";
import TeamClient from "./TeamClient";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const { members, ready, error } = await listStaff();
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{L("الموظفون", "Employees")}</h2>
          <p className="text-sm text-muted">{L("سجّل موظفيك — لكل واحد رمز خاص يدخل به صفحة", "Register your staff — each gets a private code to sign into")} <code className="rounded-sm bg-slate-100 px-1">/staff</code> {L("ويُنسب له شغله.", "and their work is attributed to them.")}</p>
        </div>
        <Link href="/inventory/approvals" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">{L("حركاتهم ←", "Their movements →")}</Link>
      </div>

      {!ready ? (
        <div className="card space-y-2 border-amber-200 bg-amber-50 text-sm text-amber-800">
          <div className="font-medium">{L("إعداد لمرة واحدة", "One-time setup")}</div>
          <p>{L("شغّل", "Run")} <code className="rounded-sm bg-white px-1">supabase/staff_members.sql</code> {L("مرة وحدة في Supabase SQL editor، ثم حدّث الصفحة.", "once in the Supabase SQL editor, then refresh.")}</p>
        </div>
      ) : error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <TeamClient initialMembers={members} locale={locale} />
      )}
    </div>
  );
}
