// Tests for the WhatsApp Cloud API request-shaping core.
// Run: node --experimental-strip-types --test lib/whatsapp-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeWaNumber,
  sanitizeTemplateParam,
  buildTextMessage,
  buildTemplateMessage,
} from "./whatsapp-compute.ts";

// ---- normalizeWaNumber --------------------------------------------------------

test("strips +, spaces, dashes and anything non-digit", () => {
  assert.equal(normalizeWaNumber("+974 5555-1234"), "97455551234");
  assert.equal(normalizeWaNumber("(974) 5555 1234"), "97455551234");
  assert.equal(normalizeWaNumber("97455551234"), "97455551234");
  assert.equal(normalizeWaNumber(""), "");
});

// ---- sanitizeTemplateParam ------------------------------------------------------

test("flattens newlines/tabs/multi-spaces (Meta rejects them in params)", () => {
  assert.equal(sanitizeTemplateParam("٢٣٣ نافد\nحركة معلّقة\t\tمهمة"), "٢٣٣ نافد حركة معلّقة مهمة");
  assert.equal(sanitizeTemplateParam("  a     b  "), "a b");
});

// ---- buildTextMessage -----------------------------------------------------------

test("free-form text message shape", () => {
  assert.deepEqual(buildTextMessage("+974 5555 1234", "مرحبا"), {
    messaging_product: "whatsapp",
    to: "97455551234",
    type: "text",
    text: { body: "مرحبا" },
  });
});

// ---- buildTemplateMessage --------------------------------------------------------

test("template message carries the alert as the single {{1}} body param", () => {
  const m = buildTemplateMessage("974-5555-1234", { name: "morning_alert", lang: "ar" }, "٢٣٣ نافد · ١ حركة") as any;
  assert.equal(m.messaging_product, "whatsapp");
  assert.equal(m.to, "97455551234");
  assert.equal(m.type, "template");
  assert.equal(m.template.name, "morning_alert");
  assert.deepEqual(m.template.language, { code: "ar" });
  assert.deepEqual(m.template.components, [
    { type: "body", parameters: [{ type: "text", text: "٢٣٣ نافد · ١ حركة" }] },
  ]);
});

test("template param is sanitized on the way in", () => {
  const m = buildTemplateMessage("974", { name: "t", lang: "ar" }, "سطر\nثاني") as any;
  assert.equal(m.template.components[0].parameters[0].text, "سطر ثاني");
});
