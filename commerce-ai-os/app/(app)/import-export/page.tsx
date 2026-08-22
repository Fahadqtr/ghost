// /import-export — Import/Export HUB (UX.3A). A light landing page: link cards
// ONLY. All heavy tools (Excel import, image tools, exports, category export) were
// moved OFF this page into their own sub-routes so the hub loads no product data
// and ships no XLSX/image client bundle. Nothing was deleted and no URL changed —
// the tool pages and their logic are untouched; this page only stops rendering them
// inline. Server component; auth is the (app) layout login gate.

import Link from "next/link";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

function HubCard({ href, icon, title, desc }: { href: string; icon: string; title: string; desc: string }) {
  return (
    <Link href={href} className="card flex items-center justify-between hover:bg-slate-50">
      <div>
        <h3 className="text-sm font-semibold text-ink">
          {icon} {title}
        </h3>
        <p className="text-xs text-muted">{desc}</p>
      </div>
      <span className="text-brand">→</span>
    </Link>
  );
}

export default async function ImportExportPage() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        {L(
          "استيراد وتصدير لكل منصة. اختر الأداة من البطاقات أدناه — كل أداة تفتح في صفحتها الخاصة.",
          "Import and per-channel export. Pick a tool from the cards below — each opens on its own page."
        )}
      </p>

      {/* الاستيراد — point at the new V2 catalog importer */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{L("الاستيراد", "Import")}</h2>
        <Link
          href="/v2/catalog/import"
          className="card flex items-center justify-between border-brand/30 bg-brand/5 hover:bg-brand/10"
        >
          <div>
            <h3 className="text-sm font-semibold text-ink">⬆️ {L("استخدام مستورد الكتالوج الجديد", "Use the new catalog importer")}</h3>
            <p className="text-xs text-muted">
              {L(
                "استيراد Excel الحديث مع معاينة وخطوات تطبيق منفصلة — يفتح في واجهة V2.",
                "The modern Excel importer with preview and separate apply steps — opens in the V2 interface."
              )}
            </p>
          </div>
          <span className="shrink-0 text-brand" title={L("يفتح في واجهة V2", "Opens in the V2 interface")}>↗</span>
        </Link>
      </section>

      {/* المنصات والمزامنة — existing sub-routes, unchanged */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{L("المنصات والمزامنة", "Platforms & sync")}</h2>
        <HubCard
          href="/import-export/availability"
          icon="🔁"
          title={L("مطابقة التوفّر بين المنصّات", "Match availability across platforms")}
          desc={L("وحّد النافد على كل المنصّات وادفعه لـ Shopify.", "Unify out-of-stock across platforms and push to Shopify.")}
        />
        <HubCard
          href="/import-export/shopify-sync"
          icon="🛍️"
          title="Shopify Sync"
          desc={L("مقارنة حية مع متجر شوبي فاي وتحديث الأسعار بضغطة.", "Live reconcile against the Shopify store and one-tap price push.")}
        />
        <HubCard
          href="/import-export/talabat-sync"
          icon="🍊"
          title="Talabat Sync"
          desc={L("شوف الناقص عند Talabat ونزّل إكسل + صور جاهزين للإرسال.", "See what Talabat is missing and download a ready Excel + images package.")}
        />
        <HubCard
          href="/import-export/pure-seoul"
          icon="🏬"
          title={L("Pure Seoul — مطابقة مليكاس", "Pure Seoul — match Malika")}
          desc={L("شوف الناقص/الزائد وفروق الأسعار مقابل مليكاس.", "See missing/extra items and price differences vs Malika.")}
        />
        <HubCard
          href="/import-export/snoonu-sync"
          icon="🔄"
          title="Snoonu Sync"
          desc={L("ارفع تصدير سنونو وطابقه عبر snoonu_id.", "Upload a Snoonu export and reconcile by snoonu_id.")}
        />
      </section>

      {/* الصور والجودة — the V2 Media Center is the canonical overview (UX.NAV.2);
          only the legacy upload/attach helpers still live here. */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{L("الصور والجودة", "Images & quality")}</h2>
        <Link
          href="/v2/operations/media"
          className="card flex items-center justify-between border-brand/30 bg-brand/5 hover:bg-brand/10"
        >
          <div>
            <h3 className="text-sm font-semibold text-ink">🖼️ {L("مركز الصور (الواجهة الجديدة)", "Media Center (new interface)")}</h3>
            <p className="text-xs text-muted">
              {L(
                "النظرة العامة المعتمدة للصور: الناقص، المكرر، صحّة الوسائط، والاسترجاع من سنونو.",
                "The canonical media overview: missing, duplicates, media health, and Snoonu recovery."
              )}
            </p>
          </div>
          <span className="shrink-0 text-brand" title={L("يفتح في واجهة V2", "Opens in the V2 interface")}>↗</span>
        </Link>
        <HubCard
          href="/import-export/images"
          icon="🧰"
          title={L("أدوات الصور القديمة", "Legacy image tools")}
          desc={L("رفع الصور وربط صورة بالـ SKU (أدوات قديمة ما زالت مستخدمة).", "Image upload and attach-by-SKU (legacy tools still in use).")}
        />
      </section>

      {/* التصدير — moved to its own workspace */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{L("التصدير", "Export")}</h2>
        <HubCard
          href="/import-export/export"
          icon="⬇️"
          title={L("التصدير", "Exports")}
          desc={L("تصدير Rafeeq/Shopify/Snoonu/Talabat، أقسام Talabat، وحزم صور المنتجات.", "Export Rafeeq/Shopify/Snoonu/Talabat, Talabat categories, and product-image packages.")}
        />
      </section>

      {/* الطلبات — stays where it is for now */}
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{L("الطلبات", "Orders")}</h2>
        <HubCard
          href="/import-export/talabat-orders"
          icon="🧾"
          title={L("طلبات Talabat", "Talabat orders")}
          desc={L("استقبل طلبات Talabat عبر Webhook وشوف الطلبات الواردة.", "Receive Talabat orders via webhook and view incoming orders.")}
        />
      </section>
    </div>
  );
}
