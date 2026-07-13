import CatalogEnrich from "@/components/CatalogEnrich";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function CatalogEnrichPage() {
  const { locale } = await getT();
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">🤖 {L("إكمال الكتالوج بالذكاء", "AI catalog completion")}</h2>
        <p className="text-sm text-muted">
          {L("يولّد أي حقل ناقص (اسم عربي، وصف عربي، تصنيف) مطابقًا للإنجليزي، ويتأكد إن العربي يطابق الإنجليزي وإن صورة المنتج تطابق الاسم والوصف.",
             "Generates any missing field (Arabic name, Arabic description, category) to match the English, and verifies the Arabic matches the English and the photo matches the name & description.")}
        </p>
      </div>
      <CatalogEnrich locale={locale} />
    </div>
  );
}
