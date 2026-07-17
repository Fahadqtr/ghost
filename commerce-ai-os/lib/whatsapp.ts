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

/**
 * Send one line to an ARBITRARY WhatsApp number (e.g. a rewards customer).
 * Best-effort: never throws, no-ops when unconfigured or the number is empty.
 *
 * Meta deliverability caveat (not ours to bypass): a business-INITIATED message
 * to a customer only lands via an APPROVED template — set WHATSAPP_TEMPLATE_NAME.
 * Free-form text (no template) is delivered only inside the 24h window after the
 * customer last messaged the business, so it's mainly useful for testing.
 */
export async function sendWhatsAppTo(toRaw: string, text: string): Promise<WaSendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = normalizeWaNumber(toRaw);
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

/** Send one alert line to the owner's WhatsApp (WHATSAPP_TO). Best-effort. */
export async function sendWhatsAppAlert(text: string): Promise<WaSendResult> {
  return sendWhatsAppTo(process.env.WHATSAPP_TO ?? "", text);
}

/**
 * Send an IMAGE (by public URL) with a caption to a customer — used to deliver
 * the prize card. Best-effort; same Meta window/template caveats as text.
 * Delivered as a native WhatsApp image message so the customer gets the visual.
 */
export async function sendWhatsAppImageTo(
  toRaw: string,
  imageUrl: string,
  caption: string
): Promise<WaSendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = normalizeWaNumber(toRaw);
  if (!token || !phoneId || !to) return { configured: false, ok: false };
  if (!imageUrl) return sendWhatsAppTo(toRaw, caption); // no image → fall back to text
  // A raw image message is business-INITIATED media: Meta only delivers it
  // inside the 24h window. When an approved text template is configured (the
  // proactive path), send the caption through it so the confirmation actually
  // reaches the customer; the native image is kept for the in-session case.
  if (process.env.WHATSAPP_TEMPLATE_NAME) return sendWhatsAppTo(toRaw, caption);

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, caption },
  };

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      return { configured: true, ok: false, mode: "text", error: j?.error?.message || `HTTP ${res.status}` };
    }
    return { configured: true, ok: true, mode: "text" };
  } catch (e) {
    return { configured: true, ok: false, mode: "text", error: e instanceof Error ? e.message : "send failed" };
  }
}
