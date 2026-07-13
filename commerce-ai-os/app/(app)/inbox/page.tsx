import { listDmConversations } from "./actions";
import InboxClient from "@/components/InboxClient";
import DmMetricsPanel from "@/components/DmMetricsPanel";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  let items: Awaited<ReturnType<typeof listDmConversations>>["items"] = [];
  let ready = true;
  let error: string | undefined;
  try {
    ({ items, ready, error } = await listDmConversations());
  } catch (e: any) {
    error = e?.message || L("تعذّر تحميل الوارد.", "Couldn't load the inbox.");
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">💬 {L("الوارد — دايركت العملاء", "Inbox — customer DMs")}</h2>
        <p className="text-sm text-muted">
          {L("«ملاك» ترد تلقائيًا على دايركت إنستقرام من الكتالوج ومعلومات المتجر — وأي شي ما تعرفه يوصلك هنا بعلامة 🙋.",
             "«Malak» auto-replies to Instagram DMs from the catalog and store info — anything she can't handle lands here flagged 🙋.")}
        </p>
      </div>
      {error ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div>
      ) : (
        <>
          <DmMetricsPanel locale={locale} />
          <InboxClient initial={items} ready={ready} locale={locale} />
        </>
      )}
    </div>
  );
}
