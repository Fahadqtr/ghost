// STEP 88C — the regression that made a good upload read as "no baseline", and
// the error message that blamed the mail provider for it.
//
// Two failures compounded in production:
//
//   1. STEP 88 moved baseline storage to versioned objects behind an
//      active.json pointer, but the READER was left on the old fixed path. A
//      perfectly valid 992-row upload therefore resolved to nothing.
//
//   2. The generate route rendered every failure through the SEND vocabulary,
//      whose fallback is "the mail provider failed" — so a missing file told
//      the owner SMTP had broken, while SMTP was never contacted.
//
// The second was the worse bug. A wrong answer is recoverable; an error that
// names the wrong subsystem sends someone to check credentials for an hour.
//
// node --conditions=react-server --experimental-strip-types --test lib/export/talabat/step88c-baseline-resolution.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATION_ERROR_AR, generationErrorMessageAr, verifyArtifactScope,
  type GenerationError, type TalabatArtifactScope,
} from "./email-artifacts.ts";
import { TALABAT_SEND_ERROR_AR, talabatSendErrorMessageAr } from "./email-send.ts";
import { WORKFLOW_BLOCK_AR } from "./email-workflow.ts";
import {
  ACTIVE_BASELINE_POINTER, BASELINE_PREFIX, baselineObjectPath, parseActiveBaselineMeta,
} from "./baseline-upload.ts";
import { baselineFingerprint } from "../../talabat/baseline-fingerprint.ts";

const HERE = join(fileURLToPath(new URL(".", import.meta.url)));
const APP_ROOT = join(HERE, "../../..");
const raw = (rel: string): string => readFileSync(join(APP_ROOT, rel), "utf8");
const code = (rel: string): string =>
  raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVER = "lib/talabat/email-workflow.server.ts";
const GEN_API = "app/api/export/talabat/email/generate/[kind]/route.ts";
const WORKFLOW_API = "app/api/export/talabat/email/workflow/[kind]/route.ts";
const BASELINE_API = "app/api/export/talabat/email/baseline/route.ts";

// The production incident, reproduced from the real storage listing.
const REAL_FINGERPRINT = "b1.fb0609060ebc6c1c1f6944e28f13b2a3";
const REAL_OBJECT = `${BASELINE_PREFIX}/${REAL_FINGERPRINT}/products.xlsx`;

// ── 1. the pointer is now the source of truth ────────────────────────────────

test("1: the active pointer resolves the VERSIONED object, not the fixed path", () => {
  assert.equal(baselineObjectPath(REAL_FINGERPRINT), REAL_OBJECT);
  const server = code(SERVER);
  // the reader downloads the pointer, parses it, then downloads meta.objectPath
  assert.ok(server.includes("download(ACTIVE_BASELINE_POINTER)"), "the pointer is read first");
  assert.ok(server.includes("parseActiveBaselineMeta(pointerRaw)"));
  assert.ok(server.includes("download(meta.objectPath)"), "…and the versioned object is what loads");
  // the pointer path is checked BEFORE the legacy path is even considered
  assert.ok(server.indexOf("download(ACTIVE_BASELINE_POINTER)") < server.indexOf("download(TALABAT_BASELINE_OBJECT)"));
});

test("2: this is exactly the production failure, and it is gone", () => {
  // In production, active.json + b1.fb06…/products.xlsx existed while
  // email-artifacts/baseline/products.xlsx did NOT — and the reader wanted
  // only the latter, so a valid upload returned baseline_missing → HTTP 409.
  const server = code(SERVER);
  const reader = server.slice(server.indexOf("export async function readActiveBaselineBytes"));
  const body = reader.slice(0, reader.indexOf("export async function loadCurrentTalabatDelta"));
  assert.ok(body.includes("meta.objectPath"), "the versioned object is read");
  const legacyIdx = body.indexOf("TALABAT_BASELINE_OBJECT");
  const pointerBranchEnd = body.indexOf("if (pointerExists)");
  assert.ok(legacyIdx > pointerBranchEnd, "the legacy path lives after the pointer branch, not inside it");
});

test("3: the legacy fixed path is used ONLY when no pointer exists at all", () => {
  const server = code(SERVER);
  const reader = server.slice(server.indexOf("export async function readActiveBaselineBytes"));
  // every failure inside the pointer branch RETURNS — none of them fall through
  for (const failure of [
    'return { ok: false, error: "baseline_pointer_invalid" }',
    'return { ok: false, error: "baseline_invalid" }',
    'return { ok: false, error: "baseline_fingerprint_mismatch" }',
  ]) {
    assert.ok(reader.includes(failure), `missing fail-closed branch: ${failure}`);
    assert.ok(reader.indexOf(failure) < reader.indexOf("TALABAT_BASELINE_OBJECT"),
      "a broken pointer must never reach the legacy fallback");
  }
});

test("4: a broken pointer fails CLOSED with its own distinct reason", () => {
  // the four states are deliberately different answers, not one "missing"
  const distinct = new Set([
    GENERATION_ERROR_AR.baseline_missing,
    GENERATION_ERROR_AR.baseline_invalid,
    GENERATION_ERROR_AR.baseline_pointer_invalid,
    GENERATION_ERROR_AR.baseline_fingerprint_mismatch,
  ]);
  assert.equal(distinct.size, 4, "each failure tells the owner something different");
  // a malformed pointer parses to null, which the reader turns into pointer_invalid
  assert.equal(parseActiveBaselineMeta({ filename: "products.xlsx" }), null);
  assert.equal(parseActiveBaselineMeta("garbage"), null);
  assert.equal(parseActiveBaselineMeta({ ...validMeta(), objectPath: "" }), null,
    "a pointer with no objectPath is not usable");
});

test("5: the bytes must actually hash to what the pointer claims", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const fp = baselineFingerprint(bytes);
  assert.equal(baselineFingerprint(bytes), fp, "stable for identical content");
  assert.notEqual(baselineFingerprint(new Uint8Array([1, 2, 3, 5])), fp);
  const server = code(SERVER);
  assert.ok(server.includes("baselineFingerprint(bytes) !== meta.fingerprint"),
    "the loaded object is verified against the pointer, not trusted");
  assert.ok(server.includes('error: "baseline_fingerprint_mismatch"'));
});

function validMeta() {
  return {
    filename: "products.xlsx", byteLength: 67939, rowCount: 992,
    fingerprint: REAL_FINGERPRINT, uploadedAtIso: "2026-09-06T19:44:47.000Z",
    uploadedBy: "owner", objectPath: REAL_OBJECT, detectedHeaders: ["sku"],
  };
}

test("6: a well-formed pointer round-trips", () => {
  const meta = parseActiveBaselineMeta(validMeta());
  assert.ok(meta);
  assert.equal(meta!.objectPath, REAL_OBJECT);
  assert.equal(meta!.fingerprint, REAL_FINGERPRINT);
  assert.equal(meta!.rowCount, 992);
  assert.equal(ACTIVE_BASELINE_POINTER, `${BASELINE_PREFIX}/active.json`);
});

// ── 2. baseline binding survives the fix ─────────────────────────────────────

test("7: generation binds to the baseline the DELTA actually read", () => {
  const server = code(SERVER);
  // one read, one answer — not a second lookup that could race the first
  assert.ok(server.includes("const baseline = delta.baseline"),
    "the artifact records the baseline the comparison used");
  assert.ok(server.includes("baseline: baseline.meta"), "…which the delta returns");
  assert.ok(server.includes("baselineFingerprint: baseline?.fingerprint")
    || server.includes("baseline?.fingerprint"), "and it reaches the generator");
});

test("8: stale-artifact protection is unchanged", () => {
  const scope: TalabatArtifactScope = {
    kind: "existing_updates", runFingerprint: "r1.x", baselineFingerprint: "b1.old",
    generatedAtIso: "t", files: [{ filename: "a.xlsx", bytes: 1, contentType: "x", crc32: 1 }],
    workbookRows: 147, workbookProducts: 147, imageCount: null,
    rowsMissingImage: 0, excludedCategoryRows: 0,
    barcodeValueRows: 0, activeValueRows: 0, categoryValueRows: 0, extensionAudit: null,
  };
  assert.deepEqual(verifyArtifactScope(scope, "r1.x", "b1.old"), []);
  assert.deepEqual(verifyArtifactScope(scope, "r1.y", "b1.old"), ["artifact_stale"]);
  assert.deepEqual(verifyArtifactScope(scope, "r1.x", "b1.new"), ["baseline_changed"]);
  assert.deepEqual(verifyArtifactScope(null, "r1.x", "b1.old"), ["artifact_missing"]);
});

// ── 3. generation never speaks about mail ────────────────────────────────────

test("9: every generation error has its OWN message", () => {
  for (const codeName of [
    "baseline_missing", "baseline_invalid", "baseline_pointer_invalid",
    "baseline_fingerprint_mismatch", "preview_unavailable", "image_package_missing",
    "artifact_write_failed", "baseline_write_failed", "email_kind_not_sendable",
  ] as GenerationError[]) {
    const msg = GENERATION_ERROR_AR[codeName];
    assert.ok(typeof msg === "string" && msg.length > 0, `${codeName} has no message`);
    assert.equal(generationErrorMessageAr(codeName), msg);
  }
  assert.match(GENERATION_ERROR_AR.baseline_missing, /ارفع آخر ملف طلبات/);
  assert.match(GENERATION_ERROR_AR.artifact_write_failed, /لم يتم إرسال أي بريد/);
});

test("10: NO generation message can claim the mail provider failed", () => {
  const providerPhrase = "تعذّر إرسال الإيميل عبر مزوّد البريد";
  for (const [codeName, msg] of Object.entries(GENERATION_ERROR_AR)) {
    assert.equal(msg.includes(providerPhrase), false, `${codeName} must not blame the provider`);
    assert.equal(msg.includes("مزوّد البريد"), false, `${codeName} must not mention the mail provider`);
  }
  // …including the fallback for an UNKNOWN code, which is what actually bit us
  const unknown = generationErrorMessageAr("something_new_nobody_mapped");
  assert.equal(unknown.includes("مزوّد البريد"), false);
  assert.match(unknown, /لم يتم إرسال أي بريد/);
  // and the send vocabulary is a genuinely different set
  assert.notEqual(generationErrorMessageAr("baseline_missing"), talabatSendErrorMessageAr("baseline_missing"));
  assert.match(TALABAT_SEND_ERROR_AR.send_failed, /مزوّد البريد/, "the send map still says what it means");
});

test("11: the generate route uses the generation vocabulary, not the send one", () => {
  const route = code(GEN_API);
  assert.ok(route.includes("generationErrorMessageAr("), "generation messages");
  assert.equal(route.includes("talabatSendErrorMessageAr"), false, "the send mapper is gone from this route");
  assert.equal(route.includes("sendMailViaSmtp"), false);
  // the baseline route too — its own rejections first, then generation codes
  const baselineRoute = code(BASELINE_API);
  assert.ok(baselineRoute.includes("generationErrorMessageAr("));
  assert.equal(baselineRoute.includes("talabatSendErrorMessageAr"), false);
});

test("12: the workflow route tries generation codes BEFORE the send fallback", () => {
  const route = code(WORKFLOW_API);
  assert.ok(route.includes("GENERATION_ERROR_AR[code as GenerationError]"));
  const mapper = route.slice(route.indexOf("const messageAr"), route.indexOf("const str ="));
  assert.ok(mapper.indexOf("GENERATION_ERROR_AR") < mapper.indexOf("talabatSendErrorMessageAr"),
    "an artifact/baseline problem must resolve before the mail fallback is reached");
  // workflow blocks still win first
  assert.ok(mapper.indexOf("WORKFLOW_BLOCK_AR") < mapper.indexOf("GENERATION_ERROR_AR"));
  assert.ok(WORKFLOW_BLOCK_AR.artifact_missing.length > 0);
});

// ── 4. generate/send separation, re-asserted ─────────────────────────────────

test("13: no generation code path can reach a transport", () => {
  const server = code(SERVER);
  for (const fn of [
    "export async function generateTalabatEmailArtifacts",
    "export async function loadCurrentTalabatDelta",
    "export async function readActiveBaselineBytes",
    "export async function uploadTalabatBaseline",
  ]) {
    const start = server.indexOf(fn);
    assert.ok(start >= 0, `${fn} not found`);
    // read to the next top-level export, i.e. this function's body
    const rest = server.slice(start + fn.length);
    const end = rest.indexOf("\nexport ");
    const body = end < 0 ? rest : rest.slice(0, end);
    for (const forbidden of ["sendMailViaSmtp", "nodemailer", "createTransport", "runTalabatEmailSend"]) {
      assert.equal(body.includes(forbidden), false, `${fn} must not reach ${forbidden}`);
    }
  }
  // exactly one transport call site remains, in the test-send function
  assert.equal((server.match(/sendMailViaSmtp\(/g) ?? []).length, 1);
  const send = server.slice(server.indexOf("export async function sendTalabatTestEmail"));
  assert.ok(send.includes("sendMailViaSmtp("), "…and it is the send function");
});

test("14: generation writes no delivery row", () => {
  const server = code(SERVER);
  const gen = server.slice(
    server.indexOf("export async function generateTalabatEmailArtifacts"),
    server.indexOf("function readCompletedDeltaImageZip"));
  assert.equal(gen.includes("talabat_email_deliveries"), false, "generation logs no delivery");
  assert.equal(gen.includes(".insert("), false);
  // the ONE insert in the file belongs to the test send, after the provider accepted
  assert.equal((server.match(/\.insert\(/g) ?? []).length, 1);
  const send = server.slice(server.indexOf("export async function sendTalabatTestEmail"));
  assert.ok(send.indexOf("sendMailViaSmtp") < send.indexOf(".insert("));
});

test("15: official send is still off and nothing here sends", () => {
  const pure = code("lib/export/talabat/email-workflow.ts");
  assert.match(pure, /export const OFFICIAL_SEND_ENABLED = false/);
  const artifacts = code("lib/export/talabat/email-artifacts.ts");
  for (const forbidden of ["nodemailer", "createTransport", "sendMailViaSmtp", "fetch("]) {
    assert.equal(artifacts.includes(forbidden), false, `the artifact module must not contain ${forbidden}`);
  }
});
