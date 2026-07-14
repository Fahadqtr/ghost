import { getT } from "@/lib/i18n-server";
import StudioVoiceEngine from "@/components/studio/StudioVoiceEngine";
import { voiceEngineStatus } from "@/app/(app)/studio/voice-actions";

export const dynamic = "force-dynamic";

// Malika AI Studio → Voice Engine (phase 3): ElevenLabs Gulf voice preview.
export default async function Page() {
  const { locale } = await getT();
  const status = await voiceEngineStatus();
  return <StudioVoiceEngine locale={locale} initialStatus={status} />;
}
