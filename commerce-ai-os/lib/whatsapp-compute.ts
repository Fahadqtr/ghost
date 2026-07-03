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

/** Digits-only international number (Meta wants E.164 WITHOUT the +). */
export function normalizeWaNumber(raw: string): string {
  return String(raw ?? "").replace(/[^0-9]/g, "");
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
