import { getT } from "@/lib/i18n-server";
import ModuleScaffold from "@/components/studio/ModuleScaffold";

export const dynamic = "force-dynamic";

// Malika AI Studio → quality (scaffold). Real engine wired in a later step.
export default async function Page() {
  const { locale } = await getT();
  return <ModuleScaffold slug="quality" locale={locale} />;
}
