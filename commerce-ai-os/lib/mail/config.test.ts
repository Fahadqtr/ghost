// MAIL ENV DIAGNOSTIC — owner-safe runtime diagnostic tests.
// Proves: booleans-only output (no value/length/fragment of any variable ever
// appears — including a sentinel password), exact mirroring of readMailConfig,
// per-variable failure shapes (the NAMES the owner needs, never values), and
// the real-world footguns that leave production on mail_not_configured.
// node --conditions=react-server --experimental-strip-types --test lib/mail/config.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readMailConfig, diagnoseMailEnv, blockingMailEnvNames } from "./config.ts";

const VALID = {
  MAIL_HOST: "smtp.example-provider.test",
  MAIL_PORT: "465",
  MAIL_SECURE: "true",
  MAIL_USERNAME: "mailbox@example.test",
  MAIL_PASSWORD: "S3CRET-sentinel-value",
  MAIL_FROM_NAME: "Malikas Universe",
  MAIL_FROM_ADDRESS: "mailbox@example.test",
  EMAIL_ATTACHMENT_MAX_BYTES: "20971520",
};

test("a fully valid environment resolves — every check true, no blocking names", () => {
  const d = diagnoseMailEnv(VALID);
  assert.equal(d.mailConfigResolved, true);
  assert.deepEqual(blockingMailEnvNames(d), []);
  for (const [name, checks] of Object.entries(d)) {
    if (typeof checks === "boolean") continue;
    for (const [k, v] of Object.entries(checks)) assert.equal(v, true, `${name}.${k}`);
  }
  assert.ok(readMailConfig(VALID) !== null, "diagnostic agrees with readMailConfig");
});

test("the diagnostic output is BOOLEANS ONLY — no value, length or fragment of any variable leaks", () => {
  const d = diagnoseMailEnv(VALID);
  const json = JSON.stringify(d);
  assert.ok(!json.includes("S3CRET") && !json.includes("sentinel"), "no password fragment");
  assert.ok(!json.includes("example") && !json.includes("465") && !json.includes("20971520"), "no other env value either");
  const walk = (v: unknown): void => {
    if (typeof v === "boolean") return;
    assert.equal(typeof v, "object");
    for (const leaf of Object.values(v as Record<string, unknown>)) walk(leaf);
  };
  walk(d);
});

test("each missing/blank required variable is reported by NAME with resolved=false", () => {
  for (const name of ["MAIL_HOST", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_FROM_ADDRESS"] as const) {
    const env: Record<string, string | undefined> = { ...VALID };
    delete env[name];
    const missing = diagnoseMailEnv(env);
    assert.equal(missing.mailConfigResolved, false, `${name} missing → unresolved`);
    assert.equal(missing[name].present, false, `${name}.present false`);
    assert.deepEqual(blockingMailEnvNames(missing), [name], `only ${name} is named`);

    const blank = diagnoseMailEnv({ ...VALID, [name]: "   " });
    assert.equal(blank.mailConfigResolved, name === "MAIL_PASSWORD", `${name} whitespace-only → ${name === "MAIL_PASSWORD" ? "password is not trimmed (any non-empty string authenticates or fails at SMTP)" : "unresolved"}`);
    if (name !== "MAIL_PASSWORD") {
      assert.equal(blank[name].present, true, "present but");
      assert.deepEqual(blockingMailEnvNames(blank), [name], "blank-after-trim is named too");
    }
  }
});

test("real-world footgun: MAIL_FROM_ADDRESS pasted with a display name is invalid syntax — named, never echoed", () => {
  const env = { ...VALID, MAIL_FROM_ADDRESS: 'Malikas Universe <mailbox@example.test>' };
  assert.equal(readMailConfig(env), null, "display-name format cannot resolve");
  const d = diagnoseMailEnv(env);
  assert.equal(d.MAIL_FROM_ADDRESS.present, true);
  assert.equal(d.MAIL_FROM_ADDRESS.nonEmptyAfterTrim, true);
  assert.equal(d.MAIL_FROM_ADDRESS.validEmailSyntax, false, "the syntax check pinpoints it");
  assert.equal(d.mailConfigResolved, false);
  assert.deepEqual(blockingMailEnvNames(d), ["MAIL_FROM_ADDRESS"]);
  assert.ok(!JSON.stringify(d).includes("mailbox"), "the bad value itself never appears");
});

test("optional variables never block resolution; their own checks still report honestly", () => {
  const env: Record<string, string | undefined> = { ...VALID };
  delete env.MAIL_PORT;
  delete env.MAIL_SECURE;
  delete env.MAIL_FROM_NAME;
  delete env.EMAIL_ATTACHMENT_MAX_BYTES;
  const d = diagnoseMailEnv(env);
  assert.equal(d.mailConfigResolved, true, "optionals default; config still resolves");
  assert.deepEqual(blockingMailEnvNames(d), []);
  assert.equal(d.MAIL_PORT.present, false);
  assert.equal(d.MAIL_PORT.parsedValidPort, false, "no explicit port → parsedValidPort false (default 465/587 applies)");
  assert.equal(d.MAIL_SECURE.parsedSecure, true, "unset MAIL_SECURE resolves secure");
  assert.equal(d.EMAIL_ATTACHMENT_MAX_BYTES.parsedPositiveInteger, false);
  const cfg = readMailConfig(env);
  assert.ok(cfg && cfg.port === 465 && cfg.attachmentMaxBytes === 20 * 1024 * 1024, "defaults documented by the diagnostic actually apply");
});

test("invalid optional values fall back instead of blocking: bad port/max, MAIL_SECURE=false flips the default port", () => {
  const d = diagnoseMailEnv({ ...VALID, MAIL_PORT: "not-a-port", EMAIL_ATTACHMENT_MAX_BYTES: "-5" });
  assert.equal(d.MAIL_PORT.parsedValidPort, false);
  assert.equal(d.EMAIL_ATTACHMENT_MAX_BYTES.parsedPositiveInteger, false);
  assert.equal(d.mailConfigResolved, true, "invalid optionals fall back to defaults");
  const insecure = readMailConfig({ ...VALID, MAIL_SECURE: "false", MAIL_PORT: "" });
  assert.ok(insecure && insecure.secure === false && insecure.port === 587, "MAIL_SECURE=false defaults to 587");
  assert.equal(diagnoseMailEnv({ ...VALID, MAIL_SECURE: "false" }).MAIL_SECURE.parsedSecure, false);
});

test("the diagnostic mirrors readMailConfig on every shape (regression harness)", () => {
  const shapes: Record<string, string | undefined>[] = [
    VALID,
    {},
    { ...VALID, MAIL_HOST: "" },
    { ...VALID, MAIL_FROM_ADDRESS: "no-at-sign" },
    { ...VALID, MAIL_FROM_ADDRESS: " padded@example.test " },
    { ...VALID, MAIL_PASSWORD: "" },
    { MAIL_HOST: "h.example.test", MAIL_USERNAME: "u@example.test", MAIL_PASSWORD: "p", MAIL_FROM_ADDRESS: "u@example.test" },
  ];
  for (const env of shapes) {
    assert.equal(
      diagnoseMailEnv(env).mailConfigResolved,
      readMailConfig(env) !== null,
      `mirror for ${JSON.stringify(Object.keys(env))}`,
    );
  }
});
