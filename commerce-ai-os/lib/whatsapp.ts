import "server-only";
import {
  buildTemplateMessage,
  buildTextMessage,
  normalizeWaNumber,
} from "./whatsapp-compute";

// Env-gated WhatsApp sender on Meta's Cloud API (no SDK — one fetch). Ships
// INACTIVE: until WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID +
// WHATSAPP_TO are set, whatsappConfigured() is false and callers no-op — the
// same pattern as web-push and the Upstash limiter.
//
// Mode is picked by env: WHATSAPP_TEMPLATE_NAME set → approved-template send
// (required for the business-initiated daily cron); unset → free-form text
// (delivered only inside the 24h session window — fine for testing).

const GRAPH_VERSION = "v21.0";

export function whatsappConfigured(): boolean {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_TO,
  );
}

export interface WaSendResult {
  configured: boolean;
  ok: boolean;
  mode?: "template" | "text";
  error?: string;
}

/** Send one alert line to the owner's WhatsApp. Best-effort: never throws. */
export async function sendWhatsAppAlert(text: string): Promise<WaSendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = normalizeWaNumber(process.env.WHATSAPP_TO ?? "");
  if (!token || !phoneId || !to) return { configured: false, ok: false };

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  const mode: "template" | "text" = templateName ? "template" : "text";
  const body = templateName
    ? buildTemplateMessage(to, { name: templateName, lang: process.env.WHATSAPP_TEMPLATE_LANG || "ar" }, text)
    : buildTextMessage(to, text);

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Meta wraps errors as { error: { message, code, ... } } — surface the message.
      const j = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      return { configured: true, ok: false, mode, error: j?.error?.message || `HTTP ${res.status}` };
    }
    return { configured: true, ok: true, mode };
  } catch (e) {
    return { configured: true, ok: false, mode, error: e instanceof Error ? e.message : "send failed" };
  }
}
