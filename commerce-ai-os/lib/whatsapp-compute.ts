// WhatsApp Cloud API request shaping — pure, DB-free core.
//
// Builds the JSON bodies for Meta's Graph API messages endpoint and normalizes
// the recipient number. No fetch here — sending lives in lib/whatsapp.ts.
//
// Two message modes (Meta's rules, not ours):
// • TEMPLATE — required for business-INITIATED messages (our daily cron). The
//   template must be pre-approved in WhatsApp Manager; ours carries the alert
//   line as its single {{1}} body parameter.
// • TEXT — free-form; only delivered inside the 24h customer-service window
//   (after the recipient last messaged the business). Useful for testing.

/**
 * Digits-only international number (Meta wants E.164 WITHOUT the +).
 *
 * Meta requires the FULL international number (country code included) or it drops
 * the send. Customers often store a bare local Qatar mobile ("50090928"), so we
 * prepend the default country code (Qatar 974) for a bare 8-digit local mobile
 * (starts 3/5/6/7), and for the same number typed with a trunk 0 or a "00"
 * international prefix. Numbers that already carry a country code (length > 8, or
 * shorter fragments like a raw "974") are returned digits-only, unchanged — so
 * "+974 5555-1234" and "97455551234" stay "97455551234".
 */
export function normalizeWaNumber(raw: string, defaultCc = "974"): string {
  let d = String(raw ?? "").replace(/[^0-9]/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2); // strip a "00" international prefix
  // bare local Qatar mobile with a trunk 0 → drop the 0, then treat as 8-digit local
  if (d.length === 9 && d.startsWith("0") && /^[3567]/.test(d.slice(1))) d = d.slice(1);
  // bare 8-digit local Qatar mobile → prepend the country code
  if (d.length === 8 && /^[3567]/.test(d)) d = defaultCc + d;
  return d;
}

/**
 * WhatsApp template body parameters may not contain newlines/tabs or 4+
 * consecutive spaces (Meta rejects the send). Flatten whatever we compose.
 */
export function sanitizeTemplateParam(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export interface WaTemplateSpec {
  name: string;
  lang: string; // e.g. "ar", "en_US"
}

/** Free-form text message (24h session window only). */
export function buildTextMessage(to: string, text: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: normalizeWaNumber(to),
    type: "text",
    text: { body: text },
  };
}

/** Approved-template message with the alert line as the single {{1}} param. */
export function buildTemplateMessage(to: string, template: WaTemplateSpec, param: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: normalizeWaNumber(to),
    type: "template",
    template: {
      name: template.name,
      language: { code: template.lang },
      components: [
        { type: "body", parameters: [{ type: "text", text: sanitizeTemplateParam(param) }] },
      ],
    },
  };
}
