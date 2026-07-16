import Link from "next/link";
import TalabatOrders from "@/components/TalabatOrders";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export default async function TalabatOrdersPage() {
  const { locale } = await getT();
  return (
    <div className="space-y-4">
      <Link href="/import-export" className="text-sm text-brand hover:underline">← Import / Export</Link>
      <TalabatOrders locale={locale === "en" ? "en" : "ar"} />
    </div>
  );
}
