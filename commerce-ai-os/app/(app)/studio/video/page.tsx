import { getT } from "@/lib/i18n-server";
import StudioVideoEngine from "@/components/studio/StudioVideoEngine";

export const dynamic = "force-dynamic";

// Malika AI Studio → Video Engine. Step-2: FLORA-first preview flow.
export default async function Page() {
  const { locale } = await getT();
  return <StudioVideoEngine locale={locale} />;
}
