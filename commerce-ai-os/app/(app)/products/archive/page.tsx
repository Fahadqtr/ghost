import Link from "next/link";
import { listArchive } from "./actions";
import ArchiveClient from "./ArchiveClient";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function ArchivePage() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  let rows: Awaited<ReturnType<typeof listArchive>>["rows"] = [];
  let ready = true;
  let error: string | undefined;
  try {
    ({ rows, ready, error } = await listArchive());
  } catch (e: any) {
    error = e?.message || L("تعذّر تحميل الأرشيف.", "Couldn't load the archive.");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{L("أرشفة وحذف المنتجات", "Archive & delete products")}</h2>
          <p className="text-sm text-muted">{L("سجّل أرقام mk أو الباركود، تُؤرشَف نسخة كاملة، ثم تُحذف من الكتالوج.", "List mk codes or barcodes — a full copy is archived, then removed from the catalog.")}</p>
        </div>
        <Link href="/products" className="btn-ghost px-3 py-1 text-xs whitespace-nowrap">{L("← المنتجات", "Products →")}</Link>
      </div>

      {!ready ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          {L("جدول الأرشيف غير موجود بعد — شغّل ", "The archive table isn't set up yet — run ")}
          <code className="rounded bg-white px-1">supabase/product_archive.sql</code>
          {L(" مرة واحدة في Supabase.", " once in Supabase.")}
        </div>
      ) : null}
      {error ? <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">{error}</div> : null}

      <ArchiveClient initialArchive={rows} locale={locale} />
    </div>
  );
}
