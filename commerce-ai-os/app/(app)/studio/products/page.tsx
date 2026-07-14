import { getT } from "@/lib/i18n-server";
import ModuleScaffold from "@/components/studio/ModuleScaffold";

export const dynamic = "force-dynamic";

// Malika AI Studio → products (scaffold). Real engine wired in a later step.
export default async function Page() {
  const { locale } = await getT();
  return <ModuleScaffold slug="products" locale={locale} />;
}
