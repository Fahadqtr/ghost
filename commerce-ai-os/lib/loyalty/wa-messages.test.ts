import test from "node:test";
import assert from "node:assert/strict";

import { approvalMessage, prizeMessage, reminderMessage, waLink } from "./wa-messages.ts";

const ctx = { name: "نورة", storeName: "Pure Seoul", required: 6, cardUrl: "https://x.test/rewards/pureseoul" };

test("waLink normalizes a local Qatar number and encodes the text", () => {
  const link = waLink("5551 2345", "مرحبا & أهلاً");
  assert.ok(link);
  const u = new URL(link!);
  assert.equal(u.origin + u.pathname, "https://wa.me/97455512345");
  assert.equal(u.searchParams.get("text"), "مرحبا & أهلاً");
});

test("waLink returns null without a usable number", () => {
  assert.equal(waLink("", "hi"), null);
  assert.equal(waLink("---", "hi"), null);
});

test("approval message counts hearts and switches to the completed wording", () => {
  const mid = approvalMessage(ctx, 3);
  assert.match(mid, /3 من 6/);
  assert.match(mid, /باقي 3/);
  assert.match(mid, /Pure Seoul/);
  assert.match(mid, /https:\/\/x\.test\/rewards\/pureseoul/);
  const done = approvalMessage(ctx, 6);
  assert.match(done, /أكملتِ الـ6 قلوب/);
  assert.doesNotMatch(done, /باقي/);
});

test("reminder message follows the card state", () => {
  assert.match(reminderMessage(ctx, 2), /باقي 4/);
  assert.match(reminderMessage(ctx, 6), /اختاري جائزتك/);
  const chosen = reminderMessage(ctx, 6, "سيروم");
  assert.match(chosen, /سيروم/);
  assert.match(chosen, /جاهزة للاستلام/);
});

test("prize message carries the prize and voucher code", () => {
  const m = prizeMessage(ctx, "سيروم", "PS-AB12CD-1");
  assert.match(m, /جائزتك: سيروم/);
  assert.match(m, /PS-AB12CD-1/);
  assert.match(prizeMessage(ctx, null, "MU-1"), /جائزتك المجانية جاهزة/);
});

test("no card url → no card line", () => {
  assert.doesNotMatch(approvalMessage({ ...ctx, cardUrl: undefined }, 1), /بطاقتك:/);
});
