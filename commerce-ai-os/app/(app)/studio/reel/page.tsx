import { getT } from "@/lib/i18n-server";
import StudioReelComposer from "@/components/studio/StudioReelComposer";
import { composerStatus } from "@/app/(app)/studio/reel-actions";

export const dynamic = "force-dynamic";

// Malika AI Studio → Final Reel Composer (phase 4).
export default async function Page() {
  const { locale } = await getT();
  const status = await composerStatus();
  return <StudioReelComposer locale={locale} status={status} />;
}
