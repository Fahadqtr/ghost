// Tests for the web-push content/validation core.
// Run: node --experimental-strip-types --test lib/push-compute.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { composeMorningPush, parseSubscription, type PushAlert } from "./push-compute.ts";

const a = (ar: string, severity: PushAlert["severity"]): PushAlert => ({ ar, severity });

// ---- composeMorningPush -------------------------------------------------------

test("nothing urgent → null (don't wake the phone)", () => {
  assert.equal(composeMorningPush([]), null);
  assert.equal(composeMorningPush([a("مهمة مفتوحة", "low")]), null);
});

test("high/med alerts compose title + joined body + dashboard url", () => {
  const p = composeMorningPush([a("٣ نافد", "high"), a("٥ منخفض", "med")])!;
  assert.equal(p.title, "ملاك — تنبيهات الصباح");
  assert.equal(p.body, "٣ نافد · ٥ منخفض");
  assert.equal(p.url, "/dashboard");
});

test("low-severity alerts are excluded from the body", () => {
  const p = composeMorningPush([a("نافد", "high"), a("مهام مفتوحة", "low")])!;
  assert.equal(p.body, "نافد");
});

test("caps at 3 lines and appends a +N overflow marker", () => {
  const p = composeMorningPush([
    a("أ", "high"), a("ب", "high"), a("ج", "med"), a("د", "med"), a("هـ", "high"),
  ])!;
  assert.equal(p.body, "أ · ب · ج · +2");
});

// ---- parseSubscription ----------------------------------------------------------

const good = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "PK", auth: "AU" } };

test("accepts a well-formed browser subscription (trimmed)", () => {
  const s = parseSubscription({ ...good, endpoint: `  ${good.endpoint}  ` })!;
  assert.deepEqual(s, { endpoint: good.endpoint, p256dh: "PK", auth: "AU" });
});

test("rejects non-https endpoints and missing keys", () => {
  assert.equal(parseSubscription({ ...good, endpoint: "http://insecure" }), null);
  assert.equal(parseSubscription({ endpoint: good.endpoint, keys: { p256dh: "PK" } }), null);
  assert.equal(parseSubscription({ endpoint: good.endpoint, keys: { auth: "AU" } }), null);
  assert.equal(parseSubscription({ endpoint: good.endpoint }), null);
});

test("rejects garbage shapes without throwing", () => {
  assert.equal(parseSubscription(null), null);
  assert.equal(parseSubscription("x"), null);
  assert.equal(parseSubscription({ endpoint: 5, keys: { p256dh: 1, auth: 2 } }), null);
});
