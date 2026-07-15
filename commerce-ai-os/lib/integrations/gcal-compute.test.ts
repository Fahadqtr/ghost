import test from "node:test";
import assert from "node:assert/strict";

import {
  nextDay, priorityColorId, taskToEvent, parseServiceAccount, base64url, buildJwtSigningInput,
} from "./gcal-compute.ts";

test("nextDay returns the exclusive all-day end, crossing month boundaries", () => {
  assert.equal(nextDay("2026-07-15"), "2026-07-16");
  assert.equal(nextDay("2026-07-31"), "2026-08-01");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
});

test("priorityColorId maps priority and dims completed tasks", () => {
  assert.equal(priorityColorId("high"), "11");
  assert.equal(priorityColorId("normal"), "5");
  assert.equal(priorityColorId("low"), "8");
  assert.equal(priorityColorId("high", true), "8"); // done → graphite
});

test("taskToEvent builds an all-day event with a tracking tag", () => {
  const ev: any = taskToEvent({ id: "t1", title: "تعبئة الرفوف", assignedName: "سارة", priority: "high", dueDate: "2026-07-15", status: "open" });
  assert.equal(ev.start.date, "2026-07-15");
  assert.equal(ev.end.date, "2026-07-16");
  assert.equal(ev.colorId, "11");
  assert.match(ev.summary, /تعبئة الرفوف/);
  assert.match(ev.summary, /سارة/);
  assert.equal(ev.extendedProperties.private.malikaTaskId, "t1");
  assert.equal(ev.extendedProperties.private.source, "malika-tasks");
});

test("taskToEvent marks a completed task with ✓ and dims it", () => {
  const ev: any = taskToEvent({ id: "t2", title: "جرد", priority: "normal", dueDate: "2026-07-15", status: "done" });
  assert.match(ev.summary, /^✓ /);
  assert.equal(ev.colorId, "8");
  assert.equal(ev.transparency, "transparent");
});

test("parseServiceAccount reads client_email + normalises escaped newlines", () => {
  const json = JSON.stringify({ client_email: "bot@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n" });
  const sa = parseServiceAccount(json);
  assert.ok(sa);
  assert.equal(sa!.clientEmail, "bot@proj.iam.gserviceaccount.com");
  assert.ok(sa!.privateKey.includes("\n")); // real newlines now
  assert.ok(!sa!.privateKey.includes("\\n"));
});

test("parseServiceAccount rejects junk / missing key", () => {
  assert.equal(parseServiceAccount(""), null);
  assert.equal(parseServiceAccount("not json"), null);
  assert.equal(parseServiceAccount(JSON.stringify({ client_email: "x@y.z" })), null); // no private_key
});

test("buildJwtSigningInput yields two base64url segments with the right claims", () => {
  const s = buildJwtSigningInput("bot@x.iam", 1_700_000_000);
  const [h, c] = s.split(".");
  assert.equal(s.split(".").length, 2);
  const claims = JSON.parse(Buffer.from(c, "base64").toString("utf8"));
  assert.equal(claims.iss, "bot@x.iam");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.exp - claims.iat, 3600);
  assert.match(claims.scope, /calendar/);
  const header = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
  assert.equal(header.alg, "RS256");
});

test("base64url has no +,/,= characters", () => {
  const out = base64url("??>>>>~~~~"); // bytes that produce +// in base64
  assert.ok(!/[+/=]/.test(out));
});
