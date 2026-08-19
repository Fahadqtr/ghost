// MEDIA.1A-P4 — session-helper unit tests (pure).
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/session-helper.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { SNOONU_SESSION_ENV_KEYS, buildSnoonuSessionEnvJson, type SessionHelperInput } from "./session-helper.ts";
import { parseSnoonuSessionConfig } from "./live-contract.ts";

const input = (over: Partial<SessionHelperInput> = {}): SessionHelperInput => ({
  businessUnitId: "bu-77",
  authorization: "Bearer abc",
  cookie: "",
  extraHeaderName: "",
  extraHeaderValue: "",
  ...over,
});

test("each storefront maps to ITS exact reserved env key (isolated destinations)", () => {
  assert.equal(SNOONU_SESSION_ENV_KEYS["snoonu:malikas"], "SNOONU_MALIKAS_MERCHANT_SESSION");
  assert.equal(SNOONU_SESSION_ENV_KEYS["snoonu:pure_seoul"], "SNOONU_PURE_SEOUL_MERCHANT_SESSION");
  assert.notEqual(SNOONU_SESSION_ENV_KEYS["snoonu:malikas"], SNOONU_SESSION_ENV_KEYS["snoonu:pure_seoul"]);
  assert.equal(Object.keys(SNOONU_SESSION_ENV_KEYS).length, 2, "exactly the two storefronts");
});

test("the generated JSON is EXACTLY the adapter's schema — proven by the adapter's own parser", () => {
  const r = buildSnoonuSessionEnvJson(input({ cookie: "sid=1; a=2" }));
  assert.ok(r.ok);
  const parsed = parseSnoonuSessionConfig(r.json);
  assert.deepEqual(parsed, {
    businessUnitId: "bu-77",
    headers: { Authorization: "Bearer abc", Cookie: "sid=1; a=2" },
  });
  // only the two documented top-level keys exist — no second schema
  assert.deepEqual(Object.keys(JSON.parse(r.json)).sort(), ["businessUnitId", "headers"]);
});

test("values are trimmed; empty sensitive fields are OMITTED (never emitted blank)", () => {
  const r = buildSnoonuSessionEnvJson(input({ businessUnitId: "  bu-1  ", authorization: "  tok  ", cookie: "   " }));
  assert.ok(r.ok);
  const obj = JSON.parse(r.json) as { businessUnitId: string; headers: Record<string, string> };
  assert.equal(obj.businessUnitId, "bu-1");
  assert.deepEqual(obj.headers, { Authorization: "tok" }, "blank cookie is omitted");
});

test("fails without businessUnitId and without at least one authenticated header", () => {
  assert.equal(buildSnoonuSessionEnvJson(input({ businessUnitId: "  " })).ok, false);
  assert.equal(buildSnoonuSessionEnvJson(input({ authorization: "", cookie: "" })).ok, false);
});

test("extra header requires BOTH name and value; included verbatim when both present", () => {
  assert.equal(buildSnoonuSessionEnvJson(input({ extraHeaderName: "x-tenant" })).ok, false);
  assert.equal(buildSnoonuSessionEnvJson(input({ extraHeaderValue: "t-9" })).ok, false);
  const r = buildSnoonuSessionEnvJson(input({ extraHeaderName: "x-tenant", extraHeaderValue: "t-9" }));
  assert.ok(r.ok);
  const parsed = parseSnoonuSessionConfig(r.json);
  assert.equal(parsed?.headers["x-tenant"], "t-9");
});

test("the JSON carries NO storefront material — isolation lives in the env key, not the value", () => {
  const r = buildSnoonuSessionEnvJson(input());
  assert.ok(r.ok);
  assert.equal(/snoonu:|malikas|pure_seoul|storefront/i.test(r.json), false);
});

test("never throws on hostile input; the error never echoes an entered value", () => {
  const r = buildSnoonuSessionEnvJson(input({ businessUnitId: "", authorization: "SECRET-VALUE" }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.includes("SECRET-VALUE"), false);
});
