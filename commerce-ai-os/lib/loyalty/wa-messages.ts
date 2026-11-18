// Beauty Rewards — ready-made WhatsApp messages the owner sends by hand.
//
// The automatic sender (lib/whatsapp.ts) only works once Meta's Cloud API is
// configured and, for a business-initiated message, an approved template
// exists. These helpers build a click-to-chat link instead: tapping it opens
// WhatsApp on the owner's own phone with the message already typed, so the
// owner can send an approval, a reminder or the prize at any time.
//
// Pure and dependency-light (relative imports only) so it runs under node:test
// and can be imported from client components.
import { normalizeWaNumber } from "../whatsapp-compute.ts";

/** Click-to-chat link that opens WhatsApp with `text` pre-filled for `phone`. */
export function waLink(phone: string, text: string): string | null {
  const to = normalizeWaNumber(phone);
  if (!to) return null;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

export type WaContext = {
  name: string;
  storeName: string;
  required: number;
  /** Public card URL (what the store's QR opens). Optional. */
  cardUrl?: string;
};

const cardLine = (url?: string) => (url ? `\nبطاقتك: ${url}` : "");

/** After the owner approves a review screenshot: one heart stamped. */
export function approvalMessage(ctx: WaContext, stamps: number): string {
  const shown = Math.max(0, Math.min(stamps, ctx.required));
  if (shown >= ctx.required) {
    return (
      `🎉🌷 مبروك يا ${ctx.name}! اعتمدنا تقييمك وأكملتِ الـ${ctx.required} قلوب في بطاقة مكافآت الجمال من ${ctx.storeName} 💝\n` +
      `هديتك جاهزة — افتحي بطاقتك واختاري جائزتك.` +
      cardLine(ctx.cardUrl)
    );
  }
  return (
    `❤️ أهلاً ${ctx.name}! اعتمدنا تقييمك وختمنا لك قلب في بطاقة مكافآت الجمال من ${ctx.storeName} 🌷\n` +
    `صار عندك ${shown} من ${ctx.required} — باقي ${ctx.required - shown} على هديتك 💝` +
    cardLine(ctx.cardUrl)
  );
}

/** Reminder — the wording follows where the customer is on her card. */
export function reminderMessage(
  ctx: WaContext,
  stamps: number,
  prizeName?: string | null
): string {
  const shown = Math.max(0, Math.min(stamps, ctx.required));
  if (shown >= ctx.required) {
    if (prizeName) {
      return `🎁 أهلاً ${ctx.name}، جائزتك (${prizeName}) من ${ctx.storeName} جاهزة للاستلام 💝 تواصلي معنا لترتيب الاستلام 🌷`;
    }
    return (
      `🎁 أهلاً ${ctx.name}، هديتك من ${ctx.storeName} تنتظرك! أكملتِ بطاقة مكافآت الجمال — افتحي بطاقتك واختاري جائزتك 💝` +
      cardLine(ctx.cardUrl)
    );
  }
  return (
    `🌷 أهلاً ${ctx.name}، نذكّرك ببطاقة مكافآت الجمال من ${ctx.storeName}: عندك ${shown} من ${ctx.required} قلوب — باقي ${ctx.required - shown} على هديتك 💝\n` +
    `قيّمي طلبك القادم على سنونو وارفعي صورة التقييم في بطاقتك.` +
    cardLine(ctx.cardUrl)
  );
}

/** The completed card's prize + voucher code. */
export function prizeMessage(ctx: WaContext, prizeName: string | null, code: string): string {
  const prizeLine = prizeName ? `جائزتك: ${prizeName}` : "جائزتك المجانية جاهزة";
  return `🎉 مبروك ${ctx.name}! أكملتِ بطاقة مكافآت الجمال من ${ctx.storeName}.\n${prizeLine}\nرقم القسيمة: ${code}\nأبرزي هذه الرسالة عند الاستلام 💝`;
}
